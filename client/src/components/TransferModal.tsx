import { useEffect, useState } from "react";
import { createTransfer, fetchCenters } from "../api/client.js";
import { formatDate } from "../lib/format.js";
import type { AssetListItem } from "../lib/types.js";
import { ErrorIcon, TransferIcon } from "../lib/icons.js";
import { useToast } from "./Toast.js";

type Step = "form" | "confirm";

export function TransferModal({
  assets,
  defaultDate,
  excludeLocation,
  onClose,
  onDone
}: {
  assets: AssetListItem[];
  defaultDate: string;
  /** Drops one center from the destination dropdown — used by the single-asset New
   *  Transfer form to exclude the asset's own current location. Register's multi-select
   *  flow never passes this (assets there can already be at different locations, so
   *  there's no one location to exclude). */
  excludeLocation?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { showToast } = useToast();
  const [step, setStep] = useState<Step>("form");
  const [centers, setCenters] = useState<string[]>([]);
  const [toLocation, setToLocation] = useState("");
  const [transactionDate, setTransactionDate] = useState(defaultDate);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The transfer date must be on or after every selected asset's capitalization date —
  // the binding constraint across a multi-select batch is whichever is latest.
  const minDate = assets.reduce((max, a) => (a.asset.dateAcquired > max ? a.asset.dateAcquired : max), "");

  useEffect(() => {
    fetchCenters().then(setCenters).catch(() => {});
  }, []);

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
    if (!toLocation) {
      setError("Choose a destination center.");
      return;
    }
    if (transactionDate < minDate) {
      setError(`Transfer date cannot be before the asset's capitalization date (${formatDate(minDate)}).`);
      return;
    }
    setError(null);
    setStep("confirm");
  }

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await createTransfer({ farIds: assets.map((a) => a.asset.farId), toLocation, transactionDate });
      const childNote = res.childrenIncluded.length > 0 ? ` (including ${res.childrenIncluded.length} child asset${res.childrenIncluded.length === 1 ? "" : "s"})` : "";
      showToast(`${assets.length} asset${assets.length === 1 ? "" : "s"} transferred to ${toLocation}${childNote}.`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transfer failed.");
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
              <TransferIcon fontSize={18} />
              Transfer {assets.length} asset(s)
            </h2>
            <p className="mt-1 text-sm text-gray-500">Move the selected assets to a different center.</p>

            <div className="mt-4 flex flex-col gap-1">
              <label htmlFor="transfer-destination" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                Destination Center
              </label>
              <select
                id="transfer-destination"
                className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                value={toLocation}
                onChange={(e) => setToLocation(e.target.value)}
              >
                <option value="">Select a center…</option>
                {centers
                  .filter((c) => c !== excludeLocation)
                  .map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
              </select>
            </div>

            <div className="mt-3 flex flex-col gap-1">
              <label htmlFor="transfer-date" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                Transfer Date
              </label>
              <input
                id="transfer-date"
                type="date"
                min={minDate}
                className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                value={transactionDate}
                onChange={(e) => setTransactionDate(e.target.value)}
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
                Transfer
              </button>
            </div>
          </>
        )}

        {step === "confirm" && (
          <>
            <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
              <TransferIcon fontSize={18} />
              Confirm Transfer
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {assets.length} asset{assets.length === 1 ? "" : "s"} will move to <strong>{toLocation}</strong> on{" "}
              {formatDate(transactionDate)}.
            </p>

            <div className="mt-4 max-h-60 overflow-y-auto rounded-md border border-gray-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">FAR ID</th>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">Asset Description</th>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">Current Location</th>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">New Location</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((item) => (
                    <tr key={item.asset.farId} className="border-t border-gray-100">
                      <td className="px-3 py-1.5 font-medium text-ink">{item.asset.farId}</td>
                      <td className="px-3 py-1.5 text-gray-600">{item.asset.assetDescription}</td>
                      <td className="px-3 py-1.5 text-gray-600">{item.result.effectiveLocation}</td>
                      <td className="px-3 py-1.5 text-gray-600">{toLocation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-xs text-gray-500">This will update the asset's location in the register.</p>

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
                {submitting ? "Transferring…" : "Confirm & Transfer"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
