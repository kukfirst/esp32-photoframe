<script setup>
// Batch upload with date/place captions (cachypc fork). Each photo is composed
// into a full frame (photo + blurred fill + caption off the photo), then goes
// through the same processing and upload path as ImageUpload.vue.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useAppStore, useSettingsStore } from "../stores";
import { MAX_ZOOM, MODES, clampView, composeFrame, coverZoom } from "../utils/captionLayout";
import {
  collectDates,
  formatDate,
  gpsFromTags,
  nearestPlace,
  pickDate,
  reverseGeocode,
  textPlaceFromTags,
} from "../utils/photoMeta";
import ProcessingControls from "./ProcessingControls.vue";
import { dither } from "../utils/ditherPool";

const appStore = useAppStore();
const settingsStore = useSettingsStore();

const LOCALE = navigator.language || "en";
const THUMBNAIL_MAX_DIM = 400;
const WORK_MAX_DIM = 900; // decoded size kept per photo for tiles
const TILE_SCALE = 0.25; // tiles are dithered at a quarter of the frame size

const items = ref([]);
const selectedId = ref(null);
const fileInput = ref(null);
const showCaption = ref(true);
const uploading = ref(false);
const frameAwake = ref(null);
const sliderPosition = ref(50);
const preview = ref({ original: null, processed: null, busy: false });
let imageProcessor = null;
let ExifReader = null;
let nextId = 1;

onMounted(async () => {
  [imageProcessor, ExifReader] = await Promise.all([
    import("@aitjcize/epaper-image-convert"),
    import("exifreader").then((m) => m.default),
  ]);
  checkFrame();
  rerenderAll();
});

// Logical frame size with the applied orientation, as the preview uses it.
const frameSize = computed(() => {
  let w = appStore.systemInfo.width || 800;
  let h = appStore.systemInfo.height || 480;
  const o = settingsStore.appliedOrientation;
  if ((o === "portrait" && w > h) || (o === "landscape" && w < h)) [w, h] = [h, w];
  return { width: w, height: h };
});

const selected = computed(() => items.value.find((i) => i.id === selectedId.value) || null);
const pending = computed(() => items.value.filter((i) => i.status !== "done"));
const doneCount = computed(() => items.value.filter((i) => i.status === "done").length);

async function checkFrame() {
  try {
    const r = await fetch("/api/system-info", { signal: AbortSignal.timeout(4000) });
    frameAwake.value = r.ok;
  } catch {
    frameAwake.value = false;
  }
}

async function decode(file, maxDim) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  if (scale === 1) return bmp;
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c;
}

// ---------- date & place ----------

function autoDate(item) {
  return item.dateAuto ? formatDate(item.dateAuto.value, LOCALE) : "";
}

function autoPlace(item) {
  if (item.placeAuto) return item.placeAuto;
  return item.near?.auto ? item.near.place : "";
}

// Fields show what goes on the frame: the override, else the automatic value.
function dateValue(item) {
  return item.dateText ?? autoDate(item);
}

function placeValue(item) {
  return item.placeText ?? autoPlace(item);
}

function dateSource(item) {
  if (item.dateText !== null) return "typed";
  if (!item.dateAuto) return "nothing found (EXIF, file name, file time)";
  // A file time alone is weak evidence: copies often reset it.
  const warn = item.dateAuto.source === "file:lastModified" ? " ⚠ check" : "";
  return `${item.dateAuto.source}${warn}`;
}

function placeSource(item) {
  if (item.placeText !== null) return "typed";
  if (item.placeAuto) return item.placeFrom;
  if (item.geocoding) return "GPS → looking up…";
  if (item.gps) return "GPS found, but the place lookup failed";
  if (item.near?.auto) return `≈ nearby photo, ${Math.round(item.near.hours)} h apart`;
  if (item.near) return "no GPS or XMP/IPTC; a nearby photo has a place:";
  return "nothing found (GPS, XMP/IPTC, nearby photos)";
}

function captionLines(item) {
  if (!showCaption.value) return [];
  return [dateValue(item), placeValue(item)];
}

function setDate(item, value) {
  item.dateText = value !== null && value === autoDate(item) ? null : value;
  refresh(item);
}

