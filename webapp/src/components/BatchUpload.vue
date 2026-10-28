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
import { getPresetOptions } from "@aitjcize/epaper-image-convert";
import { dither } from "../utils/ditherPool";
import { editRequest, importRequest } from "../utils/editRequest";

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

async function decode(file, maxDim, onSize = null) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  onSize?.(bmp.width, bmp.height);
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
  // Both sides change together when the worker is done, so the view never
  // shows a new original next to a stale processed frame.
  const originalBlob = new Promise((r) => frame.toBlob(r, "image/jpeg", 0.9));
  const out = await dither(
    "preview",
    "preview",
    "preview",
    await createImageBitmap(frame),
    perceivedOptions(item, frame)
  ).catch(() => ({ stale: true }));
  if (out.stale || token !== previewToken) return;
  swapUrl(preview.value, "original", await originalBlob);
  swapUrl(preview.value, "processed", out.blob);
  preview.value.busy = false;
  // The live (undithered) frame stays up until this point while framing.
  if (!framingPending) framing.value = false;
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
const PRESETS = getPresetOptions(); // [{ value, title, description }]

function currentPreset(item) {
  return item.params ? item.preset : settingsStore.preset;
}

function choosePreset(item, preset) {
  onPresetUpdate(preset);
  onPresetChange(preset);
}

function onParamsUpdate(newParams) {
  const item = selected.value;
  if (item?.params) {
    item.preset = "custom"; // hand-tuned values no longer match a preset
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
    // Only processing values, as settingsStore.applyPreset does.
    // eslint-disable-next-line no-unused-vars
    const { name, title, description, ...values } = imageProcessor.getPreset(preset);
    Object.assign(item.params, values);
    refresh(item);
  } else {
    settingsStore.applyPreset(preset);
  }
}

// ---------- adding photos ----------

function newItem(file, extra = {}) {
  items.value.push({
    id: nextId++,
    file,
    name: file.name,
    mode: null,
    view: null,
    natural: null,
    beforeUpscale: null,
    // Own settings by default; "All photos" switches a photo to the shared ones.
    params: { ...settingsStore.params },
    preset: settingsStore.preset,
    dateAuto: null,
    dateText: null,
    gps: null,
    geocoding: false,
    placeAuto: null,
    placeFrom: null,
    placeText: null,
    near: null,
    replaces: null, // frame path this photo replaces when sent (editing from the gallery)
    status: "reading",
    error: null,
    tile: null,
    work: null,
    full: null,
    ...extra,
  });
  return items.value[items.value.length - 1];
}

async function addFiles(fileList) {
  const added = [];
  for (const file of Array.from(fileList || [])) {
    if (!file.type.startsWith("image/")) continue;
    const it = newItem(file);
    added.push(it);
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
      it.work = await decode(file, WORK_MAX_DIM, (w, h) => (it.natural = { w, h }));
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
  return added;
}

// Photos checked in the Sort tab arrive with the place chosen there and the
// folder's month for photos without a capture date.
watch(importRequest, async (entries) => {
  if (!entries) return;
  importRequest.value = null;
  for (const e of entries) {
    const [it] = await addFiles([e.file]);
    if (!it) continue;
    if (e.place) it.placeText = e.place;
    if (!it.dateAuto && e.dateFallback) it.dateText = e.dateFallback;
    refresh(it);
  }
  notify(`${entries.length} photos from Sort added`, "success");
});

// ---------- library of originals (cachypc/upscale/server.py) ----------

const libraryUrl = (what, key) => `/library/${what}?key=${encodeURIComponent(key)}`;

// Everything needed to rebuild the photo in the editor later.
function editState(item) {
  return {
    name: item.name,
    mode: item.mode,
    view: item.view,
    params: item.params,
    preset: item.preset,
    caption: showCaption.value,
    dateAuto: item.dateAuto && {
      source: item.dateAuto.source,
      value: item.dateAuto.value.toISOString(),
    },
    dateText: item.dateText,
    gps: item.gps,
    placeAuto: item.placeAuto,
    placeFrom: item.placeFrom,
    placeText: item.placeText ?? (item.near?.auto ? item.near.place : null),
    savedAt: new Date().toISOString(),
  };
}

async function libraryFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error("The cachypc helper service is not reachable (cachypc/upscale/server.py).");
  }
}

