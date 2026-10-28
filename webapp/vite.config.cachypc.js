// cachypc fork: the device web UI served from a PC instead of the frame.
// `npm run build:cachypc && npm run serve:cachypc` serves it on PHOTOFRAME_UI_HOST:PHOTOFRAME_UI_PORT
// and proxies /api to the frame at FRAME_URL. The firmware build (vite.config.js) is untouched.
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vuetify from "vite-plugin-vuetify";
import { resolve } from "path";

const frame = process.env.FRAME_URL || "http://192.168.1.131";
const upscale = process.env.UPSCALE_URL || "http://127.0.0.1:18087";
const proxy = {
  "/api": { target: frame, changeOrigin: true },
  "/upscale": { target: upscale, changeOrigin: true, timeout: 200000, proxyTimeout: 200000 },
  "/library": { target: upscale, changeOrigin: true },
};

export default defineConfig({
  define: { "import.meta.env.VITE_CACHYPC": "true" },
  worker: { format: "es" },
  plugins: [
    vue(),
    vuetify({ autoImport: true, styles: { configFile: "src/styles/settings.scss" } }),
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
