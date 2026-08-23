import { useState } from "react";
import { ViewIcon, HideIcon } from "../lib/icons.js";

export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  autoFocus
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={visible ? "text" : "password"}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        className="w-full rounded-md border border-gray-300 px-2 py-1.5 pr-8 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={visible ? "Hide password" : "Show password"}
        onClick={() => setVisible((v) => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
      >
        {visible ? <HideIcon fontSize={16} /> : <ViewIcon fontSize={16} />}
      </button>
    </div>
  );
}
