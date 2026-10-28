<script setup>
// Batch upload with date/place captions (cachypc fork). Each photo is composed
// into a full frame (photo + blurred fill + caption off the photo), then goes
// through the same processing and upload path as ImageUpload.vue.
import { computed, onMounted, ref } from "vue";
import { useAppStore, useSettingsStore } from "../stores";
import { MODES, composeFrame } from "../utils/captionLayout";
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
const defaultMode = ref("fit");
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

function renderThumb(item) {
  if (!item.work) return;
  const { width, height } = frameSize.value;
  const canvas = composeFrame(item.work, {
    width: Math.round(width / 2),
    height: Math.round(height / 2),
    mode: item.mode,
    lines: captionLines(item),
  });
  item.thumb = canvas.toDataURL("image/jpeg", 0.85);
}

function rerenderAll() {
  items.value.forEach(renderThumb);
}

async function addFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    if (!file.type.startsWith("image/")) continue;
    const item = {
      id: nextId++,
      file,
      name: file.name,
      mode: defaultMode.value,
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
    mode: item.mode,
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

      <div class="d-flex flex-wrap align-center ga-4 mb-4">
        <v-switch
          v-model="showCaption"
          label="Date & place caption"
          hide-details
          density="compact"
          @update:model-value="rerenderAll"
        />
        <v-btn-toggle v-model="defaultMode" mandatory density="compact" variant="outlined" divided>
          <v-btn value="fit">Fit</v-btn>
          <v-btn value="crop">Crop</v-btn>
        </v-btn-toggle>
        <span class="text-caption text-grey">default for new photos</span>
      </div>

      <v-row v-if="items.length" dense>
        <v-col v-for="item in items" :key="item.id" cols="12" sm="6" lg="4">
          <v-card variant="outlined" :color="item.status === 'error' ? 'error' : undefined">
            <img
              v-if="item.thumb"
              :src="item.thumb"
              alt=""
              class="batch-thumb"
              title="Show as the panel will render it"
              @click="openPreview(item)"
            />
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
                  v-model="item.mode"
                  mandatory
                  density="compact"
                  variant="outlined"
                  divided
                  @update:model-value="renderThumb(item)"
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

    <v-card-actions v-if="items.length" class="flex-wrap ga-2 px-4 pb-4">
      <v-btn
        color="primary"
        variant="flat"
        :loading="uploading"
        :disabled="!pending.length"
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
.batch-thumb {
  display: block;
  width: 100%;
  height: auto;
  cursor: zoom-in;
}
</style>