async function saveToLibrary(key, item) {
  const put = (what, body, type) =>
    libraryFetch(libraryUrl(what, key), { method: "PUT", headers: { "Content-Type": type }, body });
  const r1 = await put("source", item.file, item.file.type || "application/octet-stream");
  const r2 = await put("meta", JSON.stringify(plain(editState(item))), "application/json");
  if (!r1.ok || !r2.ok) throw new Error("the original could not be saved for later editing");
}

async function openFromGallery({ album, filename }) {
  const key = `${album}/${filename}`;
  const existing = items.value.find((i) => i.replaces === key);
  if (existing) return select(existing);
  try {
    const metaResp = await libraryFetch(libraryUrl("meta", key));
    if (metaResp.status === 404) {
      throw new Error(
        "No original is stored for this photo: it was uploaded before the library existed " +
          "or from another device. Add the original photo again to change it."
      );
    }
    if (!metaResp.ok) throw new Error(`library answered HTTP ${metaResp.status}`);
    const meta = await metaResp.json();
    const srcResp = await libraryFetch(libraryUrl("source", key));
    if (!srcResp.ok) throw new Error(`the stored original is missing (HTTP ${srcResp.status})`);
    const blob = await srcResp.blob();
    const file = new File([blob], meta.name, { type: blob.type });
    const caption = meta.caption !== false;
    const it = newItem(file, {
      mode: meta.mode,
      view: meta.view,
      params: meta.params,
      preset: meta.preset,
      dateAuto: meta.dateAuto && {
        source: meta.dateAuto.source,
        value: new Date(meta.dateAuto.value),
      },
      dateText: caption ? meta.dateText : "",
      gps: meta.gps,
      placeAuto: meta.placeAuto,
      placeFrom: meta.placeFrom,
      placeText: caption ? meta.placeText : "",
      replaces: key,
    });
    it.work = await decode(file, WORK_MAX_DIM, (w, h) => (it.natural = { w, h }));
    it.status = "ready";
    select(it);
    refresh(it);
  } catch (e) {
    notify(`Cannot edit ${filename}: ${e.message}`, "error");
  }
}

watch(editRequest, (req) => {
  if (!req) return;
  editRequest.value = null;
  openFromGallery(req);
});

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

// Render the device frame: EPDGZ plus a JPEG thumbnail, as ImageUpload.vue does.
async function renderForDevice(item) {
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
  const layout = document.createElement("canvas");
  layout.width = out.original.width;
  layout.height = out.original.height;
  layout.getContext("2d").drawImage(out.original, 0, 0);
  out.original.close();
  const thumbCanvas = imageProcessor.generateThumbnail(layout, THUMBNAIL_MAX_DIM);
  const thumbBlob = await new Promise((r) => thumbCanvas.toBlob(r, "image/jpeg", 0.85));
  const name = baseName(item.file);
  const form = new FormData();
  form.append("image", new Blob([out.epdgz], { type: "application/gzip" }), `${name}.epdgz`);
  form.append("thumbnail", thumbBlob, `${name}.jpg`);
  return { form, filename: `${name}.epdgz` };
}

async function frameError(resp) {
  return new Error((await resp.text()) || `the frame answered HTTP ${resp.status}`);
}

