import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { resolve } from "node:path";

// Vite writes the built bundle into backend/public/ at build time.
// Go's //go:embed public (inside backend/) picks it up at the next `go build`.
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: resolve(import.meta.dirname, "../backend/public"),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2020",
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5174,
    proxy: {
      // Dev: Vite serves the SPA, Go (on :7682 locally) handles API + WS.
      "/api": "http://127.0.0.1:7682",
      "/ws": { target: "ws://127.0.0.1:7682", ws: true },
    },
  },
});
