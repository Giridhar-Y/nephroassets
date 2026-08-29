import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  fetchTransferDepreciationReport,
  getTransferDepreciationExportUrl,
  type TransferDepreciationAssetRow,
  type TransferDepreciationReport
} from "../api/client.js";
import { useSettings } from "../lib/SettingsContext.js";
import { formatCurrency, formatDate } from "../lib/format.js";
import { fySettingsKey } from "../lib/settingsKey.js";
import { CustomPeriodBadge, DATE_INPUT_CLASS } from "../components/CustomPeriodBadge.js";
import { ChevronDownIcon, EmptyIcon, ErrorIcon, ExportIcon, LocationIcon, RetryIcon, TransferIcon } from "../lib/icons.js";

type View = "location" | "asset";

const ASSET_GRID_COLS = "grid-cols-[28px_120px_1fr_130px_110px_110px_120px]";
const ROW_HEIGHT = 40;

function LocationWiseTable({ report }: { report: TransferDepreciationReport }) {
  if (report.locationWise.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <EmptyIcon fontSize={28} className="text-gray-300" />
        <p className="text-sm font-medium text-gray-600">No depreciation to attribute for this period.</p>
      </div>
    );
  }
  const grandC1 = report.locationWise.reduce((sum, r) => sum + r.c1TotalDepreciation, 0);
  const grandC2 = report.locationWise.reduce((sum, r) => sum + r.c2TotalDepreciation, 0);
  const grandTotal = report.locationWise.reduce((sum, r) => sum + r.totalDepreciation, 0);
  return (
    <table className="w-full max-w-4xl border-separate border-spacing-0 text-sm">
      <thead>
        <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-gray-500">
          <th className="border-b-2 border-gray-300 py-2 pr-3">Location</th>
          <th className="border-b-2 border-gray-300 py-2 pr-3 text-right">Asset Count</th>
          <th className="border-b-2 border-gray-300 py-2 pr-3 text-right">C1</th>
          <th className="border-b-2 border-gray-300 py-2 pr-3 text-right">C2</th>
          <th className="border-b-2 border-gray-300 py-2 pr-3 text-right">Total Depreciation</th>
        </tr>
      </thead>
      <tbody>
        {report.locationWise.map((row) => (
          <tr key={row.location}>
            <td className="border-b border-gray-100 py-2 pr-3 font-medium text-ink">{row.location}</td>
            <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">{row.assetCount}</td>
            <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">
              {formatCurrency(row.c1TotalDepreciation)}
            </td>
            <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">
              {formatCurrency(row.c2TotalDepreciation)}
            </td>
            <td className="border-b border-gray-100 py-2 pr-3 text-right tabular-nums">
              {formatCurrency(row.totalDepreciation)}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td className="border-t-2 border-gray-300 py-2 pr-3 font-semibold text-ink">Total</td>
          <td className="border-t-2 border-gray-300 py-2 pr-3 text-right font-semibold tabular-nums">
            {report.locationWise.reduce((sum, r) => sum + r.assetCount, 0)}
          </td>
          <td className="border-t-2 border-gray-300 py-2 pr-3 text-right font-semibold tabular-nums">
            {formatCurrency(grandC1)}
          </td>
          <td className="border-t-2 border-gray-300 py-2 pr-3 text-right font-semibold tabular-nums">
            {formatCurrency(grandC2)}
          </td>
          <td className="border-t-2 border-gray-300 py-2 pr-3 text-right font-semibold tabular-nums">
            {formatCurrency(grandTotal)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function AssetRow({
  item,
  expanded,
  onToggle
}: {
  item: TransferDepreciationAssetRow;
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

      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50 px-3 py-2">
          {item.segments.length === 0 ? (
            <p className="py-2 text-xs text-gray-400">No location history for this period.</p>
          ) : (
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
                {item.segments.map((seg, i) => (
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
          )}
        </div>
      )}
    </div>
  );
}

function AssetWiseTable({ report }: { report: TransferDepreciationReport }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Any number of rows can be expanded at once — each one's movement timeline is
  // independent, and comparing two assets side by side is a real use case.
  const [expandedFarIds, setExpandedFarIds] = useState<Set<string>>(new Set());

  const virtualizer = useVirtualizer({
    count: report.assetWise.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8
  });

  if (report.assetWise.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <EmptyIcon fontSize={28} className="text-gray-300" />
        <p className="text-sm font-medium text-gray-600">No assets in this period.</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl rounded-md border border-gray-200">
      {/* The sticky header must be a child of the SAME scrolling element as the rows —
          `position: sticky` sticks relative to its nearest scrolling ancestor, so a
          header living outside `scrollRef` (as a sibling, sticky relative to the outer
          page scroll instead) detaches from this box entirely once the page scrolls,
          pinning to the viewport's top while the rows scroll independently underneath
          it — the exact "header floating mid-list" bug. Register's AssetGrid puts its
          sticky header inside the same scroll container for this reason; this now
          matches. */}
      <div ref={scrollRef} className="max-h-[60vh] overflow-auto">
        <div
          className={`sticky top-0 z-10 grid ${ASSET_GRID_COLS} border-b-2 border-gray-300 bg-gray-50 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-gray-500`}
        >
          <span />
          <span>FAR ID</span>
          <span>Description</span>
          <span>Current Location</span>
          <span className="text-right">C1</span>
          <span className="text-right">C2</span>
          <span className="text-right">Total Depreciation</span>
        </div>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = report.assetWise[virtualRow.index]!;
            return (
              // The measured element MUST be the one carrying both `data-index` (so the
              // virtualizer's ResizeObserver can attribute a size change to the right
              // item) and the absolute positioning it then updates via `translateY` —
              // splitting those across a wrapper + a nested ref (the bug this replaced)
              // let the virtualizer measure a size it could never actually attribute to
              // an index, so later rows' offsets never shifted and an expanded row's
              // detail table rendered on top of whatever came after it instead of
              // pushing it down.
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
      </div>
    </div>
  );
}

export function TransferDepreciationReportPage() {
  const { settings } = useSettings();
  const [asAt, setAsAt] = useState<string | null>(null);
  const [view, setView] = useState<View>("location");
  const [report, setReport] = useState<TransferDepreciationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Independent of the app-wide "Figures as of" setting, same as Depreciation Posting's
  // Date of Depreciation override — seeded from it once, on first load.
  useEffect(() => {
    if (settings && !asAt) setAsAt(settings.asAt);
  }, [settings, asAt]);

  const isCustomDate = !!(settings && asAt && asAt !== settings.asAt);
  const settingsKey = fySettingsKey(settings);

  const load = useCallback(() => {
    if (!asAt) return;
    setLoading(true);
    setError(null);
    fetchTransferDepreciationReport(asAt)
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the report."))
      .finally(() => setLoading(false));
  }, [asAt]);

  useEffect(() => {
    load();
    // Also refetch on any global FY setting change, same reasoning as Depreciation
    // Posting: fyStart/fyEnd/daysInFy affect the calc even under a custom asAt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, settingsKey]);

  const exportUrl = useMemo(() => (asAt ? getTransferDepreciationExportUrl(asAt) : undefined), [asAt]);

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
              view === "location" ? "bg-accent text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
            onClick={() => setView("location")}
          >
            <LocationIcon fontSize={14} />
            Location-wise
          </button>
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
        </div>
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

        {loading || !report ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        ) : view === "location" ? (
          <LocationWiseTable report={report} />
        ) : (
          <AssetWiseTable report={report} />
        )}
      </div>
    </div>
  );
}