async function uploadOne(item) {
  item.status = "uploading";
  item.error = null;
  try {
    const album = appStore.selectedAlbum;
    const { form, filename } = await renderForDevice(item);
    const resp = await fetch(`/api/upload?album=${encodeURIComponent(album)}`, {
      method: "POST",
      body: form,
    });
    if (!resp.ok) throw await frameError(resp);
    const key = `${album}/${filename}`;
    // The frame has the new picture; replacing the old one and keeping the
    // original are follow-ups that should not undo a successful send.
    const warnings = [];
    try {
      await saveToLibrary(key, item);
    } catch (e) {
      warnings.push(`not editable later: ${e.message}`);
    }
    if (item.replaces && item.replaces !== key) {
      const del = await fetch("/api/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filepath: item.replaces }),
      }).catch(() => null);
      if (del?.ok)
        await libraryFetch(libraryUrl("item", item.replaces), { method: "DELETE" }).catch(
          () => null
        );
      else warnings.push(`the old version ${item.replaces} is still on the frame`);
    }
    item.replaces = key; // sending again replaces this version
    item.status = "done";
    if (warnings.length) item.error = `Sent, but ${warnings.join("; ")}.`;
  } catch (e) {
    item.status = "error";
    item.error = e.message;
  }
}

// Show the selected photo on the frame now, without saving it to an album.
const showing = ref(false);
async function showOnFrame(item) {
  await checkFrame();
  if (!frameAwake.value) return notify("The frame is asleep: press its button first.", "warning");
  showing.value = true;
  try {
    const { form } = await renderForDevice(item);
    const resp = await fetch("/api/display-image", { method: "POST", body: form });
    if (!resp.ok) throw await frameError(resp);
    notify("Shown on the frame (not saved to an album)", "success");
  } catch (e) {
    notify(`Could not show it: ${e.message}`, "error");
  } finally {
    showing.value = false;
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

let draggingSlider = false;

function onPreviewDown(event) {
  event.currentTarget.setPointerCapture(event.pointerId);
  if (!isManual.value || event.target.closest(".slider-handle")) {
    draggingSlider = true;
    slideTo(event);
  } else {
    onFrameDown(event);
  }
}

function onPreviewMove(event) {
  if (draggingSlider) slideTo(event);
  else if (isManual.value) onFrameMove(event);
}

function onPreviewUp(event) {
  draggingSlider = false;
  onFrameUp(event);
}

function onPreviewWheel(event) {
  if (!isManual.value) return;
  event.preventDefault();
  onFrameWheel(event);
}

// ---------- manual framing: drag to pan, wheel / pinch / slider to zoom ----------

const liveCanvas = ref(null);
const framing = ref(false); // true while the user is moving the photo
const pointers = new Map();
let pinchStart = null;
let framingTimer = null;
let framingPending = false; // the user moved the photo within the last 500 ms
let liveFrame = 0;

// How much the visible part of the photo is stretched on the panel: above 1,
// the panel has more pixels there than the photo does.
const upscale = computed(() => {
  const item = selected.value;
  if (!item?.natural || !item.work) return 0;
  const { width, height } = frameSize.value;
  const { w, h } = item.natural;
  const mode = effectiveMode(item);
  const zoom =
    mode === "crop"
      ? coverZoom(item.work, width, height)
      : mode === "manual"
        ? (item.view?.zoom ?? 1)
        : 1;
  return Math.min(width / w, height / h) * zoom;
});

// ---------- AI upscale of the visible part (cachypc/upscale/server.py) ----------

const UPSCALE_FROM = 1.5; // offer it only when the photo is stretched more than this
const upscaling = ref(false);
const upscaleError = ref(null);

// The part of the photo that is visible in the frame, in source pixels.
function visibleRegion(item) {
  const { width: W, height: H } = frameSize.value;
  const { w, h } = item.natural;
  const mode = effectiveMode(item);
  const view =
    mode === "manual"
      ? clampView(item.work, W, H, item.view)
      : { zoom: mode === "crop" ? coverZoom(item.work, W, H) : 1, u: 0.5, v: 0.5 };
  const scale = Math.min(W / w, H / h) * view.zoom; // frame px per source px
  const x = W / 2 - view.u * w * scale;
  const y = H / 2 - view.v * h * scale;
  const x0 = Math.max(0, -x / scale);
  const y0 = Math.max(0, -y / scale);
  const x1 = Math.min(w, (W - x) / scale);
  const y1 = Math.min(h, (H - y) / scale);
  return { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) };
}

async function aiUpscale(item) {
  upscaling.value = true;
  upscaleError.value = null;
  try {
    const r = visibleRegion(item);
    const src = await createImageBitmap(item.file, { imageOrientation: "from-image" });
    const crop = document.createElement("canvas");
    crop.width = r.w;
    crop.height = r.h;
    crop.getContext("2d").drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    src.close();
    const body = await new Promise((res) => crop.toBlob(res, "image/png"));
    let resp;
    try {
      resp = await fetch("/upscale", { method: "POST", body });
    } catch {
      // The preview proxy drops the connection when nothing listens on 18087.
      throw new Error(
        "The upscale service on cachypc is not reachable. Start it: " +
          "python3 ~/development/esp32-photoframe/cachypc/upscale/server.py"
      );
    }
    if (!resp.ok) {
      let message = `HTTP ${resp.status}`;
      try {
        message = (await resp.json()).error || message;
      } catch {
        message = `The upscale service answered HTTP ${resp.status} without details.`;
      }
      throw new Error(message);
    }
    const blob = await resp.blob();
    // The upscaled region becomes the photo; keep what is needed to undo.
    item.beforeUpscale ??= { file: item.file, mode: item.mode, view: item.view };
    item.file = new File([blob], item.name.replace(/\.[^.]+$/, "") + "-upscaled.png", {
      type: "image/png",
    });
    item.full = null;
    item.work = await decode(item.file, WORK_MAX_DIM, (w, h) => (item.natural = { w, h }));
    item.mode = "manual";
    item.view = { zoom: 1, u: 0.5, v: 0.5 };
    refresh(item);
    notify(`AI upscale done: ${r.w}×${r.h} → ${r.w * 4}×${r.h * 4}`, "success");
  } catch (e) {
    upscaleError.value = e.message;
  } finally {
    upscaling.value = false;
  }
}

async function undoUpscale(item) {
  const b = item.beforeUpscale;
  if (!b) return;
  item.file = b.file;
  item.mode = b.mode;
  item.view = b.view;
  item.beforeUpscale = null;
  item.full = null;
  item.work = await decode(item.file, WORK_MAX_DIM, (w, h) => (item.natural = { w, h }));
  upscaleError.value = null;
  refresh(item);
}

watch(selectedId, () => (upscaleError.value = null));

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
    // Resizing a canvas clears it; only do it when the size really changes.
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    }
    canvas.getContext("2d").drawImage(frame, 0, 0);
  });
}

