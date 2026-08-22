import { useState, type ReactNode } from "react";
import { InfoIcon } from "../lib/icons.js";

export function Tooltip({
  text,
  children,
  placement = "top",
  className = ""
}: {
  text: string;
  children: ReactNode;
  /** "top" (default) opens upward, above the trigger — matches every existing usage.
   *  "bottom" opens downward instead: needed inside a sticky, scroll-clipped header
   *  (e.g. Register's column headers), where "top" pushes the bubble above the
   *  scroll container's own top edge and it gets silently clipped — invisible even
   *  though it's genuinely open (found the hard way: the DOM node existed, `open`
   *  was true, nothing rendered on screen). */
  placement?: "top" | "bottom";
  /** Extra classes for the root span — e.g. `min-w-0` when this sits in a flex
   *  container that needs to let a long label shrink/truncate instead of overflowing
   *  (a plain flex child defaults to `min-width: auto`, which blocks that). */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={`relative inline-flex items-center gap-1 ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      <button
        type="button"
        aria-label="What does this mean?"
        className="grid place-items-center rounded-full text-gray-400 hover:text-accent"
        tabIndex={0}
      >
        <InfoIcon fontSize={13} />
      </button>
      {open && (
        <span
          role="tooltip"
          className={`absolute left-1/2 z-20 w-56 -translate-x-1/2 rounded-lg bg-ink px-3 py-2 text-xs font-normal normal-case leading-snug text-white shadow-lg ${
            placement === "bottom" ? "top-full mt-2" : "bottom-full mb-2"
          }`}
        >
          {text}
        </span>
      )}
    </span>
  );
}
