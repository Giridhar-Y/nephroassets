import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import "./index.css";

// Fires when a dynamically import()-ed chunk 404s — the failure mode after a new
// deployment ships and Vercel stops serving an old build's hashed filenames, if a
// long-open tab (still running the OLD index.html/bundle in memory) then tries to load
// one it doesn't already have cached. This app has no React.lazy/route-level
// code-splitting (one main bundle), but useServiceWorkerUpdate.ts's own
// import("virtual:pwa-register") IS a real dynamic import bundled as its own small
// chunk (see the build output), so this isn't purely a future-proofing no-op — it already
// covers that one. The sessionStorage guard caps the reload at once per tab so a
// persistently-broken chunk can't loop. Reloading here doesn't conflict with "never
// reload a working session out from under someone" (UpdateBanner.tsx's whole point) — by
// definition this only fires when the page ALREADY failed to load something the user (or
// this app itself) just tried to fetch, not while an otherwise-working session sits idle.
window.addEventListener("vite:preloadError", () => {
  if (sessionStorage.getItem("nephroassets.chunkReloadAttempted")) return;
  sessionStorage.setItem("nephroassets.chunkReloadAttempted", "true");
  window.location.reload();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
