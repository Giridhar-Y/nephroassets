import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  createAsset,
  deleteAsset,
  fetchCenters,
  fetchStatuses,
  fetchSubClassifications,
  type SubClassificationOption
} from "../api/client.js";
import { useSettings } from "../lib/SettingsContext.js";
import { useAssetList } from "../hooks/useAssetList.js";
import { AssetGrid } from "../components/AssetGrid.js";
import { DeleteConfirmModal } from "../components/DeleteConfirmModal.js";
import { useToast } from "../components/Toast.js";
import { FarIdAutocomplete } from "../components/FarIdAutocomplete.js";
import { ALL_COLUMNS, allScopedC1Only, hideC2Columns, resolveColumns, scopedSubClassificationNames } from "../lib/columns.js";
import { useAuth } from "../lib/AuthContext.js";
import type { AssetCreateInput, AssetFilters } from "../lib/types.js";
import type { ColumnCondition, ColumnFilterType } from "../lib/columnFilters.js";
import { buildConditionHeaderFilters, makeSetCondition } from "../lib/conditionHeaderFilters.js";
import { AddCircleIcon, ErrorIcon, UploadIcon } from "../lib/icons.js";

type Tab = "add" | "log";

const LOG_COLUMN_IDS = [
  "farId",
  "assetDescription",
  "subClassification",
  "dateAcquired",
  "location",
  "c1OpeningCost",
  "c2OpeningCost",
  "status"
];
const RAW_LOG_COLUMNS = LOG_COLUMN_IDS.map((id) => ALL_COLUMNS.find((c) => c.id === id)).filter((c) => !!c);

// Excel-style custom-condition filters for every log column (see conditionHeaderFilters.tsx).
const LOG_CONDITION_COLUMNS: Array<{ id: string; label: string; type: ColumnFilterType }> = [
  { id: "farId", label: "FAR ID", type: "text" },
  { id: "assetDescription", label: "Asset Description", type: "text" },
  { id: "subClassification", label: "Sub Classification", type: "text" },
  { id: "dateAcquired", label: "Date Acquired", type: "date" },
  { id: "location", label: "Capitalized Location", type: "text" },
  { id: "c1OpeningCost", label: "C1 Opening Gross Block", type: "number" },
  { id: "c2OpeningCost", label: "C2 Opening Gross Block", type: "number" },
  { id: "status", label: "Status", type: "text" }
];

function blankForm(defaultDate: string): AssetCreateInput {
  return {
    farId: "",
    subClassification: "",
    assetDescription: "",
    serialNo: "",
    qty: 1,
    status: "Active",
    dateAcquired: defaultDate,
    location: "",
    usefulLifeC1Years: 0,
    usefulLifeC2Years: 0,
    c1OpeningCost: 0,
    c2OpeningCost: 0,
    additionsC1: 0,
    additionsC2: 0,
    dateOfAddition: null,
    accDepC1Opening: 0,
    accDepC2Opening: 0
  };
}

const LABEL_CLASS = "text-[11px] font-bold uppercase tracking-wide text-gray-500";
const INPUT_CLASS =
  "w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

function Field({
  label,
  htmlFor,
  children
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className={LABEL_CLASS}>
        {label}
      </label>
      {children}
    </div>
  );
}

