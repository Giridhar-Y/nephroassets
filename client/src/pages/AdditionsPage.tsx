import { useEffect, useMemo, useState } from "react";
import { useSettings } from "../lib/SettingsContext.js";
import { useAuth } from "../lib/AuthContext.js";
import { useAssetList } from "../hooks/useAssetList.js";
import { AssetGrid } from "../components/AssetGrid.js";
import { FarIdAutocomplete } from "../components/FarIdAutocomplete.js";
import { AdditionModal } from "../components/AdditionModal.js";
import { DeleteConfirmModal } from "../components/DeleteConfirmModal.js";
import { useToast } from "../components/Toast.js";
import { ALL_COLUMNS, allScopedC1Only, hideC2Columns, resolveColumns, scopedSubClassificationNames } from "../lib/columns.js";
import { formatCurrency, formatDate } from "../lib/format.js";
import type { AssetListItem } from "../lib/types.js";
import type { ColumnCondition, ColumnFilterType } from "../lib/columnFilters.js";
import { buildConditionHeaderFilters, makeSetCondition } from "../lib/conditionHeaderFilters.js";
import { AdditionIcon } from "../lib/icons.js";
import { fetchSubClassifications, undoAddition, type SubClassificationOption } from "../api/client.js";
import { hasPermission } from "../lib/permissions.js";

type Tab = "new" | "log";

const LOG_COLUMN_IDS = ["farId", "assetDescription", "subClassification", "additionsC1", "additionsC2", "dateOfAddition", "effectiveLocation"];
const RAW_LOG_COLUMNS = LOG_COLUMN_IDS.map((id) => ALL_COLUMNS.find((c) => c.id === id)).filter((c) => !!c);

// Excel-style custom-condition filters for every log column (see conditionHeaderFilters.tsx) —
// labels match assetColumnFilters.ts's COLUMN_LABELS server-side so the filter popover and
// the export note (where applicable) read with the same names.
const LOG_CONDITION_COLUMNS: Array<{ id: string; label: string; type: ColumnFilterType }> = [
  { id: "farId", label: "FAR ID", type: "text" },
  { id: "assetDescription", label: "Asset Description", type: "text" },
  { id: "subClassification", label: "Sub Classification", type: "text" },
  { id: "additionsC1", label: "C1 Additions", type: "number" },
  { id: "additionsC2", label: "C2 Additions", type: "number" },
  { id: "dateOfAddition", label: "Addition Date", type: "date" },
  { id: "effectiveLocation", label: "Current Location", type: "text" }
];

function NewAdditionTab({ onDone, subClassifications }: { onDone: () => void; subClassifications: SubClassificationOption[] }) {
  const { settings } = useSettings();
  const asAt = settings?.asAt ?? "";
  const [selected, setSelected] = useState<AssetListItem | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const hasComponent2 =
    subClassifications.find((s) => s.name === selected?.asset.subClassification)?.hasComponent2 ?? true;
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
          hasComponent2={hasComponent2}
          defaultDate={asAt}
          asAt={asAt}
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

function AdditionLogTab({ subClassifications }: { subClassifications: SubClassificationOption[] }) {
  const { settings } = useSettings();
  const { user } = useAuth();
  const { showToast } = useToast();
  const [conditions, setConditions] = useState<ColumnCondition[]>([]);
  const filters = useMemo(() => ({ hasAddition: true, conditions }), [conditions]);
  const setCondition = makeSetCondition(conditions, setConditions);
  const { items, nextCursor, loading, error, reload, loadMore } = useAssetList(settings, filters);
  // Addition undo (Global Admin only) — holds the FAR ID pending confirmation.
  const [undoTargetFarId, setUndoTargetFarId] = useState<string | null>(null);

  // No multi-select Sub Classification filter on this tab (unlike Register) — only an
  // "Equals" custom condition can name an exact classification, same detection
  // scopedSubClassificationNames uses for Register's own condition-based filters.
  const hideC2 = allScopedC1Only(scopedSubClassificationNames(undefined, conditions), subClassifications);
  const rawColumns = hideC2 ? hideC2Columns(RAW_LOG_COLUMNS) : RAW_LOG_COLUMNS;
  const conditionColumns = hideC2 ? LOG_CONDITION_COLUMNS.filter((c) => c.id !== "additionsC2") : LOG_CONDITION_COLUMNS;
  const COLUMNS = resolveColumns(rawColumns, { asAt: settings?.asAt ?? "", fyStart: settings?.fyStart ?? "" });
  const headerFilters = buildConditionHeaderFilters(conditionColumns, conditions, setCondition);

  return (
    <>
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
        headerFilters={headerFilters}
        onDeleteAsset={hasPermission(user, "additions", "undo") ? (farId) => setUndoTargetFarId(farId) : undefined}
        deleteActionLabel="Undo Addition (Global Admin)"
      />
      {undoTargetFarId && (
        <DeleteConfirmModal
          title={`Undo addition on ${undoTargetFarId}`}
          confirmId={undoTargetFarId}
          confirmButtonLabel="Undo Addition"
          description="Clears this asset's recorded addition (amount and date) back to zero/blank. Blocked if the asset has since been disposed — undo the disposal first."
          onClose={() => setUndoTargetFarId(null)}
          onConfirm={async (reason) => {
            const farId = undoTargetFarId;
            await undoAddition(farId, reason);
            setUndoTargetFarId(null);
            showToast(`Addition on ${farId} undone.`, "success");
            reload();
          }}
        />
      )}
    </>
  );
}

export function AdditionsPage() {
  const [tab, setTab] = useState<Tab>("new");
  const [logRefreshKey, setLogRefreshKey] = useState(0);
  const [subClassifications, setSubClassifications] = useState<SubClassificationOption[]>([]);

  useEffect(() => {
    fetchSubClassifications().then(setSubClassifications).catch(() => {});
  }, []);

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
          subClassifications={subClassifications}
          onDone={() => {
            setLogRefreshKey((k) => k + 1);
            setTab("log");
          }}
        />
      )}
      {tab === "log" && (
        <div className="flex min-h-0 flex-1 flex-col" key={logRefreshKey}>
          <AdditionLogTab subClassifications={subClassifications} />
        </div>
      )}
    </div>
  );
}