function setPlace(item, value) {
  item.placeText = value !== null && value === autoPlace(item) ? null : value;
  refresh(item);
}

// Re-derive "nearby photo" places for the whole batch; then redraw what changed.
function inferPlaces() {
  const known = items.value.map((i) => ({
    item: i,
    name: i.name,
    date: i.dateAuto?.value ?? null,
    place: i.placeAuto,
  }));
  for (const k of known) {
    const near = k.item.placeAuto ? null : nearestPlace(k, known);
    const changed = JSON.stringify(near) !== JSON.stringify(k.item.near);
    k.item.near = near;
    if (changed) refresh(k.item);
  }
}

// ---------- rendering ----------

function itemParams(item) {
  return item.params ?? settingsStore.params;
}

// Fit keeps the whole photo; crop is a per-photo choice.
function effectiveMode(item) {
  return item.mode ?? "fit";
}

function setMode(item, mode) {
  if (mode === "manual" && !item.view && item.work) {
    // Start manual framing from what the photo looks like now.
    const { width, height } = frameSize.value;
    const zoom = effectiveMode(item) === "crop" ? coverZoom(item.work, width, height) : 1;
    item.view = { zoom, u: 0.5, v: 0.5 };
  }
  item.mode = mode;
  refresh(item);
}

// Plain copies: reactive proxies cannot be posted to a worker.
const plain = (v) => JSON.parse(JSON.stringify(v));

function palette() {
  if (appStore.isGrayscale) {
    return plain(
      imageProcessor.makeGrayscale16({
        blackY: settingsStore.palette?.black_y ?? 0.009,
        whiteY: settingsStore.palette?.white_y ?? 0.65,
        gamma: settingsStore.palette?.gamma ?? 1.42,
      })
    );
  }
  const p = settingsStore.palette;
  return plain({
    ...imageProcessor.SPECTRA6,
    perceived: p && Object.keys(p).length ? p : imageProcessor.SPECTRA6.perceived,
  });
}

function compose(item, source, scale = 1) {
  return composeFrame(source, {
    width: Math.round(frameSize.value.width * scale),
    height: Math.round(frameSize.value.height * scale),
    mode: effectiveMode(item),
    view: item.view,
    lines: captionLines(item),
  });
}

function perceivedOptions(item, frame) {
  return {
    displayWidth: frame.width,
    displayHeight: frame.height,
    palette: palette(),
    params: plain(itemParams(item)),
    orientation: null,
    scaleMode: "cover", // the frame already has the display aspect
    usePerceivedOutput: true,
  };
}

function swapUrl(target, key, blob) {
  if (target[key]) URL.revokeObjectURL(target[key]);
  target[key] = URL.createObjectURL(blob);
}

// Dithering runs in workers (utils/ditherPool.js); only composition, which
// takes tens of milliseconds, stays on the page.
async function renderTile(item) {
  if (!item.work || !imageProcessor) return;
  const frame = compose(item, item.work, TILE_SCALE);
  const bitmap = await createImageBitmap(frame);
  const out = await dither(
    "background",
    `tile:${item.id}`,
    "preview",
    bitmap,
    perceivedOptions(item, frame)
  ).catch(() => ({ stale: true }));
  if (!out.stale) swapUrl(item, "tile", out.blob);
}

let previewToken = 0;
async function renderPreview() {
  const item = selected.value;
  if (!item || !item.work || !imageProcessor) return;
  const token = ++previewToken;
  preview.value.busy = true;
  item.full ??= await decode(item.file, 4096);
  if (token !== previewToken) return;
  const frame = compose(item, item.full);
  // The original side updates at once; the processed side when the worker is done.
  frame.toBlob(
    (blob) => token === previewToken && swapUrl(preview.value, "original", blob),
    "image/jpeg",
    0.9
  );
  const out = await dither(
    "preview",
    "preview",
    "preview",
    await createImageBitmap(frame),
    perceivedOptions(item, frame)
  ).catch(() => ({ stale: true }));
  if (out.stale || token !== previewToken) return;
  swapUrl(preview.value, "processed", out.blob);
  preview.value.busy = false;
}

