import { useEffect, type ReactNode } from "react";

// Shared chrome for every dialog in the app (backdrop, centering, panel, outside-click,
// document-level Escape so it fires even before any field inside has focus). Escape/
// backdrop-click default to onClose, but several callers (Transfer/Disposal/Addition/
// Edit/Merge) step back through a form -> confirm flow instead of closing outright — they
// pass their own onEscape/onBackdropClick to keep that behaviour.
export function Modal({
  onClose,
  onEscape = onClose,
  onBackdropClick = onClose,
  widthClassName = "max-w-md",
  stacked = false,
  children
}: {
  onClose: () => void;
  onEscape?: () => void;
  onBackdropClick?: () => void;
  widthClassName?: string;
  /** Sits above AssetGrid's full-screen mode (z-50) and other modals (z-30) — used by
   *  admin delete/undo confirmations, which can be opened from within either. */
  stacked?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onEscape();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onEscape]);

  return (
    <div className={`fixed inset-0 ${stacked ? "z-[60]" : "z-30"} flex items-center justify-center bg-black/30`} onClick={onBackdropClick}>
      <div className={`w-full rounded-xl bg-white p-6 shadow-xl ${widthClassName}`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
