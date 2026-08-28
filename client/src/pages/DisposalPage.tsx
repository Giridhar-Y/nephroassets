import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../lib/SettingsContext.js";
import { useAssetList } from "../hooks/useAssetList.js";
import { AssetGrid } from "../components/AssetGrid.js";
import { FarIdAutocomplete } from "../components/FarIdAutocomplete.js";
import { DisposalModal } from "../components/DisposalModal.js";
import { ALL_COLUMNS, resolveColumns } from "../lib/columns.js";
import { formatCurrency } from "../lib/format.js";
import { useAuth } from "../lib/AuthContext.js";
import type { AssetListItem } from "../lib/types.js";
import type { ColumnCondition, ColumnFilterType } from "../lib/columnFilters.js";
import { buildConditionHeaderFilters, makeSetCondition } from "../lib/conditionHeaderFilters.js";
import { DeleteIcon, UploadIcon } from "../lib/icons.js";

type Tab = "new" | "log";

// FAR ID, Description, Sub-Classification, Location at Disposal, Disposal Date, Sale
// Value, Total WDV at Disposal (combined c1+c2, not just C1), Profit/(Loss) — the last
// two reuse the calc engine's own totalWdv/profitLoss columns (see columns.ts), not
// re-derived figures.
const DISPOSAL_COLUMN_IDS = [
  "farId",
  "assetDescription",
  "subClassification",
  "effectiveLocation",
  "dateOfDisposal",
  "saleValue",
  "totalWdv",
  "profitLoss"
];
const RAW_COLUMNS = DISPOSAL_COLUMN_IDS.map((id) => ALL_COLUMNS.find((c) => c.id === id))
  .filter((c) => !!c)
  // "Curr. Location" is the shared Register label for this field; on a Disposed asset
  // it's frozen as of the disposal, so it reads more clearly as "Location at Disposal"
  // here specifically.
  .map((c) => (c.id === "effectiveLocation" ? { ...c, label: "Location at Disposal", tooltip: "Location at the time of disposal" } : c));

// Excel-style custom-condition filters for every log column (see conditionHeaderFilters.tsx).
const LOG_CONDITION_COLUMNS: Array<{ id: string; label: string; type: ColumnFilterType }> = [
  { id: "farId", label: "FAR ID", type: "text" },
  { id: "assetDescription", label: "Asset Description", type: "text" },
  { id: "subClassification", label: "Sub Classification", type: "text" },
  { id: "effectiveLocation", label: "Location at Disposal", type: "text" },
  { id: "dateOfDisposal", label: "Disposal Date", type: "date" },
  { id: "saleValue", label: "Sale Value", type: "number" },
  { id: "totalWdv", label: "Total WDV", type: "number" },
  { id: "profitLoss", label: "Profit/(Loss) on Disposal", type: "number" }
];

function NewDisposalTab({ onDone }: { onDone: () => void }) {
  const { settings } = useSettings();
  const asAt = settings?.asAt ?? "";
  const [selected, setSelected] = useState<AssetListItem | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const currentNbv = selected ? selected.result.c1.nbv + selected.result.c2.nbv : null;

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
              Current NBV: <span className="font-medium text-gray-700">{formatCurrency(currentNbv!)}</span>
            </p>
          </div>
        )}

        <button
          type="button"
          className="mt-6 flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setModalOpen(true)}
          disabled={!selected}
        >
          <DeleteIcon fontSize={15} />
          Dispose This Asset
        </button>
      </div>

      {modalOpen && selected && asAt && (
        <DisposalModal
          assets={[selected]}
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

// Disposal Log — the pre-existing read-only table, unchanged apart from swapping C1
// WDV for the combined Total WDV.
function DisposalLogTab() {
  const { settings } = useSettings();
  const [conditions, setConditions] = useState<ColumnCondition[]>([]);
  const filters = useMemo(() => ({ status: ["Disposed"], conditions }), [conditions]);
  const setCondition = makeSetCondition(conditions, setConditions);
  const { items, nextCursor, loading, error, reload, loadMore } = useAssetList(settings, filters);
  const COLUMNS = resolveColumns(RAW_COLUMNS, { asAt: settings?.asAt ?? "", fyStart: settings?.fyStart ?? "" });
  const headerFilters = buildConditionHeaderFilters(LOG_CONDITION_COLUMNS, conditions, setCondition);

  return (
    <AssetGrid
      items={items}
      columns={COLUMNS}
      loading={loading}
      error={error}
      hasMore={!!nextCursor}
      onLoadMore={loadMore}
      onRetry={reload}
      emptyTitle="No disposed assets yet."
      emptyHint="Dispose an asset from the New Disposal tab, or from the Register (select rows, then Dispose Selected)."
      headerFilters={headerFilters}
    />
  );
}

export function DisposalPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("new");
  // Bumped after a disposal from the New Disposal tab, so the Log tab re-fetches
  // instead of showing a stale list if the user switches over to check.
  const [logRefreshKey, setLogRefreshKey] = useState(0);

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
            <DeleteIcon fontSize={20} />
            Disposals
          </h1>
          {user?.role !== "viewer" && (
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
              onClick={() => navigate("/bulk-upload?type=disposals")}
            >
              <UploadIcon fontSize={14} />
              Bulk Disposal
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-gray-500">Dispose one asset, or browse everything that's been disposed.</p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              tab === "new" ? "bg-accent text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
            onClick={() => setTab("new")}
          >
            New Disposal
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              tab === "log" ? "bg-accent text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
            onClick={() => setTab("log")}
          >
            Disposal Log
          </button>
        </div>
      </div>

      {tab === "new" && (
        <NewDisposalTab
          onDone={() => {
            setLogRefreshKey((k) => k + 1);
            setTab("log");
          }}
        />
      )}
      {tab === "log" && (
        <div className="flex min-h-0 flex-1 flex-col" key={logRefreshKey}>
          <DisposalLogTab />
        </div>
      )}
    </div>
  );
}
