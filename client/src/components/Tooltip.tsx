import { useState, type ReactNode } from "react";

export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-flex items-center gap-1"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      <button
        type="button"
        aria-label="What does this mean?"
        className="grid h-3.5 w-3.5 place-items-center rounded-full border border-gray-400 text-[9px] leading-none text-gray-500 hover:border-accent hover:text-accent"
        tabIndex={0}
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute bottom-full left-1/2 z-20 mb-2 w-56 -translate-x-1/2 rounded-lg bg-ink px-3 py-2 text-xs font-normal normal-case leading-snug text-white shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  );
}
