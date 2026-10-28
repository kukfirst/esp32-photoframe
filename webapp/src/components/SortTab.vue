<script setup>
// Sort tab (cachypc fork): pick a trip folder on this computer, read places
// from its name, group photos by time, find people, pre-check the good ones,
// then send the checked ones to the Photos editor. Nothing is uploaded here.
import { computed, onBeforeUnmount, reactive, ref } from "vue";
import {
  assignPlaces,
  buildIndex,
  matchToken,
  nearestCity,
  parseFolderName,
  placeLabel,
  timeGroups,
} from "../utils/folderPlaces";
import {
  clusterFaces,
  createFacePool,
  exifGps,
  exifTime,
  isGoodFace,
  markBursts,
  preselect,
  scorePhoto,
} from "../utils/sortAnalysis";
import { importRequest } from "../utils/editRequest";

const emit = defineEmits(["sent"]);

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const POOL_SIZE = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));

const folders = ref([]);
const people = ref([]);
const progress = reactive({
  active: false,
  stage: "",
  done: 0,
  total: 0,
  current: "",
  started: 0,
  error: null,
});
const filter = ref("all");
const hideDups = ref(true);
const folderInput = ref(null);
const tagDialog = ref(false);
const clusters = ref([]);
const snackbar = ref({ show: false, text: "", color: "info" });
let index = null;
let pool = null;
let nextId = 1;

const notify = (text, color = "info") => (snackbar.value = { show: true, text, color });

onBeforeUnmount(() => {
  pool?.terminate();
  for (const f of folders.value)
    for (const p of f.photos) if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
});

// ---------- progress ----------

const eta = computed(() => {
  if (!progress.done || progress.stage !== "analyse") return "";
  const per = (Date.now() - progress.started) / progress.done;
  const left = Math.round((per * (progress.total - progress.done)) / 1000);
  return left > 90 ? `~${Math.round(left / 60)} min left` : `~${left} s left`;
});

function stage(name, total = 0) {
  Object.assign(progress, {
    active: true,
    stage: name,
    done: 0,
    total,
    current: "",
    started: Date.now(),
    error: null,
  });
}

const STAGE_LABEL = {
  list: "Reading the folder list",
  places: "Loading place names (≈2 MB, once)",
  models: "Loading face models (≈16 MB, once)",
  names: "Reading places from folder names",
  analyse: "Analysing photos",
  done: "Done",
};

// ---------- data from cachypc ----------

async function fetchOrExplain(url, what) {
  let resp;
  try {
    resp = await fetch(url);
  } catch {
    throw new Error(
      `${what}: the cachypc helper service is not reachable (cachypc/upscale/server.py).`
    );
  }
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      msg = (await resp.json()).error || msg;
    } catch {
      /* keep the status */
    }
    throw new Error(`${what}: ${msg}`);
  }
  return resp;
}

async function ensureIndex() {
  if (index) return;
  stage("places");
  const gaz = await (await fetchOrExplain("/sortdata/gazetteer.json", "Place names")).json();
  index = buildIndex(gaz);
}

async function ensurePool() {
  if (pool) return;
  stage("models");
  pool = createFacePool(POOL_SIZE, { modelBase: "/sortdata/", wasmBase: "/ort/" });
  await pool.init();
}

async function loadPeople() {
  const data = await (await fetchOrExplain("/faces", "People")).json();
  people.value = (data.people || []).map((p) => ({
    ...p,
    embeddings: p.embeddings.map((e) => Float32Array.from(e)),
  }));
}

// ---------- places ----------

