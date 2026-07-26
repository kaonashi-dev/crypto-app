import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

// The SPA lives in ./web and builds to ./web/dist, which the Hono backend serves
// at /pay/:publicId (checkout) and /admin (internal console), plus /assets/*.
export default defineConfig({
  root: "web",
  plugins: [solid(), tailwindcss()],
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
      // Only the data routes: bare /admin must stay with Vite's SPA fallback so
      // the console hot-reloads like the checkout does.
      "/admin/api": "http://localhost:3000",
    },
  },
});
