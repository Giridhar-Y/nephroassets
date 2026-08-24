import { useMemo, useState } from "react";
import { useSettings } from "../lib/SettingsContext.js";
import { useAssetList } from "../hooks/useAssetList.js";
import { AssetGrid } from "../components/AssetGrid.js";
import { FarIdAutocomplete } from "../components/FarIdAutocomplete.js";
import { AdditionModal } from "../components/AdditionModal.js";
import { ALL_COLUMNS, resolveColumns } from "../lib/columns.js";
import { formatCurrency, formatDate } from "../lib/format.js";
import type { AssetListItem } from "../lib/types.js";
import { AdditionIcon } from "../lib/icons.js";

type Tab = "new" | "log";

const LOG_COLUMN_IDS = ["farId", "assetDescription", "subClassification", "additionsC1", "additionsC2", "dateOfAddition", "effectiveLocation"];
const RAW_LOG_COLUMNS = LOG_COLUMN_IDS.map((id) => ALL_COLUMNS.find((c) => c.id === id)).filter((c) => !!c);

function NewAdditionTab({ onDone }: { onDone: () => void }) {
  const { settings } = useSettings();
  const asAt = settings?.asAt ?? "";
  const [selected, setSelected] = useState<AssetListItem | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const hasExistingAddition = selected ? selected.asset.additionsC1 !== 0 || selected.asset.additionsC2 !== 0 : false;
  const isDisposed = selected ? selected.asset.dateOfDisposal !== null : false;
  const blocked = hasExistingAddition || isDisposed;

  return (
    <div className="flex-1 overflow-auto px-6 py-6">
      <div className="max-w-md rounded-xl bg-white p-6 shadow-sm">
        <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">FAR ID</label>
        <div className="mt-1">
          <FarIdAutocomplete asAt={asAt} onSelect={setSelected} />
        </div>

        {selected && (
          <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm">
            <p className="font-medium text-ink">{selected.asset.farId}</p>
            <p className="mt-1 text-gray-600">{selected.asset.assetDescription}</p>
            <p className="mt-1 text-xs text-gray-500">
              Current Location: <span className="font-medium text-gray-700">{selected.result.effectiveLocation}</span>
            </p>
            <p className="mt-0.5 text-xs text-gray-500">
              Capitalized: <span className="font-medium text-gray-700">{formatDate(selected.asset.dateAcquired)}</span>
            </p>
            {isDisposed && (
              <p className="mt-2 text-xs font-medium text-red-600">
                This asset has been disposed — no further additions can be recorded.
              </p>
            )}
            {!isDisposed && hasExistingAddition && (
              <p className="mt-2 text-xs font-medium text-red-600">
                This asset already has an addition recorded — C1 {formatCurrency(selected.asset.additionsC1)}, C2{" "}
                {formatCurrency(selected.asset.additionsC2)}, dated {formatDate(selected.asset.dateOfAddition)}. A
                second addition isn't supported yet.
              </p>
            )}
          </div>
        )}

        <button
          type="button"
          className="mt-6 flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setModalOpen(true)}
          disabled={!selected || blocked}
        >
          <AdditionIcon fontSize={15} />
          Record Addition
        </button>
      </div>

      {modalOpen && selected && asAt && (
        <AdditionModal
          asset={selected.asset}
          defaultDate={asAt}
          onClose={() => setModalOpen(false)}
          onDone={() => {
            setModalOpen(false);
            setSelected(null);
            onDone();
          }}
        />
      )}
    </div>
  );
}

function AdditionLogTab() {
  const { settings } = useSettings();
  const filters = useMemo(() => ({ hasAddition: true }), []);
  const { items, nextCursor, loading, error, reload, loadMore } = useAssetList(settings, filters);
  const COLUMNS = resolveColumns(RAW_LOG_COLUMNS, { asAt: settings?.asAt ?? "", fyStart: settings?.fyStart ?? "" });

  return (
    <AssetGrid
      items={items}
      columns={COLUMNS}
      loading={loading}
      error={error}
      hasMore={!!nextCursor}
      onLoadMore={loadMore}
      onRetry={reload}
      emptyTitle="No additions recorded yet."
      emptyHint="Record an addition from the New Addition tab, or via Capitalization's own Mid-Year Additions section."
      getAssetHref={(farId) => `/assets/${encodeURIComponent(farId)}`}
    />
  );
}

export function AdditionsPage() {
  const [tab, setTab] = useState<Tab>("new");
  const [logRefreshKey, setLogRefreshKey] = useState(0);

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="border-b border-gray-200 px-6 py-4">
        <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
          <AdditionIcon fontSize={20} />
          Additions
        </h1>
        <p className="mt-1 text-sm text-gray-500">Record a mid-year addition on an already-capitalized asset, or browse what's been recorded.</p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              tab === "new" ? "bg-accent text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
            onClick={() => setTab("new")}
          >
            New Addition
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              tab === "log" ? "bg-accent text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
            onClick={() => setTab("log")}
          >
            Addition Log
          </button>
        </div>
      </div>

      {tab === "new" && (
        <NewAdditionTab
          onDone={() => {
            setLogRefreshKey((k) => k + 1);
            setTab("log");
          }}
        />
      )}
      {tab === "log" && (
        <div className="flex min-h-0 flex-1 flex-col" key={logRefreshKey}>
          <AdditionLogTab />
        </div>
      )}
    </div>
  );
}