function refresh(item) {
  renderTile(item);
  if (item === selected.value) renderPreview();
}

function rerenderAll() {
  items.value.forEach(renderTile);
  renderPreview();
}

function select(item) {
  if (selected.value && selected.value !== item) selected.value.full = null; // free memory
  selectedId.value = item.id;
  sliderPosition.value = 50;
  renderPreview();
}

let settingsTimer = null;
watch(
  () => [settingsStore.params, settingsStore.palette, showCaption.value],
  () => {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(rerenderAll, 400);
  },
  { deep: true }
);

// ---------- processing settings: shared or per photo ----------

function setOwnSettings(item, own) {
  item.params = own ? { ...settingsStore.params } : null;
  item.preset = own ? settingsStore.preset : null;
  refresh(item);
}

let paramsTimer = null;
function onParamsUpdate(newParams) {
  const item = selected.value;
  if (item?.params) {
    Object.assign(item.params, newParams);
    clearTimeout(paramsTimer);
    paramsTimer = setTimeout(() => refresh(item), 400);
  } else {
    Object.assign(settingsStore.params, newParams); // the watcher redraws everything
  }
}

function onPresetUpdate(preset) {
  const item = selected.value;
  if (item?.params) item.preset = preset;
  else settingsStore.preset = preset;
}

function onPresetChange(preset) {
  if (preset === "custom") return;
  const item = selected.value;
  if (item?.params) {
    Object.assign(item.params, imageProcessor.getPreset(preset));
    refresh(item);
  } else {
    settingsStore.applyPreset(preset);
  }
}

// ---------- adding photos ----------

async function addFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    if (!file.type.startsWith("image/")) continue;
    items.value.push({
      id: nextId++,
      file,
      name: file.name,
      mode: null,
      view: null,
      params: null,
      preset: null,
      dateAuto: null,
      dateText: null,
      gps: null,
      geocoding: false,
      placeAuto: null,
      placeFrom: null,
      placeText: null,
      near: null,
      status: "reading",
      error: null,
      tile: null,
      work: null,
      full: null,
    });
    const it = items.value[items.value.length - 1];
    if (selectedId.value === null) selectedId.value = it.id;
    try {
      let tags = {};
      try {
        tags = ExifReader.load(await file.arrayBuffer());
      } catch {
        // No or unreadable metadata: the date may still come from the name.
      }
      it.dateAuto = pickDate(collectDates(tags, file.name, file.lastModified));
      it.gps = gpsFromTags(tags);
      const textPlace = textPlaceFromTags(tags);
      if (textPlace) {
        it.placeAuto = textPlace;
        it.placeFrom = "XMP/IPTC";
      }
      it.work = await decode(file, WORK_MAX_DIM);
      it.status = "ready";
      inferPlaces();
      refresh(it);
      if (it.gps && !it.placeAuto) {
        it.geocoding = true;
        reverseGeocode(it.gps, LOCALE.split("-")[0]).then((name) => {
          it.geocoding = false;
          it.placeAuto = name;
          it.placeFrom = name ? "GPS" : null;
          inferPlaces();
          refresh(it);
        });
      }
    } catch (e) {
      it.status = "error";
      it.error = `Cannot read this image: ${e.message}`;
    }
  }
}

function onFiles(event) {
  addFiles(event.target.files);
  event.target.value = "";
}

function remove(item) {
  const idx = items.value.indexOf(item);
  items.value.splice(idx, 1);
  if (selectedId.value === item.id) {
    const next = items.value[Math.min(idx, items.value.length - 1)];
    selectedId.value = next?.id ?? null;
    if (next) renderPreview();
  }
  inferPlaces();
}

function clearDone() {
  items.value = items.value.filter((i) => i.status !== "done");
  if (!selected.value) selectedId.value = items.value[0]?.id ?? null;
  renderPreview();
}

function clearAll() {
  items.value = [];
  selectedId.value = null;
}

// ---------- upload ----------

// Same naming scheme as ImageUpload.vue: FNV-1a over name + timestamp.
function baseName(file) {
  const payload = `${file.name.replace(/\.[^/.]+$/, "")}:${Date.now()}`;
  let fnv = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    fnv ^= payload.charCodeAt(i);
    fnv = Math.imul(fnv, 0x01000193);
  }
  return (fnv >>> 0).toString(16).padStart(8, "0") + Date.now().toString(36).slice(-4);
}

