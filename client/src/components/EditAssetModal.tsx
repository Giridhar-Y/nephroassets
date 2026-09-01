import { useState } from "react";
import { updateAsset, type AssetEditInput, type SubClassificationOption } from "../api/client.js";
import { formatCurrency } from "../lib/format.js";
import type { AssetListItem } from "../lib/types.js";
import { EditIcon, ErrorIcon, PassIcon } from "../lib/icons.js";
import { useToast } from "./Toast.js";
import { FarIdAutocomplete } from "./FarIdAutocomplete.js";
import { Modal } from "./ui/Modal.js";
import { Button } from "./ui/Button.js";

type Step = "form" | "confirm" | "success";

// FAR ID, Sub Classification, Asset Description, Serial No, Useful Life C1/C2, Opening
// Acc Dep C1/C2, and Parent FAR ID are editable — see the server's editAssetSchema for
// why FAR ID (identity, not a calc input) and these other categorization fields are safe
// to correct after capitalization, while Date Acquired, Location, Status, cost, and
// additions fields are not. Parent FAR ID links this asset to another as its child — a
// child always moves/disposes together with its parent (Transfer/Disposal cascade to
// it automatically) while still appearing as its own row everywhere, including here.
export function EditAssetModal({
  asset,
  subClassifications,
  asAt,
  onClose,
  onDone
}: {
  asset: AssetListItem["asset"];
  subClassifications: SubClassificationOption[];
  asAt: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { showToast } = useToast();
  const [step, setStep] = useState<Step>("form");
  const [form, setForm] = useState<AssetEditInput>({
    farId: asset.farId,
    subClassification: asset.subClassification,
    assetDescription: asset.assetDescription,
    serialNo: asset.serialNo,
    usefulLifeC1Years: asset.usefulLifeC1Years,
    usefulLifeC2Years: asset.usefulLifeC2Years,
    accDepC1Opening: asset.accDepC1Opening,
    accDepC2Opening: asset.accDepC2Opening,
    parentFarId: asset.parentFarId
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(patch: Partial<AssetEditInput>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  const hasComponent2 = subClassifications.find((s) => s.name === form.subClassification)?.hasComponent2 ?? true;

  // Same reasoning as CapitalizationPage's updateSubClassification: clear C2 fields
  // (not just hide them) when switching to a C1-only classification, so a stale value
  // left in state can't get silently submitted and rejected by the server's own check.
  function updateSubClassification(name: string) {
    const nowHasC2 = subClassifications.find((s) => s.name === name)?.hasComponent2 ?? true;
    update(nowHasC2 ? { subClassification: name } : { subClassification: name, usefulLifeC2Years: 0, accDepC2Opening: 0 });
  }

  function handleReview() {
    if (!form.farId.trim()) {
      setError("FAR ID is required.");
      return;
    }
    if (!form.subClassification.trim()) {
      setError("Sub Classification is required.");
      return;
    }
    if (!form.assetDescription.trim()) {
      setError("Asset Description is required.");
      return;
    }
    if (form.usefulLifeC1Years < 0 || form.usefulLifeC2Years < 0) {
      setError("Useful life cannot be negative.");
      return;
    }
    if (form.accDepC1Opening < 0 || form.accDepC2Opening < 0) {
      setError("Opening Acc Dep cannot be negative.");
      return;
    }
    if (form.parentFarId === asset.farId || form.parentFarId === form.farId) {
      setError("An asset cannot be its own parent.");
      return;
    }
    setError(null);
    setStep("confirm");
  }

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      await updateAsset(asset.farId, form);
      setStep("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleDone() {
    // A toast too, so the confirmation survives after this modal closes (matching every
    // other action in the app) — not shown *instead of* the in-modal success step, since
    // a rename is disorienting enough (the row's FAR ID just changed under the user)
    // that it's worth a beat of explicit, undismissable-until-acknowledged confirmation
    // right where the edit happened, not just a corner toast that can be missed.
    showToast(`${form.farId} updated successfully.`);
    onDone();
  }

  const changes: Array<{ label: string; from: string; to: string }> = [
    { label: "FAR ID", from: asset.farId, to: form.farId },
    { label: "Sub Classification", from: asset.subClassification, to: form.subClassification },
    { label: "Asset Description", from: asset.assetDescription, to: form.assetDescription },
    { label: "Serial No", from: asset.serialNo || "—", to: form.serialNo || "—" },
    { label: "Useful Life C1 (Yrs)", from: String(asset.usefulLifeC1Years), to: String(form.usefulLifeC1Years) },
    { label: "Useful Life C2 (Yrs)", from: String(asset.usefulLifeC2Years), to: String(form.usefulLifeC2Years) },
    { label: "Opening Acc Dep C1", from: formatCurrency(asset.accDepC1Opening), to: formatCurrency(form.accDepC1Opening) },
    { label: "Opening Acc Dep C2", from: formatCurrency(asset.accDepC2Opening), to: formatCurrency(form.accDepC2Opening) },
    { label: "Parent FAR ID", from: asset.parentFarId ?? "—", to: form.parentFarId ?? "—" }
  ].filter((c) => c.from !== c.to);

  // Dismissing the confirmation step (Esc, click outside) returns to the form with
  // entered values intact — it must never silently submit or discard anything. Neither
  // does anything while still on the form step (no accidental full close either).
  const dismissConfirm = () => {
    if (step === "confirm") setStep("form");
  };

  return (
    <Modal onClose={onClose} onEscape={dismissConfirm} onBackdropClick={dismissConfirm} widthClassName={step === "form" ? "max-w-sm" : "max-w-lg"}>
      <>
        {step === "form" && (
          <>
            <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
              <EditIcon fontSize={18} />
              Edit {asset.farId}
            </h2>
            <p className="mt-1 text-sm text-gray-500">{asset.assetDescription}</p>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="edit-far-id" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                  FAR ID
                </label>
                <input
                  id="edit-far-id"
                  type="text"
                  className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  value={form.farId}
                  onChange={(e) => update({ farId: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="edit-sub-class" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                  Sub Classification
                </label>
                <select
                  id="edit-sub-class"
                  className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  value={form.subClassification}
                  onChange={(e) => updateSubClassification(e.target.value)}
                >
                  {!subClassifications.some((s) => s.name === form.subClassification) && (
                    <option value={form.subClassification}>{form.subClassification}</option>
                  )}
                  {subClassifications.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-1">
              <label htmlFor="edit-description" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                Asset Description
              </label>
              <input
                id="edit-description"
                type="text"
                className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                value={form.assetDescription}
                onChange={(e) => update({ assetDescription: e.target.value })}
              />
            </div>

            <div className="mt-3 flex flex-col gap-1">
              <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                Parent Asset
              </label>
              {form.parentFarId ? (
                <div className="flex items-center justify-between rounded-md border border-gray-300 px-2 py-1.5 text-sm">
                  <span className="font-medium text-ink">{form.parentFarId}</span>
                  <button
                    type="button"
                    className="text-xs font-medium text-accent hover:underline"
                    onClick={() => update({ parentFarId: null })}
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <FarIdAutocomplete
                  asAt={asAt}
                  placeholder="Search to link this as a child of another asset…"
                  onSelect={(item) => update({ parentFarId: item.asset.farId })}
                />
              )}
              <p className="text-[11px] text-gray-400">
                A child asset always moves and disposes together with its parent.
              </p>
            </div>

            <div className="mt-3 flex flex-col gap-1">
              <label htmlFor="edit-serial-no" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                Serial No
              </label>
              <input
                id="edit-serial-no"
                type="text"
                className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                value={form.serialNo}
                onChange={(e) => update({ serialNo: e.target.value })}
              />
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="edit-life-c1" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                  Useful Life C1 (Yrs)
                </label>
                <input
                  id="edit-life-c1"
                  type="number"
                  min={0}
                  step="0.01"
                  className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  value={form.usefulLifeC1Years}
                  onChange={(e) => update({ usefulLifeC1Years: Number(e.target.value) })}
                />
              </div>
              {hasComponent2 && (
                <div className="flex flex-col gap-1">
                  <label htmlFor="edit-life-c2" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                    Useful Life C2 (Yrs)
                  </label>
                  <input
                    id="edit-life-c2"
                    type="number"
                    min={0}
                    step="0.01"
                    className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                    value={form.usefulLifeC2Years}
                    onChange={(e) => update({ usefulLifeC2Years: Number(e.target.value) })}
                  />
                </div>
              )}
              <div className="flex flex-col gap-1">
                <label htmlFor="edit-accdep-c1" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                  Opening Acc Dep C1
                </label>
                <input
                  id="edit-accdep-c1"
                  type="number"
                  min={0}
                  className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  value={form.accDepC1Opening}
                  onChange={(e) => update({ accDepC1Opening: Number(e.target.value) })}
                />
              </div>
              {hasComponent2 && (
                <div className="flex flex-col gap-1">
                  <label htmlFor="edit-accdep-c2" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                    Opening Acc Dep C2
                  </label>
                  <input
                    id="edit-accdep-c2"
                    type="number"
                    min={0}
                    className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                    value={form.accDepC2Opening}
                    onChange={(e) => update({ accDepC2Opening: Number(e.target.value) })}
                  />
                </div>
              )}
            </div>

            <p className="mt-3 text-[11px] text-gray-400">
              Useful Life and Opening Acc Dep aren't locked per period — a change recomputes depreciation for every
              "as of" date, past and future, not just going forward. Renaming FAR ID carries this asset's transfer
              history with it.
            </p>

            {error && (
              <p className="mt-3 flex items-center gap-1.5 text-sm text-red-600">
                <ErrorIcon fontSize={15} />
                {error}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleReview}>Save Changes</Button>
            </div>
          </>
        )}

        {step === "confirm" && (
          <>
            <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
              <EditIcon fontSize={18} />
              Confirm Changes
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {changes.length === 0 ? "No fields were changed." : `${changes.length} field${changes.length === 1 ? "" : "s"} will change on ${asset.farId}.`}
            </p>

            {changes.length > 0 && (
              <div className="mt-4 overflow-hidden rounded-md border border-gray-200">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-semibold text-gray-600">Field</th>
                      <th className="px-3 py-1.5 text-left font-semibold text-gray-600">From</th>
                      <th className="px-3 py-1.5 text-left font-semibold text-gray-600">To</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changes.map((c) => (
                      <tr key={c.label} className="border-t border-gray-100">
                        <td className="px-3 py-1.5 font-medium text-ink">{c.label}</td>
                        <td className="px-3 py-1.5 text-gray-500">{c.from}</td>
                        <td className="px-3 py-1.5 font-medium text-ink">{c.to}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {error && (
              <p className="mt-3 flex items-center gap-1.5 text-sm text-red-600">
                <ErrorIcon fontSize={15} />
                {error}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setStep("form")} disabled={submitting}>
                Go back
              </Button>
              <Button onClick={handleConfirm} disabled={submitting || changes.length === 0}>
                {submitting ? "Saving…" : "Confirm & Save"}
              </Button>
            </div>
          </>
        )}

        {step === "success" && (
          <div className="flex flex-col items-center py-4 text-center">
            <PassIcon fontSize={40} className="text-green-600" />
            <h2 className="mt-3 font-heading text-base font-semibold text-ink">Asset Updated</h2>
            <p className="mt-1 text-sm text-gray-500">
              {form.farId} was updated successfully — {changes.length} field{changes.length === 1 ? "" : "s"} changed.
            </p>
            <Button className="mt-6" onClick={handleDone}>
              Done
            </Button>
          </div>
        )}
      </>
    </Modal>
  );
}
