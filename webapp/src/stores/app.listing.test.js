// PHOTOFRAME-001: how the webapp reads the album listing.
//
// The frame now pages /api/images (?limit/?offset + X-Total-Count) and keeps its
// photos spread over several albums, so the store has to (a) page through a long
// album instead of expecting one big answer, (b) still work against firmware that
// ignores the paging parameters, and (c) be able to show every album at once.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAppStore } from "./index";

const albumPage = (names, album, total) => ({
  ok: true,
  headers: new Headers({
    "content-type": "application/json",
    ...(total === null ? {} : { "x-total-count": String(total) }),
  }),
  json: async () => names.map((filename) => ({ filename, album })),
});

const jsonResponse = (body) => ({
  ok: true,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body,
});

function installFrame({ albums, photos, paging }) {
  const calls = [];
  const fetchMock = vi.fn(async (url, init) => {
    const target = new URL(url, "http://frame.local");
    calls.push(`${target.pathname}${target.search}`);
    if (init?.signal?.aborted) throw new Error("aborted");

    if (target.pathname === "/api/albums") return jsonResponse(albums);
    if (target.pathname === "/api/images") {
      const album = target.searchParams.get("album");
      const limit = Number(target.searchParams.get("limit"));
      const offset = Number(target.searchParams.get("offset"));
      const all = photos[album] ?? [];
      if (!paging) {
        // Firmware without paging: one answer for everything, no total header.
        return albumPage(all, album, null);
      }
      return albumPage(all.slice(offset, offset + limit), album, all.length);
    }
    throw new Error(`unexpected request: ${url}`);
  });
  global.fetch = fetchMock;
  return calls;
}

describe("album listing (PHOTOFRAME-001)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("pages through an album longer than one page", async () => {
    const photos = 250;
    const calls = installFrame({
      albums: [{ name: "Default", enabled: true }],
      photos: { Default: Array.from({ length: photos }, (_, i) => `photo${i}.epdgz`) },
      paging: true,
    });

    const store = useAppStore();
    store.systemInfo.sdcard_inserted = true;
    await store.loadImages("Default");

    expect(store.images).toHaveLength(photos);
    expect(store.images[0].filename).toBe("photo0.epdgz");
    expect(store.images[photos - 1].filename).toBe(`photo${photos - 1}.epdgz`);
    const imageCalls = calls.filter((c) => c.startsWith("/api/images"));
    expect(imageCalls).toHaveLength(3);
    expect(imageCalls[2]).toContain("offset=200");
  });

  it("asks once when the firmware answers the whole album at once", async () => {
    const calls = installFrame({
      albums: [{ name: "Default", enabled: true }],
      photos: { Default: ["a.epdgz", "b.epdgz"] },
      paging: false,
    });

    const store = useAppStore();
    store.systemInfo.sdcard_inserted = true;
    await store.loadImages("Default");

    expect(store.images).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith("/api/images"))).toHaveLength(1);
  });

  it("reads every album for the All albums view", async () => {
    const calls = installFrame({
      albums: [
        { name: "Default", enabled: true },
        { name: "Default 2", enabled: true },
      ],
      photos: {
        Default: ["a.epdgz", "b.epdgz"],
        "Default 2": ["c.epdgz"],
      },
      paging: true,
    });

    const store = useAppStore();
    store.systemInfo.sdcard_inserted = true;
    await store.loadImages(store.ALL_ALBUMS);

    expect(store.images.map((i) => i.filename)).toEqual(["a.epdgz", "b.epdgz", "c.epdgz"]);
    expect(store.images.map((i) => i.album)).toEqual(["Default", "Default", "Default 2"]);
    const imageCalls = calls.filter((c) => c.startsWith("/api/images"));
    expect(imageCalls.some((c) => c.includes("album=Default%202"))).toBe(true);
  });

  it("lets the frame choose the album only when it advertises the feature", async () => {
    installFrame({ albums: [{ name: "Default", enabled: true }], photos: {}, paging: false });
    const store = useAppStore();

    store.systemInfo.auto_album = false;
    store.selectAlbum("Default");
    expect(store.uploadAlbumTarget()).toBe("Default");

    store.selectAlbum(store.ALL_ALBUMS);
    expect(store.uploadAlbumTarget()).toBe("Default");

    store.systemInfo.auto_album = true;
    expect(store.uploadAlbumTarget()).toBe("auto");
  });
});
