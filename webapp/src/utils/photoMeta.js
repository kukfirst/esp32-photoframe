// Capture date and place for a photo: the earliest plausible date across EXIF,
// file name and the client-side mtime, and a place name from EXIF GPS.

const MIN_YEAR = 1826; // first surviving photograph

// Defaults a camera writes after its clock was reset; "earliest wins" would
// always pick them.
const CLOCK_RESET_DAYS = new Set(["1970-01-01", "1980-01-01", "2000-01-01", "2001-01-01"]);

// Names that carry the date the file was SAVED, not taken (Telegram Desktop).
// For these the file mtime is the download time too.
const DOWNLOAD_NAME_PATTERNS = [/^photo_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/];

const NAME_PATTERNS = [
  // IMG_20190704_153012, PXL_20230101_101010123, Screenshot_20200102-030405
  /(?<!\d)(?<y>(?:19|20)\d{2})(?<m>\d{2})(?<d>\d{2})[_-](?<H>\d{2})(?<M>\d{2})(?<S>\d{2})/,
  // WhatsApp Image 2019-07-04 at 15.30.12, 2019-07-04 15-30-12, 2019-07-04
  /(?<!\d)(?<y>(?:19|20)\d{2})-(?<m>\d{2})-(?<d>\d{2})(?:(?: at |[ _T])(?<H>\d{2})[.:-](?<M>\d{2})[.:-](?<S>\d{2}))?/,
  // IMG-20190704-WA0001, bare 20190704
  /(?<!\d)(?<y>(?:19|20)\d{2})(?<m>\d{2})(?<d>\d{2})(?!\d)/,
];

const EXIF_DATE_TAGS = ["DateTimeOriginal", "DateTimeDigitized", "DateTime"];

function stem(filename) {
  return filename.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
}

function isDownloadName(filename) {
  return DOWNLOAD_NAME_PATTERNS.some((p) => p.test(stem(filename)));
}

// Local wall-clock date without a timezone shift.
function makeDate(y, m, d, H = 0, M = 0, S = 0) {
  const dt = new Date(y, m - 1, d, H, M, S);
  // Reject roll-overs such as month 13 or day 32.
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

function dayKey(dt) {
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

export function isPlausible(dt, now = new Date()) {
  if (!dt || Number.isNaN(dt.getTime())) return false;
  if (CLOCK_RESET_DAYS.has(dayKey(dt))) return false;
  return dt.getFullYear() >= MIN_YEAR && dt <= now;
}

export function exifDates(tags) {
  const out = [];
  for (const name of EXIF_DATE_TAGS) {
    const raw = tags?.[name]?.description;
    const m =
      typeof raw === "string" &&
      raw.trim().match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!m) continue;
    const dt = makeDate(...m.slice(1).map(Number));
    if (dt) out.push({ source: `exif:${name}`, value: dt });
  }
  return out;
}

export function nameDates(filename) {
  if (isDownloadName(filename)) return [];
  const s = stem(filename);
  for (const pattern of NAME_PATTERNS) {
    const g = s.match(pattern)?.groups;
    if (!g) continue;
    const dt = makeDate(+g.y, +g.m, +g.d, +(g.H ?? 0), +(g.M ?? 0), +(g.S ?? 0));
    if (dt) return [{ source: "filename", value: dt }];
  }
  return [];
}

export function collectDates(tags, filename, lastModifiedMs) {
  const found = [...exifDates(tags), ...nameDates(filename)];
  // The browser's File.lastModified is the client mtime. It never counts for
  // download-named files: there it is the download time as well.
  if (lastModifiedMs && !isDownloadName(filename)) {
    found.push({ source: "file:lastModified", value: new Date(lastModifiedMs) });
  }
  return found;
}

export function pickDate(candidates, now = new Date()) {
  const good = candidates.filter((c) => isPlausible(c.value, now));
  if (!good.length) return null;
  return good.reduce((a, b) => (b.value < a.value ? b : a));
}

export function gpsFromTags(tags) {
  const lat = Number(tags?.GPSLatitude?.description);
  const lon = Number(tags?.GPSLongitude?.description);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  const latRef = String(
    tags?.GPSLatitudeRef?.value?.[0] ?? tags?.GPSLatitudeRef?.description ?? "N"
  );
  const lonRef = String(
    tags?.GPSLongitudeRef?.value?.[0] ?? tags?.GPSLongitudeRef?.description ?? "E"
  );
  return {
    lat: latRef.startsWith("S") ? -Math.abs(lat) : Math.abs(lat),
    lon: lonRef.startsWith("W") ? -Math.abs(lon) : Math.abs(lon),
  };
}

export function formatDate(dt, locale) {
  return dt.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

// Nominatim reverse geocoding: at most 1 request per second, cached per ~1 km
// cell in localStorage so a re-opened batch does not query again.
const GEOCODE_CACHE_KEY = "cachypc.geocodeCache";
let lastGeocode = 0;
let geocodeChain = Promise.resolve();

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage unavailable: the cache is a convenience only.
  }
}

export function reverseGeocode({ lat, lon }, language) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${language}`;
  const cached = readCache()[key];
  if (cached !== undefined) return Promise.resolve(cached);
  const job = geocodeChain.then(async () => {
    const wait = 1000 - (Date.now() - lastGeocode);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeocode = Date.now();
    const url =
      "https://nominatim.openstreetmap.org/reverse?" +
      new URLSearchParams({ lat, lon, format: "jsonv2", zoom: 10, "accept-language": language });
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const addr = (await resp.json()).address || {};
      const town = ["city", "town", "village", "municipality", "county", "state"]
        .map((k) => addr[k])
        .find(Boolean);
      const name = [town, addr.country].filter(Boolean).join(", ") || null;
      const cache = readCache();
      cache[key] = name;
      writeCache(cache);
      return name;
    } catch {
      return null;
    }
  });
  geocodeChain = job.catch(() => null);
  return job;
}
