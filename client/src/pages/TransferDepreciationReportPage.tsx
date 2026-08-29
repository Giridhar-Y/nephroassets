import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  fetchCenters,
  fetchTransferDepreciationLocationWise,
  fetchTransferDepreciationSegments,
  getTransferDepreciationExportUrl,
  type LocationSegment,
  type TransferDepreciationAssetRow,
  type TransferDepreciationLocationRow
} from "../api/client.js";
import { useTransferDepreciationAssetList } from "../hooks/useTransferDepreciationAssetList.js";
import { useSettings } from "../lib/SettingsContext.js";
import { formatCurrency, formatDate } from "../lib/format.js";
import { fySettingsKey } from "../lib/settingsKey.js";
import { isConditionComplete, type ColumnCondition } from "../lib/columnFilters.js";
import type { FySettings } from "../lib/types.js";
import { CustomPeriodBadge, DATE_INPUT_CLASS } from "../components/CustomPeriodBadge.js";
import { ColumnFilterPopover, ConditionFilterPanel, DualModeFilterPanel } from "../components/ColumnFilterPopover.js";
import { ChevronDownIcon, EmptyIcon, ErrorIcon, ExportIcon, LocationIcon, RetryIcon, TransferIcon } from "../lib/icons.js";

type View = "location" | "asset";

const ASSET_GRID_COLS = "grid-cols-[28px_120px_1fr_130px_110px_110px_120px]";
const ROW_HEIGHT = 40;