async function uploadOne(item) {
  item.status = "uploading";
  item.error = null;
  try {
    const frame = compose(item, await decode(item.file, 4096));
    // The device gets native panel dimensions; the library rotates the output.
    const out = await dither(
      "background",
      `upload:${item.id}`,
      "upload",
      await createImageBitmap(frame),
      {
        displayWidth: appStore.systemInfo.width,
        displayHeight: appStore.systemInfo.height,
        palette: palette(),
        params: plain(itemParams(item)),
        orientation: settingsStore.appliedOrientation,
        scaleMode: "cover",
        usePerceivedOutput: false,
        grayscale: appStore.isGrayscale,
      }
    );
    const gz = out.epdgz;
    const layout = document.createElement("canvas");
    layout.width = out.original.width;
    layout.height = out.original.height;
    layout.getContext("2d").drawImage(out.original, 0, 0);
    out.original.close();
    const thumbCanvas = imageProcessor.generateThumbnail(layout, THUMBNAIL_MAX_DIM);
    const thumbBlob = await new Promise((r) => thumbCanvas.toBlob(r, "image/jpeg", 0.85));
    const name = baseName(item.file);
    const form = new FormData();
    form.append("image", new Blob([gz], { type: "application/gzip" }), `${name}.epdgz`);
    form.append("thumbnail", thumbBlob, `${name}.jpg`);
    const resp = await fetch(`/api/upload?album=${encodeURIComponent(appStore.selectedAlbum)}`, {
      method: "POST",
      body: form,
    });
    if (!resp.ok) throw new Error((await resp.text()) || `HTTP ${resp.status}`);
    item.status = "done";
  } catch (e) {
    item.status = "error";
    item.error = e.message;
  }
}

async function uploadAll() {
  await checkFrame();
  if (!frameAwake.value) return;
  uploading.value = true;
  try {
    for (const item of pending.value) {
      if (item.status === "reading") continue;
      await uploadOne(item);
      if (item.status === "error") {
        await checkFrame();
        if (!frameAwake.value) break;
      }
    }
    await appStore.loadSystemInfo();
    await appStore.loadImages(appStore.selectedAlbum);
  } finally {
    uploading.value = false;
  }
}

// ---------- compare slider (same interaction as ImageProcessing.vue) ----------

// Pointer capture keeps the drag on the slider even when the pointer leaves
// the preview, and avoids the browser's native image drag.
function slideTo(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  sliderPosition.value = Math.max(
    0,
    Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)
  );
}

function onSlideStart(event) {
  event.currentTarget.setPointerCapture(event.pointerId);
  slideTo(event);
}

function onSlideMove(event) {
  if (event.currentTarget.hasPointerCapture(event.pointerId)) slideTo(event);
}

// ---------- manual framing: drag to pan, wheel / pinch / slider to zoom ----------

const liveCanvas = ref(null);
const framing = ref(false); // true while the user is moving the photo
const pointers = new Map();
let pinchStart = null;
let framingTimer = null;
let liveFrame = 0;

const isManual = computed(() => selected.value && effectiveMode(selected.value) === "manual");

// Fast, undithered redraw while framing; the dithered preview follows once
// the user pauses.
function drawLive() {
  cancelAnimationFrame(liveFrame);
  liveFrame = requestAnimationFrame(() => {
    const item = selected.value;
    const canvas = liveCanvas.value;
    if (!item?.work || !canvas) return;
    const frame = compose(item, item.work, 0.5);
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext("2d").drawImage(frame, 0, 0);
  });
}

function updateView(patch) {
  const item = selected.value;
  const { width, height } = frameSize.value;
  item.view = clampView(item.work, width, height, { ...item.view, ...patch });
  framing.value = true;
  nextTick(drawLive);
  clearTimeout(framingTimer);
  framingTimer = setTimeout(() => {
    framing.value = false;
    refresh(item);
  }, 500);
}

