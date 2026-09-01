import { useEffect, useState } from "react";

// navigator.onLine plus the online/offline events — no polling, no library. Not a
// guarantee the API server itself is reachable (that's still whatever each page's own
// fetch error-handling already does), just "does this device have a network path at
// all" — the coarser, more common offline case, and the one worth a persistent banner
// rather than a per-page error state.
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    function onOnline() {
      setOnline(true);
    }
    function onOffline() {
      setOnline(false);
    }
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return online;
}
