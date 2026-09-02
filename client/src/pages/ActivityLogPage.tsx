import { Fragment, useCallback, useEffect, useState } from "react";
import { fetchActivityLog, getActivityLogExportUrl, type ActivityCategory, type ActivityLogEntry } from "../api/client.js";
import { formatDateTime } from "../lib/format.js";
import { AuditLogIcon, ChevronDownIcon, EmptyIcon, ErrorIcon, RetryIcon } from "../lib/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { Badge } from "../components/ui/Badge.js";
import { ExportButton } from "../components/ui/ExportButton.js";

const PAGE_SIZE = 50;

// Timestamp / Category / FAR ID (flexible) / Actor / Details-button — shared by the
// sticky header row and every data row (plain divs, not a <table>) so columns line up
// without needing a shared table layout to keep them aligned.
const GRID_COLUMNS = "190px 140px minmax(140px,1fr) 160px 100px";

const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  capitalization: "Capitalization",
  addition: "Addition",
  transfer: "Transfer",
  disposal: "Disposal",
  delete: "Delete",
  masters: "Masters"
};

// One of each tone Badge offers, so every category reads as visually distinct rather
// than a flat gray list — not a severity scale (Masters isn't "worse" than Addition).
const CATEGORY_TONES: Record<ActivityCategory, "info" | "success" | "brand" | "warning" | "danger" | "neutral"> = {
  capitalization: "info",
  addition: "success",
  transfer: "brand",
  disposal: "warning",
  delete: "danger",
  masters: "neutral"
};

// "additionsC1" -> "Additions C1", "cascadedFromParentFarId" -> "Cascaded From Parent Far
// Id" — same plain, generic humanizer as Delete Log's old DetailsSummary, not a
// per-action template, since `details`' shape varies by category and new fields
// shouldn't need a matching UI change every time.
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Masters update actions (center/sub-classification/status/role) carry a `previous`
// object alongside the flat entered values — see server/src/routes/masters.ts's
// diffPrevious. Only the fields the patch actually changed appear there, keyed the same
// as their flat counterpart, so a field present in `previous` renders as
// "Field: old → new" instead of just the flat new-value line every other field still
// gets. `previous` itself, and every field it already covers, are skipped from the flat
// list below so nothing renders twice.
function DetailsSummary({ details }: { details: Record<string, unknown> | null }) {
  if (!details || Object.keys(details).length === 0) {
    return <span className="text-gray-400">No details recorded.</span>;
  }
  const previous = isPlainObject(details.previous) ? details.previous : null;
  const changedEntries = previous ? Object.entries(previous) : [];
  const flatEntries = Object.entries(details).filter(([key]) => key !== "previous" && !(previous && key in previous));

  return (
    <ul className="space-y-1">
      {changedEntries.map(([key, oldValue]) => (
        <li key={key} className="break-words">
          <span className="font-medium text-gray-500">{humanizeKey(key)}:</span>{" "}
          <span className="text-gray-400 line-through">{formatDetailValue(oldValue)}</span>
          <span className="mx-1 text-gray-400">→</span>
          <span className="font-semibold text-ink">{formatDetailValue(details[key])}</span>
        </li>
      ))}
      {flatEntries.map(([key, value]) => (
        <li key={key} className="break-words">
          <span className="font-medium text-gray-500">{humanizeKey(key)}:</span>{" "}
          <span className="text-gray-700">{formatDetailValue(value)}</span>
        </li>
      ))}
    </ul>
  );
}