// Screen pixels -> photo-relative units at the current zoom.
function photoUnits(rect) {
  const item = selected.value;
  const { width, height } = frameSize.value;
  const fit = Math.min(width / item.work.width, height / item.work.height);
  const toFrame = width / rect.width;
  return {
    du: toFrame / (item.work.width * fit * item.view.zoom),
    dv: toFrame / (item.work.height * fit * item.view.zoom),
  };
}

function onFrameDown(event) {
  event.currentTarget.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: selected.value.view.zoom };
  }
}

function onFrameMove(event) {
  const prev = pointers.get(event.pointerId);
  if (!prev) return;
  const cur = { x: event.clientX, y: event.clientY };
  pointers.set(event.pointerId, cur);
  if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    updateView({ zoom: (pinchStart.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pinchStart.dist });
    return;
  }
  const { du, dv } = photoUnits(event.currentTarget.getBoundingClientRect());
  const view = selected.value.view;
  updateView({ u: view.u - (cur.x - prev.x) * du, v: view.v - (cur.y - prev.y) * dv });
}

function onFrameUp(event) {
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinchStart = null;
}

function onFrameWheel(event) {
  updateView({ zoom: selected.value.view.zoom * Math.exp(-event.deltaY * 0.0015) });
}

const statusIcon = {
  reading: "mdi-timer-sand",
  uploading: "mdi-upload",
  done: "mdi-check-circle",
  error: "mdi-alert-circle",
};
</script>

