import { useState } from "react";
import { recordAddition } from "../api/client.js";
import { formatCurrency, formatDate } from "../lib/format.js";
import type { AssetListItem } from "../lib/types.js";
import { AdditionIcon, ErrorIcon } from "../lib/icons.js";
import { useToast } from "./Toast.js";
import { FarIdAutocomplete } from "./FarIdAutocomplete.js";
import { Modal } from "./ui/Modal.js";
import { Button } from "./ui/Button.js";

type Step = "form" | "confirm";

// Single-asset only — unlike TransferModal/DisposalModal, this has no Register
// multi-select use case to also serve, and an asset can only ever carry one addition
// (see the server's additionSchema comment), so there's nothing to batch.
export function AdditionModal({
  asset,
  hasComponent2,
  defaultDate,
  asAt,
  onClose,
  onDone
}: {
  asset: AssetListItem["asset"];
  hasComponent2: boolean;
  defaultDate: string;
  asAt: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { showToast } = useToast();
  const [step, setStep] = useState<Step>("form");
  const [additionsC1, setAdditionsC1] = useState(0);
  const [additionsC2, setAdditionsC2] = useState(0);
  const [dateOfAddition, setDateOfAddition] = useState(defaultDate);
  // A smaller, separate affordance from Capitalization's own parent field — links this
  // *already-existing* asset to a parent while recording the addition, instead of a
  // second trip through Edit. Only offered when the asset isn't already linked (this
  // endpoint can only set the link, not clear one — see the server's additionSchema).
  const [linkParentFarId, setLinkParentFarId] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleReview() {
    if (additionsC1 === 0 && additionsC2 === 0) {
      setError("Enter an amount for Additions C1 or C2.");
      return;
    }
    if (dateOfAddition < asset.dateAcquired) {
      setError(`Addition date cannot be before the asset's capitalization date (${formatDate(asset.dateAcquired)}).`);
      return;
    }
    if (linkParentFarId === asset.farId) {
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
      await recordAddition(asset.farId, { additionsC1, additionsC2, dateOfAddition, parentFarId: linkParentFarId });
      showToast(`Addition recorded on ${asset.farId}.`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the addition.");
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
    <Modal onClose={onClose} onEscape={dismissConfirm} onBackdropClick={dismissConfirm} widthClassName={step === "confirm" ? "max-w-lg" : "max-w-sm"}>
      <>
        {step === "form" && (
          <>
            <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
              <AdditionIcon fontSize={18} />
              Record Addition — {asset.farId}
            </h2>
            <p className="mt-1 text-sm text-gray-500">{asset.assetDescription}</p>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="add-c1" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                  Additions C1
                </label>
                <input
                  id="add-c1"
                  type="number"
                  min={0}
                  className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  value={additionsC1}
                  onChange={(e) => setAdditionsC1(Number(e.target.value))}
                />
              </div>
              {hasComponent2 && (
                <div className="flex flex-col gap-1">
                  <label htmlFor="add-c2" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                    Additions C2
                  </label>
                  <input
                    id="add-c2"
                    type="number"
                    min={0}
                    className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                    value={additionsC2}
                    onChange={(e) => setAdditionsC2(Number(e.target.value))}
                  />
                </div>
              )}
            </div>

            <div className="mt-3 flex flex-col gap-1">
              <label htmlFor="add-date" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                Date of Addition
              </label>
              <input
                id="add-date"
                type="date"
                min={asset.dateAcquired}
                className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                value={dateOfAddition}
                onChange={(e) => setDateOfAddition(e.target.value)}
              />
            </div>

            {asset.parentFarId ? (
              <p className="mt-3 text-[11px] text-gray-400">
                Already linked as a child of {asset.parentFarId} — manage this link via Edit.
              </p>
            ) : (
              <div className="mt-3 flex flex-col gap-1">
                <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                  Link to Parent (optional)
                </label>
                {linkParentFarId ? (
                  <div className="flex items-center justify-between rounded-md border border-gray-300 px-2 py-1.5 text-sm">
                    <span className="font-medium text-ink">{linkParentFarId}</span>
                    <button
                      type="button"
                      className="text-xs font-medium text-accent hover:underline"
                      onClick={() => setLinkParentFarId(undefined)}
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <FarIdAutocomplete
                    asAt={asAt}
                    placeholder="Search to link this as a child of another asset…"
                    onSelect={(item) => setLinkParentFarId(item.asset.farId)}
                  />
                )}
              </div>
            )}

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
              <Button onClick={handleReview}>Record Addition</Button>
            </div>
          </>
        )}

        {step === "confirm" && (
          <>
            <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
              <AdditionIcon fontSize={18} />
              Confirm Addition
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {asset.farId} will get an addition dated {formatDate(dateOfAddition)}.
            </p>

            <div className="mt-4 overflow-hidden rounded-md border border-gray-200">
              <table className="w-full text-xs">
                <tbody>
                  <tr className="border-b border-gray-100">
                    <td className="px-3 py-1.5 font-medium text-ink">Additions C1</td>
                    <td className="px-3 py-1.5 text-right text-gray-600">{formatCurrency(additionsC1)}</td>
                  </tr>
                  {hasComponent2 && (
                    <tr className="border-b border-gray-100">
                      <td className="px-3 py-1.5 font-medium text-ink">Additions C2</td>
                      <td className="px-3 py-1.5 text-right text-gray-600">{formatCurrency(additionsC2)}</td>
                    </tr>
                  )}
                  <tr className={linkParentFarId ? "border-b border-gray-100" : ""}>
                    <td className="px-3 py-1.5 font-medium text-ink">Date of Addition</td>
                    <td className="px-3 py-1.5 text-right text-gray-600">{formatDate(dateOfAddition)}</td>
                  </tr>
                  {linkParentFarId && (
                    <tr>
                      <td className="px-3 py-1.5 font-medium text-ink">Link to Parent</td>
                      <td className="px-3 py-1.5 text-right text-gray-600">{linkParentFarId}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-gray-400">
              This asset can only have one addition recorded, ever — double-check the amounts before confirming.
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
              <Button onClick={handleConfirm} disabled={submitting}>
                {submitting ? "Saving…" : "Confirm & Record"}
              </Button>
            </div>
          </>
        )}
      </>
    </Modal>
  );
}