// Read-only view of every Capitalization/Addition/Transfer/Disposal CREATE event, every
// Global-Admin delete/undo action ("Delete" category — merged in from the former
// standalone Delete Log page), and every Masters create/rename/deactivate/reactivate
// ("Masters" category) — single-item and bulk-uploaded alike. See server
// routes/activityLog.ts. Editor+ visibility throughout, including Delete entries: this
// is the one deliberate, requested consequence of consolidating what used to be an
// admin-only page into this editor+ one. A Masters entry has no FAR ID (it's not
// asset-scoped) — rendered as "—" rather than left blank/broken.
export function ActivityLogPage() {
  const [items, setItems] = useState<ActivityLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Lifts the sticky header row visually above the scrolling content once there's
  // something to lift above — a shadow, not another border, so it reads as elevation.
  // Same technique as AssetGrid's own sticky header.
  const [scrolled, setScrolled] = useState(false);

  const [farIdInput, setFarIdInput] = useState("");
  const [farId, setFarId] = useState("");
  const [category, setCategory] = useState<ActivityCategory | "">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchActivityLog({
        farId: farId || undefined,
        category: category || undefined,
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
  }, [farId, category, dateFrom, dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetchActivityLog({
        farId: farId || undefined,
        category: category || undefined,
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

  const hasActiveFilters = !!(farId || category || dateFrom || dateTo);
  function clearFilters() {
    setFarIdInput("");
    setFarId("");
    setCategory("");
    setDateFrom("");
    setDateTo("");
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <PageHeader
        icon={AuditLogIcon}
        title="Activity Log"
        subtitle="Every Capitalization, Addition, Transfer, Disposal, Delete/Undo, and Masters change — single-item and
          bulk-uploaded alike — newest first. Read-only. Only covers activity recorded after this log shipped."
        actions={
          <ExportButton
            url={getActivityLogExportUrl({
              farId: farId || undefined,
              category: category || undefined,
              dateFrom: dateFrom || undefined,
              dateTo: dateTo || undefined
            })}
          />
        }
      >
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
            <label htmlFor="al-category" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
              Category
            </label>
            <select
              id="al-category"
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              value={category}
              onChange={(e) => setCategory(e.target.value as ActivityCategory | "")}
            >
              <option value="">All</option>
              {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
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
      </PageHeader>

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

      <div
        className="min-h-0 flex-1 overflow-auto px-6"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        {/* py-4 lives here, one level in from the scrolling element, not on it — a
            sticky child's `top: 0` resolves against the nearest SCROLLING ancestor's own
            padding box, so top padding on the scroll container itself leaves a permanent
            gap above the "stuck" header that scrolled-past content peeks through
            (reproduced live: a sliver of the previous row visible above the header at
            any scrollTop > 0). Padding one level in avoids that gap entirely while still
            giving the same visual inset. */}
        <div className="py-4">
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
                : "Capitalization, Addition, Transfer, Disposal, Delete/Undo, and Masters changes will show up here."}
            </p>
          </div>
        ) : (
          // A plain <table>'s sticky header is unreliable here: position:sticky on
          // individual <th> cells (rather than the whole <thead>/<tr>) can let a later
          // <tbody> row paint over the "stuck" header, because native table
          // layout/painting order doesn't cleanly handle a row that stays in normal flow
          // while only its child cells are pulled into sticky positioning — reproduced
          // live (a row from further down the list rendering above the header once
          // scrolled). Same reasoning AssetGrid (Register's own grid) already uses a
          // div/CSS-Grid layout instead of a native table for its own sticky header —
          // matched here rather than continuing to chase table-sticky quirks.
          <div className="w-full text-sm">
            <div
              className={`sticky top-0 z-10 grid items-center gap-3 border-b-2 border-gray-300 bg-white py-2 text-left text-[11px] font-bold uppercase tracking-wide text-gray-500 transition-shadow duration-150 ${
                scrolled ? "shadow-md" : ""
              }`}
              style={{ gridTemplateColumns: GRID_COLUMNS }}
            >
              <div>Timestamp</div>
              <div>Category</div>
              <div>FAR ID</div>
              <div>Actor</div>
              <div />
            </div>
            {items.map((entry) => {
              const rowKey = `${entry.source}-${entry.id}`;
              const expanded = expandedId === rowKey;
              return (
                <Fragment key={rowKey}>
                  <div
                    className="grid items-center gap-3 border-b border-gray-100 py-2 odd:bg-white even:bg-gray-50/60 hover:bg-brand-blue/5"
                    style={{ gridTemplateColumns: GRID_COLUMNS }}
                  >
                    <div className="whitespace-nowrap text-gray-600">{formatDateTime(entry.createdAt)}</div>
                    <div>
                      <Badge tone={CATEGORY_TONES[entry.category]}>{CATEGORY_LABELS[entry.category]}</Badge>
                    </div>
                    <div className="truncate font-medium text-ink">{entry.farId ?? "—"}</div>
                    <div className="truncate text-gray-600">{entry.actorUsername ?? "Unknown user"}</div>
                    <div>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        className="flex items-center gap-1 whitespace-nowrap text-xs font-medium text-accent hover:underline"
                        onClick={() => setExpandedId(expanded ? null : rowKey)}
                      >
                        <ChevronDownIcon fontSize={13} className={expanded ? "" : "-rotate-90"} />
                        Details
                      </button>
                    </div>
                  </div>
                  {expanded && (
                    <div className="border-b border-gray-100 bg-gray-50 px-3 py-2 text-xs">
                      <DetailsSummary details={entry.details} />
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
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
    </div>
  );
}
