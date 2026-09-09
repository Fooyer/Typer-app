import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // Pre-bundles these eagerly at cold start instead of letting Vite discover them lazily as the
  // (large) module graph loads — a mid-session re-optimize invalidates every already-issued
  // `/deps/*.js?v=<hash>` URL, and the WebView2 window (unlike a browser tab a dev iterates in)
  // has usually already requested some of those by the time the re-optimize happens, surfacing as
  // "504 Outdated Optimize Dep" and a page that never finishes loading.
  optimizeDeps: {
    include: ["react", "react-dom", "react/jsx-dev-runtime", "react-dom/client", "monaco-editor"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
