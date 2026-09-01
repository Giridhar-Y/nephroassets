import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  fetchCenters,
  fetchTransferDepreciationLocationWise,
  getTransferDepreciationExportUrl,
  type MovementScheduleRow,
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
import { EmptyIcon, ErrorIcon, ExportIcon, LocationIcon, TransferIcon } from "../lib/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";

const SCHEDULE_GRID_COLS = "grid-cols-[120px_1fr_130px_100px_100px_80px_100px_100px_110px]";
const ROW_HEIGHT = 40;

// Backs the collapsible "Location Totals" panel — same aggregate the export's own
// trailing Location Totals block uses, fetched only once the panel is opened (a full
// table scan; no reason to pay for it before the user asks to see it).
function LocationTotalsPanel({ asAt, conditions }: { asAt: string; conditions: ColumnCondition[] }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TransferDepreciationLocationRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conditionsKey = JSON.stringify(conditions);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetchTransferDepreciationLocationWise(asAt, conditions)
      .then((res) => setRows(res.locationWise))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load location totals."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, asAt, conditionsKey]);

  return (
    <details
      className="max-w-4xl rounded-md border border-gray-200"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2 text-sm font-medium text-ink hover:bg-gray-50">
        <LocationIcon fontSize={15} />
        Location Totals
      </summary>
      <div className="border-t border-gray-200 p-3">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        ) : error ? (
          <p className="flex items-center gap-1.5 text-sm text-red-600">
            <ErrorIcon fontSize={15} />
            {error}
          </p>
        ) : !rows || rows.length === 0 ? (
          <p className="py-2 text-sm text-gray-500">No depreciation to attribute for this period.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-gray-500">
                <th className="border-b-2 border-gray-300 py-1.5">Location</th>
                <th className="border-b-2 border-gray-300 py-1.5 text-right">Asset Count</th>
                <th className="border-b-2 border-gray-300 py-1.5 text-right">C1</th>
                <th className="border-b-2 border-gray-300 py-1.5 text-right">C2</th>
                <th className="border-b-2 border-gray-300 py-1.5 text-right">Total Depreciation</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.location}>
                  <td className="border-b border-gray-100 py-1.5 font-medium text-ink">{row.location}</td>
                  <td className="border-b border-gray-100 py-1.5 text-right tabular-nums">{row.assetCount}</td>
                  <td className="border-b border-gray-100 py-1.5 text-right tabular-nums">{formatCurrency(row.c1TotalDepreciation)}</td>
                  <td className="border-b border-gray-100 py-1.5 text-right tabular-nums">{formatCurrency(row.c2TotalDepreciation)}</td>
                  <td className="border-b border-gray-100 py-1.5 text-right tabular-nums">{formatCurrency(row.totalDepreciation)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="border-t-2 border-gray-300 py-1.5 font-semibold text-ink">Grand Total</td>
                <td className="border-t-2 border-gray-300 py-1.5 text-right font-semibold tabular-nums">
                  {rows.reduce((sum, r) => sum + r.assetCount, 0)}
                </td>
                <td className="border-t-2 border-gray-300 py-1.5 text-right font-semibold tabular-nums">
                  {formatCurrency(rows.reduce((sum, r) => sum + r.c1TotalDepreciation, 0))}
                </td>
                <td className="border-t-2 border-gray-300 py-1.5 text-right font-semibold tabular-nums">
                  {formatCurrency(rows.reduce((sum, r) => sum + r.c2TotalDepreciation, 0))}
                </td>
                <td className="border-t-2 border-gray-300 py-1.5 text-right font-semibold tabular-nums">
                  {formatCurrency(rows.reduce((sum, r) => sum + r.totalDepreciation, 0))}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </details>
  );
}