<template>
  <v-card>
    <v-card-title class="d-flex align-center flex-wrap ga-2">
      <v-icon icon="mdi-image-multiple" class="mr-1" />
      Upload photos
      <v-spacer />
      <v-chip
        size="small"
        :color="frameAwake === null ? 'grey' : frameAwake ? 'success' : 'warning'"
        @click="checkFrame"
      >
        {{
          frameAwake === null
            ? "checking frame…"
            : frameAwake
              ? "frame awake"
              : "frame asleep — press its button"
        }}
      </v-chip>
      <v-btn
        v-if="items.length"
        color="primary"
        variant="flat"
        :loading="uploading"
        :disabled="!pending.length || !frameAwake"
        @click="uploadAll"
      >
        Send {{ pending.length }} to “{{ appStore.selectedAlbum }}”
      </v-btn>
    </v-card-title>

    <v-card-text>
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        multiple
        style="display: none"
        @change="onFiles"
      />

      <!-- Empty state: big drop zone -->
      <v-sheet
        v-if="!items.length"
        class="d-flex flex-column align-center justify-center pa-8"
        rounded
        border
        style="cursor: pointer"
        @click="fileInput?.click()"
        @dragover.prevent
        @drop.prevent="addFiles($event.dataTransfer.files)"
      >
        <v-icon icon="mdi-cloud-upload" size="56" color="grey" />
        <p class="text-h6 mt-3 mb-1">Click or drop photos</p>
        <p class="text-body-2 text-grey mb-0">
          As many as you like · album <strong>{{ appStore.selectedAlbum }}</strong>
        </p>
      </v-sheet>

      <template v-else>
        <!-- Tile strip -->
        <div
          class="tile-strip"
          @dragover.prevent
          @drop.prevent="addFiles($event.dataTransfer.files)"
        >
          <div
            v-for="item in items"
            :key="item.id"
            class="tile"
            :class="{ selected: item.id === selectedId, done: item.status === 'done' }"
            :title="item.name"
            @click="select(item)"
          >
            <img v-if="item.tile" :src="item.tile" alt="" />
            <v-progress-circular v-else indeterminate size="20" />
            <v-icon
              v-if="statusIcon[item.status]"
              :icon="statusIcon[item.status]"
              size="18"
              class="tile-status"
              :color="
                item.status === 'error' ? 'error' : item.status === 'done' ? 'success' : undefined
              "
            />
            <v-icon
              v-if="item.params"
              icon="mdi-tune"
              size="16"
              class="tile-own"
              title="Own settings"
            />
          </div>
          <div class="tile tile-add" title="Add photos" @click="fileInput?.click()">
            <v-icon icon="mdi-plus" size="32" color="grey" />
          </div>
        </div>

        <div class="d-flex flex-wrap align-center ga-3 mt-2 mb-4">
          <v-switch
            v-model="showCaption"
            label="Date & place caption"
            hide-details
            density="compact"
          />
          <v-spacer />
          <v-btn v-if="doneCount" size="small" variant="text" @click="clearDone"
            >Clear {{ doneCount }} sent</v-btn
          >
          <v-btn size="small" variant="text" :disabled="uploading" @click="clearAll"
            >Clear all</v-btn
          >
        </div>

        <!-- Selected photo -->
        <v-row v-if="selected">
          <v-col cols="12" md="8">
            <div
              v-if="isManual"
              class="compare framing"
              :style="{ aspectRatio: frameSize.width / frameSize.height }"
              @pointerdown.prevent="onFrameDown"
              @pointermove="onFrameMove"
              @pointerup="onFrameUp"
              @pointercancel="onFrameUp"
              @wheel.prevent="onFrameWheel"
            >
              <canvas v-show="framing" ref="liveCanvas" class="compare-img" />
              <img
                v-if="!framing && preview.processed"
                :src="preview.processed"
                alt=""
                class="compare-img"
                draggable="false"
              />
              <v-progress-linear v-if="preview.busy" indeterminate class="compare-busy" />
            </div>
            <div
              v-else
              class="compare"
              :style="{ aspectRatio: frameSize.width / frameSize.height }"
              @pointerdown.prevent="onSlideStart"
              @pointermove="onSlideMove"
            >
              <template v-if="preview.original">
                <img :src="preview.original" alt="" class="compare-img" draggable="false" />
                <img
                  :src="preview.processed"
                  alt=""
                  class="compare-img"
                  draggable="false"
                  :style="{ clipPath: `inset(0 0 0 ${sliderPosition}%)` }"
                />
                <div class="slider-line" :style="{ left: `${sliderPosition}%` }">
                  <div class="slider-handle">
                    <v-icon size="small">mdi-arrow-left-right</v-icon>
                  </div>
                </div>
              </template>
              <v-progress-linear v-if="preview.busy" indeterminate class="compare-busy" />
            </div>
            <div v-if="isManual" class="d-flex align-center ga-2 mt-1">
              <v-icon icon="mdi-magnify-minus-outline" size="small" />
              <v-slider
                :model-value="selected.view.zoom"
                :min="1"
                :max="MAX_ZOOM"
                :step="0.01"
                hide-details
                density="compact"
                @update:model-value="updateView({ zoom: $event })"
              />
              <v-icon icon="mdi-magnify-plus-outline" size="small" />
              <span class="text-caption text-grey ml-2">drag to move · wheel or pinch to zoom</span>
            </div>
            <div v-else class="d-flex justify-space-between mt-1">
              <span class="text-caption">← Original</span>
              <span class="text-caption">Processed (as on the panel) →</span>
            </div>
          </v-col>

          <v-col cols="12" md="4">
            <div class="d-flex align-center mb-3">
              <span class="text-subtitle-2 text-truncate" :title="selected.name">{{
                selected.name
              }}</span>
              <v-spacer />
              <v-btn
                icon="mdi-delete"
                size="small"
                variant="text"
                :disabled="selected.status === 'uploading'"
                @click="remove(selected)"
              />
            </div>
            <div v-if="selected.error" class="text-caption text-error mb-2">
              {{ selected.error }}
            </div>

            <v-text-field
              :model-value="dateValue(selected)"
              placeholder="none — e.g. ≈1987"
              persistent-placeholder
              label="Date"
              density="compact"
              hide-details
              @change="setDate(selected, $event.target.value)"
            >
              <template #append-inner>
                <v-btn
                  v-if="selected.dateText !== null"
                  size="x-small"
                  variant="text"
                  @click="setDate(selected, null)"
                  >auto</v-btn
                >
              </template>
            </v-text-field>
            <div class="text-caption text-grey mb-3">from: {{ dateSource(selected) }}</div>

            <v-text-field
              :model-value="placeValue(selected)"
              placeholder="none"
              persistent-placeholder
              label="Place"
              density="compact"
              hide-details
              @change="setPlace(selected, $event.target.value)"
            >
              <template #append-inner>
                <v-btn
                  v-if="selected.placeText !== null"
                  size="x-small"
                  variant="text"
                  @click="setPlace(selected, null)"
                  >auto</v-btn
                >
              </template>
            </v-text-field>
            <div class="text-caption text-grey">from: {{ placeSource(selected) }}</div>
            <v-btn
              v-if="
                selected.near &&
                !selected.near.auto &&
                selected.placeText === null &&
                !selected.placeAuto
              "
              size="small"
              variant="tonal"
              class="mt-1 text-none suggest-btn"
              :title="`From ${selected.near.from}`"
              @click="setPlace(selected, selected.near.place)"
            >
              Use “{{ selected.near.place }}” · {{ Math.round(selected.near.hours) }} h apart
            </v-btn>

            <div class="d-flex align-center flex-wrap ga-2 mt-4">
              <v-btn-toggle
                :model-value="effectiveMode(selected)"
                mandatory
                density="compact"
                variant="outlined"
                divided
                @update:model-value="setMode(selected, $event)"
              >
                <v-btn v-for="m in MODES" :key="m" :value="m" size="small">{{ m }}</v-btn>
              </v-btn-toggle>
              <v-spacer />
              <v-btn size="small" variant="text" @click="setDate(selected, '')">no date</v-btn>
              <v-btn size="small" variant="text" @click="setPlace(selected, '')">no place</v-btn>
            </div>
          </v-col>

          <v-col cols="12">
            <v-card variant="outlined">
              <v-card-title class="d-flex align-center flex-wrap ga-2 text-subtitle-1">
                Processing
                <v-spacer />
                <v-btn-toggle
                  :model-value="selected.params ? 'own' : 'shared'"
                  mandatory
                  density="compact"
                  variant="outlined"
                  divided
                  @update:model-value="setOwnSettings(selected, $event === 'own')"
                >
                  <v-btn value="shared" size="small">All photos</v-btn>
                  <v-btn value="own" size="small">This photo only</v-btn>
                </v-btn-toggle>
              </v-card-title>
              <v-card-text>
                <div class="text-caption text-grey mb-3">
                  {{
                    selected.params
                      ? "Changes apply to this photo only."
                      : "Shared with Settings → Processing: changes apply to every photo without its own settings. Save Settings there to keep them."
                  }}
                </div>
                <ProcessingControls
                  :params="itemParams(selected)"
                  :preset="selected.params ? selected.preset : settingsStore.preset"
                  @update:params="onParamsUpdate"
                  @update:preset="onPresetUpdate"
                  @preset-change="onPresetChange"
                />
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>
      </template>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.tile-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tile {
  position: relative;
  width: 120px;
  aspect-ratio: 4 / 3;
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
  outline: 2px solid transparent;
  outline-offset: 1px;
  background: rgba(0, 0, 0, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
}
.tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.tile.selected {
  outline-color: rgb(var(--v-theme-primary));
}
.tile.done img {
  opacity: 0.45;
}
.tile-status,
.tile-own {
  position: absolute;
  background: rgba(255, 255, 255, 0.85);
  border-radius: 50%;
}
.tile-status {
  top: 4px;
  right: 4px;
}
.tile-own {
  bottom: 4px;
  right: 4px;
}
.tile-add {
  border: 2px dashed rgba(0, 0, 0, 0.2);
}
@media (max-width: 600px) {
  .tile {
    width: calc((100% - 16px) / 3);
  }
}
.suggest-btn {
  max-width: 100%;
  white-space: normal;
  height: auto !important;
  min-height: 28px;
  padding-top: 4px;
  padding-bottom: 4px;
}
.compare {
  position: relative;
  width: 100%;
  background: #000;
  border-radius: 6px;
  overflow: hidden;
  user-select: none;
  touch-action: pan-y;
  cursor: ew-resize;
}
.compare.framing {
  cursor: grab;
  touch-action: none;
}
.compare.framing:active {
  cursor: grabbing;
}
.compare-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
.compare-busy {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
}
.slider-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #fff;
  transform: translateX(-1px);
  pointer-events: none;
}
.slider-handle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: #fff;
  border-radius: 50%;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}
</style>
