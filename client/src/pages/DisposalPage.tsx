import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../lib/SettingsContext.js";
import { useAssetList } from "../hooks/useAssetList.js";
import { AssetGrid } from "../components/AssetGrid.js";
import { DisposalModal } from "../components/DisposalModal.js";
import { DeleteConfirmModal } from "../components/DeleteConfirmModal.js";
import { useToast } from "../components/Toast.js";
import { ALL_COLUMNS, resolveColumns } from "../lib/columns.js";
import { useAuth } from "../lib/AuthContext.js";
import { undoDisposal } from "../api/client.js";
import type { ColumnCondition, ColumnFilterType } from "../lib/columnFilters.js";
import { buildConditionHeaderFilters, makeSetCondition } from "../lib/conditionHeaderFilters.js";
import { DeleteIcon, UploadIcon } from "../lib/icons.js";
import { hasPermission } from "../lib/permissions.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { Button } from "../components/ui/Button.js";
import { GridViewControls } from "../components/ui/GridViewControls.js";
import { useDensity } from "../hooks/useDensity.js";

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
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="flex-1 overflow-auto px-6 py-6">
      <div className="max-w-md rounded-xl bg-white p-6 shadow-sm">
        <p className="text-sm text-gray-600">Dispose one or more assets in a single action.</p>

        <button
          type="button"
          className="mt-4 flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setModalOpen(true)}
          disabled={!asAt}
        >
          <DeleteIcon fontSize={15} />
          New Disposal
        </button>
      </div>

      {modalOpen && asAt && (
        <DisposalModal
          assets={[]}
          asAt={asAt}
          defaultDate={asAt}
          onClose={() => setModalOpen(false)}
          onDone={() => {
            setModalOpen(false);
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
  const { user } = useAuth();
  const { showToast } = useToast();
  const [conditions, setConditions] = useState<ColumnCondition[]>([]);
  const filters = useMemo(() => ({ status: ["Disposed"], conditions }), [conditions]);
  const setCondition = makeSetCondition(conditions, setConditions);
  const { items, nextCursor, loading, loadingMore, error, reload, loadMore } = useAssetList(settings, filters);
  const COLUMNS = resolveColumns(RAW_COLUMNS, { asAt: settings?.asAt ?? "", fyStart: settings?.fyStart ?? "" });
  const headerFilters = buildConditionHeaderFilters(LOG_CONDITION_COLUMNS, conditions, setCondition);
  // Disposal undo (Global Admin only) — holds the FAR ID pending confirmation.
  const [undoTargetFarId, setUndoTargetFarId] = useState<string | null>(null);
  const [density, setDensity] = useDensity();
  const [gridExpanded, setGridExpanded] = useState(false);

  return (
    <>
      <div className="flex items-center justify-end border-b border-gray-200 bg-white px-6 py-2">
        <GridViewControls density={density} onDensityChange={setDensity} expanded={gridExpanded} onExpandedChange={setGridExpanded} />
      </div>
      <AssetGrid
        items={items}
        columns={COLUMNS}
        loading={loading}
        loadingMore={loadingMore}
        error={error}
        hasMore={!!nextCursor}
        onLoadMore={loadMore}
        onRetry={reload}
        emptyTitle="No disposed assets yet."
        emptyHint="Dispose an asset from the New Disposal tab, or from the Register (select rows, then Dispose Selected)."
        headerFilters={headerFilters}
        onDeleteAsset={hasPermission(user, "disposals", "undo") ? (farId) => setUndoTargetFarId(farId) : undefined}
        deleteActionLabel="Undo Disposal (Global Admin)"
        density={density}
        onDensityChange={setDensity}
        expanded={gridExpanded}
        onExpandedChange={setGridExpanded}
      />
      {undoTargetFarId && (
        <DeleteConfirmModal
          title={`Undo disposal of ${undoTargetFarId}`}
          confirmId={undoTargetFarId}
          confirmButtonLabel="Undo Disposal"
          description="Reverses this disposal — status is restored to Active (the exact pre-disposal status isn't stored, correct it via Edit if it was something else). Also automatically un-disposes any child asset that was disposed as part of this same cascade. Blocked if this disposal was itself cascaded from a parent — undo the parent's disposal instead."
          onClose={() => setUndoTargetFarId(null)}
          onConfirm={async (reason) => {
            const farId = undoTargetFarId;
            const result = await undoDisposal(farId, reason);
            setUndoTargetFarId(null);
            showToast(
              result.childrenUndone.length > 0
                ? `Disposal of ${farId} undone, along with ${result.childrenUndone.length} cascaded child asset(s).`
                : `Disposal of ${farId} undone.`,
              "success"
            );
            reload();
          }}
        />
      )}
    </>
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
      <PageHeader
        icon={DeleteIcon}
        title="Disposals"
        subtitle="Dispose one or more assets, or browse everything that's been disposed."
        actions={
          hasPermission(user, "bulkUpload", "disposals") && (
            <Button variant="secondary" size="sm" onClick={() => navigate("/bulk-upload?type=disposals")}>
              <UploadIcon fontSize={14} />
              Bulk Disposal
            </Button>
          )
        }
      >
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
      </PageHeader>

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
