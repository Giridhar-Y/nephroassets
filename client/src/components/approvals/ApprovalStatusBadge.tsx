import type { ComponentType } from "react";
import type { FluentIconsProps } from "@fluentui/react-icons";
import { STATUS_LABELS, type RequestStatus } from "../../api/approvals.js";
import { ApplyingIcon, ClockIcon, FailIcon, PassIcon, WarningIcon, WithdrawIcon } from "../../lib/icons.js";

// One badge for every approval state, always an icon plus a label — status is never
// shown by colour alone. Brand palette only: Calming Blue for Pending, Teal for In
// review, Crimson for Returned, the app's existing success green and amber for
// Approved/Needs attention. Text stays Deep Blue (or the tone's own dark shade) on a
// light tint so every pairing meets AA contrast; the colour lives in the tint and icon.
const STYLES: Record<RequestStatus, { cls: string; icon: ComponentType<FluentIconsProps>; iconCls: string }> = {
  draft: { cls: "bg-gray-100 text-gray-700", icon: ClockIcon, iconCls: "text-gray-500" },
  pending: { cls: "bg-brand-blue/15 text-ink", icon: ClockIcon, iconCls: "text-brand-blue" },
  in_review: { cls: "bg-brand-teal/15 text-ink", icon: ClockIcon, iconCls: "text-brand-teal" },
  applying: { cls: "bg-brand-teal/15 text-ink", icon: ApplyingIcon, iconCls: "text-brand-teal motion-safe:animate-spin" },
  applied: { cls: "bg-green-100 text-green-800", icon: PassIcon, iconCls: "text-green-700" },
  rejected: { cls: "bg-accent-light text-accent-hover", icon: FailIcon, iconCls: "text-accent" },
  needs_attention: { cls: "bg-amber-100 text-amber-800", icon: WarningIcon, iconCls: "text-amber-700" },
  withdrawn: { cls: "bg-gray-100 text-gray-600", icon: WithdrawIcon, iconCls: "text-gray-500" }
};

export function ApprovalStatusBadge({
  status,
  step,
  className = ""
}: {
  status: RequestStatus;
  /** Shown for an in-flight request: "In review · Step 2 of 3". */
  step?: { current: number; total: number };
  className?: string;
}) {
  const s = STYLES[status];
  const Icon = s.icon;
  const stepText = step && (status === "pending" || status === "in_review") && step.total > 1 ? ` · Step ${step.current + 1} of ${step.total}` : "";
  return (
    <span className={`inline-flex w-fit items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors duration-200 ${s.cls} ${className}`}>
      <Icon fontSize={14} className={s.iconCls} aria-hidden />
      {STATUS_LABELS[status]}
      {stepText}
    </span>
  );
}
