import { useState } from "react";
import { DeleteIcon, ErrorIcon } from "../lib/icons.js";

// Shared by every Global-Admin-only delete/undo action (Capitalization delete, Addition
// undo, Disposal undo, Transfer delete) — a required reason plus type-the-identifier-to-
// confirm, since every one of these looks irreversible to the user even though it's a
// soft delete/field-revert at the data layer (see the server's own audit-log comment).
export function DeleteConfirmModal({
  title,
  confirmId,
  description,
  confirmButtonLabel = "Delete",
  onConfirm,
  onClose
}: {
  title: string;
  /** What the admin must type to enable the confirm button — the FAR ID for an
   *  asset-level action, or a transfer's own identifying text for a transfer delete. */
  confirmId: string;
  description: string;
  confirmButtonLabel?: string;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canConfirm = reason.trim().length > 0 && confirmText === confirmId;

  async function handleConfirm() {
    if (!canConfirm || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "This action failed.");
      setSubmitting(false);
    }
  }

  return (
    // z-[60]: AssetGrid's own "expand table to full screen" mode uses z-50 (see
    // AssetGrid.tsx) — every Log tab this modal opens from can be in that state when an
    // admin clicks Delete, so this must sit above it, not at EditAssetModal's z-30.
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="flex items-center gap-2 text-base font-semibold text-red-600">
          <DeleteIcon fontSize={18} />
          {title}
        </h2>
        <p className="mt-2 text-sm text-gray-600">{description}</p>

        <div className="mt-4 flex flex-col gap-1">
          <label htmlFor="delete-reason" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Reason (required)
          </label>
          <textarea
            id="delete-reason"
            rows={2}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this being done? Recorded in the audit log."
          />
        </div>

        <div className="mt-3 flex flex-col gap-1">
          <label htmlFor="delete-confirm-text" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Type <span className="font-mono text-ink">{confirmId}</span> to confirm
          </label>
          <input
            id="delete-confirm-text"
            type="text"
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoComplete="off"
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
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
            onClick={handleConfirm}
            disabled={!canConfirm || submitting}
          >
            {submitting ? "Working…" : confirmButtonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
