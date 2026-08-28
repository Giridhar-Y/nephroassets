import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
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
import { ColumnFilterPopover, DateRangeFilterPanel, SelectFilterPanel, TextFilterPanel } from "../components/ColumnFilterPopover.js";
import { ExportIcon, SearchIcon, UploadIcon } from "../lib/icons.js";
import { toggleRegisterSelection, type SelectionState } from "../lib/registerSelection.js";
import { fetchCenters, fetchStatuses, fetchSubClassifications, getExportUrl } from "../api/client.js";

export function RegisterPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { settings } = useSettings();
  const { filters, setFilter, clearFilter, clearAll } = useFilters();
  const columnPrefs = useColumnPrefs({ asAt: settings?.asAt ?? "", fyStart: settings?.fyStart ?? "" });
  const { columns, setColumnWidth, moveColumnTo } = columnPrefs;
  const asAt = settings?.asAt ?? null;

  const [centers, setCenters] = useState<string[]>([]);
  const [subClassifications, setSubClassifications] = useState<string[]>([]);
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

  const hasActiveFilters = Object.keys(filters).length > 0;

  const headerFilters: Partial<Record<string, ReactNode>> = {
    farId: (
      <ColumnFilterPopover label="FAR ID" active={!!filters.search}>
        {() => (
          <TextFilterPanel
            label="FAR ID"
            placeholder="e.g. FAR-000123"
            value={filters.search ?? ""}
            onChange={(v) => (v ? setFilter("search", v) : clearFilter("search"))}
          />
        )}
      </ColumnFilterPopover>
    ),
    assetDescription: (
      <ColumnFilterPopover label="Asset Description" active={!!filters.descriptionSearch}>
        {() => (
          <TextFilterPanel
            label="Asset Description"
            placeholder="Search description…"
            value={filters.descriptionSearch ?? ""}
            onChange={(v) => (v ? setFilter("descriptionSearch", v) : clearFilter("descriptionSearch"))}
          />
        )}
      </ColumnFilterPopover>
    ),
    subClassification: (
      <ColumnFilterPopover label="Sub Classification" active={(filters.subClassification?.length ?? 0) > 0}>
        {() => (
          <SelectFilterPanel
            label="Sub Classification"
            options={subClassifications}
            value={filters.subClassification ?? []}
            onChange={(v) => (v.length > 0 ? setFilter("subClassification", v) : clearFilter("subClassification"))}
          />
        )}
      </ColumnFilterPopover>
    ),
    status: (
      <ColumnFilterPopover label="Status" active={(filters.status?.length ?? 0) > 0}>
        {() => (
          <SelectFilterPanel
            label="Status"
            options={statuses}
            value={filters.status ?? []}
            onChange={(v) => (v.length > 0 ? setFilter("status", v) : clearFilter("status"))}
          />
        )}
      </ColumnFilterPopover>
    ),
    effectiveLocation: (
      <ColumnFilterPopover label="Current Location" active={(filters.center?.length ?? 0) > 0}>
        {() => (
          <SelectFilterPanel
            label="Center"
            options={centers}
            value={filters.center ?? []}
            onChange={(v) => (v.length > 0 ? setFilter("center", v) : clearFilter("center"))}
          />
        )}
      </ColumnFilterPopover>
    ),
    location: (
      <ColumnFilterPopover label="Capitalized Location" active={(filters.capLocation?.length ?? 0) > 0}>
        {() => (
          <SelectFilterPanel
            label="Center"
            options={centers}
            value={filters.capLocation ?? []}
            onChange={(v) => (v.length > 0 ? setFilter("capLocation", v) : clearFilter("capLocation"))}
          />
        )}
      </ColumnFilterPopover>
    ),
    dateAcquired: (
      <ColumnFilterPopover label="Date Acquired" active={!!(filters.dateAcquiredFrom || filters.dateAcquiredTo)}>
        {() => (
          <DateRangeFilterPanel
            fromLabel="Acquired From"
            toLabel="Acquired To"
            from={filters.dateAcquiredFrom ?? ""}
            to={filters.dateAcquiredTo ?? ""}
            onChangeFrom={(v) => (v ? setFilter("dateAcquiredFrom", v) : clearFilter("dateAcquiredFrom"))}
            onChangeTo={(v) => (v ? setFilter("dateAcquiredTo", v) : clearFilter("dateAcquiredTo"))}
          />
        )}
      </ColumnFilterPopover>
    )
  };

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
                {Object.keys(filters).length} filter{Object.keys(filters).length === 1 ? "" : "s"} applied
              </span>
              <button type="button" className="font-medium text-accent hover:underline" onClick={clearAll}>
                Clear all filters
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {user?.role !== "viewer" && (
            <>
              <RecordMovementControl
                selectedCount={selected.size}
                onTransfer={() => setTransferOpen(true)}
                onDispose={() => setDisposeOpen(true)}
                onMerge={() => setMergeOpen(true)}
              />
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                onClick={() => navigate("/bulk-upload?type=merge")}
              >
                <UploadIcon fontSize={14} />
                Bulk Merge
              </button>
            </>
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
        </div>
      </div>

      <AssetGrid
        items={items}
        columns={columns}
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
        onEditAsset={user?.role !== "viewer" ? (farId) => setEditingFarId(farId) : undefined}
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
