import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useServiceWorkerUpdate } from "../hooks/useServiceWorkerUpdate.js";

/** No UI (replaces the old UpdateBanner.tsx toast) — re-checks for a new deployment on
 *  every route change so an update lands seamlessly during a navigation the user is
 *  already making, rather than surfacing a manual "Update Now" prompt mid-task. Mounted
 *  inside HashRouter (App.tsx), above the route switch, so it sees every navigation
 *  including the pre-login → post-login one. */
export function ServiceWorkerUpdater() {
  const location = useLocation();
  const { checkForUpdate } = useServiceWorkerUpdate();

  useEffect(() => {
    checkForUpdate();
  }, [location.pathname, checkForUpdate]);

  return null;
}
