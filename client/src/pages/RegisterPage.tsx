import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.js";
import { useFilters } from "../lib/FiltersContext.js";
import { useSettings } from "../lib/SettingsContext.js";
import { useColumnPrefs } from "../lib/useColumnPrefs.js";
import { useAssetList } from "../hooks/useAssetList.js";
import { ColumnPicker } from "../components/ColumnPicker.js";
import { TransferModal } from "../components/TransferModal.js";
import { DisposalModal } from "../components/DisposalModal.js";
import { MergeModal } from "../components/MergeModal.js";
import { EditAssetModal } from "../components/EditAssetModal.js";
import { AssetGrid } from "../components/AssetGrid.js";
import { RecordMovementControl } from "../components/RecordMovementControl.js";
import { ColumnFilterPopover, ConditionFilterPanel, DualModeFilterPanel } from "../components/ColumnFilterPopover.js";
import { SearchIcon } from "../lib/icons.js";
import { useDensity } from "../hooks/useDensity.js";
import { Tooltip } from "../components/Tooltip.js";
import { ExportButton } from "../components/ui/ExportButton.js";
import { GridViewControls } from "../components/ui/GridViewControls.js";
import { formatCompactIndianCount } from "../lib/format.js";
import { toggleRegisterSelection, type SelectionState } from "../lib/registerSelection.js";
import { groupParentChildRows } from "../lib/registerGrouping.js";
import { fetchCenters, fetchStatuses, fetchSubClassifications, getExportUrl, type SubClassificationOption } from "../api/client.js";
import { isConditionComplete, OPERATORS_BY_TYPE, type ColumnCondition, type ColumnFilterType } from "../lib/columnFilters.js";
import { allScopedC1Only, C2_COLUMN_IDS, hideC2Columns, scopedSubClassificationNames } from "../lib/columns.js";
import { hasPermission } from "../lib/permissions.js";
import { FilterChips, type FilterChip } from "../components/ui/FilterChips.js";
import { EXCEPTION_LABELS, isExceptionKey } from "../lib/exceptions.js";

// Every Register column that gets a plain Excel-style custom-condition filter (operator
// + value, no "distinct values" checklist) — the four columns that also get a checklist
// (Sub Classification, Status, the two Location columns) are wired up separately below
// via DualModeFilterPanel, since those need extra props (the options list, the existing
// multi-select filter state) this generic table doesn't have.
const CONDITION_COLUMNS: Array<{ id: string; label: string; type: ColumnFilterType }> = [
  { id: "farId", label: "FAR ID", type: "text" },
  { id: "assetDescription", label: "Asset Description", type: "text" },
  { id: "dateAcquired", label: "Date Acquired", type: "date" },
  { id: "lastDateOfTransaction", label: "Last Transaction Date", type: "date" },
  { id: "serialNo", label: "Serial No", type: "text" },
  { id: "parentFarId", label: "Parent FAR ID", type: "text" },
  { id: "qty", label: "Qty", type: "number" },
  { id: "usefulLifeC1Years", label: "Useful Life C1 (Years)", type: "number" },
  { id: "usefulLifeC2Years", label: "Useful Life C2 (Years)", type: "number" },
  { id: "expiryDateC1", label: "Expiry Date C1", type: "date" },
  { id: "expiryDateC2", label: "Expiry Date C2", type: "date" },
  { id: "c1OpeningCost", label: "C1 Opening Gross Block", type: "number" },
  { id: "c2OpeningCost", label: "C2 Opening Gross Block", type: "number" },
  { id: "additionsC1", label: "C1 Additions", type: "number" },
  { id: "additionsC2", label: "C2 Additions", type: "number" },
  { id: "dateOfAddition", label: "Addition Date", type: "date" },
  { id: "dateOfDisposal", label: "Disposal Date", type: "date" },
  { id: "deletionsC1", label: "C1 Deletions", type: "number" },
  { id: "deletionsC2", label: "C2 Deletions", type: "number" },
  { id: "saleValue", label: "Sale Value", type: "number" },
  { id: "c1GrossBlock", label: "C1 Gross Block", type: "number" },
  { id: "c2GrossBlock", label: "C2 Gross Block", type: "number" },
  { id: "accDepC1Opening", label: "C1 Opening Acc. Dep.", type: "number" },
  { id: "accDepC2Opening", label: "C2 Opening Acc. Dep.", type: "number" },
  { id: "c1PeriodDep", label: "C1 Depreciation (Period)", type: "number" },
  { id: "c2PeriodDep", label: "C2 Depreciation (Period)", type: "number" },
  { id: "accDepOnDisposedC1", label: "C1 Acc. Dep. on Disposed", type: "number" },
  { id: "accDepOnDisposedC2", label: "C2 Acc. Dep. on Disposed", type: "number" },
  { id: "c1AccDep", label: "C1 Acc. Dep.", type: "number" },
  { id: "c2AccDep", label: "C2 Acc. Dep.", type: "number" },
  { id: "c1Wdv", label: "C1 WDV", type: "number" },
  { id: "c2Wdv", label: "C2 WDV", type: "number" },
  { id: "totalWdv", label: "Total WDV", type: "number" },
  { id: "profitLoss", label: "Profit/(Loss) on Disposal", type: "number" },
  { id: "c1NbvOpening", label: "C1 Opening NBV", type: "number" },
  { id: "c2NbvOpening", label: "C2 Opening NBV", type: "number" },
  { id: "c1Nbv", label: "C1 NBV", type: "number" },
  { id: "c2Nbv", label: "C2 NBV", type: "number" }
];

