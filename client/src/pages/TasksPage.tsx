import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { fetchApprovalModules, fetchTasks, STATUS_LABELS, type ModuleInfo, type RequestStatus, type TaskItem, type TaskTab } from "../api/approvals.js";
import { useAuth } from "../lib/AuthContext.js";
import { hasPermission } from "../lib/permissions.js";
import { formatCurrency, formatDateTime } from "../lib/format.js";
import { ClockIcon, EmptyIcon, ErrorIcon, TasksIcon } from "../lib/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { ApprovalStatusBadge } from "../components/approvals/ApprovalStatusBadge.js";
import { RequestPanel } from "../components/approvals/RequestPanel.js";
import { TASKS_CHANGED as TASKS_CHANGED_EVENT } from "../lib/useApprovalPreview.js";

// Tasks: what's waiting for my approval, what I've submitted, and (admins) everything.
// Selecting a row opens its side panel. A decided row updates its badge, then collapses
// out of "Awaiting my approval" so the queue visibly shrinks.

export { TASKS_CHANGED as TASKS_CHANGED_EVENT } from "../lib/useApprovalPreview.js";

const SELECT_CLASS =
  "rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-ink focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue";

const EMPTY_BY_TAB: Record<TaskTab, { title: string; hint: string }> = {
  mine: { title: "Nothing waiting for your approval.", hint: "New tasks show up here and in your notifications." },
  requests: { title: "You haven't submitted any requests yet.", hint: "Entries you send for approval show up here, with their progress." },
  all: { title: "No approval requests yet.", hint: "Requests from every module show up here once workflows are in use." }
};

