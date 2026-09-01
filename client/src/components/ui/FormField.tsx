import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

// The border/focus-ring treatment repeated on every text input, select and textarea in
// the app — kept as a plain class string (not just baked into <Input>) so existing
// hand-rolled fields can adopt the same look without a full rewrite.
export const fieldControlClass =
  "rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400";

export const fieldLabelClass = "text-[11px] font-bold uppercase tracking-wide text-gray-500";

export function Field({
  label,
  htmlFor,
  error,
  className = "",
  children
}: {
  label: string;
  htmlFor: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label htmlFor={htmlFor} className={fieldLabelClass}>
        {label}
      </label>
      {children}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${fieldControlClass} ${className}`} {...props} />;
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${fieldControlClass} ${className}`} {...props} />;
}

export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${fieldControlClass} ${className}`} {...props} />;
}
