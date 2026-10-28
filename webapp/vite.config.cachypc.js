// cachypc fork: the device web UI served from a PC instead of the frame.
// `npm run build:cachypc && npm run serve:cachypc` serves it on PHOTOFRAME_UI_HOST:PHOTOFRAME_UI_PORT
// and proxies /api to the frame at FRAME_URL. The firmware build (vite.config.js) is untouched.
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vuetify from "vite-plugin-vuetify";
import { resolve } from "path";
import { copyFileSync, mkdirSync } from "node:fs";

// onnxruntime-web loads its WASM at run time from /ort/ (Sort tab face analysis).
const ortFiles = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"];
function copyOrt(outDir) {
  return {
    name: "copy-onnxruntime-wasm",
    apply: "build",
    closeBundle() {
      mkdirSync(resolve(outDir, "ort"), { recursive: true });
      for (const f of ortFiles)
        copyFileSync(
          resolve(__dirname, "node_modules/onnxruntime-web/dist", f),
          resolve(outDir, "ort", f)
        );
    },
  };
}

const frame = process.env.FRAME_URL || "http://192.168.1.131";
const upscale = process.env.UPSCALE_URL || "http://127.0.0.1:18087";
const proxy = {
  "/api": { target: frame, changeOrigin: true },
  "/upscale": { target: upscale, changeOrigin: true, timeout: 200000, proxyTimeout: 200000 },
  "/library": { target: upscale, changeOrigin: true },
  "/sortdata": { target: upscale, changeOrigin: true },
  "/faces": { target: upscale, changeOrigin: true },
};

export default defineConfig({
  define: { "import.meta.env.VITE_CACHYPC": "true" },
  worker: { format: "es" },
  plugins: [
    vue(),
    vuetify({ autoImport: true, styles: { configFile: "src/styles/settings.scss" } }),
    ,
    copyOrt(resolve(__dirname, "dist-cachypc")),
  ],
  build: {
    outDir: resolve(__dirname, "dist-cachypc"),
    emptyOutDir: true,
    rollupOptions: { external: ["/measurement_sample.jpg"] },
  },
  server: { proxy },
  preview: {
    host: process.env.PHOTOFRAME_UI_HOST || "127.0.0.1",
    port: Number(process.env.PHOTOFRAME_UI_PORT || 18086),
    strictPort: true,
    proxy,
  },
});
