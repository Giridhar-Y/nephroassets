import { useCallback, useEffect, useRef } from "react";

/** Registers the service worker and applies any update the instant it's found — no
 *  "Update Now" prompt (see vite.config.ts's registerType:"autoUpdate" +
 *  workbox.clientsClaim/skipWaiting, which make the generated worker itself never wait
 *  to be told). `checkForUpdate` (called by ServiceWorkerUpdater.tsx on every route
 *  change) asks the browser to re-fetch the deployed sw.js — that's what actually
 *  surfaces a same-session deployment, since a worker otherwise only checks on its own
 *  schedule. Tying the check to navigation means a reload (when one happens) lands
 *  exactly when the user is already moving to a new screen, not mid-task.
 *
 *  `virtual:pwa-register` is a build-time virtual module the VitePWA plugin generates —
 *  imported dynamically inside the effect, not as a static top-level import, because the
 *  SEPARATE vitest.config.ts (client unit tests) doesn't load that plugin; a static
 *  import would fail to resolve the moment this file entered any test's import graph. In
 *  `vite dev` (devOptions.enabled is false, see vite.config.ts) the resolved registerSW
 *  itself no-ops rather than throwing. */
export function useServiceWorkerUpdate() {
  const updateRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("virtual:pwa-register")
      .then(({ registerSW }) => {
        if (cancelled) return;
        updateRef.current = registerSW({
          immediate: true,
          onNeedRefresh: () => {
            void updateRef.current?.(true);
          }
        });
      })
      .catch(() => {
        // No installable service worker in this environment — nothing to update.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const checkForUpdate = useCallback(() => {
    void updateRef.current?.();
  }, []);

  return { checkForUpdate };
}
