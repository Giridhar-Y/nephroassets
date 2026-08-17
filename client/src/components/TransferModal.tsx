import { useEffect, useState } from "react";
import { createTransfer, fetchCenters } from "../api/client.js";
import { ErrorIcon, TransferIcon } from "../lib/icons.js";

export function TransferModal({
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
  const [centers, setCenters] = useState<string[]>([]);
  const [toLocation, setToLocation] = useState("");
  const [transactionDate, setTransactionDate] = useState(defaultDate);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCenters().then(setCenters).catch(() => {});
  }, []);

  async function handleSubmit() {
    if (!toLocation) {
      setError("Choose a destination center.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createTransfer({ farIds, toLocation, transactionDate });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transfer failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
        <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
          <TransferIcon fontSize={18} />
          Transfer {farIds.length} asset(s)
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
            {centers.map((c) => (
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
            {submitting ? "Transferring…" : "Transfer"}
          </button>
        </div>
      </div>
    </div>
  );
}
