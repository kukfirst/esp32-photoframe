<script setup>
// Batch upload with date/place captions (cachypc fork). Each photo is composed
// into a full frame (photo + blurred fill + caption off the photo), then goes
// through the same processing and upload path as ImageUpload.vue.
import { computed, onMounted, ref, watch } from "vue";
import { useAppStore, useSettingsStore } from "../stores";
import { MODES, composeFrame } from "../utils/captionLayout";
import ProcessingControls from "./ProcessingControls.vue";
import {
  collectDates,
  formatDate,
  gpsFromTags,
  pickDate,
  reverseGeocode,
} from "../utils/photoMeta";

const appStore = useAppStore();
const settingsStore = useSettingsStore();

const LOCALE = navigator.language || "en";
const THUMBNAIL_MAX_DIM = 400;
const WORK_MAX_DIM = 900; // decoded size kept per photo for the on-page preview

const items = ref([]);
const fileInput = ref(null);
const showCaption = ref(true);
const uploading = ref(false);
const frameAwake = ref(null);
const previewDialog = ref(false);
const previewUrl = ref(null);
const previewBusy = ref(false);
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

function captionLines(item) {
  if (!showCaption.value) return [];
  const date = item.dateText ?? (item.dateAuto ? formatDate(item.dateAuto.value, LOCALE) : "");
  const place = item.placeText ?? item.placeAuto ?? "";
  return [date, place];
}

// Scale Mode in the processing settings is the default; a per-photo choice wins.
function effectiveMode(item) {
  return item.mode ?? (settingsStore.params.scaleMode === "fit" ? "fit" : "crop");
}

function setMode(item, mode) {
  item.mode = mode;
  renderThumb(item);
}

// Thumbnails are dithered at half resolution with the current settings, so
// the grid shows what the panel will show. Renders run one at a time; a newer
// request for the same item supersedes an older queued one.
let renderChain = Promise.resolve();

function renderThumb(item) {
  if (!item.work) return;
  const token = (item.renderToken = (item.renderToken || 0) + 1);
  item.rendering = true;
  renderChain = renderChain.then(async () => {
    if (token !== item.renderToken || !imageProcessor) return;
    await new Promise((r) => setTimeout(r, 0)); // let the UI paint between renders
    const width = Math.round(frameSize.value.width / 2);
    const height = Math.round(frameSize.value.height / 2);
    const frame = composeFrame(item.work, {
      width,
      height,
      mode: effectiveMode(item),
      lines: captionLines(item),
    });
    const result = imageProcessor.processImage(frame, {
      displayWidth: width,
      displayHeight: height,
      palette: palette(),
      params: { ...settingsStore.params },
      orientation: null,
      scaleMode: "cover",
      usePerceivedOutput: true,
    });
    if (token !== item.renderToken) return;
    item.thumb = result.canvas.toDataURL("image/png");
    item.rendering = false;
  });
}