function updateView(patch) {
  const item = selected.value;
  const { width, height } = frameSize.value;
  item.view = clampView(item.work, width, height, { ...item.view, ...patch });
  framing.value = true;
  framingPending = true;
  nextTick(drawLive);
  clearTimeout(framingTimer);
  framingTimer = setTimeout(() => {
    framingPending = false;
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

// ---------- storage (moved here from ImageUpload.vue) and settings persistence ----------

const showFormatConfirm = ref(false);
const formatting = ref(false);
const savingDefaults = ref(false);
const snackbar = ref({ show: false, text: "", color: "info" });

function notify(text, color = "info") {
  snackbar.value = { show: true, text, color };
}

const hasStorage = computed(
  () =>
    (appStore.systemInfo.sdcard_inserted || appStore.systemInfo.has_flash_storage) &&
    appStore.systemInfo.storage_total > 0
);
const storageUsedPercent = computed(() =>
  Math.round(
    ((appStore.systemInfo.storage_used || 0) / (appStore.systemInfo.storage_total || 1)) * 100
  )
);
const storageColor = computed(() =>
  storageUsedPercent.value > 90 ? "error" : storageUsedPercent.value > 75 ? "warning" : "success"
);
const mb = (bytes) => ((bytes || 0) / 1048576).toFixed(1) + " MB";

async function formatStorage() {
  formatting.value = true;
  try {
    const response = await fetch("/api/format-storage", { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    notify("Storage formatted", "success");
    await appStore.loadSystemInfo();
    await appStore.loadImages(appStore.selectedAlbum);
  } catch (error) {
    notify(`Format failed: ${error.message}`, "error");
  } finally {
    formatting.value = false;
    showFormatConfirm.value = false;
  }
}

// Shared processing settings are stored on the frame (Settings had a Processing
// tab for this; in the cachypc build it lives here).
async function saveDefaults() {
  savingDefaults.value = true;
  try {
    if (!(await settingsStore.saveSettings())) throw new Error("the frame did not accept them");
    notify("Saved as the frame's default processing", "success");
  } catch (error) {
    notify(`Could not save: ${error.message}`, "error");
  } finally {
    savingDefaults.value = false;
  }
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
      <template v-if="hasStorage">
        <v-icon
          :icon="appStore.systemInfo.sdcard_inserted ? 'mdi-sd' : 'mdi-database'"
          size="small"
        />
        <span class="text-body-2 text-medium-emphasis">
          {{ mb(appStore.systemInfo.storage_used) }} / {{ mb(appStore.systemInfo.storage_total) }}
        </span>
        <v-chip size="x-small" :color="storageColor" variant="flat" class="text-white">
          {{ storageUsedPercent }}%
        </v-chip>
        <v-btn
          icon="mdi-delete-sweep"
          size="x-small"
          variant="text"
          title="Format storage"
          @click="showFormatConfirm = true"
        />
      </template>
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
              class="compare"
              :class="{ framing: isManual }"
              :style="{ aspectRatio: frameSize.width / frameSize.height }"
              @pointerdown.prevent="onPreviewDown"
              @pointermove="onPreviewMove"
              @pointerup="onPreviewUp"
              @pointercancel="onPreviewUp"
              @wheel="onPreviewWheel"
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
              </template>
              <canvas v-show="isManual && framing" ref="liveCanvas" class="compare-img" />
              <div
                v-if="preview.original"
                v-show="!(isManual && framing)"
                class="slider-line"
                :style="{ left: `${sliderPosition}%` }"
              >
                <div class="slider-handle" title="Drag to compare">
                  <v-icon size="small">mdi-arrow-left-right</v-icon>
                </div>
              </div>
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
              <span class="text-caption text-grey ml-2"
                >drag to move · wheel or pinch to zoom · drag ↔ to compare</span
              >
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
                size="small"
                variant="tonal"
                prepend-icon="mdi-monitor-eye"
                :loading="showing"
                :disabled="!frameAwake || selected.status === 'reading'"
                title="Show this photo on the frame now, without saving it to an album"
                @click="showOnFrame(selected)"
              >
                Show
              </v-btn>
              <v-btn
                icon="mdi-delete"
                size="small"
                variant="text"
                :disabled="selected.status === 'uploading'"
                @click="remove(selected)"
              />
            </div>
            <div v-if="selected.replaces" class="text-caption text-medium-emphasis mb-2">
              Editing {{ selected.replaces }} — sending replaces it on the frame.
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
                <v-btn
                  v-if="dateValue(selected)"
                  size="x-small"
                  variant="text"
                  title="No date on the frame"
                  @click="setDate(selected, '')"
                  >none</v-btn
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
                <v-btn
                  v-if="placeValue(selected)"
                  size="x-small"
                  variant="text"
                  title="No place on the frame"
                  @click="setPlace(selected, '')"
                  >none</v-btn
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

            <div class="text-caption text-medium-emphasis mt-4 mb-1">Framing</div>
            <div class="d-flex align-center flex-wrap ga-2">
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
              <v-chip
                v-if="upscale > 1.05"
                size="small"
                :color="upscale > 2 ? 'warning' : undefined"
                variant="tonal"
                :title="`The visible part of the photo has fewer pixels than the panel: it is stretched ${upscale.toFixed(1)}×`"
              >
                stretched ×{{ upscale.toFixed(1) }}
              </v-chip>
            </div>
            <div
              v-if="upscale > UPSCALE_FROM || selected.beforeUpscale"
              class="d-flex align-center flex-wrap ga-2 mt-2"
            >
              <v-btn
                v-if="upscale > UPSCALE_FROM"
                size="small"
                variant="tonal"
                prepend-icon="mdi-auto-fix"
                :loading="upscaling"
                title="4x-UltraSharp on the cachypc GPU, only the visible part"
                @click="aiUpscale(selected)"
              >
                AI upscale
              </v-btn>
              <v-btn
                v-if="selected.beforeUpscale"
                size="small"
                variant="text"
                prepend-icon="mdi-undo"
                :disabled="upscaling"
                @click="undoUpscale(selected)"
              >
                Undo upscale
              </v-btn>
            </div>
            <v-alert
              v-if="upscaleError"
              type="error"
              variant="tonal"
              density="compact"
              class="mt-2 text-body-2"
              closable
              title="AI upscale not done"
              :text="upscaleError"
              @click:close="upscaleError = null"
            />

            <div class="d-flex align-center mt-4 mb-1">
              <span class="text-caption text-medium-emphasis">Look</span>
              <v-spacer />
              <v-btn-toggle
                :model-value="selected.params ? 'own' : 'shared'"
                mandatory
                density="compact"
                variant="text"
                divided
                @update:model-value="setOwnSettings(selected, $event === 'own')"
              >
                <v-btn value="own" size="x-small" title="Settings for this photo only"
                  >this photo</v-btn
                >
                <v-btn value="shared" size="x-small" title="Shared settings for all photos"
                  >all photos</v-btn
                >
              </v-btn-toggle>
            </div>
            <div class="d-flex flex-wrap ga-1">
              <v-btn
                v-for="p in PRESETS"
                :key="p.value"
                size="small"
                :variant="currentPreset(selected) === p.value ? 'flat' : 'outlined'"
                :color="currentPreset(selected) === p.value ? 'primary' : undefined"
                :title="p.description"
                @click="choosePreset(selected, p.value)"
              >
                {{ p.title }}
              </v-btn>
              <v-chip v-if="currentPreset(selected) === 'custom'" size="small" variant="tonal"
                >custom</v-chip
              >
            </div>
            <div class="text-caption text-grey mt-1">
              {{
                selected.params
                  ? "Applies to this photo only."
                  : "Shared by every photo without its own settings."
              }}
            </div>
            <v-btn
              v-if="!selected.params"
              variant="tonal"
              size="small"
              class="mt-2"
              prepend-icon="mdi-content-save"
              :loading="savingDefaults"
              :disabled="!frameAwake"
              @click="saveDefaults"
            >
              Save as the frame's default
            </v-btn>
          </v-col>

          <v-col cols="12" class="pt-0">
            <v-expansion-panels variant="accordion">
              <v-expansion-panel>
                <v-expansion-panel-title>
                  Advanced: tone, colour matching, dithering
                  <span class="text-caption text-grey ml-2">
                    ({{ selected.params ? "this photo" : "all photos" }})
                  </span>
                </v-expansion-panel-title>
                <v-expansion-panel-text>
                  <ProcessingControls
                    :params="itemParams(selected)"
                    :preset="currentPreset(selected)"
                    hide-preset
                    hide-layout
                    @update:params="onParamsUpdate"
                    @update:preset="onPresetUpdate"
                    @preset-change="onPresetChange"
                  />
                </v-expansion-panel-text>
              </v-expansion-panel>
            </v-expansion-panels>
          </v-col>
        </v-row>
      </template>
    </v-card-text>
    <v-dialog v-model="showFormatConfirm" max-width="400">
      <v-card>
        <v-card-title>Format Storage</v-card-title>
        <v-card-text>
          This will erase all images
          {{ appStore.systemInfo.sdcard_inserted ? "on the SD card" : "on internal storage" }}. This
          action cannot be undone.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="showFormatConfirm = false">Cancel</v-btn>
          <v-btn color="error" :loading="formatting" @click="formatStorage">Format</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snackbar.show" :color="snackbar.color" :timeout="4000">
      {{ snackbar.text }}
    </v-snackbar>
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
  pointer-events: auto;
  cursor: ew-resize;
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