// Column labels for the filter-chips row (item 8) — CONDITION_COLUMNS above, plus the
// four checklist filters (Sub Classification/Status/the two Locations) that are wired up
// separately via DualModeFilterPanel and so aren't in that list.
const CONDITION_COLUMN_LABELS: Record<string, string> = Object.fromEntries([
  ["subClassification", "Sub Classification"],
  ["status", "Status"],
  ["effectiveLocation", "Current Location"],
  ["location", "Capitalized Location"],
  ...CONDITION_COLUMNS.map((c): [string, string] => [c.id, c.label])
]);

// "Contains 163", "On 21-08-2026", "Blank" — the operator's own label already reads
// naturally lower-cased after the column name; no-value operators (Blank, Today, ...)
// need nothing appended.
function describeCondition(c: ColumnCondition): string {
  const opLabel = OPERATORS_BY_TYPE[c.type].find((o) => o.value === c.op)?.label ?? c.op;
  if (c.value === undefined || c.value === "") return opLabel;
  return c.valueTo ? `${opLabel} ${c.value}–${c.valueTo}` : `${opLabel} ${c.value}`;
}

export function RegisterPage() {
  const { user } = useAuth();
  const { settings } = useSettings();
  const { filters, setFilter, clearFilter, clearAll } = useFilters();
  const columnPrefs = useColumnPrefs({ asAt: settings?.asAt ?? "", fyStart: settings?.fyStart ?? "" });
  const { columns, setColumnWidth, moveColumnTo } = columnPrefs;

  // Finance FAR Dashboard drill-through: a tile links here with ?exception=<key>&asAt=...
  // — read straight from the URL, deliberately kept OUT of FiltersContext (that's
  // Register's own persisted filter state; this is a single server-side predicate key
  // tied to one navigation, not a client-composed condition — see lib/types.ts's
  // AssetFilters.exception). `asAt` on this request pins the drill-through to the exact
  // date shown on the dashboard when the tile was clicked, even if the org's global
  // "Figures as of" changes a moment later.
  const [searchParams, setSearchParams] = useSearchParams();
  const exceptionParam = searchParams.get("exception");
  const exceptionKey = exceptionParam && isExceptionKey(exceptionParam) ? exceptionParam : null;
  const exceptionAsAt = searchParams.get("asAt");
  const clearException = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("exception");
    next.delete("asAt");
    setSearchParams(next, { replace: true });
  };

  const asAt = exceptionKey && exceptionAsAt ? exceptionAsAt : (settings?.asAt ?? null);
  const effectiveSettings = useMemo(
    () => (exceptionKey && exceptionAsAt && settings ? { ...settings, asAt: exceptionAsAt } : settings),
    [settings, exceptionKey, exceptionAsAt]
  );
  const assetListFilters = useMemo(
    () => (exceptionKey ? { ...filters, exception: exceptionKey } : filters),
    [filters, exceptionKey]
  );

  const [centers, setCenters] = useState<string[]>([]);
  const [subClassifications, setSubClassifications] = useState<SubClassificationOption[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);

  useEffect(() => {
    fetchCenters().then(setCenters).catch(() => {});
    fetchSubClassifications().then(setSubClassifications).catch(() => {});
    fetchStatuses().then(setStatuses).catch(() => {});
  }, []);

  const { items, nextCursor, total, loading, loadingMore, error, reload, loadMore } = useAssetList(
    effectiveSettings,
    assetListFilters
  );
  const [density, setDensity] = useDensity();
  const [selectionState, setSelectionState] = useState<SelectionState>({
    selected: new Set(),
    autoSelected: new Set()
  });
  const selected = selectionState.selected;
  const [transferOpen, setTransferOpen] = useState(false);
  const [disposeOpen, setDisposeOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [editingFarId, setEditingFarId] = useState<string | null>(null);
  const [gridExpanded, setGridExpanded] = useState(false);

  // Parent and children sorted adjacent to each other without disturbing the chosen
  // column sort otherwise — see registerGrouping.ts. Recomputed only when the loaded
  // page itself changes, not on every render.
  const groupedItems = useMemo(() => groupParentChildRows(items), [items]);

  const clearSelection = () => setSelectionState({ selected: new Set(), autoSelected: new Set() });

  // Checking a parent's row auto-checks its currently-loaded active children (and
  // unchecking it drops only the ones it auto-added) — see registerSelection.ts.
  const toggleRow = (farId: string) => {
    setSelectionState((prev) => toggleRegisterSelection(items, farId, prev));
  };

  const toggleAllLoaded = () => {
    setSelectionState((prev) =>
      prev.selected.size === items.length
        ? { selected: new Set(), autoSelected: new Set() }
        : { selected: new Set(items.map((i) => i.asset.farId)), autoSelected: new Set() }
    );
  };

  // Filter count for the toolbar badge: every named field (the four checklist filters,
  // plus the global search box) counts as one, and the `conditions` array — however many
  // custom column conditions are active — counts as its own bucket rather than one-per-
  // condition, so it reads as "N kinds of filter applied", matching how the rest of the
  // filters are counted (one multi-select is one filter regardless of how many values are
  // checked).
  const activeFilterCount = Object.keys(filters).length;
  const hasActiveFilters = activeFilterCount > 0;

  const conditions = filters.conditions ?? [];
  const setConditions = (next: ColumnCondition[]) => (next.length > 0 ? setFilter("conditions", next) : clearFilter("conditions"));
  const setCondition = (columnId: string, next: ColumnCondition | undefined) => {
    const rest = conditions.filter((c) => c.columnId !== columnId);
    setConditions(isConditionComplete(next) ? [...rest, next] : rest);
  };

  // One removable chip per active filter — see FilterChips. A multi-select field (Sub
  // Classification, Status, either Location) is one chip with every picked value listed,
  // matching how the toolbar's own "N filters applied" count already treats it as a
  // single filter regardless of how many values are checked.
  const filterChips: FilterChip[] = [
    ...(exceptionKey
      ? [
          {
            key: "exception",
            label: `Dashboard: ${EXCEPTION_LABELS[exceptionKey]}${total !== null ? ` (${total})` : ""}`,
            onRemove: clearException
          }
        ]
      : []),
    ...(filters.globalSearch ? [{ key: "globalSearch", label: `Search: "${filters.globalSearch}"`, onRemove: () => clearFilter("globalSearch") }] : []),
    ...(filters.subClassification?.length
      ? [{ key: "subClassification", label: `Sub Classification: ${filters.subClassification.join(", ")}`, onRemove: () => clearFilter("subClassification") }]
      : []),
    ...(filters.status?.length ? [{ key: "status", label: `Status: ${filters.status.join(", ")}`, onRemove: () => clearFilter("status") }] : []),
    ...(filters.center?.length
      ? [{ key: "center", label: `Current Location: ${filters.center.join(", ")}`, onRemove: () => clearFilter("center") }]
      : []),
    ...(filters.capLocation?.length
      ? [{ key: "capLocation", label: `Capitalized Location: ${filters.capLocation.join(", ")}`, onRemove: () => clearFilter("capLocation") }]
      : []),
    ...conditions.map((c) => ({
      key: `condition-${c.columnId}`,
      label: `${CONDITION_COLUMN_LABELS[c.columnId] ?? c.columnId}: ${describeCondition(c)}`,
      onRemove: () => setCondition(c.columnId, undefined)
    }))
  ];

  // Component 2 columns/filters disappear only once the Register is scoped (via the Sub
  // Classification filter) to classification(s) that are ALL C1-only — an unfiltered or
  // mixed view keeps them, since some visible rows may still need them.
  const scopedNames = scopedSubClassificationNames(filters.subClassification, conditions);
  const hideC2 = allScopedC1Only(scopedNames, subClassifications);
  const visibleColumns = hideC2 ? hideC2Columns(columns) : columns;
  const visibleConditionColumns = hideC2 ? CONDITION_COLUMNS.filter((c) => !C2_COLUMN_IDS.has(c.id)) : CONDITION_COLUMNS;

  const headerFilters: Partial<Record<string, ReactNode>> = {
    subClassification: (
      <ColumnFilterPopover
        label="Sub Classification"
        active={(filters.subClassification?.length ?? 0) > 0 || !!conditions.find((c) => c.columnId === "subClassification")}
      >
        {() => (
          <DualModeFilterPanel
            label="Sub Classification"
            columnId="subClassification"
            type="text"
            options={subClassifications.map((s) => s.name)}
            selectValue={filters.subClassification ?? []}
            onSelectChange={(v) => (v.length > 0 ? setFilter("subClassification", v) : clearFilter("subClassification"))}
            condition={conditions.find((c) => c.columnId === "subClassification")}
            onConditionChange={(next) => setCondition("subClassification", next)}
          />
        )}
      </ColumnFilterPopover>
    ),
    status: (
      <ColumnFilterPopover
        label="Status"
        active={(filters.status?.length ?? 0) > 0 || !!conditions.find((c) => c.columnId === "status")}
      >
        {() => (
          <DualModeFilterPanel
            label="Status"
            columnId="status"
            type="text"
            options={statuses}
            selectValue={filters.status ?? []}
            onSelectChange={(v) => (v.length > 0 ? setFilter("status", v) : clearFilter("status"))}
            condition={conditions.find((c) => c.columnId === "status")}
            onConditionChange={(next) => setCondition("status", next)}
          />
        )}
      </ColumnFilterPopover>
    ),
    effectiveLocation: (
      <ColumnFilterPopover
        label="Current Location"
        active={(filters.center?.length ?? 0) > 0 || !!conditions.find((c) => c.columnId === "effectiveLocation")}
      >
        {() => (
          <DualModeFilterPanel
            label="Center"
            columnId="effectiveLocation"
            type="text"
            options={centers}
            selectValue={filters.center ?? []}
            onSelectChange={(v) => (v.length > 0 ? setFilter("center", v) : clearFilter("center"))}
            condition={conditions.find((c) => c.columnId === "effectiveLocation")}
            onConditionChange={(next) => setCondition("effectiveLocation", next)}
          />
        )}
      </ColumnFilterPopover>
    ),
    location: (
      <ColumnFilterPopover
        label="Capitalized Location"
        active={(filters.capLocation?.length ?? 0) > 0 || !!conditions.find((c) => c.columnId === "location")}
      >
        {() => (
          <DualModeFilterPanel
            label="Center"
            columnId="location"
            type="text"
            options={centers}
            selectValue={filters.capLocation ?? []}
            onSelectChange={(v) => (v.length > 0 ? setFilter("capLocation", v) : clearFilter("capLocation"))}
            condition={conditions.find((c) => c.columnId === "location")}
            onConditionChange={(next) => setCondition("location", next)}
          />
        )}
      </ColumnFilterPopover>
    )
  };

  for (const col of visibleConditionColumns) {
    const current = conditions.find((c) => c.columnId === col.id);
    headerFilters[col.id] = (
      <ColumnFilterPopover label={col.label} active={!!current}>
        {() => (
          <ConditionFilterPanel label={col.label} columnId={col.id} type={col.type} condition={current} onChange={(next) => setCondition(col.id, next)} />
        )}
      </ColumnFilterPopover>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-200 bg-white px-6 py-3">
        <div className="relative max-w-sm">
          <SearchIcon fontSize={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search assets…"
            className="w-full rounded-md border border-gray-300 py-1.5 pl-8 pr-7 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={filters.globalSearch ?? ""}
            onChange={(e) => (e.target.value ? setFilter("globalSearch", e.target.value) : clearFilter("globalSearch"))}
          />
          <span className="absolute right-1.5 top-1/2 -translate-y-1/2">
            <Tooltip text="Searches FAR ID, Description, Sub Classification, Status, and Location." placement="bottom">
              <></>
            </Tooltip>
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-2">
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {loading
            ? "Loading…"
            : total !== null && total > items.length
              ? `${formatCompactIndianCount(items.length)} / ${formatCompactIndianCount(total)} loaded`
              : `${formatCompactIndianCount(items.length)} loaded`}
          {hasActiveFilters && (
            <>
              <span className="flex items-center gap-1 rounded-full bg-ink px-2 py-0.5 text-[11px] font-semibold text-white">
                {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"} applied
              </span>
              <button
                type="button"
                className="font-medium text-accent hover:underline"
                onClick={() => {
                  clearAll();
                  if (exceptionKey) clearException();
                }}
              >
                Clear all filters
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {(hasPermission(user, "transfers", "create") ||
            hasPermission(user, "disposals", "create") ||
            hasPermission(user, "register", "edit")) && (
            <RecordMovementControl
              selectedCount={selected.size}
              onTransfer={() => setTransferOpen(true)}
              onDispose={() => setDisposeOpen(true)}
              onMerge={() => setMergeOpen(true)}
            />
          )}
          <ExportButton url={asAt ? getExportUrl({ asAt, ...assetListFilters }) : undefined} />
          <ColumnPicker prefs={columnPrefs} />
          <GridViewControls density={density} onDensityChange={setDensity} expanded={gridExpanded} onExpandedChange={setGridExpanded} />
        </div>
      </div>

      <FilterChips chips={filterChips} />

      <AssetGrid
        items={groupedItems}
        expanded={gridExpanded}
        onExpandedChange={setGridExpanded}
        density={density}
        onDensityChange={setDensity}
        columns={visibleColumns}
        loading={loading}
        loadingMore={loadingMore}
        error={error}
        hasMore={!!nextCursor}
        onLoadMore={loadMore}
        onRetry={reload}
        selectable
        selected={selected}
        onToggleRow={toggleRow}
        onToggleAll={toggleAllLoaded}
        headerFilters={headerFilters}
        getAssetHref={(farId) => `/assets/${encodeURIComponent(farId)}`}
        onEditAsset={hasPermission(user, "register", "edit") ? (farId) => setEditingFarId(farId) : undefined}
        onResizeColumn={setColumnWidth}
        onReorderColumn={moveColumnTo}
        showGroupBand
      />

      {transferOpen && asAt && (
        <TransferModal
          assets={items.filter((i) => selected.has(i.asset.farId))}
          asAt={asAt}
          defaultDate={asAt}
          onClose={() => setTransferOpen(false)}
          onDone={() => {
            setTransferOpen(false);
            clearSelection();
            reload();
          }}
        />
      )}

      {disposeOpen && asAt && (
        <DisposalModal
          assets={items.filter((i) => selected.has(i.asset.farId))}
          asAt={asAt}
          defaultDate={asAt}
          onClose={() => setDisposeOpen(false)}
          onDone={() => {
            setDisposeOpen(false);
            clearSelection();
            reload();
          }}
        />
      )}

      {mergeOpen && (
        <MergeModal
          assets={items.filter((i) => selected.has(i.asset.farId))}
          onClose={() => setMergeOpen(false)}
          onDone={() => {
            setMergeOpen(false);
            clearSelection();
            reload();
          }}
        />
      )}

      {editingFarId &&
        asAt &&
        (() => {
          const editingAsset = items.find((i) => i.asset.farId === editingFarId)?.asset;
          if (!editingAsset) return null;
          return (
            <EditAssetModal
              asset={editingAsset}
              subClassifications={subClassifications}
              asAt={asAt}
              onClose={() => setEditingFarId(null)}
              onDone={() => {
                setEditingFarId(null);
                reload();
              }}
            />
          );
        })()}
    </div>
  );
}
