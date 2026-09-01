import { useOnlineStatus } from "../hooks/useOnlineStatus.js";
import { OfflineIcon } from "../lib/icons.js";

// The app shell (this banner included) loads from the service worker's cache while
// offline — every /api/* call is network-only (see vite.config.ts), so it simply fails
// instead of silently serving a stale disposal/depreciation figure. This banner is the
// explicit "you're offline" signal that failure deserves; each page's own existing
// fetch-error handling (a "Could not load..." message + Retry) still fires underneath
// it — this doesn't replace that, it just makes the *reason* obvious at a glance instead
// of reading as a generic error.
export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;

  return (
    <div className="flex shrink-0 items-center justify-center gap-2 bg-accent px-4 py-1.5 text-xs font-medium text-white print:hidden">
      <OfflineIcon fontSize={14} />
      You're offline — new data can't be loaded until you're back online.
    </div>
  );
}
