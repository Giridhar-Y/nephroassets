import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // devOptions.enabled defaults to false — the service worker is never registered
      // under `vite dev`, so it can't affect e2e/dev testing at all; left unset
      // deliberately rather than toggled, so that stays true regardless of test mode.
      //
      // "autoUpdate": a new deployment's service worker takes over automatically —
      // no "Update Now" prompt. useServiceWorkerUpdate.ts still does the actual
      // skipWaiting+reload itself (via `virtual:pwa-register`, immediate:true), timed to
      // a route navigation (ServiceWorkerUpdater.tsx) rather than firing mid-task; this
      // setting plus workbox.clientsClaim/skipWaiting below just make the generated
      // service worker itself never sit around waiting to be told. injectRegister:null
      // stops the plugin auto-injecting its own fire-and-forget registration script,
      // since useServiceWorkerUpdate.ts registers the service worker itself instead,
      // specifically so it can hook onNeedRefresh.
      registerType: "autoUpdate",
      injectRegister: null,
      includeAssets: ["favicon.svg", "icons/favicon-32x32.png"],
      manifest: {
        name: "NephroAssets - FAR",
        short_name: "NephroAssets",
        description: "Fixed Asset Register for NephroPlus.",
        theme_color: "#01486F",
        // Matches the app's actual body background (index.html/index.css), not a bare
        // #FFFFFF assumption.
        background_color: "#FAFAFA",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "icons/pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icons/maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "icons/apple-touch-icon.png", sizes: "180x180", type: "image/png", purpose: "any" }
        ]
      },
      workbox: {
        // Paired with registerType:"autoUpdate" above: the installed/waiting worker
        // claims every open tab (and this installed PWA, on its next reopen or
        // navigation) the instant it activates, instead of waiting to be asked.
        clientsClaim: true,
        skipWaiting: true,
        // Precache only the built app shell (JS/CSS/HTML/fonts/icons) — generateSW's
        // default globPatterns already only match dist/ build output, so /api/* was
        // never going to be swept in by that alone. The runtimeCaching + denylist rules
        // below aren't fixing a real leak, they're making the "never cache /api" intent
        // explicit and future-proof against someone later adding a catch-all runtime
        // caching rule that would otherwise sweep API calls in too.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: "NetworkOnly"
          }
        ]
      }
    })
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000"
    }
  }
});