function ScheduleRow({ item }: { item: MovementScheduleRow }) {
  return (
    <div
      className={`grid w-full ${SCHEDULE_GRID_COLS} items-center border-b border-gray-100 px-3 py-2 text-left text-sm`}
      style={{ minHeight: ROW_HEIGHT }}
    >
      <span className="truncate font-medium text-ink">{item.farId}</span>
      <span className="truncate text-gray-600">{item.assetDescription}</span>
      <span className="truncate text-gray-600">{item.location}</span>
      <span className="truncate text-gray-600">{formatDate(item.fromDate)}</span>
      <span className="truncate text-gray-600">{formatDate(item.toDate)}</span>
      <span className="text-right tabular-nums text-gray-600">{item.daysHeld}</span>
      <span className="text-right tabular-nums text-gray-600">{formatCurrency(item.c1Depreciation)}</span>
      <span className="text-right tabular-nums text-gray-600">{formatCurrency(item.c2Depreciation)}</span>
      <span className="text-right tabular-nums text-ink">{formatCurrency(item.depreciation)}</span>
    </div>
  );
}

function ScheduleHeaderFilter({
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

function MovementScheduleTable({
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
  const { items, nextCursor, loading, error, loadMore } = useTransferDepreciationAssetList(fy, conditions);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasMore = !!nextCursor;

  // Fixed row height — no expand/collapse anymore, so no dynamic-size virtualizer needed
  // (see the plain estimateSize below, unlike the earlier per-asset-expand version).
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
    <div className="max-w-7xl rounded-md border border-gray-200">
      {error && (
        <p className="flex items-center gap-1.5 border-b border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">
          <ErrorIcon fontSize={15} />
          {error}
        </p>
      )}
      <div ref={scrollRef} className="max-h-[65vh] overflow-auto">
        <div
          className={`sticky top-0 z-10 grid ${SCHEDULE_GRID_COLS} items-center border-b-2 border-gray-300 bg-gray-50 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-gray-500`}
        >
          <span className="flex items-center gap-1">
            FAR ID
            <ScheduleHeaderFilter columnId="farId" label="FAR ID" type="text" conditions={conditions} onChange={onConditionChange} />
          </span>
          <span className="flex items-center gap-1">
            Description
            <ScheduleHeaderFilter
              columnId="assetDescription"
              label="Description"
              type="text"
              conditions={conditions}
              onChange={onConditionChange}
            />
          </span>
          <span className="flex items-center gap-1">
            Location
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
          <span>From</span>
          <span>To</span>
          <span className="text-right">Days Held</span>
          <span className="flex items-center justify-end gap-1">
            <ScheduleHeaderFilter columnId="c1TotalDepreciation" label="C1" type="number" conditions={conditions} onChange={onConditionChange} />
            C1
          </span>
          <span className="flex items-center justify-end gap-1">
            <ScheduleHeaderFilter columnId="c2TotalDepreciation" label="C2" type="number" conditions={conditions} onChange={onConditionChange} />
            C2
          </span>
          <span className="flex items-center justify-end gap-1">
            <ScheduleHeaderFilter
              columnId="totalDepreciation"
              label="Total Depreciation"
              type="number"
              conditions={conditions}
              onChange={onConditionChange}
            />
            Total
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
                <div
                  key={`${item.farId}-${item.fromDate}`}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  data-testid="movement-schedule-row"
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <ScheduleRow item={item} />
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
      <PageHeader
        icon={TransferIcon}
        title="Asset Movement & Depreciation Schedule"
        subtitle="Every asset, one row per location it physically sat in during the period — an asset that never moved
              still gets exactly one row."
        actions={
          <a
            href={exportUrl}
            className={`flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50 ${
              exportUrl ? "" : "pointer-events-none opacity-50"
            }`}
          >
            <ExportIcon fontSize={15} />
            Export to Excel
          </a>
        }
      >

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

        {conditions.length > 0 && (
          <div className="mt-4">
            <span className="flex items-center text-xs text-gray-500">
              {conditions.length} filter{conditions.length === 1 ? "" : "s"} applied
              <button type="button" className="ml-1.5 font-semibold text-accent hover:underline" onClick={() => setConditions([])}>
                Clear
              </button>
            </span>
          </div>
        )}
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
        {!asAt ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <LocationTotalsPanel key={settingsKey} asAt={asAt} conditions={conditions} />
            <MovementScheduleTable
              fy={{ ...settings!, asAt }}
              conditions={conditions}
              onConditionChange={handleConditionChange}
              locationOptions={locationOptions}
            />
          </div>
        )}
      </div>
    </div>
  );
}
