import { formatDateTime } from "../../lib/format.js";
import { RetryIcon } from "../../lib/icons.js";
import { Button } from "./Button.js";

// "Last updated: <time>" + a Refresh button — shared by Dashboard and Audit
// Reconciliation. `computedAt` is the server cache row's own timestamp (see
// reportTotalsCache.ts), not the time the browser fetched it, so it honestly says how old
// the figures are. Refresh re-requests from the server, which serves a cached row only if
// it was computed against the data as it is now (the data signature) and recomputes
// otherwise, so a Refresh after any data change, in-app or not, reflects it. "checked
// <time>" moves on every attempt, so a Refresh with nothing new still visibly registered.
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
              ? `Last updated: ${formatDateTime(computedAt)}${attemptedAt ? ` · checked ${new Date(attemptedAt).toLocaleTimeString("en-IN")}` : ""}`
              : null}
      </span>
      <Button variant="secondary" size="sm" onClick={onRefresh} disabled={loading}>
        <RetryIcon fontSize={14} className={loading ? "animate-spin" : undefined} />
        Refresh
      </Button>
    </div>
  );
}