export function CapitalizationPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { settings } = useSettings();
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>("add");
  const [centers, setCenters] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [subClassifications, setSubClassifications] = useState<SubClassificationOption[]>([]);
  // Capitalization delete (Global Admin only) — holds the FAR ID pending confirmation;
  // null when the modal is closed.
  const [deleteTargetFarId, setDeleteTargetFarId] = useState<string | null>(null);
  const [form, setForm] = useState<AssetCreateInput>(() => blankForm(settings?.asAt ?? ""));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Kept fetching regardless of the active tab (like Disposals' own log) so the data is
  // already fresh — no loading flicker — the moment the user switches to the Log tab or
  // clicks "View in Log" in the success toast below.
  const [logConditions, setLogConditions] = useState<ColumnCondition[]>([]);
  const logFilters: AssetFilters = useMemo(() => ({ conditions: logConditions }), [logConditions]);
  const setLogCondition = makeSetCondition(logConditions, setLogConditions);
  const logSort = useMemo(() => ({ sortBy: "dateAcquired" as const, sortDir: "desc" as const }), []);
  // No multi-select Sub Classification filter on this log tab (unlike Register) — only
  // an "Equals" custom condition can name an exact classification.
  const logHideC2 = allScopedC1Only(scopedSubClassificationNames(undefined, logConditions), subClassifications);
  const logRawColumns = logHideC2 ? hideC2Columns(RAW_LOG_COLUMNS) : RAW_LOG_COLUMNS;
  const logConditionColumns = logHideC2 ? LOG_CONDITION_COLUMNS.filter((c) => c.id !== "c2OpeningCost") : LOG_CONDITION_COLUMNS;
  const LOG_COLUMNS = resolveColumns(logRawColumns, { asAt: settings?.asAt ?? "", fyStart: settings?.fyStart ?? "" });
  const {
    items: logItems,
    nextCursor: logNextCursor,
    loading: logLoading,
    error: logError,
    reload: reloadLog,
    loadMore: loadMoreLog
  } = useAssetList(settings, logFilters, logSort);

  useEffect(() => {
    fetchCenters().then(setCenters).catch(() => {});
    // excludeSystemManaged: a brand-new asset must never be capitalized as already
    // Disposed — that status is only ever set through the Disposal flow.
    fetchStatuses(true).then(setStatuses).catch(() => {});
    fetchSubClassifications().then(setSubClassifications).catch(() => {});
  }, []);

  const update = (patch: Partial<AssetCreateInput>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const hasComponent2 = subClassifications.find((s) => s.name === form.subClassification)?.hasComponent2 ?? true;

  // Clearing C2 fields when the newly-picked Sub Classification is C1-only, not just
  // hiding them — a value left over in state from before the switch would otherwise
  // still get submitted and rejected by the server's own C2-on-C1-only check, a
  // confusing error for fields the user can no longer even see.
  function updateSubClassification(name: string) {
    const nowHasC2 = subClassifications.find((s) => s.name === name)?.hasComponent2 ?? true;
    update(
      nowHasC2
        ? { subClassification: name }
        : { subClassification: name, usefulLifeC2Years: 0, c2OpeningCost: 0, additionsC2: 0, accDepC2Opening: 0 }
    );
  }

  const logHeaderFilters: Partial<Record<string, ReactNode>> = buildConditionHeaderFilters(
    logConditionColumns,
    logConditions,
    setLogCondition
  );

  function validate(): string | null {
    if (!form.farId.trim()) return "FAR ID is required.";
    if (!form.subClassification.trim()) return "Sub Classification is required.";
    if (!form.assetDescription.trim()) return "Asset Description is required.";
    if (!form.status.trim()) return "Status is required.";
    if (!form.dateAcquired) return "Date Acquired is required.";
    if (!form.location.trim()) return "Location is required.";
    if (form.usefulLifeC1Years < 0 || form.usefulLifeC2Years < 0) return "Useful life cannot be negative.";
    return null;
  }

  async function handleSubmit() {
    const validation = validate();
    if (validation) {
      setError(validation);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createAsset(form);
      showToast(`Asset ${form.farId} (${form.assetDescription}) capitalized successfully.`, "success", {
        label: "View in Log",
        onClick: () => setTab("log")
      });
      setForm(blankForm(settings?.asAt ?? ""));
      reloadLog();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not capitalize the asset.", "error");
    } finally {
      setSubmitting(false);
    }
  }

  const logFilterCount = logConditions.length;

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
            <AddCircleIcon fontSize={20} />
            Capitalization
          </h1>
          {user?.role !== "viewer" && (
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
              onClick={() => navigate("/bulk-upload?type=assets")}
            >
              <UploadIcon fontSize={14} />
              Bulk Upload
            </button>
          )}
        </div>
        <p className="mt-1 max-w-xl text-sm text-gray-500">
          {tab === "add"
            ? "Register a brand-new asset into the Fixed Asset Register."
            : "Every asset that has been capitalized, newest first."}
        </p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              tab === "add" ? "bg-accent text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
            onClick={() => setTab("add")}
          >
            Add New
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              tab === "log" ? "bg-accent text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
            onClick={() => setTab("log")}
          >
            Capitalization Log
          </button>
        </div>
      </div>

      {tab === "add" && (
        <div className="flex-1 overflow-auto px-6 py-6">
          <div className="max-w-3xl rounded-xl bg-white p-6 shadow-sm">
            <div className="grid grid-cols-2 gap-4">
              <Field label="FAR ID" htmlFor="cap-far-id">
                <input
                  id="cap-far-id"
                  type="text"
                  className={INPUT_CLASS}
                  value={form.farId}
                  onChange={(e) => update({ farId: e.target.value })}
                />
              </Field>
              <Field label="Sub Classification" htmlFor="cap-sub-class">
                <select
                  id="cap-sub-class"
                  className={INPUT_CLASS}
                  value={form.subClassification}
                  onChange={(e) => updateSubClassification(e.target.value)}
                >
                  <option value="">Select…</option>
                  {subClassifications.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Asset Description" htmlFor="cap-description">
                <input
                  id="cap-description"
                  type="text"
                  className={INPUT_CLASS}
                  value={form.assetDescription}
                  onChange={(e) => update({ assetDescription: e.target.value })}
                />
              </Field>
              <Field label="Serial No" htmlFor="cap-serial">
                <input
                  id="cap-serial"
                  type="text"
                  className={INPUT_CLASS}
                  value={form.serialNo}
                  onChange={(e) => update({ serialNo: e.target.value })}
                />
              </Field>

              <Field label="Qty" htmlFor="cap-qty">
                <input
                  id="cap-qty"
                  type="number"
                  min={0}
                  className={INPUT_CLASS}
                  value={form.qty}
                  onChange={(e) => update({ qty: Number(e.target.value) })}
                />
              </Field>
              <Field label="Status" htmlFor="cap-status">
                <select id="cap-status" className={INPUT_CLASS} value={form.status} onChange={(e) => update({ status: e.target.value })}>
                  <option value="">Select…</option>
                  {statuses.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Date Acquired" htmlFor="cap-date-acquired">
                <input
                  id="cap-date-acquired"
                  type="date"
                  className={INPUT_CLASS}
                  value={form.dateAcquired}
                  onChange={(e) => update({ dateAcquired: e.target.value })}
                />
              </Field>
              <Field label="Location" htmlFor="cap-location">
                <select
                  id="cap-location"
                  className={INPUT_CLASS}
                  value={form.location}
                  onChange={(e) => update({ location: e.target.value })}
                >
                  <option value="">Select…</option>
                  {centers.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="mt-6 border-t border-gray-100 pt-4">
              <h2 className="text-sm font-semibold text-ink">Cost &amp; Useful Life</h2>
              <div className="mt-3 grid grid-cols-2 gap-4">
                <Field label="Component 1 Useful Life (Years)" htmlFor="cap-life-c1">
                  <input
                    id="cap-life-c1"
                    type="number"
                    min={0}
                    step="0.01"
                    className={INPUT_CLASS}
                    value={form.usefulLifeC1Years}
                    onChange={(e) => update({ usefulLifeC1Years: Number(e.target.value) })}
                  />
                </Field>
                {hasComponent2 && (
                  <Field label="Component 2 Useful Life (Years)" htmlFor="cap-life-c2">
                    <input
                      id="cap-life-c2"
                      type="number"
                      min={0}
                      step="0.01"
                      className={INPUT_CLASS}
                      value={form.usefulLifeC2Years}
                      onChange={(e) => update({ usefulLifeC2Years: Number(e.target.value) })}
                    />
                  </Field>
                )}
                <Field label="Component 1 Opening Cost" htmlFor="cap-cost-c1">
                  <input
                    id="cap-cost-c1"
                    type="number"
                    min={0}
                    className={INPUT_CLASS}
                    value={form.c1OpeningCost}
                    onChange={(e) => update({ c1OpeningCost: Number(e.target.value) })}
                  />
                </Field>
                {hasComponent2 && (
                  <Field label="Component 2 Opening Cost" htmlFor="cap-cost-c2">
                    <input
                      id="cap-cost-c2"
                      type="number"
                      min={0}
                      className={INPUT_CLASS}
                      value={form.c2OpeningCost}
                      onChange={(e) => update({ c2OpeningCost: Number(e.target.value) })}
                    />
                  </Field>
                )}
              </div>
            </div>

            <div className="mt-6 border-t border-gray-100 pt-4">
              <h2 className="text-sm font-semibold text-ink">Mid-Year Additions (optional)</h2>
              <div className="mt-3 grid grid-cols-3 gap-4">
                <Field label="Additions C1" htmlFor="cap-add-c1">
                  <input
                    id="cap-add-c1"
                    type="number"
                    min={0}
                    className={INPUT_CLASS}
                    value={form.additionsC1}
                    onChange={(e) => update({ additionsC1: Number(e.target.value) })}
                  />
                </Field>
                {hasComponent2 && (
                  <Field label="Additions C2" htmlFor="cap-add-c2">
                    <input
                      id="cap-add-c2"
                      type="number"
                      min={0}
                      className={INPUT_CLASS}
                      value={form.additionsC2}
                      onChange={(e) => update({ additionsC2: Number(e.target.value) })}
                    />
                  </Field>
                )}
                <Field label="Date of Addition" htmlFor="cap-add-date">
                  <input
                    id="cap-add-date"
                    type="date"
                    className={INPUT_CLASS}
                    value={form.dateOfAddition ?? ""}
                    onChange={(e) => update({ dateOfAddition: e.target.value || null })}
                  />
                </Field>
              </div>
            </div>

            <div className="mt-6 border-t border-gray-100 pt-4">
              <h2 className="text-sm font-semibold text-ink">Parent Asset (optional)</h2>
              <p className="mt-1 text-xs text-gray-500">
                Link this new asset as a child of an existing one — it'll always move and dispose together with its
                parent, while keeping its own cost, quantity, and useful life.
              </p>
              <div className="mt-3 max-w-sm">
                {form.parentFarId ? (
                  <div className="flex items-center justify-between rounded-md border border-gray-300 px-2 py-1.5 text-sm">
                    <span className="font-medium text-ink">{form.parentFarId}</span>
                    <button
                      type="button"
                      className="text-xs font-medium text-accent hover:underline"
                      onClick={() => update({ parentFarId: undefined })}
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <FarIdAutocomplete
                    asAt={settings?.asAt ?? ""}
                    placeholder="Search to link this as a child of another asset…"
                    onSelect={(item) => update({ parentFarId: item.asset.farId })}
                  />
                )}
              </div>
            </div>

            <div className="mt-6 border-t border-gray-100 pt-4">
              <h2 className="text-sm font-semibold text-ink">Opening Accumulated Depreciation (optional)</h2>
              <div className="mt-3 grid grid-cols-2 gap-4">
                <Field label="Component 1" htmlFor="cap-accdep-c1">
                  <input
                    id="cap-accdep-c1"
                    type="number"
                    min={0}
                    className={INPUT_CLASS}
                    value={form.accDepC1Opening}
                    onChange={(e) => update({ accDepC1Opening: Number(e.target.value) })}
                  />
                </Field>
                {hasComponent2 && (
                  <Field label="Component 2" htmlFor="cap-accdep-c2">
                    <input
                      id="cap-accdep-c2"
                      type="number"
                      min={0}
                      className={INPUT_CLASS}
                      value={form.accDepC2Opening}
                      onChange={(e) => update({ accDepC2Opening: Number(e.target.value) })}
                    />
                  </Field>
                )}
              </div>
            </div>

            {error && (
              <p className="mt-4 flex items-center gap-1.5 text-sm text-red-600">
                <ErrorIcon fontSize={15} />
                {error}
              </p>
            )}

            <button
              type="button"
              className="mt-6 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? "Capitalizing…" : "Capitalize Asset"}
            </button>
          </div>
        </div>
      )}

      {tab === "log" && (
        <div className="flex min-h-0 flex-1 flex-col">
          {logFilterCount > 0 && (
            <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-6 py-2">
              <span className="flex items-center gap-1 rounded-full bg-ink px-2 py-0.5 text-[11px] font-semibold text-white">
                {logFilterCount} filter{logFilterCount === 1 ? "" : "s"} applied
              </span>
              <button
                type="button"
                className="text-xs font-medium text-accent hover:underline"
                onClick={() => setLogConditions([])}
              >
                Clear all filters
              </button>
            </div>
          )}
          <AssetGrid
            items={logItems}
            columns={LOG_COLUMNS}
            loading={logLoading}
            error={logError}
            hasMore={!!logNextCursor}
            onLoadMore={loadMoreLog}
            onRetry={reloadLog}
            emptyTitle="No assets have been capitalized yet."
            emptyHint="Assets you capitalize from the Add New tab will show up here."
            headerFilters={logHeaderFilters}
            getAssetHref={(farId) => `/assets/${encodeURIComponent(farId)}`}
            onDeleteAsset={user?.role === "admin" ? (farId) => setDeleteTargetFarId(farId) : undefined}
            deleteActionLabel="Delete (Global Admin)"
          />
        </div>
      )}

      {deleteTargetFarId && (
        <DeleteConfirmModal
          title={`Delete ${deleteTargetFarId}`}
          confirmId={deleteTargetFarId}
          description="Soft-deletes this asset — it disappears from the Register and every Report, but the row and its full history survive for audit purposes. Blocked if it has any transfer, addition, disposal, or child assets; undo those first."
          onClose={() => setDeleteTargetFarId(null)}
          onConfirm={async (reason) => {
            const farId = deleteTargetFarId;
            await deleteAsset(farId, reason);
            setDeleteTargetFarId(null);
            showToast(`${farId} deleted.`, "success");
            reloadLog();
          }}
        />
      )}
    </div>
  );
}
