import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchOpenRequests, type TaskItem } from "../../api/approvals.js";
import { formatDateTime } from "../../lib/format.js";
import { ClockIcon } from "../../lib/icons.js";
import { ApprovalStatusBadge } from "./ApprovalStatusBadge.js";

// Entries waiting for approval (or returned/needing attention) for a module or one asset,
// shown apart from — and above — the applied records in a module log or asset history.
// Renders nothing when there's nothing open, so pages without workflows look unchanged.
export function PendingRequestsStrip({ modules, farId, className = "" }: { modules?: string[]; farId?: string; className?: string }) {
  const [items, setItems] = useState<TaskItem[]>([]);
  const key = `${modules?.join(",") ?? ""}|${farId ?? ""}`;
  useEffect(() => {
    let current = true;
    fetchOpenRequests({ module: modules?.join(","), farId })
      .then((r) => current && setItems(r.items))
      .catch(() => {});
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (items.length === 0) return null;
  return (
    <section className={`animate-panel-in rounded-xl border border-dashed border-brand-blue/40 bg-brand-blue/5 p-3 ${className}`} aria-label="Awaiting approval">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink">
        <ClockIcon fontSize={14} className="text-brand-blue" aria-hidden />
        Awaiting approval ({items.length}) · not yet in the register
      </p>
      <ul className="space-y-1.5">
        {items.slice(0, 6).map((i) => (
          <li key={i.id}>
            <Link
              to={`/tasks?tab=${i.canAct ? "mine" : "requests"}&request=${i.id}`}
              className="flex items-center gap-3 rounded-lg bg-white px-3 py-2 text-sm shadow-sm transition-shadow hover:shadow-md"
            >
              <span className="min-w-0 flex-1 truncate text-ink">{i.summary}</span>
              <span className="hidden text-xs text-gray-500 sm:inline">
                {i.makerName}, {formatDateTime(i.createdAt)}
              </span>
              <ApprovalStatusBadge status={i.status} step={{ current: i.currentStep, total: i.stepsTotal }} />
            </Link>
          </li>
        ))}
      </ul>
      {items.length > 6 && (
        <Link to="/tasks?tab=requests" className="mt-2 inline-block text-xs font-semibold text-accent hover:underline">
          See all {items.length} in Tasks
        </Link>
      )}
    </section>
  );
}
