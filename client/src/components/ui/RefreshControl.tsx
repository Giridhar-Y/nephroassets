import { formatDateTime } from "../../lib/format.js";
import { RetryIcon } from "../../lib/icons.js";
import { Button } from "./Button.js";

// "Last updated: <time>" + a Refresh button — shared by Dashboard and Audit
// Reconciliation. `computedAt` is the server cache row's own timestamp (see
// reportTotalsCache.ts), not the time the browser fetched it, so it honestly says how old
// the figures are. Refresh re-requests from the server; it deliberately doesn't bypass
// the cache — every data write already clears it, so a cache hit is never stale for its
// asAt, and a forced cold recompute at production scale is exactly the 60s+ scan that
// 504s on Vercel.
export function RefreshControl({
  computedAt,
  loading,
  failed = false,
  attemptedAt = null,
  onRefresh
}: {
  computedAt: string | null;
  loading: boolean;
  /** Some request failed — says so instead of silently showing no timestamp. */
  failed?: boolean;
  /** When the last load/refresh attempt finished (ISO). Shown with seconds on failure,
   *  so a Refresh that fails again visibly changes the text instead of looking like a
   *  no-op click — computedAt only moves on success. */
  attemptedAt?: string | null;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className={`text-xs ${!loading && failed ? "text-red-600" : "text-gray-500"}`} aria-live="polite">
        {loading
          ? "Loading…"
          : failed
            ? `Some figures couldn't load${attemptedAt ? ` · tried at ${new Date(attemptedAt).toLocaleTimeString("en-IN")}` : ""}`
            : computedAt
              ? `Last updated: ${formatDateTime(computedAt)}`
              : null}
      </span>
      <Button variant="secondary" size="sm" onClick={onRefresh} disabled={loading}>
        <RetryIcon fontSize={14} className={loading ? "animate-spin" : undefined} />
        Refresh
      </Button>
    </div>
  );
}
