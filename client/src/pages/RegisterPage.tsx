import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { CollapseExpandIcon, ExpandIcon, ExportIcon, SearchIcon } from "../lib/icons.js";
import { toggleRegisterSelection, type SelectionState } from "../lib/registerSelection.js";
import { groupParentChildRows } from "../lib/registerGrouping.js";
import { fetchCenters, fetchStatuses, fetchSubClassifications, getExportUrl, type SubClassificationOption } from "../api/client.js";
import { isConditionComplete, type ColumnCondition, type ColumnFilterType } from "../lib/columnFilters.js";
import { allScopedC1Only, C2_COLUMN_IDS, hideC2Columns, scopedSubClassificationNames } from "../lib/columns.js";
import { hasPermission } from "../lib/permissions.js";

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

export function RegisterPage() {
  const { user } = useAuth();
  const { settings } = useSettings();
  const { filters, setFilter, clearFilter, clearAll } = useFilters();
  const columnPrefs = useColumnPrefs({ asAt: settings?.asAt ?? "", fyStart: settings?.fyStart ?? "" });
  const { columns, setColumnWidth, moveColumnTo } = columnPrefs;
  const asAt = settings?.asAt ?? null;

  const [centers, setCenters] = useState<string[]>([]);
  const [subClassifications, setSubClassifications] = useState<SubClassificationOption[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);

  useEffect(() => {
    fetchCenters().then(setCenters).catch(() => {});
    fetchSubClassifications().then(setSubClassifications).catch(() => {});
    fetchStatuses().then(setStatuses).catch(() => {});
  }, []);

  const { items, nextCursor, loading, loadingMore, error, reload, loadMore } = useAssetList(settings, filters);
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
            placeholder="Search FAR ID, Description, Sub Classification, Status, or Location…"
            className="w-full rounded-md border border-gray-300 py-1.5 pl-8 pr-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={filters.globalSearch ?? ""}
            onChange={(e) => (e.target.value ? setFilter("globalSearch", e.target.value) : clearFilter("globalSearch"))}
          />
        </div>
      </div>

      <div className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-2">
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {loading
            ? "Loading…"
            : `${items.length} asset${items.length === 1 ? "" : "s"} loaded${nextCursor ? " (more available)" : ""}`}
          {!loading && nextCursor && (
            <button
              type="button"
              className="font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
          {hasActiveFilters && (
            <>
              <span className="flex items-center gap-1 rounded-full bg-ink px-2 py-0.5 text-[11px] font-semibold text-white">
                {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"} applied
              </span>
              <button type="button" className="font-medium text-accent hover:underline" onClick={clearAll}>
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
          <a
            href={asAt ? getExportUrl({ asAt, ...filters }) : undefined}
            aria-disabled={!asAt}
            className={`flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 ${
              !asAt ? "pointer-events-none opacity-40" : ""
            }`}
          >
            <ExportIcon fontSize={14} />
            Export to Excel
          </a>
          <ColumnPicker prefs={columnPrefs} />
          <button
            type="button"
            aria-label={gridExpanded ? "Exit full screen" : "Expand table to full screen"}
            title={gridExpanded ? "Exit full screen (Esc)" : "Expand to full screen"}
            onClick={() => setGridExpanded((e) => !e)}
            className="flex items-center gap-1.5 rounded-md border border-gray-300 px-2 py-1.5 text-gray-600 hover:bg-gray-50"
          >
            {gridExpanded ? <CollapseExpandIcon fontSize={14} /> : <ExpandIcon fontSize={14} />}
          </button>
        </div>
      </div>

      <AssetGrid
        items={groupedItems}
        expanded={gridExpanded}
        onExpandedChange={setGridExpanded}
        columns={visibleColumns}
        loading={loading}
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
