import { defineStore } from "pinia";
import { ref, computed } from "vue";

export const useAppStore = defineStore("app", () => {
  // State
  const albums = ref([]);
  const selectedAlbum = ref("Default");
  const images = ref([]);
  const battery = ref({
    connected: false,
    level: 0,
    voltage: 0,
    charging: false,
  });
  const systemInfo = ref({
    width: 800,
    height: 480,
    has_sdcard: false,
    sdcard_inserted: false,
    has_flash_storage: false,
    storage_total: 0,
    storage_used: 0,
    version: "v1.0",
    project_name: "PhotoFrame",
    wakeup_key_name: "wake button",
    compile_time: "",
    compile_date: "",
    idf_version: "",
    board_name: "waveshare_photopainter_73",
    last_crash: null,
  });
  const loading = ref({
    albums: false,
    images: false,
    battery: false,
    systemInfo: false,
  });

  // API base URL (empty for same-origin)
  const API_BASE = "";

  // PHOTOFRAME-001: the frame's album scan (and anything else SD-backed) can stop
  // answering forever, and a pending fetch pins the page forever — Chrome only
  // allows six connections per origin, so the whole tab queues behind it. Every
  // call to the frame gets a deadline; callers already treat failure as
  // "standalone mode" / "asleep".
  const FRAME_TIMEOUT_MS = 30_000;
  const frameFetch = (url, init = {}) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(FRAME_TIMEOUT_MS) });

  // PHOTOFRAME-001: the frame now spreads uploads over several albums ("Default",
  // "Default 2", …) so that no single album grows past the point where walking its
  // directory stops being instant. The Gallery therefore needs to be able to look
  // at every album at once — ALL_ALBUMS is that pseudo-album. A real album that
  // happens to be named this still wins.
  const ALL_ALBUMS = "All albums";
  const IMAGES_PAGE_SIZE = 100;

  // Getters
  const sortedAlbums = computed(() => {
    return [...albums.value].sort((a, b) => {
      if (a.name === "Default") return -1;
      if (b.name === "Default") return 1;
      return a.name.localeCompare(b.name);
    });
  });

  const currentAlbumImages = computed(() => images.value);

  // Grayscale panels ("gc16", and any future "gc8"/"gc4") hide the color-only
  // controls (saturation, 6-color palette calibration).
  const isGrayscale = computed(() => (systemInfo.value.display_type || "").startsWith("gc"));

  // Actions
  async function loadBatteryStatus() {
    try {
      const response = await frameFetch(`${API_BASE}/api/battery`);
      if (!response.ok || response.headers.get("content-type")?.includes("text/html")) {
        return;
      }
      const data = await response.json();
      battery.value = {
        connected: data.battery_connected,
        level: data.battery_level,
        voltage: data.battery_voltage,
        charging: data.charging,
      };
    } catch (_error) {
      console.log("Battery API not available (standalone mode)");
    }
  }

  async function loadAlbums() {
    loading.value.albums = true;
    try {
      if (!systemInfo.value.sdcard_inserted && !systemInfo.value.has_flash_storage) {
        albums.value = [{ name: "Default", enabled: true, image_count: 0 }];
        return;
      }
      const response = await frameFetch(`${API_BASE}/api/albums`);
      if (!response.ok || response.headers.get("content-type")?.includes("text/html")) {
        albums.value = [{ name: "Default", enabled: true, image_count: 0 }];
        return;
      }
      albums.value = await response.json();
    } catch (error) {
      console.log("Failed to load albums (standalone mode):", error);
      albums.value = [{ name: "Default", enabled: true, image_count: 0 }];
    } finally {
      loading.value.albums = false;
    }
  }

  async function fetchImagePage(albumName, offset) {
    const response = await frameFetch(
      `${API_BASE}/api/images?album=${encodeURIComponent(albumName)}&limit=${IMAGES_PAGE_SIZE}&offset=${offset}`
    );
    if (!response.ok || response.headers.get("content-type")?.includes("text/html")) {
      return null;
    }
    const batch = await response.json();
    if (!Array.isArray(batch)) {
      return null;
    }
    return { batch, total: Number(response.headers.get("x-total-count")) };
  }

  // Paged so the response stays small on a big album. Firmware that ignores
  // ?limit/?offset answers the whole album at once and sends no X-Total-Count —
  // in that case one page already is everything, and asking again would fetch the
  // same album twice.
  async function fetchAllImages(albumName) {
    const collected = [];
    let offset = 0;
    for (let page = 0; page < 100; page++) {
      const result = await fetchImagePage(albumName, offset);
      if (!result || result.batch.length === 0) {
        break;
      }
      collected.push(...result.batch);
      offset += result.batch.length;
      if (!Number.isFinite(result.total) || offset >= result.total) {
        break;
      }
    }
    return collected;
  }

  async function albumNamesToRead(albumName) {
    if (albumName !== ALL_ALBUMS || albums.value.some((album) => album.name === ALL_ALBUMS)) {
      return [albumName];
    }
    if (albums.value.length === 0) {
      await loadAlbums();
    }
    return albums.value.map((album) => album.name);
  }

  async function loadImages(albumName) {
    loading.value.images = true;
    try {
      if (!systemInfo.value.sdcard_inserted && !systemInfo.value.has_flash_storage) {
        images.value = [];
        return;
      }
      const names = await albumNamesToRead(albumName);
      const merged = [];
      for (const name of names) {
        merged.push(...(await fetchAllImages(name)));
      }
      images.value = merged;
    } catch (error) {
      console.log("Failed to load images (standalone mode):", error);
      images.value = [];
    } finally {
      loading.value.images = false;
    }
  }

  // Where an upload should go: the frame chooses the album when it advertises the
  // feature; older firmware would create an album literally named "auto" and never
  // show it, so those keep the album the user picked.
  function uploadAlbumTarget() {
    if (systemInfo.value.auto_album) {
      return "auto";
    }
    return selectedAlbum.value === ALL_ALBUMS ? "Default" : selectedAlbum.value;
  }

  function selectAlbum(albumName) {
    selectedAlbum.value = albumName;
    loadImages(albumName);
  }

  async function toggleAlbumEnabled(albumName, enabled) {
    try {
      const response = await frameFetch(
        `${API_BASE}/api/albums/enabled?name=${encodeURIComponent(albumName)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        }
      );
      if (response.ok) {
        await loadAlbums();
      }
    } catch (error) {
      console.error("Failed to toggle album:", error);
    }
  }

  async function createAlbum(name) {
    try {
      const response = await frameFetch(`${API_BASE}/api/albums`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (response.ok) {
        await loadAlbums();
        return true;
      }
      return false;
    } catch (error) {
      console.error("Failed to create album:", error);
      return false;
    }
  }

  async function deleteAlbum(albumName) {
    try {
      const response = await frameFetch(
        `${API_BASE}/api/albums?name=${encodeURIComponent(albumName)}`,
        {
          method: "DELETE",
        }
      );
      if (response.ok) {
        await loadAlbums();
        await loadSystemInfo();
        if (selectedAlbum.value === albumName) {
          selectAlbum("Default");
        }
        return true;
      }
      return false;
    } catch (error) {
      console.error("Failed to delete album:", error);
      return false;
    }
  }

  async function deleteImage(album, filename) {
    try {
      const fullPath = `${album}/${filename}`;
      const response = await frameFetch(`${API_BASE}/api/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filepath: fullPath }),
      });
      if (response.ok) {
        await loadImages(selectedAlbum.value);
        await loadSystemInfo();
        return true;
      }
      return false;
    } catch (error) {
      console.error("Failed to delete image:", error);
      return false;
    }
  }

  async function displayImage(album, filename) {
    try {
      const fullPath = `${album}/${filename}`;
      const response = await frameFetch(`${API_BASE}/api/display`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filepath: fullPath }),
      });
      return response.ok;
    } catch (error) {
      console.error("Failed to display image:", error);
      return false;
    }
  }

  async function enterSleep() {
    try {
      const response = await frameFetch(`${API_BASE}/api/sleep`, { method: "POST" });
      return response.ok;
    } catch (error) {
      console.error("Failed to enter sleep:", error);
      return false;
    }
  }

  async function rotateNow() {
    try {
      const response = await frameFetch(`${API_BASE}/api/rotate`, { method: "POST" });
      return response.ok;
    } catch (error) {
      console.error("Failed to rotate:", error);
      return false;
    }
  }

  async function keepAlive() {
    try {
      const response = await frameFetch(`${API_BASE}/api/keep_alive`, { method: "POST" });
      return response.ok;
    } catch (error) {
      console.error("Failed to send keep-alive:", error);
      return false;
    }
  }

  async function loadSystemInfo() {
    loading.value.systemInfo = true;
    try {
      const response = await frameFetch(`${API_BASE}/api/system-info`);
      if (response.ok) {
        systemInfo.value = await response.json();
      }
    } catch (error) {
      console.error("Failed to load system info:", error);
    } finally {
      loading.value.systemInfo = false;
    }
  }

  async function probeAwake() {
    // PHOTOFRAME-001: "is the frame awake?" must not depend on one endpoint.
    try {
      const response = await frameFetch(`${API_BASE}/api/system-info`);
      return response.ok;
    } catch (_error) {
      return false;
    }
  }

  return {
    // State
    ALL_ALBUMS,
    albums,
    selectedAlbum,
    images,
    battery,
    systemInfo,
    loading,
    // Getters
    sortedAlbums,
    currentAlbumImages,
    isGrayscale,
    // Actions
    loadBatteryStatus,
    loadAlbums,
    loadImages,
    selectAlbum,
    uploadAlbumTarget,
    toggleAlbumEnabled,
    createAlbum,
    deleteAlbum,
    deleteImage,
    displayImage,
    enterSleep,
    rotateNow,
    keepAlive,
    probeAwake,
    loadSystemInfo,
  };
});
