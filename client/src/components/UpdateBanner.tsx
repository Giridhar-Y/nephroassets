import { useServiceWorkerUpdate } from "../hooks/useServiceWorkerUpdate.js";
import { RetryIcon } from "../lib/icons.js";

/** A persistent notification, not a Toast.tsx confirmation — Toast auto-dismisses in
 *  4-6s, wrong for something a user mid-task might not act on for many minutes. Stays up
 *  until they click Update Now (which reloads); no separate dismiss, matching the plain
 *  "message + one button" this was asked for. Same bottom-right corner Toast.tsx already
 *  uses (fixed bottom-4 right-4), not a full-width bottom bar — that was tried first and
 *  found to sit on top of the sidebar's own Sign Out button (inset-x-0 spans behind it,
 *  same z-50 layer, intercepting its clicks entirely), since the sidebar has no reserved
 *  space carved out for a fixed bar spanning the whole viewport width. Mounted once at
 *  the app root (App.tsx), outside auth gating, so it still shows on /login. */
export function UpdateBanner() {
  const { needRefresh, applyUpdate } = useServiceWorkerUpdate();
  if (!needRefresh) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-md bg-ink py-2.5 pl-4 pr-3 text-sm font-medium text-white shadow-lg"
    >
      <RetryIcon fontSize={16} className="shrink-0 text-brand-teal" />
      <span>A new version of NephroAssets is available.</span>
      <button
        type="button"
        className="shrink-0 whitespace-nowrap rounded-md bg-white/15 px-3 py-1 text-xs font-bold hover:bg-white/25"
        onClick={applyUpdate}
      >
        Update Now
      </button>
    </div>
  );
}
