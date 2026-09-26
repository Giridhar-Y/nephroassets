import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  decideRequest,
  fetchBulkRows,
  fetchDirectory,
  fetchRequest,
  reassignRequest,
  resubmitSingle,
  withdrawRequest,
  type Assignee,
  type BulkRowsPage,
  type Directory,
  type RequestDetail
} from "../../api/approvals.js";
import { ApiError } from "../../api/client.js";
import { formatCurrency, formatDateTime } from "../../lib/format.js";
import { CommentIcon, DismissIcon, ErrorIcon, PassIcon, FailIcon, ReassignIcon, SearchIcon, WithdrawIcon } from "../../lib/icons.js";
import { Button } from "../ui/Button.js";
import { useToast } from "../Toast.js";
import { useAuth } from "../../lib/AuthContext.js";
import { ApprovalStatusBadge } from "./ApprovalStatusBadge.js";
import { AssigneePicker } from "./AssigneePicker.js";

// The side panel for one request: what it changes, who has approved so far, and the
// decision controls. Opened from the Tasks screen (and from notification links).

// The same labels the module forms use (Capitalization, Addition, Disposal, Transfer,
// Edit Asset, Masters), in form order. Anything not listed falls back to a readable
// version of its field name.
const FIELD_LABELS: Array<[string, string]> = [
  ["farId", "FAR ID"],
  ["farIds", "FAR IDs"],
  ["subClassification", "Sub Classification"],
  ["assetDescription", "Asset Description"],
  ["serialNo", "Serial No"],
  ["qty", "Qty"],
  ["status", "Status"],
  ["dateAcquired", "Date Acquired"],
  ["location", "Location"],
  ["toLocation", "Destination Center"],
  ["transactionDate", "Transfer Date"],
  ["usefulLifeC1Years", "Component 1 Useful Life (Years)"],
  ["usefulLifeC2Years", "Component 2 Useful Life (Years)"],
  ["c1OpeningCost", "Component 1 Opening Cost"],
  ["c2OpeningCost", "Component 2 Opening Cost"],
  ["additionsC1", "Additions C1"],
  ["additionsC2", "Additions C2"],
  ["dateOfAddition", "Date of Addition"],
  ["parentFarId", "Parent Asset"],
  ["accDepC1Opening", "Opening Accumulated Depreciation (Component 1)"],
  ["accDepC2Opening", "Opening Accumulated Depreciation (Component 2)"],
  ["dateOfDisposal", "Disposal Date"],
  ["saleValue", "Sale Value"],
  ["code", "Code"],
  ["name", "Name"],
  ["description", "Description"],
  ["defaultUsefulLifeC1Years", "Default C1 Life (yrs)"],
  ["defaultUsefulLifeC2Years", "Default C2 Life (yrs)"],
  ["hasComponent2", "Has Component 2"],
  ["active", "Active"],
  ["grants", "Permissions"]
];
const LABEL = new Map(FIELD_LABELS);
const ORDER = new Map(FIELD_LABELS.map(([k], i) => [k, i]));

/** Optional amounts left at zero read as "not used" (a capitalization's Mid-Year
 *  Additions, opening accumulated depreciation, Component 2 on a C1-only asset). */
const OPTIONAL_ZERO = new Set(["additionsC1", "additionsC2", "accDepC1Opening", "accDepC2Opening", "c2OpeningCost", "usefulLifeC2Years"]);