let lastNominatim = 0;
async function searchOsm(token) {
  const key = `cachypc.osm:${token.toLowerCase()}`;
  try {
    const cached = localStorage.getItem(key);
    if (cached) return JSON.parse(cached);
  } catch {
    /* no storage */
  }
  const wait = 1000 - (Date.now() - lastNominatim);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({
      q: token,
      format: "jsonv2",
      limit: 3,
      addressdetails: 1,
      "accept-language": "en",
    });
  try {
    const rows = await (await fetch(url)).json();
    // The matched feature's own name ("Santorini"), not the municipality around it.
    const seen = new Set();
    const places = rows
      .map((r) => {
        const a = r.address || {};
        const name = r.name || a.city || a.town || a.village || a.country;
        const kind = name === a.country ? "country" : "city";
        return {
          kind,
          name,
          country: a.country,
          cc: (a.country_code || "").toUpperCase(),
          osm: true,
        };
      })
      .filter((pl) => {
        const id = placeLabel(pl);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    try {
      localStorage.setItem(key, JSON.stringify(places));
    } catch {
      /* no storage */
    }
    return places;
  } catch {
    return [];
  }
}

async function readFolderPlaces(folder) {
  for (const tok of folder.tokens) {
    const m = matchToken(index, tok.text);
    let options = m.places;
    if (!m.exact) {
      // Islands and small places are not in the city list; ask OpenStreetMap.
      const osm = await searchOsm(tok.text);
      options = [...osm, ...options];
    }
    tok.options = options.map((p) => ({
      title: placeLabel(p) + (p.osm ? " (OSM)" : ""),
      value: placeLabel(p),
      place: p,
    }));
    tok.choice = tok.options[0]?.value ?? null;
    tok.certain = m.exact;
  }
}

/** Place label for a group: the folder's chosen place for that position. */
function folderPlaceChoices(folder) {
  const labels = folder.tokens.map((t) => t.choice).filter(Boolean);
  const countries = new Set(
    folder.tokens
      .map((t) => t.options.find((o) => o.value === t.choice)?.place.country)
      .filter(Boolean)
  );
  // All places in one country: offer the country as well.
  if (countries.size === 1 && labels.length > 1) labels.push([...countries][0]);
  return [...new Set(labels)];
}

function applyGroupPlaces(folder) {
  const choices = folder.tokens.map((t) => t.choice).filter(Boolean);
  const idx = assignPlaces(folder.groups.length, choices.length);
  folder.groups.forEach((g, i) => {
    g.place = idx[i] === null ? "" : choices[idx[i]];
  });
}

function photoPlace(photo, group) {
  if (photo.gpsPlace) return { label: photo.gpsPlace, source: "GPS" };
  return { label: group.place || "", source: group.place ? "folder" : "" };
}

// ---------- analysis ----------

async function onFolderPicked(event) {
  const files = Array.from(event.target.files || []).filter((f) => IMAGE_RE.test(f.name));
  event.target.value = "";
  if (!files.length) return notify("No photos (JPEG/PNG/WebP) in that folder.", "warning");
  try {
    stage("list");
    const byDir = new Map();
    for (const f of files) {
      const rel = f.webkitRelativePath || f.name;
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "(folder)";
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(f);
    }
    await ensureIndex();
    await loadPeople();
    await ensurePool();

    stage("names", byDir.size);
    const newFolders = [];
    for (const [dir, list] of byDir) {
      const name = dir.split("/").pop();
      progress.current = name;
      const parsed = parseFolderName(name);
      const folder = reactive({
        id: nextId++,
        dir,
        name,
        year: parsed.year,
        month: parsed.month,
        tokens: parsed.tokens.map((text) => ({ text, options: [], choice: null, certain: false })),
        photos: list
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((file) => ({
            id: nextId++,
            file,
            name: file.name,
            status: "waiting",
            faces: [],
            checked: false,
          })),
        groups: [],
        analysed: false,
      });
      await readFolderPlaces(folder);
      newFolders.push(folder);
      progress.done++;
    }
    folders.value = [...newFolders, ...folders.value];

    const all = newFolders.flatMap((f) => f.photos);
    stage("analyse", all.length);
    let next = 0;
    const runWorker = async (w) => {
      while (next < all.length) {
        const photo = all[next++];
        progress.current = photo.name;
        try {
          const r = await pool.analyse(w, photo.file);
          Object.assign(photo, {
            status: "done",
            width: r.width,
            height: r.height,
            faces: r.faces,
            hash: r.hash,
            time: exifTime(r.exif.dateTag),
            gps: exifGps(r.exif),
            thumbUrl: URL.createObjectURL(r.thumb),
          });
          if (photo.gps) photo.gpsPlace = placeLabel(nearestCity(index, photo.gps));
          Object.assign(photo, scorePhoto(photo, people.value));
        } catch (e) {
          photo.status = "error";
          photo.error = e.message;
        }
        progress.done++;
      }
    };
    await Promise.all(Array.from({ length: pool.size }, (_, w) => runWorker(w)));

    for (const folder of newFolders) finishFolder(folder);
    progress.stage = "done";
    progress.current = "";
    const checked = all.filter((p) => p.checked).length;
    notify(`${all.length} photos analysed, ${checked} pre-checked.`, "success");
  } catch (e) {
    progress.error = e.message;
  } finally {
    progress.active = false;
  }
}

function finishFolder(folder) {
  const byTime = [...folder.photos].sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
  markBursts(byTime.filter((p) => p.status === "done"));
  folder.groups = timeGroups(byTime).map((photos, i) =>
    reactive({ id: `${folder.id}-${i}`, photos, place: "" })
  );
  applyGroupPlaces(folder);
  for (const p of folder.photos)
    p.checked = p.status === "done" && !p.dupOf && preselect(p, people.value.length);
  sortGroups(folder);
  folder.analysed = true;
}

// Checked first, then by time. Re-sorted on demand, not on every click.
function sortGroups(folder) {
  for (const g of folder.groups) {
    g.photos.sort((a, b) => Number(b.checked) - Number(a.checked) || (a.time ?? 0) - (b.time ?? 0));
  }
}

function rescore() {
  for (const folder of folders.value) {
    for (const p of folder.photos)
      if (p.status === "done") Object.assign(p, scorePhoto(p, people.value));
    finishFolder(folder);
  }
}

// ---------- view ----------

function visible(photo) {
  if (hideDups.value && photo.dupOf) return false;
  if (filter.value === "people") return photo.good > 0;
  if (filter.value === "us") return photo.us;
  if (filter.value === "checked") return photo.checked;
  return true;
}

const checkedPhotos = computed(() =>
  folders.value.flatMap((f) =>
    f.groups.flatMap((g) => g.photos.filter((p) => p.checked).map((p) => ({ p, g, f })))
  )
);

function setGroupChecked(group, value) {
  for (const p of group.photos) if (visible(p)) p.checked = value;
}

function folderDate(folder) {
  if (!folder.year) return "";
  if (!folder.month) return `≈${folder.year}`;
  return new Date(folder.year, folder.month - 1, 1).toLocaleDateString(navigator.language || "en", {
    month: "short",
    year: "numeric",
  });
}

// Union of the good faces, normalised: the editor crops around it.
function faceBox(p) {
  const good = (p.faces || []).filter(isGoodFace);
  if (!good.length) return null;
  return [
    Math.min(...good.map((f) => f.box[0])),
    Math.min(...good.map((f) => f.box[1])),
    Math.max(...good.map((f) => f.box[2])),
    Math.max(...good.map((f) => f.box[3])),
  ];
}

function sendChecked() {
  const entries = checkedPhotos.value.map(({ p, g, f }) => ({
    file: p.file,
    faceBox: faceBox(p),
    place: photoPlace(p, g).label,
    dateFallback: p.time ? null : folderDate(f),
  }));
  if (!entries.length) return;
  importRequest.value = entries;
  for (const { p } of checkedPhotos.value) p.sent = true;
  emit("sent");
}

// ---------- tagging people ----------

async function cropFace({ photo, face }) {
  const img = new Image();
  img.src = photo.thumbUrl;
  await img.decode();
  const [x0, y0, x1, y1] = face.box;
  const pad = 0.25;
  const w = (x1 - x0) * img.width;
  const h = (y1 - y0) * img.height;
  const side = Math.max(w, h) * (1 + 2 * pad);
  const cx = ((x0 + x1) / 2) * img.width;
  const cy = ((y0 + y1) / 2) * img.height;
  const c = document.createElement("canvas");
  c.width = c.height = 96;
  c.getContext("2d").drawImage(img, cx - side / 2, cy - side / 2, side, side, 0, 0, 96, 96);
  return c.toDataURL("image/jpeg", 0.85);
}

async function openTagging() {
  const photos = folders.value.flatMap((f) => f.photos.filter((p) => p.status === "done"));
  const found = clusterFaces(photos)
    .filter((c) => c.members.length >= 2)
    .slice(0, 8);
  clusters.value = await Promise.all(
    found.map(async (c) => ({
      ...c,
      name: "",
      saved: null,
      crops: await Promise.all(c.members.slice(0, 6).map(cropFace)),
    }))
  );
  tagDialog.value = true;
}

async function savePerson(cluster) {
  const name = cluster.name.trim();
  if (!name) return;
  const embeddings = cluster.members.slice(0, 12).map((m) => Array.from(m.face.embedding));
  const existing = people.value.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const list = people.value.map((p) => ({
    ...p,
    embeddings: p.embeddings.map((e) => Array.from(e)),
  }));
  if (existing) {
    list.find((p) => p.id === existing.id).embeddings.push(...embeddings);
  } else {
    list.push({ id: `p${Date.now()}`, name, embeddings });
  }
  try {
    const resp = await fetch("/faces", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ people: list }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await loadPeople();
    cluster.saved = name;
    rescore();
    notify(`Saved ${name}. Photos re-scored.`, "success");
  } catch (e) {
    notify(`Could not save ${name}: ${e.message}`, "error");
  }
}

async function forgetPerson(person) {
  const list = people.value
    .filter((p) => p.id !== person.id)
    .map((p) => ({ ...p, embeddings: p.embeddings.map((e) => Array.from(e)) }));
  await fetch("/faces", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ people: list }),
  });
  await loadPeople();
  rescore();
}

