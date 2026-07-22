import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The checkout SPA lives in ./web and builds to ./web/dist, which the Hono
// backend serves at /pay/:publicId (+ /assets/*).
export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // `vite` dev server with HMR; API calls are proxied to the Bun backend.
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/public": "http://localhost:3000",
    },
  },
});