const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function fieldLabel(key: string): string {
  const k = camel(key);
  return LABEL.get(k) ?? k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

function isEmptyField(key: string, value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return OPTIONAL_ZERO.has(camel(key)) && Number(value) === 0;
}

/** The rows the detail table shows, in form order: every submitted field that has a
 *  value, plus any whose before-value differs (a cleared field is still a change). With a
 *  before-snapshot (an update), only the submitted fields; the snapshot's other columns
 *  (ids, untouched settings) are noise. Exported for its test. */
export function comparisonRows(before: Record<string, unknown> | null, proposed: Record<string, unknown>): Array<{ key: string; before: unknown; proposed: unknown; changed: boolean }> {
  const beforeOf = (k: string) => (before ? (k in before ? before[k] : before[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]) : undefined);
  return Object.keys(proposed)
    .map((key) => ({ key, before: beforeOf(key), proposed: proposed[key], changed: before ? display(beforeOf(key)) !== display(proposed[key]) : true }))
    .filter((r) => (before && r.changed ? !(isEmptyField(r.key, r.before) && isEmptyField(r.key, r.proposed)) : !isEmptyField(r.key, r.proposed)))
    .sort((x, y) => (ORDER.get(x.key) ?? 999) - (ORDER.get(y.key) ?? 999));
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value))
    return value
      .map((v) => (v && typeof v === "object" && "module" in v && "action" in v ? `${String(v.module)}: ${String(v.action)}` : typeof v === "object" ? JSON.stringify(v) : String(v)))
      .join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

const ACTION_TEXT: Record<string, string> = {
  submit: "Submitted",
  resubmit: "Resubmitted",
  approve: "Approved",
  reject: "Returned for changes",
  withdraw: "Withdrawn",
  reassign: "Reassigned",
  apply: "Applied to the register",
  apply_failed: "Couldn't be applied"
};

