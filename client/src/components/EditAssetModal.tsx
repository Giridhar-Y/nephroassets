import { useEffect, useState } from "react";
import { updateAsset, type AssetEditInput } from "../api/client.js";
import { formatCurrency } from "../lib/format.js";
import type { AssetListItem } from "../lib/types.js";
import { EditIcon, ErrorIcon } from "../lib/icons.js";
import { useToast } from "./Toast.js";

type Step = "form" | "confirm";

// Only Serial No, Useful Life C1/C2, and Opening Acc Dep C1/C2 are editable — see the
// server's editAssetSchema for why FAR ID, Date Acquired, Location, Status, Sub
// Classification, cost, and additions fields are deliberately excluded.
export function EditAssetModal({
  asset,
  onClose,
  onDone
}: {
  asset: AssetListItem["asset"];
  onClose: () => void;
  onDone: () => void;
}) {
  const { showToast } = useToast();
  const [step, setStep] = useState<Step>("form");
  const [form, setForm] = useState<AssetEditInput>({
    serialNo: asset.serialNo,
    usefulLifeC1Years: asset.usefulLifeC1Years,
    usefulLifeC2Years: asset.usefulLifeC2Years,
    accDepC1Opening: asset.accDepC1Opening,
    accDepC2Opening: asset.accDepC2Opening
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (step !== "confirm") return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setStep("form");
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [step]);

  function update(patch: Partial<AssetEditInput>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  function handleReview() {
    if (form.usefulLifeC1Years < 0 || form.usefulLifeC2Years < 0) {
      setError("Useful life cannot be negative.");
      return;
    }
    if (form.accDepC1Opening < 0 || form.accDepC2Opening < 0) {
      setError("Opening Acc Dep cannot be negative.");
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
      showToast(`Asset ${asset.farId} updated.`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setSubmitting(false);
    }
  }

  const changes: Array<{ label: string; from: string; to: string }> = [
    { label: "Serial No", from: asset.serialNo || "—", to: form.serialNo || "—" },
    { label: "Useful Life C1 (Yrs)", from: String(asset.usefulLifeC1Years), to: String(form.usefulLifeC1Years) },
    { label: "Useful Life C2 (Yrs)", from: String(asset.usefulLifeC2Years), to: String(form.usefulLifeC2Years) },
    { label: "Opening Acc Dep C1", from: formatCurrency(asset.accDepC1Opening), to: formatCurrency(form.accDepC1Opening) },
    { label: "Opening Acc Dep C2", from: formatCurrency(asset.accDepC2Opening), to: formatCurrency(form.accDepC2Opening) }
  ].filter((c) => c.from !== c.to);

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/30"
      onClick={() => {
        if (step === "confirm") setStep("form");
      }}
    >
      <div
        className={`w-full rounded-xl bg-white p-6 shadow-xl ${step === "confirm" ? "max-w-lg" : "max-w-sm"}`}
        onClick={(e) => e.stopPropagation()}
      >
        {step === "form" && (
          <>
            <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
              <EditIcon fontSize={18} />
              Edit {asset.farId}
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {asset.assetDescription} — only these particulars can be changed after capitalization.
            </p>

            <div className="mt-4 flex flex-col gap-1">
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
                  className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  value={form.usefulLifeC1Years}
                  onChange={(e) => update({ usefulLifeC1Years: Number(e.target.value) })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="edit-life-c2" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                  Useful Life C2 (Yrs)
                </label>
                <input
                  id="edit-life-c2"
                  type="number"
                  min={0}
                  className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  value={form.usefulLifeC2Years}
                  onChange={(e) => update({ usefulLifeC2Years: Number(e.target.value) })}
                />
              </div>
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
            </div>

            <p className="mt-3 text-[11px] text-gray-400">
              Useful Life and Opening Acc Dep aren't locked per period — a change recomputes depreciation for every
              "as of" date, past and future, not just going forward.
            </p>

            {error && (
              <p className="mt-3 flex items-center gap-1.5 text-sm text-red-600">
                <ErrorIcon fontSize={15} />
                {error}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover"
                onClick={handleReview}
              >
                Save Changes
              </button>
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
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100"
                onClick={() => setStep("form")}
                disabled={submitting}
              >
                Go back
              </button>
              <button
                type="button"
                className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
                onClick={handleConfirm}
                disabled={submitting || changes.length === 0}
              >
                {submitting ? "Saving…" : "Confirm & Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