function LocationWiseTable({ asAt, conditions }: { asAt: string; conditions: ColumnCondition[] }) {
  const [rows, setRows] = useState<TransferDepreciationLocationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const conditionsKey = JSON.stringify(conditions);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchTransferDepreciationLocationWise(asAt, conditions)
      .then((res) => setRows(res.locationWise))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the location-wise summary."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asAt, conditionsKey]);

  if (loading) {
    return (
      <div className="max-w-4xl space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-9 animate-pulse rounded bg-gray-100" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-red-600">
        <ErrorIcon fontSize={15} />
        {error}
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <EmptyIcon fontSize={28} className="text-gray-300" />
        <p className="text-sm font-medium text-gray-600">No depreciation to attribute for this period.</p>
      </div>
    );
  }

  const grandC1 = rows.reduce((sum, r) => sum + r.c1TotalDepreciation, 0);
  const grandC2 = rows.reduce((sum, r) => sum + r.c2TotalDepreciation, 0);
  const grandTotal = rows.reduce((sum, r) => sum + r.totalDepreciation, 0);

  return (
    // Own bounded scroll box with the header INSIDE it (not a sibling) — sticky only
    // works relative to its nearest scrolling ancestor, and this is what the asset-wise
    // table's own header-floating-mid-list bug turned out to be. This table is small
    // (bounded by distinct-location count, not asset count, even at 250k assets) so it
    // doesn't need virtualization, just the same correctly-scoped sticky header.
    <div className="max-w-4xl rounded-md border border-gray-200">
      <div className="max-h-[60vh] overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-10 bg-gray-50">
            <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-gray-500">
              <th className="border-b-2 border-gray-300 px-3 py-2">Location</th>
              <th className="border-b-2 border-gray-300 px-3 py-2 text-right">Asset Count</th>
              <th className="border-b-2 border-gray-300 px-3 py-2 text-right">C1</th>
              <th className="border-b-2 border-gray-300 px-3 py-2 text-right">C2</th>
              <th className="border-b-2 border-gray-300 px-3 py-2 text-right">Total Depreciation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.location}>
                <td className="border-b border-gray-100 px-3 py-2 font-medium text-ink">{row.location}</td>
                <td className="border-b border-gray-100 px-3 py-2 text-right tabular-nums">{row.assetCount}</td>
                <td className="border-b border-gray-100 px-3 py-2 text-right tabular-nums">
                  {formatCurrency(row.c1TotalDepreciation)}
                </td>
                <td className="border-b border-gray-100 px-3 py-2 text-right tabular-nums">
                  {formatCurrency(row.c2TotalDepreciation)}
                </td>
                <td className="border-b border-gray-100 px-3 py-2 text-right tabular-nums">
                  {formatCurrency(row.totalDepreciation)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="border-t-2 border-gray-300 px-3 py-2 font-semibold text-ink">Total</td>
              <td className="border-t-2 border-gray-300 px-3 py-2 text-right font-semibold tabular-nums">
                {rows.reduce((sum, r) => sum + r.assetCount, 0)}
              </td>
              <td className="border-t-2 border-gray-300 px-3 py-2 text-right font-semibold tabular-nums">
                {formatCurrency(grandC1)}
              </td>
              <td className="border-t-2 border-gray-300 px-3 py-2 text-right font-semibold tabular-nums">
                {formatCurrency(grandC2)}
              </td>
              <td className="border-t-2 border-gray-300 px-3 py-2 text-right font-semibold tabular-nums">
                {formatCurrency(grandTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function MovementTimeline({ farId, asAt }: { farId: string; asAt: string }) {
  const [segments, setSegments] = useState<LocationSegment[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchTransferDepreciationSegments(farId, asAt)
      .then((res) => setSegments(res.segments))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load movement history."))
      .finally(() => setLoading(false));
  }, [farId, asAt]);

  if (loading) return <p className="py-2 text-xs text-gray-400">Loading movement history…</p>;
  if (error) {
    return (
      <p className="flex items-center gap-1.5 py-2 text-xs text-red-600">
        <ErrorIcon fontSize={13} />
        {error}
      </p>
    );
  }
  if (!segments || segments.length === 0) {
    return <p className="py-2 text-xs text-gray-400">No location history for this period.</p>;
  }

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left font-semibold text-gray-500">
          <th className="py-1 pr-3">Location</th>
          <th className="py-1 pr-3">From</th>
          <th className="py-1 pr-3">To</th>
          <th className="py-1 pr-3 text-right">Days Held</th>
          <th className="py-1 pr-3 text-right">C1</th>
          <th className="py-1 pr-3 text-right">C2</th>
          <th className="py-1 pr-3 text-right">Depreciation</th>
        </tr>
      </thead>
      <tbody>
        {segments.map((seg, i) => (
          <tr key={i} data-testid="movement-segment-row">
            <td className="py-1 pr-3 font-medium text-ink">{seg.location}</td>
            <td className="py-1 pr-3 text-gray-600">{formatDate(seg.fromDate)}</td>
            <td className="py-1 pr-3 text-gray-600">{formatDate(seg.toDate)}</td>
            <td className="py-1 pr-3 text-right tabular-nums text-gray-600">{seg.daysHeld}</td>
            <td className="py-1 pr-3 text-right tabular-nums text-gray-600">{formatCurrency(seg.c1Depreciation)}</td>
            <td className="py-1 pr-3 text-right tabular-nums text-gray-600">{formatCurrency(seg.c2Depreciation)}</td>
            <td className="py-1 pr-3 text-right tabular-nums text-gray-600">{formatCurrency(seg.depreciation)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AssetRow({
  item,
  asAt,
  expanded,
  onToggle
}: {
  item: TransferDepreciationAssetRow;
  asAt: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-gray-100">
      <button
        type="button"
        onClick={onToggle}
        className={`grid w-full ${ASSET_GRID_COLS} items-center px-3 py-2 text-left text-sm hover:bg-gray-50`}
        style={{ minHeight: ROW_HEIGHT }}
        aria-expanded={expanded}
      >
        <ChevronDownIcon
          fontSize={14}
          className={`shrink-0 text-gray-400 transition-transform ${expanded ? "" : "-rotate-90"}`}
        />
        <span className="truncate font-medium text-ink">{item.farId}</span>
        <span className="truncate text-gray-600">{item.assetDescription}</span>
        <span className="truncate text-gray-600">{item.currentLocation}</span>
        <span className="text-right tabular-nums text-gray-600">{formatCurrency(item.c1TotalDepreciation)}</span>
        <span className="text-right tabular-nums text-gray-600">{formatCurrency(item.c2TotalDepreciation)}</span>
        <span className="text-right tabular-nums text-ink">{formatCurrency(item.totalDepreciation)}</span>
      </button>

      {/* Fetched lazily, only for the asset actually expanded — see MovementTimeline —
          not pre-computed for every row of a list that can run to 250k assets. */}
      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50 px-3 py-2">
          <MovementTimeline farId={item.farId} asAt={asAt} />
        </div>
      )}
    </div>
  );
}

function AssetWiseHeaderFilter({
  columnId,
  label,
  type,
  conditions,
  onChange
}: {
  columnId: string;
  label: string;
  type: "text" | "number";
  conditions: ColumnCondition[];
  onChange: (columnId: string, next: ColumnCondition | undefined) => void;
}) {
  const current = conditions.find((c) => c.columnId === columnId);
  return (
    <ColumnFilterPopover label={label} active={!!current}>
      {() => (
        <ConditionFilterPanel
          label={label}
          columnId={columnId}
          type={type}
          condition={current}
          onChange={(next) => onChange(columnId, next)}
        />
      )}
    </ColumnFilterPopover>
  );
}

function AssetWiseTable({
  fy,
  conditions,
  onConditionChange,
  locationOptions
}: {
  fy: FySettings;
  conditions: ColumnCondition[];
  onConditionChange: (columnId: string, next: ColumnCondition | undefined) => void;
  locationOptions: string[];
}) {
  const asAt = fy.asAt;
  const { items, nextCursor, loading, error, loadMore } = useTransferDepreciationAssetList(fy, conditions);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Any number of rows can be expanded at once — each one's movement timeline is
  // independent, and comparing two assets side by side is a real use case.
  const [expandedFarIds, setExpandedFarIds] = useState<Set<string>>(new Set());
  const hasMore = !!nextCursor;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8
  });

  // Same load-more-near-the-end trigger as AssetGrid.tsx (Register) — fetches the next
  // page once the last rendered virtual row is within 20 rows of the end of what's
  // currently loaded.
  useEffect(() => {
    const virtualItems = virtualizer.getVirtualItems();
    const last = virtualItems[virtualItems.length - 1];
    if (hasMore && last && last.index >= items.length - 20) {
      loadMore();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualizer.getVirtualItems(), items.length, hasMore]);

  const currentLocationCondition = conditions.find((c) => c.columnId === "currentLocation");

  return (
    <div className="max-w-5xl rounded-md border border-gray-200">
      {error && (
        <p className="flex items-center gap-1.5 border-b border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">
          <ErrorIcon fontSize={15} />
          {error}
        </p>
      )}
      <div ref={scrollRef} className="max-h-[60vh] overflow-auto">
        <div
          className={`sticky top-0 z-10 grid ${ASSET_GRID_COLS} items-center border-b-2 border-gray-300 bg-gray-50 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-gray-500`}
        >
          <span />
          <span className="flex items-center gap-1">
            FAR ID
            <AssetWiseHeaderFilter columnId="farId" label="FAR ID" type="text" conditions={conditions} onChange={onConditionChange} />
          </span>
          <span className="flex items-center gap-1">
            Description
            <AssetWiseHeaderFilter
              columnId="assetDescription"
              label="Description"
              type="text"
              conditions={conditions}
              onChange={onConditionChange}
            />
          </span>
          <span className="flex items-center gap-1">
            Current Location
            <ColumnFilterPopover label="Current Location" active={!!currentLocationCondition}>
              {() => (
                <DualModeFilterPanel
                  label="Current Location"
                  columnId="currentLocation"
                  type="text"
                  options={locationOptions}
                  selectValue={[]}
                  onSelectChange={() => {}}
                  condition={currentLocationCondition}
                  onConditionChange={(next) => onConditionChange("currentLocation", next)}
                />
              )}
            </ColumnFilterPopover>
          </span>
          <span className="flex items-center justify-end gap-1">
            <AssetWiseHeaderFilter columnId="c1TotalDepreciation" label="C1" type="number" conditions={conditions} onChange={onConditionChange} />
            C1
          </span>
          <span className="flex items-center justify-end gap-1">
            <AssetWiseHeaderFilter columnId="c2TotalDepreciation" label="C2" type="number" conditions={conditions} onChange={onConditionChange} />
            C2
          </span>
          <span className="flex items-center justify-end gap-1">
            <AssetWiseHeaderFilter
              columnId="totalDepreciation"
              label="Total Depreciation"
              type="number"
              conditions={conditions}
              onChange={onConditionChange}
            />
            Total Depreciation
          </span>
        </div>

        {loading && items.length === 0 ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <EmptyIcon fontSize={28} className="text-gray-300" />
            <p className="text-sm font-medium text-gray-600">No assets match these filters.</p>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = items[virtualRow.index]!;
              return (
                // The measured element carries both `data-index` and the absolute
                // positioning it updates via `translateY` — see the commit that fixed
                // the header-floating/row-overlap bugs for why these must be on the
                // same element.
                <div
                  key={item.farId}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  data-testid="asset-wise-row"
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <AssetRow
                    item={item}
                    asAt={asAt}
                    expanded={expandedFarIds.has(item.farId)}
                    onToggle={() =>
                      setExpandedFarIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(item.farId)) next.delete(item.farId);
                        else next.add(item.farId);
                        return next;
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function TransferDepreciationReportPage() {
  const { settings } = useSettings();
  const [asAt, setAsAt] = useState<string | null>(null);
  const [view, setView] = useState<View>("asset");
  const [conditions, setConditions] = useState<ColumnCondition[]>([]);
  const [locationOptions, setLocationOptions] = useState<string[]>([]);

  useEffect(() => {
    fetchCenters()
      .then(setLocationOptions)
      .catch(() => {});
  }, []);

  // Independent of the app-wide "Figures as of" setting, same as Depreciation Posting's
  // Date of Depreciation override — seeded from it once, on first load.
  useEffect(() => {
    if (settings && !asAt) setAsAt(settings.asAt);
  }, [settings, asAt]);

  const isCustomDate = !!(settings && asAt && asAt !== settings.asAt);
  const settingsKey = fySettingsKey(settings);

  const handleConditionChange = useCallback((columnId: string, next: ColumnCondition | undefined) => {
    setConditions((prev) => {
      const rest = prev.filter((c) => c.columnId !== columnId);
      return isConditionComplete(next) ? [...rest, next] : rest;
    });
  }, []);

  const exportUrl = useMemo(() => (asAt ? getTransferDepreciationExportUrl(asAt, conditions) : undefined), [asAt, conditions]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <div className="border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
              <TransferIcon fontSize={20} />
              Transfer &amp; Depreciation Report
            </h1>
            <p className="mt-1 max-w-xl text-sm text-gray-500">
              Each asset's period depreciation, split across every location it physically sat in — not just its
              current one.
            </p>
          </div>
          <a
            href={exportUrl}
            className={`flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50 ${
              exportUrl ? "" : "pointer-events-none opacity-50"
            }`}
          >
            <ExportIcon fontSize={15} />
            Export to Excel
          </a>
        </div>

        {asAt && (
          <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="xdep-date" className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
                Figures as of
              </label>
              <input
                id="xdep-date"
                type="date"
                className={DATE_INPUT_CLASS}
                value={asAt}
                onChange={(e) => setAsAt(e.target.value)}
              />
            </div>
            {isCustomDate && settings && (
              <CustomPeriodBadge label="Custom date" resetLabel="Reset to current" onReset={() => setAsAt(settings.asAt)} />
            )}
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold ${
              view === "asset" ? "bg-accent text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
            onClick={() => setView("asset")}
          >
            <TransferIcon fontSize={14} />
            Asset-wise
          </button>
          <button
            type="button"
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold ${
              view === "location" ? "bg-accent text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
            onClick={() => setView("location")}
          >
            <LocationIcon fontSize={14} />
            Location-wise
          </button>
          {conditions.length > 0 && (
            <span className="flex items-center text-xs text-gray-500">
              {conditions.length} filter{conditions.length === 1 ? "" : "s"} applied
              <button type="button" className="ml-1.5 font-semibold text-accent hover:underline" onClick={() => setConditions([])}>
                Clear
              </button>
            </span>
          )}
        </div>
        {view === "location" && (
          <p className="mt-1 text-xs text-gray-500">
            Filters are set from the Asset-wise view's column headers and apply to both views.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
        {!asAt ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        ) : view === "location" ? (
          <LocationWiseTable key={settingsKey} asAt={asAt} conditions={conditions} />
        ) : (
          <AssetWiseTable
            fy={{ ...settings!, asAt }}
            conditions={conditions}
            onConditionChange={handleConditionChange}
            locationOptions={locationOptions}
          />
        )}
      </div>
    </div>
  );
}
