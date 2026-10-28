// Folder names like "2011.09 Finnland-Netherland-Vienna" -> date + places,
// matched fuzzily against a GeoNames gazetteer and localized country names.

const COUNTRY_LANGS = ["en", "de", "ru", "fr", "it", "es", "nl", "pl", "cs", "fi", "sv"];

export function normalize(s) {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .trim();
}

/** "2011.09 Finnland-Netherland-Vienna" -> { year, month, tokens } (null date if absent). */
export function parseFolderName(name) {
  const m = name.match(/^\s*(\d{4})(?:[._-](\d{1,2}))?(?:[._-]\d{1,2})?\s*(.*)$/);
  const year = m ? Number(m[1]) : null;
  const month = m && m[2] ? Number(m[2]) : null;
  const rest = m ? m[3] : name;
  const tokens = rest
    .split(/\s*(?:-|–|—|,|&|\+|\/|;)\s*/)
    .map((t) => t.trim())
    .filter((t) => t && /\p{L}/u.test(t));
  return { year: year && year >= 1900 && year <= 2100 ? year : null, month, tokens };
}

// Damerau-free Levenshtein, early exit above `max`.
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Build a search index. `gazetteer.cities` rows: [name, cc, population, lat, lon, alts].
 * Countries come from Intl.DisplayNames, so "Finnland" (de) and "Австрия" (ru) resolve too.
 */
export function buildIndex(gazetteer, countryCodes) {
  const entries = []; // { key, place }
  const regionNames = COUNTRY_LANGS.map((l) => new Intl.DisplayNames([l], { type: "region" }));
  const english = regionNames[0];
  const codes =
    countryCodes ||
    [...new Set(gazetteer.cities.map((c) => c[1]))].filter((c) => /^[A-Z]{2}$/.test(c));
  for (const cc of codes) {
    const place = {
      kind: "country",
      name: english.of(cc),
      country: english.of(cc),
      cc,
      population: 1e9,
    };
    const names = new Set(regionNames.map((r) => r.of(cc)).filter((n) => n && n !== cc));
    for (const n of names) entries.push({ key: normalize(n), place });
  }
  for (const [name, cc, population, lat, lon, alts] of gazetteer.cities) {
    const place = { kind: "city", name, country: english.of(cc), cc, population, lat, lon };
    const keys = new Set([name, ...alts].map(normalize).filter((k) => k.length >= 3));
    for (const key of keys) entries.push({ key, place });
  }
  const exact = new Map();
  for (const e of entries) {
    if (!exact.has(e.key)) exact.set(e.key, []);
    exact.get(e.key).push(e.place);
  }
  return { entries, exact, cities: gazetteer.cities, english };
}

const rank = (p) => (p.kind === "country" ? 2e9 : p.population);

function uniqueSorted(places) {
  const seen = new Set();
  return places
    .sort((a, b) => rank(b) - rank(a))
    .filter((p) => {
      const id = `${p.kind}:${p.name}:${p.cc}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

/** Candidates for one token, best first: exact name matches, else close spellings. */
export function matchToken(index, token, limit = 5) {
  const key = normalize(token);
  if (!key) return [];
  const exact = index.exact.get(key);
  if (exact) return { exact: true, places: uniqueSorted([...exact]).slice(0, limit) };
  const max = key.length <= 4 ? 1 : key.length <= 8 ? 2 : 3;
  const close = [];
  for (const e of index.entries) {
    if (e.key[0] !== key[0] && e.key[1] !== key[1]) continue; // cheap prefilter
    const d = distance(key, e.key, max);
    if (d <= max) close.push({ d, place: e.place });
  }
  close.sort((a, b) => a.d - b.d || rank(b.place) - rank(a.place));
  return { exact: false, places: uniqueSorted(close.map((c) => c.place)).slice(0, limit) };
}

/** Human label: "Vienna, Austria" or "Austria". */
export function placeLabel(p) {
  return p.kind === "country" ? p.name : `${p.name}, ${p.country}`;
}

/** Nearest gazetteer city to a GPS point (photos with GPS beat the folder name). */
export function nearestCity(index, { lat, lon }) {
  let best = null;
  let bestD = Infinity;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  for (const [name, cc, population, clat, clon] of index.cities) {
    const d = (clat - lat) ** 2 + ((clon - lon) * cosLat) ** 2;
    if (d < bestD) {
      bestD = d;
      best = {
        kind: "city",
        name,
        country: index.english.of(cc),
        cc,
        population,
        lat: clat,
        lon: clon,
      };
    }
  }
  return best;
}

/**
 * Split photos (sorted by time) into groups at a new day or a gap longer than
 * `gapHours`. Photos without a time join the group of their neighbour.
 */
export function timeGroups(photos, gapHours = 6) {
  const groups = [];
  let cur = null;
  let last = null;
  for (const p of photos) {
    const t = p.time;
    const newGroup =
      !cur ||
      (t != null &&
        last != null &&
        (t - last > gapHours * 3600e3 ||
          new Date(t).toDateString() !== new Date(last).toDateString()));
    if (newGroup) groups.push((cur = []));
    cur.push(p);
    if (t != null) last = t;
  }
  return groups;
}

/**
 * Give each time group a place from the folder: one place -> all groups; as
 * many groups as places -> in order; otherwise spread places over the groups
 * in order (the trip went in the order of the name). Returns indexes into
 * `places` per group.
 */
export function assignPlaces(groupCount, placeCount) {
  if (!placeCount) return Array(groupCount).fill(null);
  if (placeCount === 1) return Array(groupCount).fill(0);
  return Array.from({ length: groupCount }, (_, g) =>
    Math.min(placeCount - 1, Math.floor((g * placeCount) / groupCount))
  );
}
