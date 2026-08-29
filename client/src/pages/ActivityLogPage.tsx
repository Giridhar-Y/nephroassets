import { Fragment, useCallback, useEffect, useState } from "react";
import { fetchActivityLog, type ActivityAction, type ActivityLogEntry } from "../api/client.js";
import { formatDateTime } from "../lib/format.js";
import { AuditLogIcon, ChevronDownIcon, EmptyIcon, ErrorIcon, RetryIcon } from "../lib/icons.js";

const PAGE_SIZE = 50;

const ACTION_LABELS: Record<ActivityAction, string> = {
  capitalization_create: "Capitalization",
  addition_create: "Addition",
  transfer_create: "Transfer",
  disposal_create: "Disposal"
};

// "additionsC1" -> "Additions C1", "cascadedFromParentFarId" -> "Cascaded From Parent Far
// Id" — same plain, generic humanizer as Delete Log's DetailsSummary, not a per-action
// template, since `details`' shape varies by action and new fields shouldn't need a
// matching UI change every time.
function humanizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    return value.map((v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v))).join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function DetailsSummary({ details }: { details: Record<string, unknown> | null }) {
  if (!details || Object.keys(details).length === 0) {
    return <span className="text-gray-400">No details recorded.</span>;
  }
  return (
    <ul className="space-y-0.5">
      {Object.entries(details).map(([key, value]) => (
        <li key={key}>
          <span className="font-medium text-gray-500">{humanizeKey(key)}:</span>{" "}
          <span className="text-gray-700">{formatDetailValue(value)}</span>
        </li>
      ))}
    </ul>
  );
}

// Read-only view of every Capitalization/Addition/Transfer/Disposal CREATE event
// (single-item and Bulk Upload/Bulk Transfer/Bulk Dispose alike) — see server
// routes/activityLog.ts. Editor+ visibility, same as the actions themselves. Only
// forward-looking: activity from before this feature shipped was never captured (see
// asset_activity_log's schema.sql comment).
export function ActivityLogPage() {
  const [items, setItems] = useState<ActivityLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const [farIdInput, setFarIdInput] = useState("");
  const [farId, setFarId] = useState("");
  const [action, setAction] = useState<ActivityAction | "">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchActivityLog({
        farId: farId || undefined,
        action: action || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        limit: PAGE_SIZE
      });
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the activity log.");
    } finally {
      setLoading(false);
    }
  }, [farId, action, dateFrom, dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetchActivityLog({
        farId: farId || undefined,
        action: action || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        cursor: nextCursor,
        limit: PAGE_SIZE
      });
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more rows.");
    } finally {
      setLoadingMore(false);
    }
  }

  const hasActiveFilters = !!(farId || action || dateFrom || dateTo);
  function clearFilters() {
    setFarIdInput("");
    setFarId("");
    setAction("");
    setDateFrom("");
    setDateTo("");
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="border-b border-gray-200 px-6 py-4">
        <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
          <AuditLogIcon fontSize={20} />
          Activity Log
        </h1>
        <p className="mt-1 max-w-xl text-sm text-gray-500">
          Every Capitalization, Addition, Transfer, and Disposal — single-item and bulk-uploaded alike — newest
          first. Read-only. Only covers activity recorded after this log shipped.
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="al-far-id" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
              FAR ID
            </label>
            <input
              id="al-far-id"
              type="text"
              className="w-40 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              value={farIdInput}
              onChange={(e) => setFarIdInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setFarId(farIdInput.trim());
              }}
              onBlur={() => setFarId(farIdInput.trim())}
              placeholder="Search…"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="al-action" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
              Category
            </label>
            <select
              id="al-action"
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              value={action}
              onChange={(e) => setAction(e.target.value as ActivityAction | "")}
            >
              <option value="">All</option>
              {Object.entries(ACTION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="al-date-from" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
              From
            </label>
            <input
              id="al-date-from"
              type="date"
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="al-date-to" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
              To
            </label>
            <input
              id="al-date-to"
              type="date"
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </div>
          {hasActiveFilters && (
            <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-1.5 border-b border-red-100 bg-red-50 px-6 py-2 text-sm text-red-700">
          <ErrorIcon fontSize={15} />
          {error}{" "}
          <button className="flex items-center gap-1 font-semibold underline" onClick={load}>
            <RetryIcon fontSize={13} />
            Retry
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {loading && items.length === 0 ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
            <EmptyIcon fontSize={28} className="text-gray-300" />
            <p className="text-sm font-medium text-gray-600">No activity recorded yet.</p>
            <p className="text-xs text-gray-400">
              {hasActiveFilters
                ? "Try widening the filters above."
                : "Capitalization, Addition, Transfer, and Disposal actions will show up here."}
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-white">
              <tr className="border-b-2 border-gray-300 text-left text-[11px] font-bold uppercase tracking-wide text-gray-500">
                <th className="py-2 pr-3">Timestamp</th>
                <th className="py-2 pr-3">Category</th>
                <th className="py-2 pr-3">FAR ID</th>
                <th className="py-2 pr-3">Actor</th>
                <th className="py-2 pr-3" />
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => {
                const expanded = expandedId === entry.id;
                return (
                  <Fragment key={entry.id}>
                    <tr className="border-b border-gray-100 odd:bg-white even:bg-gray-50/60">
                      <td className="whitespace-nowrap py-2 pr-3 text-gray-600">{formatDateTime(entry.createdAt)}</td>
                      <td className="py-2 pr-3 text-gray-600">{ACTION_LABELS[entry.action]}</td>
                      <td className="py-2 pr-3 font-medium text-ink">{entry.farId}</td>
                      <td className="py-2 pr-3 text-gray-600">{entry.actorUsername ?? "Unknown user"}</td>
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          className="flex items-center gap-1 whitespace-nowrap text-xs font-medium text-accent hover:underline"
                          onClick={() => setExpandedId(expanded ? null : entry.id)}
                        >
                          <ChevronDownIcon fontSize={13} className={expanded ? "" : "-rotate-90"} />
                          Details
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-gray-100 bg-gray-50">
                        <td colSpan={5} className="px-3 py-2 text-xs">
                          <DetailsSummary details={entry.details} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {!loading && nextCursor && (
          <div className="flex justify-center py-4">
            <button
              type="button"
              className="rounded-md border border-gray-300 px-4 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