function rerenderAll() {
  items.value.forEach(renderThumb);
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

function onParamsUpdate(newParams) {
  Object.assign(settingsStore.params, newParams);
}

function onPresetChange(preset) {
  if (preset !== "custom") settingsStore.applyPreset(preset);
}

async function addFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    if (!file.type.startsWith("image/")) continue;
    const item = {
      id: nextId++,
      file,
      name: file.name,
      mode: null,
      rendering: false,
      renderToken: 0,
      dateAuto: null,
      candidates: [],
      dateText: null,
      gps: null,
      placeAuto: null,
      placeText: null,
      status: "reading",
      error: null,
      thumb: null,
      work: null,
    };
    items.value.push(item);
    const it = items.value[items.value.length - 1];
    try {
      let tags = {};
      try {
        tags = ExifReader.load(await file.arrayBuffer());
      } catch {
        // No or unreadable EXIF: the date may still come from the name.
      }
      it.candidates = collectDates(tags, file.name, file.lastModified);
      it.dateAuto = pickDate(it.candidates);
      it.gps = gpsFromTags(tags);
      it.work = await decode(file, WORK_MAX_DIM);
      it.status = "ready";
      renderThumb(it);
      if (it.gps) {
        reverseGeocode(it.gps, LOCALE.split("-")[0]).then((name) => {
          it.placeAuto = name;
          renderThumb(it);
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
  items.value = items.value.filter((i) => i !== item);
}

function clearDone() {
  items.value = items.value.filter((i) => i.status !== "done");
}

function setDate(item, value) {
  item.dateText = value !== null && value === autoDate(item) ? null : value;
  renderThumb(item);
}

function setPlace(item, value) {
  item.placeText = value !== null && value === (item.placeAuto ?? "") ? null : value;
  renderThumb(item);
}

function autoDate(item) {
  return item.dateAuto ? formatDate(item.dateAuto.value, LOCALE) : "";
}

// Fields show what goes on the frame: the override, else the automatic value.
function dateValue(item) {
  return item.dateText ?? autoDate(item);
}

function placeValue(item) {
  return item.placeText ?? item.placeAuto ?? "";
}

function sourceLabel(item) {
  if (!item.dateAuto) return "no date found";
  // A file time alone is weak evidence: copies often reset it.
  const warn = item.dateAuto.source === "file:lastModified" ? " ⚠ check" : "";
  return `${autoDate(item)} · ${item.dateAuto.source}${warn}`;
}

function palette() {
  if (appStore.isGrayscale) {
    return imageProcessor.makeGrayscale16({
      blackY: settingsStore.palette?.black_y ?? 0.009,
      whiteY: settingsStore.palette?.white_y ?? 0.65,
      gamma: settingsStore.palette?.gamma ?? 1.42,
    });
  }
  const p = settingsStore.palette;
  return {
    ...imageProcessor.SPECTRA6,
    perceived: p && Object.keys(p).length ? p : imageProcessor.SPECTRA6.perceived,
  };
}

async function processItem(item, perceived) {
  const full = await decode(item.file, 4096);
  const frame = composeFrame(full, {
    ...frameSize.value,
    mode: effectiveMode(item),
    lines: captionLines(item),
  });
  // The device gets native panel dimensions (the library rotates the output);
  // the on-screen preview stays in the logical orientation, unrotated.
  return imageProcessor.processImage(frame, {
    displayWidth: perceived ? frameSize.value.width : appStore.systemInfo.width,
    displayHeight: perceived ? frameSize.value.height : appStore.systemInfo.height,
    palette: palette(),
    params: { ...settingsStore.params },
    orientation: perceived ? null : settingsStore.appliedOrientation,
    scaleMode: "cover", // the frame already has the display aspect
    usePerceivedOutput: perceived,
  });
}

async function openPreview(item) {
  previewDialog.value = true;
  previewBusy.value = true;
  previewUrl.value = null;
  try {
    const result = await processItem(item, true);
    previewUrl.value = result.canvas.toDataURL("image/png");
  } finally {
    previewBusy.value = false;
  }
}

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
    const result = await processItem(item, false);
    const gz = await imageProcessor.createEPDGZ(result.canvas, { grayscale: appStore.isGrayscale });
    const thumbCanvas = imageProcessor.generateThumbnail(result.originalCanvas, THUMBNAIL_MAX_DIM);
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

const statusColor = {
  reading: "grey",
  ready: "primary",
  uploading: "info",
  done: "success",
  error: "error",
};
</script>

<template>
  <v-card>
    <v-card-title class="d-flex align-center flex-wrap ga-2">
      <v-icon icon="mdi-image-multiple" class="mr-1" />
      Batch upload with captions
      <v-spacer />
      <v-btn
        v-if="items.length"
        color="primary"
        variant="flat"
        size="small"
        :loading="uploading"
        :disabled="!pending.length || !frameAwake"
        @click="uploadAll"
      >
        Upload {{ pending.length }} to “{{ appStore.selectedAlbum }}”
      </v-btn>
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

      <v-sheet
        class="d-flex flex-column align-center justify-center pa-6 mb-4"
        rounded
        border
        style="cursor: pointer"
        @click="fileInput?.click()"
        @dragover.prevent
        @drop.prevent="addFiles($event.dataTransfer.files)"
      >
        <v-icon icon="mdi-cloud-upload" size="48" color="grey" />
        <p class="text-subtitle-1 mt-2 mb-0">Click or drop photos — as many as you like</p>
        <p class="text-body-2 text-grey mb-0">
          Album: <strong>{{ appStore.selectedAlbum }}</strong>
        </p>
      </v-sheet>

      <v-switch
        v-model="showCaption"
        label="Date & place caption"
        hide-details
        density="compact"
        class="mb-2"
      />

      <v-expansion-panels class="mb-4">
        <v-expansion-panel>
          <v-expansion-panel-title>
            Processing — {{ settingsStore.preset }}, default
            {{ settingsStore.params.scaleMode === "fit" ? "fit" : "crop" }}
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <div class="text-caption text-grey mb-3">
              Same settings as Settings → Processing. Previews below update as you change them; use
              Save Settings there to keep them for next time.
            </div>
            <ProcessingControls
              :params="settingsStore.params"
              :preset="settingsStore.preset"
              @update:params="onParamsUpdate"
              @update:preset="settingsStore.preset = $event"
              @preset-change="onPresetChange"
            />
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>

      <v-row v-if="items.length" dense>
        <v-col v-for="item in items" :key="item.id" cols="12" sm="6" lg="4">
          <v-card variant="outlined" :color="item.status === 'error' ? 'error' : undefined">
            <div v-if="item.thumb" class="batch-thumb-wrap">
              <img
                :src="item.thumb"
                alt=""
                class="batch-thumb"
                title="Full-size panel preview"
                @click="openPreview(item)"
              />
              <v-progress-linear v-if="item.rendering" indeterminate class="batch-thumb-busy" />
            </div>
            <div
              v-else
              class="d-flex align-center justify-center bg-grey-lighten-3"
              :style="{ aspectRatio: frameSize.width / frameSize.height }"
            >
              <v-progress-circular v-if="item.status === 'reading'" indeterminate />
            </div>
            <v-card-text class="pa-3">
              <div class="d-flex align-center mb-2">
                <span class="text-body-2 text-truncate" :title="item.name">{{ item.name }}</span>
                <v-spacer />
                <v-chip size="x-small" :color="statusColor[item.status]">{{ item.status }}</v-chip>
              </div>
              <v-text-field
                :model-value="dateValue(item)"
                placeholder="none — e.g. ≈1987"
                persistent-placeholder
                label="Date"
                density="compact"
                hide-details
                class="mb-1"
                @change="setDate(item, $event.target.value)"
              >
                <template #append-inner>
                  <v-btn
                    v-if="item.dateText !== null"
                    size="x-small"
                    variant="text"
                    @click="setDate(item, null)"
                    >auto</v-btn
                  >
                </template>
              </v-text-field>
              <div class="text-caption text-grey mb-2">auto: {{ sourceLabel(item) }}</div>
              <v-text-field
                :model-value="placeValue(item)"
                :placeholder="item.gps && item.placeAuto === null ? 'looking up…' : 'none'"
                persistent-placeholder
                label="Place"
                density="compact"
                hide-details
                class="mb-2"
                @change="setPlace(item, $event.target.value)"
              >
                <template #append-inner>
                  <v-btn
                    v-if="item.placeText !== null"
                    size="x-small"
                    variant="text"
                    @click="setPlace(item, null)"
                    >auto</v-btn
                  >
                </template>
              </v-text-field>
              <div class="d-flex align-center flex-wrap ga-1">
                <v-btn-toggle
                  :model-value="effectiveMode(item)"
                  mandatory
                  density="compact"
                  variant="outlined"
                  divided
                  @update:model-value="setMode(item, $event)"
                >
                  <v-btn v-for="m in MODES" :key="m" :value="m" size="small">{{ m }}</v-btn>
                </v-btn-toggle>
                <v-spacer />
                <v-btn
                  size="small"
                  variant="text"
                  title="No date on the frame"
                  @click="setDate(item, '')"
                  >no date</v-btn
                >
                <v-btn
                  size="small"
                  variant="text"
                  title="No place on the frame"
                  @click="setPlace(item, '')"
                  >no place</v-btn
                >
                <v-btn
                  icon="mdi-delete"
                  size="small"
                  variant="text"
                  :disabled="item.status === 'uploading'"
                  @click="remove(item)"
                />
              </div>
              <div v-if="item.error" class="text-caption text-error mt-1">{{ item.error }}</div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </v-card-text>

    <v-card-actions v-if="items.length" class="flex-wrap ga-2 px-4 pb-16">
      <v-btn
        color="primary"
        variant="flat"
        :loading="uploading"
        :disabled="!pending.length || !frameAwake"
        @click="uploadAll"
      >
        Upload {{ pending.length }} to “{{ appStore.selectedAlbum }}”
      </v-btn>
      <v-btn v-if="doneCount" variant="text" @click="clearDone"
        >Clear {{ doneCount }} uploaded</v-btn
      >
      <v-btn variant="text" :disabled="uploading" @click="items = []">Clear all</v-btn>
    </v-card-actions>

    <v-dialog v-model="previewDialog" max-width="1200">
      <v-card>
        <v-card-title>Panel preview</v-card-title>
        <v-card-text class="d-flex justify-center">
          <v-progress-circular v-if="previewBusy" indeterminate size="48" class="ma-8" />
          <img
            v-else-if="previewUrl"
            :src="previewUrl"
            alt=""
            style="max-width: 100%; height: auto"
          />
        </v-card-text>
        <v-card-actions
          ><v-spacer /><v-btn @click="previewDialog = false">Close</v-btn></v-card-actions
        >
      </v-card>
    </v-dialog>
  </v-card>
</template>

<style scoped>
.batch-thumb-wrap {
  position: relative;
}
.batch-thumb-busy {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
}
.batch-thumb {
  display: block;
  width: 100%;
  height: auto;
  cursor: zoom-in;
}
</style>
