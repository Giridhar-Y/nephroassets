import { useCallback, useEffect, useState } from "react";
import { fetchDepreciationPosting, type DepreciationPostingBreakdown } from "../api/client.js";
import { useSettings } from "../lib/SettingsContext.js";
import { formatCurrency, formatDate } from "../lib/format.js";
import { fySettingsKey } from "../lib/settingsKey.js";
import { Tooltip } from "../components/Tooltip.js";
import { FIELD_INFO } from "../lib/fieldInfo.js";
import { DepreciationIcon, ErrorIcon, RetryIcon } from "../lib/icons.js";

export function DepreciationPostingPage() {
  const { settings } = useSettings();
  const asAt = settings?.asAt ?? null;
  const [total, setTotal] = useState<number | null>(null);
  const [breakdown, setBreakdown] = useState<DepreciationPostingBreakdown[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const settingsKey = fySettingsKey(settings);

  const load = useCallback(() => {
    if (!asAt) return;
    setLoading(true);
    setError(null);
    fetchDepreciationPosting(asAt)
      .then((res) => {
        setTotal(res.totalPeriodDepreciation);
        setBreakdown(res.breakdown);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the posting summary."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asAt]);

  useEffect(() => {
    load();
    // Refetch on any FY setting change, not just AS_AT.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <div className="border-b border-gray-200 px-6 py-4">
        <h1 className="text-base font-semibold text-ink">Depreciation Posting Summary</h1>
        <p className="mt-1 text-sm text-gray-500">
          The total depreciation for this period, across every asset and both cost components — the amount to post
          as a journal entry.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
        {error && (
          <p className="mb-4 flex items-center gap-1.5 text-sm text-red-600">
            <ErrorIcon fontSize={15} />
            {error}{" "}
            <button className="flex items-center gap-1 font-semibold underline" onClick={load}>
              <RetryIcon fontSize={13} />
              Retry
            </button>
          </p>
        )}

        <div className="max-w-md rounded-xl bg-white px-6 py-5 shadow-sm">
          <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-500">
            <DepreciationIcon fontSize={14} />
            Journal Entry — as of {asAt ? formatDate(asAt) : "…"}
          </div>
          <div className="mt-2 text-3xl font-semibold text-ink">
            {loading || total === null ? "…" : formatCurrency(total)}
          </div>
          <div className="mt-3 space-y-1 text-sm text-gray-600">
            <div className="flex justify-between">
              <span>Dr. Depreciation Expense</span>
              <span className="tabular-nums">{loading || total === null ? "…" : formatCurrency(total)}</span>
            </div>
            <div className="flex justify-between">
              <span>Cr. Accumulated Depreciation</span>
              <span className="tabular-nums">{loading || total === null ? "…" : formatCurrency(total)}</span>
            </div>
          </div>
        </div>

        <h2 className="mt-8 text-sm font-semibold text-ink">By Sub Classification</h2>
        {loading ? (
          <div className="mt-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        ) : breakdown.length === 0 ? (
          <p className="mt-3 text-sm text-gray-400">No depreciation to post yet.</p>
        ) : (
          <table className="mt-3 w-full max-w-2xl border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-gray-500">
                <th className="border-b-2 border-gray-300 py-2 pr-3">Sub Classification</th>
                <th className="border-b-2 border-gray-300 py-2 pr-3 text-right">
                  <Tooltip text={`${FIELD_INFO.periodDepreciation.tooltip} (Cost Component 1)`}>C1</Tooltip>
                </th>
                <th className="border-b-2 border-gray-300 py-2 pr-3 text-right">
                  <Tooltip text={`${FIELD_INFO.periodDepreciation.tooltip} (Cost Component 2)`}>C2</Tooltip>
                </th>
                <th className="border-b-2 border-gray-300 py-2 pr-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map((b) => (
                <tr key={b.subClassification}>
                  <td className="border-b border-gray-100 py-2 pr-3 font-medium text-ink">{b.subClassification}</td>
                  <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">
                    {formatCurrency(b.c1PeriodDep)}
                  </td>
                  <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">
                    {formatCurrency(b.c2PeriodDep)}
                  </td>
                  <td className="border-b border-gray-100 py-2 pr-3 text-right font-semibold tabular-nums">
                    {formatCurrency(b.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
