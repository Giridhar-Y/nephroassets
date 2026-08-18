import { useState } from "react";
import { disposeAsset } from "../api/client.js";
import { DeleteIcon, ErrorIcon } from "../lib/icons.js";

export function DisposalModal({
  farIds,
  defaultDate,
  onClose,
  onDone
}: {
  farIds: string[];
  defaultDate: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [dateOfDisposal, setDateOfDisposal] = useState(defaultDate);
  const [saleValue, setSaleValue] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await Promise.all(farIds.map((farId) => disposeAsset(farId, { dateOfDisposal, saleValue })));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disposal failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
        <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
          <DeleteIcon fontSize={18} />
          Dispose {farIds.length} asset(s)
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
            Sale Value{farIds.length > 1 ? " (applied to each)" : ""}
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
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? "Disposing…" : "Dispose"}
          </button>
        </div>
      </div>
    </div>
  );
}