export function TasksPage() {
  const { user } = useAuth();
  const canViewAll = hasPermission(user, "approvals", "viewAll");
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<TaskTab>((params.get("tab") as TaskTab) ?? "mine");
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [filters, setFilters] = useState({ module: "", center: "", status: "", aging: false });
  const [items, setItems] = useState<TaskItem[] | null>(null);
  const [agingDays, setAgingDays] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [fading, setFading] = useState(false);
  const [leaving, setLeaving] = useState<Set<number>>(new Set());
  const selected = params.get("request") ? Number(params.get("request")) : null;
  const runId = useRef(0);

  useEffect(() => {
    fetchApprovalModules().then(setModules).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    const run = ++runId.current;
    setFading(true);
    try {
      const res = await fetchTasks(tab, { ...filters, center: filters.center.trim() || undefined });
      if (run !== runId.current) return;
      setItems(res.items);
      setAgingDays(res.agingDays);
      setError(null);
    } catch (err) {
      if (run === runId.current) setError(err instanceof Error ? err.message : "Couldn't load tasks.");
    } finally {
      if (run === runId.current) setFading(false);
    }
  }, [tab, filters]);

  useEffect(() => {
    load();
  }, [load]);

  function select(id: number | null) {
    const next = new URLSearchParams(params);
    if (id === null) next.delete("request");
    else next.set("request", String(id));
    setParams(next, { replace: true });
  }

  function onDecided(id: number, decision: "approve" | "reject" | "other") {
    window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
    if (tab === "mine" && decision !== "other") {
      // Let the badge update register, then collapse the row out of the queue.
      setTimeout(() => setLeaving((s) => new Set(s).add(id)), 450);
      setTimeout(() => {
        setItems((list) => list?.filter((i) => i.id !== id) ?? null);
        setLeaving((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      }, 900);
      setItems((list) => list?.map((i) => (i.id === id ? { ...i, status: decision === "approve" ? "in_review" : "rejected", canAct: false } : i)) ?? null);
    } else {
      load();
    }
  }

  const tabs: Array<{ key: TaskTab; label: string }> = [
    { key: "mine", label: "Awaiting my approval" },
    { key: "requests", label: "My requests" },
    ...(canViewAll ? [{ key: "all" as const, label: "All requests" }] : [])
  ];

  const filtersActive = Boolean(filters.module || filters.center.trim() || filters.status || filters.aging);
  const emptyState = filtersActive
    ? { title: "No requests match.", hint: "Try clearing the filters." }
    : EMPTY_BY_TAB[tab];

  const statusOptions = useMemo(() => (tab === "mine" ? (["pending", "in_review"] as RequestStatus[]) : (Object.keys(STATUS_LABELS) as RequestStatus[]).filter((s) => s !== "draft")), [tab]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <PageHeader icon={TasksIcon} title="Tasks" subtitle="Approvals waiting for you, and the requests you've sent." />
      <div className="border-b border-gray-200 px-8">
        <div role="tablist" className="flex gap-6">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => {
                setTab(t.key);
                setFilters((f) => ({ ...f, status: "" }));
              }}
              className={`-mb-px border-b-2 py-3 text-sm font-semibold transition-colors ${
                tab === t.key ? "border-accent text-ink" : "border-transparent text-gray-500 hover:text-ink"
              }`}
            >
              {t.label}
              {t.key === "mine" && items && tab === "mine" && (
                <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-xs text-white">{items.filter((i) => i.canAct).length}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 px-8 py-4">
        <label className="flex flex-col gap-1 text-[11px] font-bold uppercase tracking-wide text-gray-500">
          Module
          <select className={SELECT_CLASS} value={filters.module} onChange={(e) => setFilters((f) => ({ ...f, module: e.target.value }))}>
            <option value="">All modules</option>
            {modules.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-bold uppercase tracking-wide text-gray-500">
          Center
          <input
            className={SELECT_CLASS}
            placeholder="Any center"
            value={filters.center}
            onChange={(e) => setFilters((f) => ({ ...f, center: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-bold uppercase tracking-wide text-gray-500">
          Status
          <select className={SELECT_CLASS} value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
            <option value="">Any status</option>
            {statusOptions.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-ink">
          <input
            type="checkbox"
            checked={filters.aging}
            onChange={(e) => setFilters((f) => ({ ...f, aging: e.target.checked }))}
            className="h-4 w-4 rounded border-gray-300 text-accent focus:ring-accent"
          />
          Waiting more than {agingDays} days
        </label>
      </div>

      <div className={`min-h-0 flex-1 overflow-auto px-8 pb-8 transition-opacity duration-200 ${fading && items ? "opacity-50" : "opacity-100"}`}>
        {error && (
          <p className="mb-3 flex items-center gap-1.5 text-sm text-accent-hover">
            <ErrorIcon fontSize={15} aria-hidden /> {error}
          </p>
        )}
        {!items && !error && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl bg-gray-100" />
            ))}
          </div>
        )}
        {items && items.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-20 text-center">
            <EmptyIcon fontSize={30} className="text-gray-300" aria-hidden />
            <p className="text-sm font-medium text-ink">{emptyState.title}</p>
            <p className="text-xs text-gray-500">{emptyState.hint}</p>
          </div>
        )}
        {items && items.length > 0 && (
          <ul className="space-y-2" aria-label="Requests">
            {items.map((i) => {
              const isLeaving = leaving.has(i.id);
              return (
                <li
                  key={i.id}
                  className="row-collapse"
                  style={{ maxHeight: isLeaving ? 0 : 200, opacity: isLeaving ? 0 : 1, paddingBottom: 0 }}
                >
                  <button
                    type="button"
                    onClick={() => select(i.id)}
                    className={`flex w-full items-center gap-4 rounded-xl border bg-white px-4 py-3 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
                      selected === i.id ? "border-brand-blue ring-1 ring-brand-blue" : "border-gray-200"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                        {i.moduleLabel} · #{i.id}
                        {i.centers.length > 0 && ` · ${i.centers.slice(0, 2).join(", ")}${i.centers.length > 2 ? "…" : ""}`}
                      </p>
                      <p className="truncate text-sm font-semibold text-ink">{i.summary}</p>
                      <p className="text-xs text-gray-500">
                        {tab === "requests" ? "" : `By ${i.makerName} · `}
                        {formatDateTime(i.createdAt)}
                        {i.currentStepLabel && ` · With ${i.currentStepLabel}`}
                      </p>
                    </div>
                    {i.amount !== null && <span className="hidden text-sm font-semibold tabular-nums text-ink sm:block">{formatCurrency(i.amount)}</span>}
                    {i.aging && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800" title={`Waiting ${i.ageDays} days`}>
                        <ClockIcon fontSize={13} aria-hidden /> {i.ageDays}d
                      </span>
                    )}
                    <ApprovalStatusBadge status={i.status} step={{ current: i.currentStep, total: i.stepsTotal }} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {selected !== null && (
        <>
          <div className="fixed inset-0 z-30 bg-black/20 transition-opacity" onClick={() => select(null)} aria-hidden />
          <RequestPanel requestId={selected} onClose={() => select(null)} onDecided={onDecided} />
        </>
      )}
    </div>
  );
}
