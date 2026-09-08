import { useEffect, useRef, useState } from "react";

/** True once a new deployment's service worker has installed and is waiting to take
 *  over — the signal UpdateBanner.tsx uses to show its "a new version is available"
 *  prompt. Deliberately never reloads on its own: vite.config.ts's registerType:"prompt"
 *  (paired with injectRegister:null so this hook is the only registration path) makes
 *  the new worker install and wait rather than vite-plugin-pwa's default "autoUpdate"
 *  behavior of calling skipWaiting()+clientsClaim() the instant it's found, on every open
 *  tab, with no warning — which would swap the running app out from under someone
 *  mid-task. `applyUpdate` only fires once the user explicitly clicks the banner's button.
 *
 *  `virtual:pwa-register` is a build-time virtual module the VitePWA plugin registers —
 *  imported dynamically inside the effect, not as a static top-level import, because the
 *  SEPARATE vitest.config.ts (client unit tests) doesn't load that plugin; a static
 *  import would fail to resolve the moment this file entered any test's import graph. In
 *  `vite dev` (devOptions.enabled is false, see vite.config.ts) the resolved registerSW
 *  itself no-ops rather than throwing, so needRefresh simply never becomes true there. */
export function useServiceWorkerUpdate() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const updateRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("virtual:pwa-register")
      .then(({ registerSW }) => {
        if (cancelled) return;
        updateRef.current = registerSW({ onNeedRefresh: () => setNeedRefresh(true) });
      })
      .catch(() => {
        // No installable service worker in this environment — nothing to prompt about.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Neither registerSW's own internal reload (passing true below asks it to reload once
  // its `controlling` listener fires) nor a direct navigator.serviceWorker
  // "controllerchange" listener (the standard MDN-documented pattern for this) reloaded
  // reliably in live testing — the new worker demonstrably DID take over as controller
  // (confirmed via getRegistrations()) with neither listener firing a reload. Rather than
  // depend on an event whose delivery isn't reliable here, poll for the controller
  // actually changing and reload once it has, falling back to an unconditional reload
  // after REPLACE_TIMEOUT_MS regardless — skipWaiting's message was already sent by then
  // in every observed case, so a slightly-early reload here just means one extra reload
  // cycle at worst, never a stuck banner with a dead button.
  function applyUpdate() {
    const priorController = navigator.serviceWorker?.controller;
    void updateRef.current?.(true);
    const start = Date.now();
    const REPLACE_TIMEOUT_MS = 3000;
    const poll = setInterval(() => {
      const changed = navigator.serviceWorker?.controller !== priorController;
      if (changed || Date.now() - start > REPLACE_TIMEOUT_MS) {
        clearInterval(poll);
        window.location.reload();
      }
    }, 100);
  }

  return { needRefresh, applyUpdate };
}
