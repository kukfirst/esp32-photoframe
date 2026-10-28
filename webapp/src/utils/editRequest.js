// cachypc fork: the gallery asks the batch editor to open an uploaded photo.
// A plain shared ref; BatchUpload watches it and clears it once handled.
import { ref } from "vue";

export const editRequest = ref(null); // { album, filename } | null

// The Sort tab hands checked photos to the batch editor:
// [{ file, place, dateFallback }] | null
export const importRequest = ref(null);
