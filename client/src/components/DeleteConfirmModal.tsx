import { useState } from "react";
import { DeleteIcon, ErrorIcon } from "../lib/icons.js";
import { Modal } from "./ui/Modal.js";
import { Button } from "./ui/Button.js";

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
    // stacked (z-[60]): AssetGrid's own "expand table to full screen" mode uses z-50 (see
    // AssetGrid.tsx) — every Log tab this modal opens from can be in that state when an
    // admin clicks Delete, so this must sit above it, not at the default z-30.
    <Modal onClose={onClose} widthClassName="max-w-sm" stacked>
      <>
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
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={!canConfirm || submitting}>
            {submitting ? "Working…" : confirmButtonLabel}
          </Button>
        </div>
      </>
    </Modal>
  );
}
