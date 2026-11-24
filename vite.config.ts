import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  root: "web",
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Keep the browser's Host header: the server rejects writes whose Origin host differs from Host, and the
      // string shorthand would turn on changeOrigin and send Host: localhost:8080.
      "/api": { target: "http://localhost:8080", changeOrigin: false },
    },
    // The web app imports ../shared, which sits outside the Vite root.
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url))] },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Recall",
        short_name: "Recall",
        description: "Save anything. Find it later.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#f5f5f4",
        theme_color: "#f5f5f4",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
});
