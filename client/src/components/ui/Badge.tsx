import type { ReactNode } from "react";

type Tone = "neutral" | "success" | "danger" | "warning" | "info" | "brand";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-gray-100 text-gray-700",
  success: "bg-green-100 text-green-800",
  // Brand palette, not Tailwind's default red/blue — danger reads as a muted Crimson
  // tint (the brand's only red), info as a Deep Blue tint (its "calm, authoritative"
  // role per the brand guide), matching every other brand-colored surface in the app.
  danger: "bg-accent-light text-accent-hover",
  warning: "bg-amber-100 text-amber-800",
  info: "bg-brand-blue/15 text-brand-deepBlue",
  brand: "bg-ink text-white"
};

// Status vocabulary for assets — the actual value set (Masters > Statuses): Active,
// Disposed, Under Repair. "Condemned" isn't a real value today but costs nothing to
// pre-map — Masters lets an admin add new status values at any time. All read from
// here so a status always gets the same colour everywhere it's shown (Register, every
// Log tab, Asset History, Bulk Upload preview, ...).
const STATUS_TONE: Record<string, Tone> = {
  Active: "info",
  Disposed: "danger",
  Condemned: "danger",
  "Under Repair": "warning"
};

export function Badge({ tone = "neutral", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex w-fit items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASSES[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function StatusBadge({ status, className = "" }: { status: string; className?: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"} className={className}>
      {status}
    </Badge>
  );
}
