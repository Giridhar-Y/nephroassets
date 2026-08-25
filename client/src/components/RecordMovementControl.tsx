import { useState } from "react";
import { ChevronDownIcon, DeleteIcon, MergeIcon, TransferIcon } from "../lib/icons.js";

/** Combines "Transfer Selected", "Dispose Selected", and "Merge Selected" into one
 *  toolbar control, using the same trigger+panel dropdown pattern as ColumnPicker.
 *  Disabled with the same styling as the buttons it replaces whenever nothing is
 *  selected; Merge additionally needs at least 2 (one parent, one child). */
export function RecordMovementControl({
  selectedCount,
  onTransfer,
  onDispose,
  onMerge
}: {
  selectedCount: number;
  onTransfer: () => void;
  onDispose: () => void;
  onMerge: () => void;
}) {
  const [open, setOpen] = useState(false);
  const disabled = selectedCount === 0;
  const mergeDisabled = selectedCount < 2;

  return (
    <div className="relative">
      <button
        type="button"
        className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold ${
          disabled
            ? "cursor-not-allowed border border-gray-200 bg-gray-100 text-gray-400"
            : "bg-accent text-white hover:bg-accent-hover"
        }`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        Record Movement ({selectedCount})
        <ChevronDownIcon fontSize={14} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-44 rounded-lg border border-gray-200 bg-white p-1 shadow-lg">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
              onClick={() => {
                setOpen(false);
                onTransfer();
              }}
            >
              <TransferIcon fontSize={15} />
              Transfer
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
              onClick={() => {
                setOpen(false);
                onDispose();
              }}
            >
              <DeleteIcon fontSize={15} />
              Dispose
            </button>
            <button
              type="button"
              className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm ${
                mergeDisabled ? "cursor-not-allowed text-gray-300" : "text-gray-700 hover:bg-gray-50"
              }`}
              disabled={mergeDisabled}
              title={mergeDisabled ? "Select at least 2 assets — one parent, one or more children" : undefined}
              onClick={() => {
                setOpen(false);
                onMerge();
              }}
            >
              <MergeIcon fontSize={15} />
              Merge
            </button>
          </div>
        </>
      )}
    </div>
  );
}
