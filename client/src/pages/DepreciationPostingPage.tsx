import { useCallback, useEffect, useState } from "react";
import { fetchDepreciationPosting, type DepreciationPostingBreakdown } from "../api/client.js";
import { useSettings } from "../lib/SettingsContext.js";
import { formatCurrency, formatDate } from "../lib/format.js";
import { fySettingsKey } from "../lib/settingsKey.js";
import { Tooltip } from "../components/Tooltip.js";
import { CustomPeriodBadge, DATE_INPUT_CLASS } from "../components/CustomPeriodBadge.js";
import { FIELD_INFO } from "../lib/fieldInfo.js";
import { DepreciationIcon, ErrorIcon, RetryIcon } from "../lib/icons.js";

export function DepreciationPostingPage() {
  const { settings } = useSettings();
  const [total, setTotal] = useState<number | null>(null);
  const [breakdown, setBreakdown] = useState<DepreciationPostingBreakdown[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Independent of the app-wide "Figures as of" setting, same as Audit Reconciliation's
  // period override — seeded from it once, on first load, so picking a Date of
  // Depreciation here never touches Settings and vice versa. Only asAt is overridable
  // (unlike Audit Reconciliation's fyStart/fyEnd too) — this report never leaves the
  // current FY, it just posts the journal entry for a different date within it.
  const [depDate, setDepDate] = useState<string | null>(null);
  useEffect(() => {
    if (settings && !depDate) setDepDate(settings.asAt);
  }, [settings, depDate]);

  const isCustomDate = !!(settings && depDate && depDate !== settings.asAt);
  const settingsKey = fySettingsKey(settings);

  const load = useCallback(() => {
    if (!depDate) return;
    setLoading(true);
    setError(null);
    fetchDepreciationPosting(depDate)
      .then((res) => {
        setTotal(res.totalPeriodDepreciation);
        setBreakdown(res.breakdown);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the posting summary."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depDate]);

  useEffect(() => {
    load();
    // Also refetch on any global FY setting change (fyStart/fyEnd/daysInFy affect the
    // calc even when depDate is a custom override, since only asAt is overridden here).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, settingsKey]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <div className="border-b border-gray-200 px-6 py-4">
        <h1 className="text-base font-semibold text-ink">Depreciation Posting Summary</h1>
        <p className="mt-1 text-sm text-gray-500">
          The total depreciation for this period, across every asset and both cost components — the amount to post
          as a journal entry.
        </p>

        {depDate && (
          <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="dep-date" className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
                Date of Depreciation
              </label>
              <input
                id="dep-date"
                type="date"
                className={DATE_INPUT_CLASS}
                value={depDate}
                onChange={(e) => setDepDate(e.target.value)}
              />
            </div>
            {isCustomDate && settings && (
              <CustomPeriodBadge
                label="Custom date"
                resetLabel="Reset to current"
                onReset={() => setDepDate(settings.asAt)}
              />
            )}
          </div>
        )}
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
            Journal Entry — as of {depDate ? formatDate(depDate) : "…"}
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
