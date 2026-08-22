import { useMemo } from "react";
import { useSettings } from "../lib/SettingsContext.js";
import { useAssetList } from "../hooks/useAssetList.js";
import { AssetGrid } from "../components/AssetGrid.js";
import { ALL_COLUMNS, resolveColumns } from "../lib/columns.js";
import { DeleteIcon } from "../lib/icons.js";

const DISPOSAL_COLUMN_IDS = [
  "farId",
  "assetDescription",
  "subClassification",
  "effectiveLocation",
  "dateOfDisposal",
  "saleValue",
  "c1Wdv",
  "profitLoss"
];
const RAW_COLUMNS = DISPOSAL_COLUMN_IDS.map((id) => ALL_COLUMNS.find((c) => c.id === id)).filter((c) => !!c);

// Read-only, like Transfers: initiating a disposal happens via "Dispose Selected" in
// Register (select assets, DisposalModal). This screen just shows what's been disposed.
export function DisposalPage() {
  const { settings } = useSettings();
  const filters = useMemo(() => ({ status: ["Disposed"] }), []);
  const { items, nextCursor, loading, error, reload, loadMore } = useAssetList(settings, filters);
  const COLUMNS = resolveColumns(RAW_COLUMNS, { asAt: settings?.asAt ?? "", fyStart: settings?.fyStart ?? "" });

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-200 bg-white px-6 py-4">
        <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
          <DeleteIcon fontSize={20} />
          Disposals
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Assets that have been disposed, with disposal date, sale value, and profit/(loss).
        </p>
      </div>

      <AssetGrid
        items={items}
        columns={COLUMNS}
        loading={loading}
        error={error}
        hasMore={!!nextCursor}
        onLoadMore={loadMore}
        onRetry={reload}
        emptyTitle="No disposed assets yet."
        emptyHint="Dispose assets from the Register screen (select rows, then Dispose Selected)."
      />
    </div>
  );
}