loadPeople().catch(() => {});

// Why a photo is (not) pre-checked: each face's size, sharpness and verdict.
function tileTitle(p) {
  if (p.error) return `${p.name} — ${p.error}`;
  const faces = (p.faces || []).map((f) => {
    const size = Math.round((f.box[3] - f.box[1]) * 100);
    const who = f.person ? ` ${personName(f.person)}` : "";
    const ok = isGoodFace(f) ? " ✓" : "";
    return `${size}% tall, sharpness ${Math.round(f.sharpness)}, conf ${f.score.toFixed(2)}${ok}${who}`;
  });
  return [p.name, p.gpsPlace && `GPS: ${p.gpsPlace}`, ...faces].filter(Boolean).join("\n");
}

const personName = (id) => people.value.find((p) => p.id === id)?.name ?? "?";
</script>

<template>
  <v-card>
    <v-card-title class="d-flex align-center flex-wrap ga-2">
      <v-icon icon="mdi-folder-search" class="mr-1" />
      Sort a folder
      <v-spacer />
      <v-btn
        v-if="checkedPhotos.length"
        color="primary"
        variant="flat"
        prepend-icon="mdi-arrow-right"
        @click="sendChecked"
      >
        Send {{ checkedPhotos.length }} checked to Photos
      </v-btn>
    </v-card-title>

    <v-card-text>
      <input
        ref="folderInput"
        type="file"
        webkitdirectory
        multiple
        style="display: none"
        @change="onFolderPicked"
      />
      <div class="d-flex align-center flex-wrap ga-3 mb-3">
        <v-btn
          prepend-icon="mdi-folder-open"
          :disabled="progress.active"
          @click="folderInput?.click()"
        >
          Choose a folder
        </v-btn>
        <span class="text-caption text-grey">
          Read on this computer — nothing is uploaded until you send photos to the editor.
        </span>
      </div>

      <!-- Progress: always say what is happening -->
      <v-alert
        v-if="progress.error"
        type="error"
        variant="tonal"
        class="mb-3"
        closable
        :title="'Analysis stopped'"
        :text="progress.error"
        @click:close="progress.error = null"
      />
      <v-sheet v-if="progress.active" rounded border class="pa-3 mb-3">
        <div class="d-flex align-center ga-2 mb-2">
          <v-progress-circular indeterminate size="18" width="2" />
          <strong>{{ STAGE_LABEL[progress.stage] }}</strong>
          <span v-if="progress.total" class="text-medium-emphasis">
            {{ progress.done }} / {{ progress.total }}
          </span>
          <v-spacer />
          <span class="text-caption text-grey">{{ eta }}</span>
        </div>
        <v-progress-linear
          :model-value="progress.total ? (progress.done / progress.total) * 100 : undefined"
          :indeterminate="!progress.total"
          rounded
        />
        <div class="text-caption text-grey mt-1 text-truncate">{{ progress.current }}</div>
      </v-sheet>

      <!-- People -->
      <div class="d-flex align-center flex-wrap ga-2 mb-3">
        <span class="text-body-2">People:</span>
        <v-chip
          v-for="p in people"
          :key="p.id"
          size="small"
          closable
          @click:close="forgetPerson(p)"
        >
          {{ p.name }} · {{ p.embeddings.length }}
        </v-chip>
        <span v-if="!people.length" class="text-caption text-grey">
          none tagged yet — tag the two of you once, then "us" photos are found everywhere
        </span>
        <v-btn
          size="small"
          variant="tonal"
          prepend-icon="mdi-account-plus"
          :disabled="!folders.some((f) => f.analysed)"
          @click="openTagging"
        >
          Tag people
        </v-btn>
      </div>

      <div v-if="folders.length" class="d-flex align-center flex-wrap ga-3 mb-2">
        <v-chip-group v-model="filter" mandatory selected-class="text-primary">
          <v-chip value="all" size="small" variant="outlined">All</v-chip>
          <v-chip value="people" size="small" variant="outlined">With people</v-chip>
          <v-chip value="us" size="small" variant="outlined" :disabled="!people.length">Us</v-chip>
          <v-chip value="checked" size="small" variant="outlined">Checked</v-chip>
        </v-chip-group>
        <v-switch v-model="hideDups" label="Hide near-duplicates" density="compact" hide-details />
        <v-spacer />
        <v-btn
          size="small"
          variant="text"
          prepend-icon="mdi-sort"
          @click="folders.forEach(sortGroups)"
        >
          Checked first
        </v-btn>
      </div>

      <!-- Folders -->
      <v-card v-for="folder in folders" :key="folder.id" variant="outlined" class="mb-4">
        <v-card-title class="text-subtitle-1 d-flex align-center flex-wrap ga-2">
          <v-icon icon="mdi-folder" size="small" />
          {{ folder.name }}
          <span class="text-caption text-grey">
            {{ folder.photos.length }} photos ·
            {{ folder.photos.filter((p) => p.checked).length }} checked
          </span>
        </v-card-title>
        <v-card-text>
          <div class="d-flex flex-wrap ga-3 mb-3">
            <div v-for="(tok, i) in folder.tokens" :key="i" class="token">
              <v-select
                v-model="tok.choice"
                :items="tok.options"
                :label="`“${tok.text}”`"
                density="compact"
                hide-details
                variant="outlined"
                :prepend-inner-icon="
                  tok.certain ? 'mdi-map-marker-check' : 'mdi-map-marker-question'
                "
                :no-data-text="'Nothing found'"
                @update:model-value="applyGroupPlaces(folder)"
              />
            </div>
            <span v-if="!folder.tokens.length" class="text-caption text-grey"
              >No place in the folder name.</span
            >
          </div>

          <div v-for="group in folder.groups" :key="group.id" class="mb-4">
            <div class="d-flex align-center flex-wrap ga-2 mb-1">
              <span class="text-body-2">
                {{
                  group.photos[0]?.time
                    ? new Date(group.photos.find((p) => p.time)?.time).toLocaleDateString(
                        undefined,
                        {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        }
                      )
                    : "no date"
                }}
                · {{ group.photos.length }}
              </span>
              <v-combobox
                v-model="group.place"
                :items="folderPlaceChoices(folder)"
                density="compact"
                hide-details
                variant="underlined"
                placeholder="place for this group"
                class="group-place"
              />
              <v-btn size="x-small" variant="text" @click="setGroupChecked(group, true)"
                >check all</v-btn
              >
              <v-btn size="x-small" variant="text" @click="setGroupChecked(group, false)"
                >none</v-btn
              >
            </div>
            <div class="tiles">
              <div
                v-for="p in group.photos.filter(visible)"
                :key="p.id"
                class="tile"
                :class="{ checked: p.checked, sent: p.sent }"
                :title="tileTitle(p)"
                @click="p.checked = !p.checked"
              >
                <img v-if="p.thumbUrl" :src="p.thumbUrl" alt="" />
                <v-icon v-else-if="p.status === 'error'" icon="mdi-alert" color="error" />
                <v-progress-circular v-else indeterminate size="18" />
                <v-icon
                  class="tile-check"
                  :icon="p.checked ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline'"
                  :color="p.checked ? 'primary' : 'white'"
                  size="22"
                />
                <div class="tile-badges">
                  <span v-if="p.us" class="badge us">♥ us</span>
                  <span v-else-if="p.people?.length" class="badge">{{
                    p.people.map(personName).join(", ")
                  }}</span>
                  <span v-if="p.good" class="badge">👤{{ p.good }}</span>
                  <span v-if="p.burstSize > 1" class="badge" title="Best of a series"
                    >★{{ p.burstSize }}</span
                  >
                  <span v-if="p.gpsPlace" class="badge" :title="p.gpsPlace">📍</span>
                </div>
              </div>
            </div>
          </div>
        </v-card-text>
      </v-card>
    </v-card-text>

    <!-- Tag people -->
    <v-dialog v-model="tagDialog" max-width="760" scrollable>
      <v-card>
        <v-card-title>Who is who</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-3">
            Faces that look like the same person are grouped. Name the two of you; one name per
            group. Use the same name again to add more faces to a person.
          </p>
          <div v-for="(c, i) in clusters" :key="i" class="d-flex align-center flex-wrap ga-2 mb-3">
            <img v-for="(src, j) in c.crops" :key="j" class="face" :src="src" alt="" />
            <span class="text-caption text-grey">×{{ c.members.length }}</span>
            <v-combobox
              v-model="c.name"
              :items="people.map((p) => p.name)"
              density="compact"
              hide-details
              placeholder="name"
              style="max-width: 180px"
            />
            <v-btn size="small" variant="tonal" :disabled="!c.name" @click="savePerson(c)">
              {{ c.saved ? "Saved ✓" : "Save" }}
            </v-btn>
          </div>
          <div v-if="!clusters.length" class="text-body-2 text-grey">
            No face seen twice yet. Analyse a folder with photos of you first.
          </div>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="tagDialog = false">Close</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snackbar.show" :color="snackbar.color" :timeout="5000">
      {{ snackbar.text }}
    </v-snackbar>
  </v-card>
</template>

<style scoped>
.token {
  min-width: 220px;
}
.group-place {
  max-width: 260px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 6px;
}
.tile {
  position: relative;
  aspect-ratio: 4 / 3;
  background: rgba(0, 0, 0, 0.06);
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  outline: 3px solid transparent;
  outline-offset: -3px;
}
.tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.tile:not(.checked) img {
  opacity: 0.55;
}
.tile.checked {
  outline-color: rgb(var(--v-theme-primary));
}
.tile.sent::after {
  content: "sent";
  position: absolute;
  bottom: 4px;
  left: 4px;
  font-size: 11px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  padding: 0 4px;
  border-radius: 3px;
}
.tile-check {
  position: absolute;
  top: 4px;
  left: 4px;
  filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.6));
}
.tile-badges {
  position: absolute;
  right: 4px;
  bottom: 4px;
  display: flex;
  gap: 3px;
}
.badge {
  font-size: 11px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  padding: 0 4px;
  border-radius: 3px;
}
.badge.us {
  background: rgb(var(--v-theme-primary));
}
.face {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background-color: #ddd;
}
</style>
