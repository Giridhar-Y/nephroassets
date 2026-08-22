import { useEffect, useState } from "react";
import { disposeAsset } from "../api/client.js";
import { formatCurrency, formatDate } from "../lib/format.js";
import type { AssetListItem } from "../lib/types.js";
import { DeleteIcon, ErrorIcon } from "../lib/icons.js";
import { useToast } from "./Toast.js";

type Step = "form" | "confirm";

export function DisposalModal({
  assets,
  defaultDate,
  onClose,
  onDone
}: {
  assets: AssetListItem[];
  defaultDate: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { showToast } = useToast();
  const [step, setStep] = useState<Step>("form");
  const [dateOfDisposal, setDateOfDisposal] = useState(defaultDate);
  const [saleValue, setSaleValue] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dismissing the confirmation step (Esc, click outside) returns to the form with
  // entered values intact — it must never silently submit or discard anything.
  useEffect(() => {
    if (step !== "confirm") return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setStep("form");
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [step]);

  function handleReview() {
    setError(null);
    setStep("confirm");
  }

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      await Promise.all(assets.map((a) => disposeAsset(a.asset.farId, { dateOfDisposal, saleValue })));
      showToast(`${assets.length} asset${assets.length === 1 ? "" : "s"} disposed.`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disposal failed.");
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
              <DeleteIcon fontSize={18} />
              Dispose {assets.length} asset(s)
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Full disposal only — each asset's entire capitalized cost is written off.
            </p>

            <div className="mt-4 flex flex-col gap-1">
              <label htmlFor="disposal-modal-date" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                Disposal Date
              </label>
              <input
                id="disposal-modal-date"
                type="date"
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
                Dispose
              </button>
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
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">Asset Description</th>
                    <th className="px-3 py-1.5 text-right font-semibold text-gray-600">Sale Value</th>
                    <th className="px-3 py-1.5 text-right font-semibold text-gray-600">Est. Profit / (Loss)</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((item) => {
                    const currentNbv = item.result.c1.nbv + item.result.c2.nbv;
                    const estProfitLoss = saleValue - currentNbv;
                    return (
                      <tr key={item.asset.farId} className="border-t border-gray-100">
                        <td className="px-3 py-1.5 font-medium text-ink">{item.asset.farId}</td>
                        <td className="px-3 py-1.5 text-gray-600">{item.asset.assetDescription}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{formatCurrency(saleValue)}</td>
                        <td
                          className={`px-3 py-1.5 text-right font-medium ${
                            estProfitLoss >= 0 ? "text-green-700" : "text-red-600"
                          }`}
                        >
                          {estProfitLoss >= 0 ? "" : "("}
                          {formatCurrency(Math.abs(estProfitLoss))}
                          {estProfitLoss >= 0 ? "" : ")"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-[11px] text-gray-400">
              Estimated from each asset's net book value as of the current "Figures as of" date — the exact
              figure will be calculated against the disposal date above.
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
                {submitting ? "Disposing…" : "Confirm & Dispose"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
