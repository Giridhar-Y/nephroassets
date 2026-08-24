import { useEffect, useState } from "react";
import { recordAddition } from "../api/client.js";
import { formatCurrency, formatDate } from "../lib/format.js";
import type { AssetListItem } from "../lib/types.js";
import { AdditionIcon, ErrorIcon } from "../lib/icons.js";
import { useToast } from "./Toast.js";

type Step = "form" | "confirm";

// Single-asset only — unlike TransferModal/DisposalModal, this has no Register
// multi-select use case to also serve, and an asset can only ever carry one addition
// (see the server's additionSchema comment), so there's nothing to batch.
export function AdditionModal({
  asset,
  defaultDate,
  onClose,
  onDone
}: {
  asset: AssetListItem["asset"];
  defaultDate: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { showToast } = useToast();
  const [step, setStep] = useState<Step>("form");
  const [additionsC1, setAdditionsC1] = useState(0);
  const [additionsC2, setAdditionsC2] = useState(0);
  const [dateOfAddition, setDateOfAddition] = useState(defaultDate);
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

  function handleReview() {
    if (additionsC1 === 0 && additionsC2 === 0) {
      setError("Enter an amount for Additions C1 or C2.");
      return;
    }
    if (dateOfAddition < asset.dateAcquired) {
      setError(`Addition date cannot be before the asset's capitalization date (${formatDate(asset.dateAcquired)}).`);
      return;
    }
    setError(null);
    setStep("confirm");
  }

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      await recordAddition(asset.farId, { additionsC1, additionsC2, dateOfAddition });
      showToast(`Addition recorded on ${asset.farId}.`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the addition.");
    } finally {
      setSubmitting(false);
    }
  }

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
                Record Addition
              </button>
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
                  <tr className="border-b border-gray-100">
                    <td className="px-3 py-1.5 font-medium text-ink">Additions C2</td>
                    <td className="px-3 py-1.5 text-right text-gray-600">{formatCurrency(additionsC2)}</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-1.5 font-medium text-ink">Date of Addition</td>
                    <td className="px-3 py-1.5 text-right text-gray-600">{formatDate(dateOfAddition)}</td>
                  </tr>
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
                disabled={submitting}
              >
                {submitting ? "Saving…" : "Confirm & Record"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
