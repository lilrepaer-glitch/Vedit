import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server pro UI; /api a /ws proxyuje na Vedit API server (127.0.0.1:47000).
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // povolit preview host (Arena proxy) i localhost
    allowedHosts: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:47000", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:47000", ws: true },
    },
  },
  build: {
    outDir: "dist",
  },
});
