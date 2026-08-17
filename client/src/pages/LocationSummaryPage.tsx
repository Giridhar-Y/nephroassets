import { useEffect, useMemo, useState } from "react";
import { fetchCenters, fetchLocationSummary, type LocationSummary } from "../api/client.js";
import { useFilters } from "../lib/FiltersContext.js";
import { useSettings } from "../lib/SettingsContext.js";
import { useAssetList } from "../hooks/useAssetList.js";
import { AssetGrid } from "../components/AssetGrid.js";
import { Tooltip } from "../components/Tooltip.js";
import { ALL_COLUMNS, DEFAULT_VISIBLE_COLUMNS } from "../lib/columns.js";
import { formatCurrency, formatDate } from "../lib/format.js";
import { FIELD_INFO } from "../lib/fieldInfo.js";
import { fySettingsKey } from "../lib/settingsKey.js";

const COLUMNS = ALL_COLUMNS.filter((c) => DEFAULT_VISIBLE_COLUMNS.includes(c.id));

export function LocationSummaryPage() {
  const { settings } = useSettings();
  const { filters, setFilter } = useFilters();
  const asAt = settings?.asAt ?? null;
  const location = filters.center ?? "";

  const [centers, setCenters] = useState<string[]>([]);
  const [summary, setSummary] = useState<LocationSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  useEffect(() => {
    fetchCenters().then(setCenters).catch(() => {});
  }, []);

  const settingsKey = fySettingsKey(settings);

  useEffect(() => {
    if (!location || !asAt) {
      setSummary(null);
      return;
    }
    setSummaryLoading(true);
    setSummaryError(null);
    fetchLocationSummary(location, asAt)
      .then(setSummary)
      .catch((err) => setSummaryError(err instanceof Error ? err.message : "Could not load the summary."))
      .finally(() => setSummaryLoading(false));
    // Refetch on any FY setting change, not just AS_AT — settingsKey covers all of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, settingsKey]);

  const listFilters = useMemo(() => (location ? { center: location } : {}), [location]);
  const { items, nextCursor, loading, error, reload, loadMore } = useAssetList(location ? settings : null, listFilters);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-200 bg-white px-6 py-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="location-summary-picker" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Location
          </label>
          <select
            id="location-summary-picker"
            className="w-56 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={location}
            onChange={(e) => setFilter("center", e.target.value || undefined)}
          >
            <option value="">Choose a location…</option>
            {centers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {location && (
          <div className="mt-4 flex gap-6">
            <div className="rounded-xl bg-white px-5 py-4 shadow-sm">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Assets at this Location</div>
              <div className="mt-1 text-2xl font-semibold text-ink">
                {summaryLoading ? "…" : (summary?.assetCount ?? 0)}
              </div>
            </div>
            <div className="rounded-xl bg-white px-5 py-4 shadow-sm">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                <Tooltip text={FIELD_INFO.grossBlock.tooltip}>Total C1 {FIELD_INFO.grossBlock.label}</Tooltip>
              </div>
              <div className="mt-1 text-2xl font-semibold text-ink">
                {summaryLoading ? "…" : formatCurrency(summary?.totalC1GrossBlock ?? 0)}
              </div>
            </div>
            <div className="rounded-xl bg-white px-5 py-4 shadow-sm">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">As Of</div>
              <div className="mt-1 text-2xl font-semibold text-ink">{asAt ? formatDate(asAt) : "…"}</div>
            </div>
          </div>
        )}
        {summaryError && <p className="mt-2 text-sm text-red-600">{summaryError}</p>}
      </div>

      {!location ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
          <p className="text-sm font-medium text-gray-600">Choose a location to see its assets.</p>
          <p className="text-xs text-gray-400">You'll get a count and total Gross Block, plus the full list below.</p>
        </div>
      ) : (
        <AssetGrid
          items={items}
          columns={COLUMNS}
          loading={loading}
          error={error}
          hasMore={!!nextCursor}
          onLoadMore={loadMore}
          onRetry={reload}
          emptyTitle="No assets are currently at this location."
          emptyHint="Try a different location, or check the AS_AT date."
        />
      )}
    </div>
  );
}