/** Before / proposed, one row per field that applies (see comparisonRows). */
function Comparison({ before, proposed }: { before: Record<string, unknown> | null; proposed: Record<string, unknown> }) {
  const rows = comparisonRows(before, proposed);
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-[11px] font-bold uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-3 py-2">Field</th>
            {before && <th className="px-3 py-2">Before</th>}
            <th className="px-3 py-2">{before ? "Proposed" : "Value"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={`border-t border-gray-100 ${r.changed ? "" : "text-gray-400"}`}>
              <td className="px-3 py-1.5 font-medium">{fieldLabel(r.key)}</td>
              {before && <td className="px-3 py-1.5 tabular-nums">{display(r.before)}</td>}
              <td className={`px-3 py-1.5 tabular-nums ${r.changed && before ? "font-semibold text-ink" : ""}`}>
                {display(r.proposed)}
                {r.changed && before && <span className="sr-only"> (changed)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Vertical stepper; a completed step's connector fills as the request moves on. */
function Stepper({ detail }: { detail: RequestDetail }) {
  return (
    <ol className="space-y-0">
      {detail.steps.map((s, i) => {
        const done = s.state === "done";
        const current = s.state === "current";
        const rejected = s.state === "rejected";
        return (
          <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
            {i < detail.steps.length - 1 && (
              <span aria-hidden className="absolute left-[11px] top-6 h-[calc(100%-18px)] w-0.5 bg-gray-200">
                <span className="block w-full bg-brand-teal transition-all duration-500 ease-out" style={{ height: done ? "100%" : "0%" }} />
              </span>
            )}
            <span
              className={`relative z-10 mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 text-[11px] font-bold transition-colors duration-300 ${
                done
                  ? "border-brand-teal bg-brand-teal text-white"
                  : rejected
                    ? "border-accent bg-accent text-white"
                    : current
                      ? "border-brand-blue bg-white text-brand-blue"
                      : "border-gray-300 bg-white text-gray-400"
              }`}
            >
              {done ? <PassIcon fontSize={14} aria-hidden /> : rejected ? <FailIcon fontSize={14} aria-hidden /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-semibold ${current ? "text-ink" : done ? "text-ink" : "text-gray-500"}`}>
                {s.label}
                <span className="sr-only"> — {done ? "approved" : rejected ? "returned" : current ? "waiting" : "not started"}</span>
              </p>
              <p className="text-xs text-gray-500">
                {s.rule === "all" && s.assignees.length > 1 ? "All must approve" : s.assignees.length > 1 ? "Any one can approve" : ""}
                {current && " · Waiting now"}
              </p>
              {s.approvals.map((a) => (
                <p key={a.at} className="mt-0.5 text-xs text-gray-600">
                  Approved by {a.by}, {formatDateTime(a.at)}
                </p>
              ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function BulkSection({ detail }: { detail: RequestDetail }) {
  const bulk = detail.bulk!;
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [data, setData] = useState<BulkRowsPage | null>(null);
  useEffect(() => {
    let current = true;
    fetchBulkRows(detail.id, page, search)
      .then((d) => current && setData(d))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [detail.id, page, search]);
  const columns = data?.rows[0] ? previewColumns(Object.keys(data.rows[0].data)) : [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const progress = bulk.progress;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {[
          ["Rows", bulk.rows.toLocaleString("en-IN")],
          ["New / updates", `${bulk.creates.toLocaleString("en-IN")} / ${bulk.updates.toLocaleString("en-IN")}`],
          ["Amount", bulk.amount === null ? "—" : formatCurrency(bulk.amount)]
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-gray-200 px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">{label}</p>
            <p className="font-heading text-base font-bold tabular-nums text-ink">{value}</p>
          </div>
        ))}
      </div>
      {progress && detail.status === "applying" && (
        <div className="rounded-lg border border-brand-teal/30 bg-brand-teal/5 p-3" role="status">
          <p className="text-sm font-medium text-ink">
            {progress.phase === "validating" ? "Checking every row before applying…" : "Applying the file…"} {progress.rowsDone.toLocaleString("en-IN")} of{" "}
            {progress.rowsTotal.toLocaleString("en-IN")} rows
          </p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full bg-brand-teal transition-all duration-500"
              style={{ width: `${progress.rowsTotal ? (progress.rowsDone / progress.rowsTotal) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}
      {progress && progress.errors.length > 0 && detail.status !== "applying" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">Rows that need fixing</p>
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto text-xs">
            {progress.errors.slice(0, 100).map((e) => (
              <li key={`${e.row}-${e.message}`}>
                Row {e.row}: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-gray-500">By center</p>
        <div className="flex flex-wrap gap-1.5">
          {bulk.byCenter.map((c) => (
            <span key={c.center} className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-ink">
              {c.center}: {c.rows.toLocaleString("en-IN")}
              {c.amount !== null && ` · ${formatCurrency(c.amount)}`}
            </span>
          ))}
        </div>
      </div>
      <div>
        <form
          className="mb-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setSearch(q);
          }}
        >
          <label className="relative flex-1">
            <span className="sr-only">Search rows</span>
            <SearchIcon fontSize={15} className="absolute left-2.5 top-2.5 text-gray-400" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by FAR ID, center or any value"
              className="w-full rounded-lg border border-gray-300 py-1.5 pl-8 pr-2 text-sm focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue"
            />
          </label>
          <Button variant="secondary" size="sm" type="submit">
            Search
          </Button>
        </form>
        <div className="max-h-80 overflow-auto rounded-lg border border-gray-200">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 text-left text-[11px] font-bold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-2 py-1.5">Row</th>
                {columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-2 py-1.5">
                    {fieldLabel(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="transition-opacity duration-200" style={{ opacity: data ? 1 : 0.4 }}>
              {data?.rows.map((r) => (
                <tr key={r.row} className="border-t border-gray-100 align-top">
                  <td className="px-2 py-1 tabular-nums text-gray-500">{r.row}</td>
                  {columns.map((c) => {
                    const beforeValue = r.before ? (r.before as Record<string, unknown>)[c] : undefined;
                    const changed = beforeValue !== undefined && display(beforeValue) !== display(r.data[c]);
                    return (
                      <td key={c} className="whitespace-nowrap px-2 py-1">
                        {changed && <span className="block text-gray-400 line-through">{display(beforeValue)}</span>}
                        <span className={changed ? "font-semibold text-ink" : ""}>{display(r.data[c])}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {data && data.rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 1} className="px-2 py-6 text-center text-gray-500">
                    No rows match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {data && (
          <div className="mt-2 flex items-center justify-between text-xs text-gray-600">
            <span>
              {data.total.toLocaleString("en-IN")} rows · page {page} of {pages}
            </span>
            <span className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** The maker's "Edit and resubmit" for a single entry: every simple field of what they
 *  submitted, editable, re-sent through the same route (so it's validated again). */
function ResubmitForm({ detail, onDone }: { detail: RequestDetail; onDone: (message: string) => void }) {
  const original = detail.payload.body ?? {};
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(original)
        .filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v) || (Array.isArray(v) && v.every((x) => typeof x === "string")))
        .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v === null ? "" : String(v)])
    )
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const body: Record<string, unknown> = { ...original };
    for (const [k, raw] of Object.entries(values)) {
      const was = original[k];
      body[k] = Array.isArray(was)
        ? raw.split(",").map((s) => s.trim()).filter(Boolean)
        : typeof was === "number"
          ? Number(raw)
          : typeof was === "boolean"
            ? raw === "true"
            : was === null && raw === ""
              ? null
              : raw;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await resubmitSingle(detail, body);
      onDone(res.pendingApproval.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't resubmit.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="animate-panel-in space-y-3 rounded-lg border border-gray-200 p-3">
      <p className="text-sm font-semibold text-ink">Edit and resubmit</p>
      <div className="grid grid-cols-2 gap-3">
        {Object.keys(values).map((k) => (
          <label key={k} className="flex flex-col gap-1 text-xs font-medium text-gray-600">
            {fieldLabel(k)}
            <input
              value={values[k]}
              onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm text-ink focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue"
            />
          </label>
        ))}
      </div>
      {error && (
        <p className="flex items-center gap-1.5 text-sm text-accent-hover">
          <ErrorIcon fontSize={15} aria-hidden /> {error}
        </p>
      )}
      <Button onClick={submit} disabled={busy}>
        {busy ? "Sending…" : "Resubmit for approval"}
      </Button>
    </div>
  );
}

/** Opens Bulk Upload on the same upload type (and Masters list) the file came from. */
function bulkUploadQuery(path: string | undefined): string {
  const types: Record<string, string> = {
    "/api/assets/bulk-upload": "type=assets",
    "/api/assets/bulk-dispose": "type=disposals",
    "/api/transfers/bulk-upload": "type=transfers",
    "/api/assets/bulk-merge": "type=merge",
    "/api/masters/centers/bulk-upload": "type=masters&list=centers",
    "/api/masters/sub-classifications/bulk-upload": "type=masters&list=subClassifications",
    "/api/masters/statuses/bulk-upload": "type=masters&list=statuses"
  };
  return (path && types[path]) || "type=assets";
}

// The row data comes back as jsonb, which stores keys shortest-first (qty, farId,
// status…); show the columns a reviewer reads first, then whatever else fits.
const PREVIEW_COLUMN_ORDER = [
  "farId", "assetDescription", "subClassification", "location", "fromLocation", "toLocation", "status", "dateAcquired",
  "transferDate", "dateOfDisposal", "saleValue", "c1OpeningCost", "c2OpeningCost", "parentFarId", "childFarId", "code", "name", "description"
];
function previewColumns(keys: string[]): string[] {
  const rank = (k: string) => (PREVIEW_COLUMN_ORDER.includes(k) ? PREVIEW_COLUMN_ORDER.indexOf(k) : PREVIEW_COLUMN_ORDER.length);
  return [...keys].sort((a, b) => rank(a) - rank(b)).slice(0, 8);
}

export function RequestPanel({
  requestId,
  onClose,
  onDecided
}: {
  requestId: number;
  onClose: () => void;
  /** Called after any action that changes the request (decision, withdraw, resubmit, reassign). */
  onDecided: (id: number, decision: "approve" | "reject" | "other") => void;
}) {
  const { showToast } = useToast();
  const { user } = useAuth();
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"none" | "resubmit" | "reassign">("none");
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [reassignTo, setReassignTo] = useState<Assignee[]>([]);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let current = true;
    setDetail(null);
    setError(null);
    setMode("none");
    fetchRequest(requestId)
      .then((d) => current && setDetail(d))
      .catch((err) => current && setError(err instanceof Error ? err.message : "Couldn't load this request."));
    closeRef.current?.focus();
    return () => {
      current = false;
    };
  }, [requestId]);

  // A file being applied: poll its progress (each poll also moves the job along).
  useEffect(() => {
    if (detail?.status !== "applying") return;
    const t = setTimeout(() => fetchRequest(requestId).then(setDetail).catch(() => {}), 3000);
    return () => clearTimeout(t);
  }, [detail, requestId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function act(decision: "approve" | "reject") {
    if (!detail) return;
    if (decision === "reject" && !comment.trim()) {
      setError("Please say why you're returning this, so the submitter can fix it.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await decideRequest(detail.id, decision, { step: detail.currentStep, cycle: detail.cycle, comment: comment.trim() || undefined });
      setDetail(next);
      setComment("");
      showToast(
        decision === "reject"
          ? `Returned to ${detail.makerName} for changes.`
          : next.status === "applied"
            ? "Approved and applied to the register."
            : next.status === "applying"
              ? "Approved. The file is being applied now."
              : next.status === "needs_attention"
                ? "Approved, but it couldn't be applied. The submitter has been told why."
                : `Approved. Sent on to ${next.currentStepLabel}.`,
        decision === "reject" || next.status === "needs_attention" ? "error" : "success"
      );
      onDecided(detail.id, decision);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Something went wrong.");
      if (err instanceof ApiError && err.status === 409) fetchRequest(detail.id).then(setDetail).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function run(fn: () => Promise<RequestDetail>, message: string) {
    setBusy(true);
    setError(null);
    try {
      setDetail(await fn());
      showToast(message, "success");
      setMode("none");
      onDecided(requestId, "other");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const proposed = (detail?.payload.body ?? {}) as Record<string, unknown>;

  return (
    <aside
      role="dialog"
      aria-label="Request details"
      className="animate-slide-in-right fixed inset-y-0 right-0 z-40 flex w-full max-w-2xl flex-col border-l border-gray-200 bg-white shadow-2xl"
    >
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-6 py-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{detail ? `${detail.moduleLabel} · #${detail.id}` : "Loading…"}</p>
          <h2 className="mt-0.5 font-heading text-lg font-bold text-ink">{detail?.summary ?? " "}</h2>
          {detail && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <ApprovalStatusBadge status={detail.status} step={{ current: detail.currentStep, total: detail.stepsTotal }} />
              <span>
                Submitted by {detail.makerName}, {formatDateTime(detail.createdAt)}
              </span>
              {detail.aging && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">Waiting {detail.ageDays} days</span>
              )}
            </div>
          )}
        </div>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-ink">
          <DismissIcon fontSize={18} />
        </button>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
        {!detail && !error && <div className="h-40 animate-pulse rounded-lg bg-gray-100" />}
        {detail?.lastError && (
          <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <ErrorIcon fontSize={16} className="mt-0.5 shrink-0" aria-hidden />
            <div>
              <p className="font-semibold">Approved, but not applied</p>
              <p>{detail.lastError}</p>
            </div>
          </div>
        )}
        {detail && (
          <>
            <section>
              <h3 className="mb-2 font-heading text-sm font-bold text-ink">{detail.kind === "bulk" ? "What this file changes" : detail.before ? "What changes" : "Details"}</h3>
              {detail.kind === "bulk" ? (
                <BulkSection detail={detail} />
              ) : (
                <Comparison
                  before={detail.before && typeof detail.before === "object" && !Array.isArray(detail.before) ? (detail.before as Record<string, unknown>) : null}
                  proposed={proposed}
                />
              )}
            </section>
            {detail.steps.length > 0 && (
              <section>
                <h3 className="mb-3 font-heading text-sm font-bold text-ink">Approval steps</h3>
                <Stepper detail={detail} />
              </section>
            )}
            <section>
              <h3 className="mb-3 font-heading text-sm font-bold text-ink">History</h3>
              <ol className="space-y-3 border-l-2 border-gray-100 pl-4">
                {detail.timeline.map((t) => (
                  <li key={t.id} className="relative">
                    <span aria-hidden className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand-blue" />
                    <p className="text-sm text-ink">
                      <span className="font-semibold">{ACTION_TEXT[t.action] ?? t.action}</span>
                      {t.step !== null && ["approve", "reject", "reassign"].includes(t.action) && ` at step ${t.step + 1}`} · {t.by}
                    </p>
                    <p className="text-xs text-gray-500">{formatDateTime(t.at)}</p>
                    {t.comment && (
                      <p className="mt-1 flex gap-1.5 rounded-md bg-gray-50 px-2.5 py-1.5 text-sm text-gray-700">
                        <CommentIcon fontSize={14} className="mt-0.5 shrink-0 text-gray-400" aria-hidden />
                        {t.comment}
                      </p>
                    )}
                    {t.action === "reassign" && t.details && (
                      <p className="mt-0.5 text-xs text-gray-600">
                        {((t.details.from as { assignees?: Array<{ label: string }> })?.assignees ?? []).map((a) => a.label).join(", ")} →{" "}
                        {((t.details.to as { assignees?: Array<{ label: string }> })?.assignees ?? []).map((a) => a.label).join(", ")}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </section>
            {mode === "resubmit" && detail.kind === "single" && (
              <ResubmitForm
                detail={detail}
                onDone={(message) => {
                  showToast(message, "success");
                  fetchRequest(detail.id).then(setDetail).catch(() => {});
                  setMode("none");
                  onDecided(detail.id, "other");
                }}
              />
            )}
            {mode === "reassign" && (
              <div className="animate-panel-in space-y-2 rounded-lg border border-gray-200 p-3">
                <p className="text-sm font-semibold text-ink">Reassign step {detail.currentStep + 1}</p>
                <p className="text-xs text-gray-500">Replaces who can approve this step for this request only. The change is recorded in its history.</p>
                {directory ? <AssigneePicker value={reassignTo} onChange={setReassignTo} directory={directory} /> : <div className="h-9 animate-pulse rounded bg-gray-100" />}
                <Button disabled={busy || reassignTo.length === 0} onClick={() => run(() => reassignRequest(detail.id, reassignTo), "Step reassigned.")}>
                  Reassign
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {detail && (
        <div className="space-y-3 border-t border-gray-200 bg-gray-50/60 px-6 py-4">
          {error && (
            <p className="flex items-center gap-1.5 text-sm text-accent-hover" role="alert">
              <ErrorIcon fontSize={15} aria-hidden /> {error}
            </p>
          )}
          {detail.canAct && (
            <>
              <label className="block">
                <span className="text-xs font-semibold text-gray-600">Comment (required to return it)</span>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={2}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue"
                />
              </label>
              <div className="flex gap-2">
                <Button onClick={() => act("approve")} disabled={busy}>
                  <PassIcon fontSize={16} aria-hidden /> Approve
                </Button>
                <Button variant="secondary" onClick={() => act("reject")} disabled={busy}>
                  <FailIcon fontSize={16} aria-hidden /> Return for changes
                </Button>
              </div>
            </>
          )}
          {!detail.canAct && detail.blockReason && detail.makerId !== user?.id && ["pending", "in_review"].includes(detail.status) && (
            <p className="text-xs text-gray-500">{detail.blockReason}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {detail.permissions.canResubmit && detail.kind === "single" && (
              <Button variant="secondary" size="sm" onClick={() => setMode(mode === "resubmit" ? "none" : "resubmit")}>
                Edit and resubmit
              </Button>
            )}
            {detail.permissions.canResubmit && detail.kind === "bulk" && (
              <Link
                to={`/bulk-upload?resubmit=${detail.id}&${bulkUploadQuery(detail.payload.path)}`}
                className="inline-flex items-center rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
              >
                Upload a corrected file
              </Link>
            )}
            {detail.permissions.canWithdraw && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => withdrawRequest(detail.id), "Request withdrawn.")}>
                <WithdrawIcon fontSize={14} aria-hidden /> Withdraw
              </Button>
            )}
            {detail.permissions.canReassign && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMode(mode === "reassign" ? "none" : "reassign");
                  if (!directory) fetchDirectory().then(setDirectory).catch(() => setError("Couldn't load people and roles."));
                }}
              >
                <ReassignIcon fontSize={14} aria-hidden /> Reassign step
              </Button>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
