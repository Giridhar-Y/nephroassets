import { useState } from "react";
import { useFilters } from "../lib/FiltersContext.js";
import { useSettings } from "../lib/SettingsContext.js";
import { useColumnPrefs } from "../lib/useColumnPrefs.js";
import { useAssetList } from "../hooks/useAssetList.js";
import { FilterBar } from "../components/FilterBar.js";
import { ColumnPicker } from "../components/ColumnPicker.js";
import { TransferModal } from "../components/TransferModal.js";
import { AssetGrid } from "../components/AssetGrid.js";

export function RegisterPage() {
  const { settings } = useSettings();
  const { filters } = useFilters();
  const columnPrefs = useColumnPrefs();
  const { columns } = columnPrefs;
  const asAt = settings?.asAt ?? null;

  const { items, nextCursor, loading, error, reload, loadMore } = useAssetList(settings, filters);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [transferOpen, setTransferOpen] = useState(false);

  const toggleRow = (farId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(farId)) next.delete(farId);
      else next.add(farId);
      return next;
    });
  };

  const toggleAllLoaded = () => {
    setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map((i) => i.asset.farId))));
  };

  return (
    <div className="flex h-full flex-col">
      <FilterBar asAt={asAt} />

      <div className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-2">
        <div className="text-xs text-gray-500">
          {loading ? "Loading…" : `${items.length}${nextCursor ? "+" : ""} asset${items.length === 1 ? "" : "s"} loaded`}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            disabled={selected.size === 0}
            onClick={() => setTransferOpen(true)}
          >
            Transfer Selected ({selected.size})
          </button>
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
      />

      {transferOpen && asAt && (
        <TransferModal
          farIds={[...selected]}
          defaultDate={asAt}
          onClose={() => setTransferOpen(false)}
          onDone={() => {
            setTransferOpen(false);
            setSelected(new Set());
            reload();
          }}
        />
      )}
    </div>
  );
}
