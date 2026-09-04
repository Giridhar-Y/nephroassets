import { useEffect, useState } from "react";
import {
  fetchCenters,
  fetchRegisterSummary,
  fetchStatuses,
  fetchSubClassifications,
  getRegisterSummaryExportUrl,
  type RegisterSummaryResult,
  type SubClassificationOption
} from "../api/client.js";
import { useSettings } from "../lib/SettingsContext.js";
import { formatCurrency } from "../lib/format.js";
import { DATE_INPUT_CLASS } from "../components/CustomPeriodBadge.js";
import { EmptyIcon, ErrorIcon, RegisterIcon, RetryIcon } from "../lib/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { ExportButton } from "../components/ui/ExportButton.js";

const SELECT_CLASS =
  "rounded-md border border-gray-300 px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

// Only Qty is a plain count — every other numeric column here is a cost/depreciation
// figure, formatted the same Indian-currency way Audit Reconciliation's own totals are
// (formatCurrency), for the same on-screen readability reason; the CSV export (unlike
// this page) keeps every value a plain unformatted number, matching every other export
// this app produces.
function formatCell(key: string, value: number): string {
  return key === "qty" ? String(value) : formatCurrency(value);
}

export function RegisterSummaryPage() {
  const { settings } = useSettings();
  const asAt = settings?.asAt;

  const [centers, setCenters] = useState<string[]>([]);
  const [subClassifications, setSubClassifications] = useState<SubClassificationOption[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  useEffect(() => {
    fetchCenters().then(setCenters).catch(() => {});
    fetchSubClassifications().then(setSubClassifications).catch(() => {});
    fetchStatuses().then(setStatuses).catch(() => {});
  }, []);

  // Deliberately simple single-select filters (not Register's own multi-select/Excel-
  // condition filtering) — this report is for checking totals, most often against one
  // center/classification/status at a time, and the server route already accepts the
  // richer filter set (multi-value, computed conditions) if a future need for that
  // shows up here; nothing about this page's own filters would need to change to add
  // it, since it's the API shape, not this UI, that would grow.
  const [center, setCenter] = useState("");
  const [subClassification, setSubClassification] = useState("");
  const [status, setStatus] = useState("");
  const [dateAcquiredFrom, setDateAcquiredFrom] = useState("");
  const [dateAcquiredTo, setDateAcquiredTo] = useState("");
  const hasFilters = !!(center || subClassification || status || dateAcquiredFrom || dateAcquiredTo);

  const [data, setData] = useState<RegisterSummaryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    if (!asAt) return;
    setLoading(true);
    setError(null);
    fetchRegisterSummary({
      asAt,
      center: center || undefined,
      subClassification: subClassification || undefined,
      status: status || undefined,
      dateAcquiredFrom: dateAcquiredFrom || undefined,
      dateAcquiredTo: dateAcquiredTo || undefined
    })
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the register summary."))
      .finally(() => setLoading(false));
  }

  // Reruns on every filter change, same reactive convention Audit Reconciliation's own
  // period selector already uses — no separate "Apply" button to remember to click.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asAt, center, subClassification, status, dateAcquiredFrom, dateAcquiredTo]);

  const exportUrl = asAt
    ? getRegisterSummaryExportUrl({
        asAt,
        center: center || undefined,
        subClassification: subClassification || undefined,
        status: status || undefined,
        dateAcquiredFrom: dateAcquiredFrom || undefined,
        dateAcquiredTo: dateAcquiredTo || undefined
      })
    : undefined;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <PageHeader
        icon={RegisterIcon}
        title="Register Summary"
        subtitle="The Register Export's own figures, totaled by Sub Classification, Status, and Location instead of listed
          one row per asset — for cross-checking against a manually-maintained FAR file organized the same way."
        actions={<ExportButton url={exportUrl} />}
      >
        <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="summary-location" className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
              Location
            </label>
            <select id="summary-location" className={SELECT_CLASS} value={center} onChange={(e) => setCenter(e.target.value)}>
              <option value="">All Locations</option>
              {centers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="summary-subclass" className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
              Sub Classification
            </label>
            <select
              id="summary-subclass"
              className={SELECT_CLASS}
              value={subClassification}
              onChange={(e) => setSubClassification(e.target.value)}
            >
              <option value="">All Sub Classifications</option>
              {subClassifications.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="summary-status" className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
              Status
            </label>
            <select id="summary-status" className={SELECT_CLASS} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All Statuses</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="summary-date-from" className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
              Date Acquired From
            </label>
            <input
              id="summary-date-from"
              type="date"
              className={DATE_INPUT_CLASS}
              value={dateAcquiredFrom}
              max={dateAcquiredTo || undefined}
              onChange={(e) => setDateAcquiredFrom(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="summary-date-to" className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
              Date Acquired To
            </label>
            <input
              id="summary-date-to"
              type="date"
              className={DATE_INPUT_CLASS}
              value={dateAcquiredTo}
              min={dateAcquiredFrom || undefined}
              onChange={(e) => setDateAcquiredTo(e.target.value)}
            />
          </div>
          {hasFilters && (
            <button
              type="button"
              className="text-xs font-medium text-gray-500 underline hover:text-ink"
              onClick={() => {
                setCenter("");
                setSubClassification("");
                setStatus("");
                setDateAcquiredFrom("");
                setDateAcquiredTo("");
              }}
            >
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

      {!loading && !error && data && (
        <p className="border-b border-gray-100 bg-gray-50 px-6 py-1.5 text-xs text-gray-500">
          Filters applied: {data.filterSummaryText}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        ) : !data || data.groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
            <EmptyIcon fontSize={28} className="text-gray-300" />
            <p className="text-sm font-medium text-gray-600">No assets match these filters.</p>
          </div>
        ) : (
          <table className="w-full min-w-[3600px] border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-gray-500">
                <th className="border-b-2 border-gray-300 py-2 pr-3">Sub Classification</th>
                <th className="border-b-2 border-gray-300 py-2 pr-3">Status</th>
                <th className="border-b-2 border-gray-300 py-2 pr-3">Location</th>
                <th className="border-b-2 border-gray-300 py-2 pr-3 text-right">Asset Count</th>
                {data.columns.map((c) => (
                  <th key={c.key} className="whitespace-nowrap border-b-2 border-gray-300 py-2 pr-3 text-right">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.groups.map((g) => (
                <tr key={`${g.subClassification}|${g.status}|${g.location}`}>
                  <td className="border-b border-gray-100 py-2 pr-3 font-medium text-ink">{g.subClassification}</td>
                  <td className="border-b border-gray-100 py-2 pr-3">{g.status}</td>
                  <td className="border-b border-gray-100 py-2 pr-3">{g.location}</td>
                  <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">{g.assetCount}</td>
                  {data.columns.map((c) => (
                    <td key={c.key} className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">
                      {formatCell(c.key, g[c.key] as number)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              {/* Bold, distinct top border — same "Grand Total stands apart" convention
                  the old styled Register Export used (a bold totals row), the one part
                  of that presentation this report keeps even though the export itself
                  moved to plain CSV. */}
              <tr className="font-bold text-ink">
                <td className="border-t-2 border-gray-300 bg-gray-50 py-2 pr-3" colSpan={3}>
                  GRAND TOTAL
                </td>
                <td className="border-t-2 border-gray-300 bg-gray-50 py-2 pr-3 text-right tabular-nums">
                  {data.grandTotal.assetCount}
                </td>
                {data.columns.map((c) => (
                  <td key={c.key} className="border-t-2 border-gray-300 bg-gray-50 py-2 pr-3 text-right tabular-nums">
                    {formatCell(c.key, data.grandTotal[c.key] as number)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
