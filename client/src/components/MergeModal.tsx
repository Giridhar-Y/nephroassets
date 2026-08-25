import { useEffect, useState } from "react";
import { mergeAssets } from "../api/client.js";
import type { AssetListItem } from "../lib/types.js";
import { ErrorIcon, MergeIcon } from "../lib/icons.js";
import { useToast } from "./Toast.js";

type Step = "form" | "confirm";

// Bulk merge from Register: the checkbox selection supplies every candidate (both the
// parent and its children-to-be) — this modal only picks which ONE of them is the
// parent. The actual one-level/self-parent/disposed-parent validation is entirely
// server-side (validateParentLink, same rules Edit already enforces one-at-a-time); this
// only catches the obvious case (an already-a-child asset picked as parent) early.
export function MergeModal({
  assets,
  onClose,
  onDone
}: {
  assets: AssetListItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { showToast } = useToast();
  const [step, setStep] = useState<Step>("form");
  const [parentFarId, setParentFarId] = useState<string | null>(null);
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

  const parent = assets.find((a) => a.asset.farId === parentFarId) ?? null;
  const children = assets.filter((a) => a.asset.farId !== parentFarId);

  function handleReview() {
    if (!parentFarId) {
      setError("Choose which asset is the parent.");
      return;
    }
    if (parent?.asset.parentFarId) {
      setError(`"${parentFarId}" is already a child of another asset — pick a different parent.`);
      return;
    }
    setError(null);
    setStep("confirm");
  }

  async function handleConfirm() {
    if (!parentFarId) return;
    setSubmitting(true);
    setError(null);
    try {
      await mergeAssets(parentFarId, children.map((c) => c.asset.farId));
      showToast(`${children.length} asset${children.length === 1 ? "" : "s"} linked to ${parentFarId}.`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Merge failed.");
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
              <MergeIcon fontSize={18} />
              Merge {assets.length} assets
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Pick which one is the parent — every other selected asset becomes its child.
            </p>

            <div className="mt-4 max-h-72 overflow-y-auto rounded-md border border-gray-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">Parent</th>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">FAR ID</th>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">Asset Description</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((item) => (
                    <tr key={item.asset.farId} className="border-t border-gray-100">
                      <td className="px-3 py-1.5">
                        <input
                          type="radio"
                          name="merge-parent"
                          className="accent-accent"
                          checked={parentFarId === item.asset.farId}
                          onChange={() => setParentFarId(item.asset.farId)}
                        />
                      </td>
                      <td className="px-3 py-1.5 font-medium text-ink">{item.asset.farId}</td>
                      <td className="px-3 py-1.5 text-gray-600">{item.asset.assetDescription}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                Merge
              </button>
            </div>
          </>
        )}

        {step === "confirm" && parentFarId && (
          <>
            <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
              <MergeIcon fontSize={18} />
              Confirm Merge
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {children.length} asset{children.length === 1 ? "" : "s"} will become children of{" "}
              <strong>{parentFarId}</strong>.
            </p>

            <div className="mt-4 max-h-60 overflow-y-auto rounded-md border border-gray-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">FAR ID</th>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">Asset Description</th>
                    <th className="px-3 py-1.5 text-left font-semibold text-gray-600">Becomes Child Of</th>
                  </tr>
                </thead>
                <tbody>
                  {children.map((item) => (
                    <tr key={item.asset.farId} className="border-t border-gray-100">
                      <td className="px-3 py-1.5 font-medium text-ink">{item.asset.farId}</td>
                      <td className="px-3 py-1.5 text-gray-600">{item.asset.assetDescription}</td>
                      <td className="px-3 py-1.5 text-gray-600">{parentFarId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-xs text-gray-500">
              A child asset always moves and disposes together with its parent, while keeping its own cost,
              quantity, and useful life.
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
                {submitting ? "Merging…" : "Confirm & Merge"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
