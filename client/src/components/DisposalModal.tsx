import { useState } from "react";
import { disposeAsset, previewDisposal, type DisposalPreview } from "../api/client.js";
import { formatCurrency, formatDate } from "../lib/format.js";
import type { AssetListItem } from "../lib/types.js";
import { describeAssetRelationship } from "../lib/assetRelationship.js";
import { AssetSelectionEditor } from "./AssetSelectionEditor.js";
import { DeleteIcon, ErrorIcon } from "../lib/icons.js";
import { useToast } from "./Toast.js";
import { Modal } from "./ui/Modal.js";
import { Button } from "./ui/Button.js";

type Step = "form" | "confirm";

export function DisposalModal({
  assets: initialAssets,
  asAt,
  defaultDate,
  onClose,
  onDone
}: {
  /** Starting selection — non-empty from Register's Record Movement, empty from the
   *  dedicated Disposals page's New Disposal button. Fully editable from here via
   *  AssetSelectionEditor either way. */
  assets: AssetListItem[];
  asAt: string;
  defaultDate: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { showToast } = useToast();
  const [step, setStep] = useState<Step>("form");
  const [assets, setAssets] = useState<AssetListItem[]>(initialAssets);
  const [autoAdded, setAutoAdded] = useState<Set<string>>(new Set());
  const [dateOfDisposal, setDateOfDisposal] = useState(defaultDate);
  const [saleValue, setSaleValue] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previews, setPreviews] = useState<Map<string, DisposalPreview>>(new Map());

  // The disposal date must be on or after every selected asset's capitalization date —
  // the binding constraint across a multi-select batch is whichever is latest.
  const minDate = assets.reduce((max, a) => (a.asset.dateAcquired > max ? a.asset.dateAcquired : max), "");

  // A child whose parent is also in this selection is never dealt with directly — the
  // server rejects both a disposal preview and the disposal itself for a child asset
  // ("dispose the parent instead"), since it's disposed automatically as part of the
  // parent's own call. Shared by handleReview and handleConfirm so both agree on which
  // rows get their own API call and which are left to the cascade.
  const selectedFarIds = new Set(assets.map((a) => a.asset.farId));
  const roots = assets.filter((a) => !(a.asset.parentFarId && selectedFarIds.has(a.asset.parentFarId)));

  async function handleReview() {
    if (assets.length === 0) {
      setError("Add at least one asset.");
      return;
    }
    if (dateOfDisposal < minDate) {
      setError(`Disposal date cannot be before the asset's capitalization date (${formatDate(minDate)}).`);
      return;
    }
    setError(null);
    setPreviewing(true);
    setStep("confirm");
    try {
      const results = await Promise.all(roots.map((a) => previewDisposal(a.asset.farId, { dateOfDisposal, saleValue })));
      setPreviews(new Map(results.map((r) => [r.farId, r])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not compute disposal preview.");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      const results = await Promise.all(roots.map((a) => disposeAsset(a.asset.farId, { dateOfDisposal, saleValue })));
      const childrenDisposed = results.reduce((sum, r) => sum + r.childrenDisposed.length, 0);
      const childNote = childrenDisposed > 0 ? ` (including ${childrenDisposed} child asset${childrenDisposed === 1 ? "" : "s"})` : "";
      showToast(`${assets.length} asset${assets.length === 1 ? "" : "s"} disposed${childNote}.`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disposal failed.");
    } finally {
      setSubmitting(false);
    }
  }

  // Dismissing the confirmation step (Esc, click outside) returns to the form with
  // entered values intact — it must never silently submit or discard anything. Neither
  // does anything while still on the form step (no accidental full close either).
  const dismissConfirm = () => {
    if (step === "confirm") setStep("form");
  };

  return (
    <Modal onClose={onClose} onEscape={dismissConfirm} onBackdropClick={dismissConfirm} widthClassName={step === "confirm" ? "max-w-lg" : "max-w-md"}>
      <>
        {step === "form" && (
          <>
            <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
              <DeleteIcon fontSize={18} />
              {assets.length === 0 ? "New Disposal" : `Dispose ${assets.length} asset${assets.length === 1 ? "" : "s"}`}
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Full disposal only — each asset's entire capitalized cost is written off.
            </p>

            <div className="mt-4">
              <AssetSelectionEditor
                asAt={asAt}
                assets={assets}
                autoAdded={autoAdded}
                onChange={(next, nextAuto) => {
                  setAssets(next);
                  setAutoAdded(nextAuto);
                }}
              />
            </div>

            <div className="mt-4 flex flex-col gap-1">
              <label htmlFor="disposal-modal-date" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                Disposal Date
              </label>
              <input
                id="disposal-modal-date"
                type="date"
                min={minDate}
                className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                value={dateOfDisposal}
                onChange={(e) => setDateOfDisposal(e.target.value)}
              />
            </div>

            <div className="mt-3 flex flex-col gap-1">
              <label
                htmlFor="disposal-modal-sale-value"
                className="text-[11px] font-bold uppercase tracking-wide text-gray-500"
              >
                Sale Value{assets.length > 1 ? " (applied to each)" : ""}
              </label>
              <input
                id="disposal-modal-sale-value"
                type="number"
                min={0}
                className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                value={saleValue}
                onChange={(e) => setSaleValue(Number(e.target.value))}
              />
            </div>

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
              <Button onClick={handleReview} disabled={assets.length === 0}>
                Dispose
              </Button>
            </div>
          </>
        )}

        {step === "confirm" && (
          <>
            <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
              <DeleteIcon fontSize={18} />
              Confirm Disposal
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {assets.length} asset{assets.length === 1 ? "" : "s"} will be disposed on {formatDate(dateOfDisposal)}{" "}
              for {formatCurrency(saleValue)} each.
            </p>

            <div className="mt-4 max-h-60 overflow-y-auto rounded-md border border-gray-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">FAR ID</th>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">Relationship</th>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">Asset Description</th>
                    <th className="px-3 py-1.5 text-right font-semibold text-gray-600">Sale Value</th>
                    <th className="px-3 py-1.5 text-right font-semibold text-gray-600">Profit / (Loss)</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((item) => {
                    const preview = previews.get(item.asset.farId);
                    const profitLoss = preview?.profitLoss;
                    return (
                      <tr key={item.asset.farId} className="border-t border-gray-100">
                        <td className="px-3 py-1.5 font-medium text-ink">{item.asset.farId}</td>
                        <td className="px-3 py-1.5 text-gray-500">{describeAssetRelationship(item, assets) ?? "—"}</td>
                        <td className="px-3 py-1.5 text-gray-600">{item.asset.assetDescription}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{formatCurrency(saleValue)}</td>
                        <td
                          className={`px-3 py-1.5 text-right font-medium ${
                            profitLoss === undefined ? "text-gray-400" : profitLoss >= 0 ? "text-green-700" : "text-red-600"
                          }`}
                        >
                          {profitLoss === undefined ? (
                            previewing ? "…" : "—"
                          ) : (
                            <>
                              {profitLoss >= 0 ? "" : "("}
                              {formatCurrency(Math.abs(profitLoss))}
                              {profitLoss >= 0 ? "" : ")"}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-[11px] text-gray-400">
              Depreciation is calculated up to the disposal date above; deletions are each asset's full
              capitalized cost.
            </p>

            <p className="mt-3 text-xs font-medium text-red-600">
              This will mark the asset{assets.length === 1 ? "" : "s"} as Disposed and cannot be easily undone.
              Please confirm the details are correct.
            </p>

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
              <Button onClick={handleConfirm} disabled={submitting || previewing}>
                {submitting ? "Disposing…" : "Confirm & Dispose"}
              </Button>
            </div>
          </>
        )}
      </>
    </Modal>
  );
}
