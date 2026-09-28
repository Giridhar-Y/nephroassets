import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  deleteAssignment,
  fetchApprovalModules,
  fetchDirectory,
  fetchWorkflows,
  saveAgingDays,
  saveAssignment,
  saveWorkflow,
  setWorkflowActive,
  testScenario,
  type ApprovalModule,
  type Assignment,
  type AssignmentInput,
  type Directory,
  type ModuleInfo,
  type ScenarioResult,
  type Workflow,
  type WorkflowInput
} from "../api/approvals.js";
import { formatCurrency } from "../lib/format.js";
import { assignmentSummary, matrixCell, type MatrixCell } from "../lib/approvalWorkflows.js";
import {
  AddCircleIcon,
  ClockIcon,
  DeleteIcon,
  DuplicateIcon,
  EditIcon,
  ErrorIcon,
  PassIcon,
  RetryIcon,
  ScenarioIcon,
  StepArrowIcon,
  WarningIcon,
  WorkflowIcon
} from "../lib/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { Button } from "../components/ui/Button.js";
import { Badge } from "../components/ui/Badge.js";
import { Modal } from "../components/ui/Modal.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { useToast } from "../components/Toast.js";
import { AssigneeChip, AssigneePicker } from "../components/approvals/AssigneePicker.js";
import { WorkflowEditor, inputClass, labelClass } from "../components/approvals/WorkflowEditor.js";

// Approval Workflows admin: reusable workflows (named step chains), assignments (which
// modules and submitter roles use which workflow, optionally above an amount), and a
// scenario tester. The most specific assignment wins; no match = applied immediately.

type Tab = "workflows" | "assignments" | "test";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "workflows", label: "Workflows" },
  { key: "assignments", label: "Assignments" },
  { key: "test", label: "Test a scenario" }
];

interface Data {
  modules: ModuleInfo[];
  dir: Directory;
  workflows: Workflow[];
  assignments: Assignment[];
  agingDays: number;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");
const roleName = (dir: Directory, id: number) => dir.roles.find((r) => r.id === id)?.name ?? `Role #${id}`;

/** "Finance Manager → Finance Head" as pills. */
function ChainPreview({ chain }: { chain: string[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label="Approval steps">
      {chain.map((label, i) => (
        <li key={i} className="flex items-center gap-1.5">
          <span className="rounded-md border border-brand-blue/25 bg-brand-blue/5 px-2 py-0.5 text-xs font-medium text-ink">
            <span className="sr-only">Step {i + 1}: </span>
            {label}
          </span>
          {i < chain.length - 1 && <StepArrowIcon fontSize={13} className="text-gray-400" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

// --- Workflows tab ----------------------------------------------------------------------

function WorkflowCard({
  wf,
  modules,
  onEdit,
  onDuplicate,
  onToggle
}: {
  wf: Workflow;
  modules: ModuleInfo[];
  onEdit: () => void;
  onDuplicate: () => void;
  onToggle: () => void;
}) {
  const used = wf.modules.map((m) => modules.find((x) => x.key === m)?.label ?? m);
  return (
    <article
      className={`animate-panel-in flex flex-col rounded-xl border bg-white p-5 shadow-sm transition-shadow hover:shadow-md ${wf.active ? "border-gray-200" : "border-dashed border-gray-300 bg-gray-50/60"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className={`font-heading text-base font-bold ${wf.active ? "text-ink" : "text-gray-500"}`}>{wf.name}</h3>
        <Badge tone={wf.active ? "success" : "neutral"}>{wf.active ? "Active" : "Inactive"}</Badge>
      </div>
      {wf.description && <p className="mt-1 text-sm text-gray-600">{wf.description}</p>}
      <div className="mt-4">
        <ChainPreview chain={wf.chain} />
      </div>
      <p className="mt-4 text-xs text-gray-500" title={used.join(", ")}>
        {used.length ? (
          <>
            <span className="font-semibold text-ink">
              Used by {used.length} module{used.length === 1 ? "" : "s"}
            </span>
            : {used.join(", ")}
          </>
        ) : (
          "Not assigned to any module yet"
        )}
      </p>
      <div className="mt-4 flex flex-wrap gap-1 border-t border-gray-100 pt-3">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <EditIcon fontSize={14} aria-hidden /> Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={onDuplicate}>
          <DuplicateIcon fontSize={14} aria-hidden /> Duplicate
        </Button>
        <Button variant="ghost" size="sm" onClick={onToggle} className="ml-auto">
          {wf.active ? "Deactivate" : "Reactivate"}
        </Button>
      </div>
    </article>
  );
}

// --- Assignments tab --------------------------------------------------------------------

const ASSET_MODULES = (modules: ModuleInfo[]) => modules.filter((m) => m.key !== "masters");

function ModulePicker({ modules, value, onChange }: { modules: ModuleInfo[]; value: ApprovalModule[]; onChange: (v: ApprovalModule[]) => void }) {
  const asset = ASSET_MODULES(modules).map((m) => m.key);
  const allAsset = asset.every((k) => value.includes(k));
  const toggle = (k: ApprovalModule) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  const box = (m: ModuleInfo) => (
    <label key={m.key} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-ink hover:bg-gray-50">
      <input type="checkbox" checked={value.includes(m.key)} onChange={() => toggle(m.key)} className="h-4 w-4 rounded border-gray-300 text-accent focus:ring-brand-blue" />
      {m.label}
    </label>
  );
  return (
    <fieldset className="rounded-lg border border-gray-200 p-3">
      <legend className="px-1 text-[11px] font-bold uppercase tracking-wide text-gray-500">Modules</legend>
      <label className="mb-1 flex items-center gap-2 border-b border-gray-100 px-2 pb-2 text-sm font-semibold text-ink">
        <input
          type="checkbox"
          checked={allAsset}
          onChange={() => onChange(allAsset ? value.filter((k) => !asset.includes(k)) : [...new Set([...value, ...asset])])}
          className="h-4 w-4 rounded border-gray-300 text-accent focus:ring-brand-blue"
        />
        Select all asset modules
      </label>
      <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">{modules.map(box)}</div>
    </fieldset>
  );
}

function AssignmentEditor({
  initial,
  id,
  data,
  onSaved,
  onClose
}: {
  initial: AssignmentInput;
  id: number | null;
  data: Data;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AssignmentInput>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noAmount = draft.modules.filter((m) => !data.modules.find((x) => x.key === m)?.hasAmount);
  const amountAllowed = draft.modules.length > 0 && noAmount.length === 0;
  const workflow = data.workflows.find((w) => w.id === draft.workflowId);
  const active = data.workflows.filter((w) => w.active || w.id === initial.workflowId);

  async function save() {
    if (draft.modules.length === 0) return setError("Pick at least one module.");
    if (!workflow) return setError("Pick a workflow.");
    setBusy(true);
    setError(null);
    try {
      await saveAssignment(id, { ...draft, minAmount: amountAllowed ? draft.minAmount : null });
      onSaved();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} widthClassName="max-w-2xl">
      <div className="flex max-h-[85vh] flex-col">
        <h2 className="font-heading text-lg font-bold text-ink">{id ? "Edit assignment" : "New assignment"}</h2>
        <div className="mt-4 flex-1 space-y-4 overflow-auto pr-1">
          <ModulePicker modules={data.modules} value={draft.modules} onChange={(modules) => setDraft({ ...draft, modules })} />
          <div className="flex flex-col gap-1">
            <span className={labelClass}>Submitted by</span>
            <AssigneePicker
              roleOnly
              placeholder="Any role (pick roles to narrow it)"
              directory={data.dir}
              value={draft.roleIds.map((rid) => ({ type: "role" as const, id: rid }))}
              onChange={(v) => setDraft({ ...draft, roleIds: v.map((a) => a.id) })}
            />
            <span className="text-xs text-gray-500">Leave empty for any role. A specific role takes precedence over "any role".</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={labelClass}>
              Only if amount is at least (₹)
              <input
                type="number"
                min={0}
                disabled={!amountAllowed}
                value={amountAllowed ? (draft.minAmount ?? "") : ""}
                onChange={(e) => setDraft({ ...draft, minAmount: e.target.value === "" ? null : Number(e.target.value) })}
                placeholder="Any amount"
                className={inputClass}
              />
              {!amountAllowed && draft.modules.length > 0 && (
                <span className="text-[11px] font-normal normal-case tracking-normal text-gray-500">
                  {noAmount.map((m) => data.modules.find((x) => x.key === m)?.label).join(", ")} {noAmount.length === 1 ? "has" : "have"} no amount.
                </span>
              )}
            </label>
            <label className={labelClass}>
              Workflow
              <select value={draft.workflowId || ""} onChange={(e) => setDraft({ ...draft, workflowId: Number(e.target.value) })} className={inputClass}>
                <option value="">Pick a workflow…</option>
                {active.map((w) => (
                  <option key={w.id} value={w.id} disabled={!w.active}>
                    {w.name}
                    {w.active ? "" : " (inactive)"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {workflow && draft.modules.length > 0 && (
            <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-ink" aria-live="polite">
              {assignmentSummary({ ...draft, minAmount: amountAllowed ? draft.minAmount : null }, workflow.steps, data.modules, data.dir)}
            </p>
          )}
        </div>
        {error && (
          <p className="mt-3 flex items-start gap-1.5 text-sm text-accent-hover" role="alert">
            <ErrorIcon fontSize={15} className="mt-0.5 shrink-0" aria-hidden /> {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2 border-t border-gray-100 pt-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : id ? "Save changes" : "Add assignment"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CellContent({ cell, byId }: { cell: MatrixCell; byId: Map<number, Workflow> }) {
  const name = (id: number | null | "conflict") =>
    id === "conflict" ? <span className="font-semibold text-accent-hover">Conflict</span> : id === null ? <span className="text-gray-400">No approval</span> : byId.get(id)?.name;
  return (
    <div className="space-y-0.5">
      <div className={cell.base === null ? "" : "font-medium text-ink"}>{name(cell.base)}</div>
      {cell.tiers.map((t) => (
        <div key={t.minAmount} className="text-xs text-gray-600">
          ≥ {formatCurrency(t.minAmount)}: <span className="font-medium text-ink">{name(t.workflowId)}</span>
        </div>
      ))}
    </div>
  );
}

function OverviewMatrix({ data }: { data: Data }) {
  const byId = new Map(data.workflows.map((w) => [w.id, w]));
  const used = new Set(data.assignments.flatMap((a) => a.roleIds));
  const roles = data.dir.roles.filter((r) => r.active || used.has(r.id));
  const columns: Array<{ id: number | null; label: string }> = [...roles.map((r) => ({ id: r.id, label: r.name })), { id: null, label: "Other roles" }];
  return (
    <section aria-labelledby="matrix-title" className="mt-8">
      <h2 id="matrix-title" className="font-heading text-base font-bold text-ink">
        Overview
      </h2>
      <p className="mt-0.5 text-sm text-gray-500">Which workflow an entry goes through, by module and the submitter's role. Amount tiers are listed under the default.</p>
      <div className="mt-3 overflow-auto rounded-xl border border-gray-200">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-gray-50 text-[11px] font-bold uppercase tracking-wide text-gray-500">
            <tr>
              <th scope="col" className="sticky left-0 bg-gray-50 px-3 py-2">
                Module
              </th>
              {columns.map((c) => (
                <th key={c.id ?? "other"} scope="col" className="whitespace-nowrap px-3 py-2">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.modules.map((m) => (
              <tr key={m.key} className="align-top">
                <th scope="row" className="sticky left-0 whitespace-nowrap bg-white px-3 py-2 font-semibold text-ink">
                  {m.label}
                </th>
                {columns.map((c) => (
                  <td key={c.id ?? "other"} className="min-w-[10rem] px-3 py-2">
                    <CellContent cell={matrixCell(data.assignments, m.key, c.id)} byId={byId} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AssignmentsTab({ data, onEdit, onRemove }: { data: Data; onEdit: (a: Assignment | null) => void; onRemove: (a: Assignment) => void }) {
  const byId = new Map(data.workflows.map((w) => [w.id, w]));
  const canAdd = data.workflows.some((w) => w.active);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-gray-600">
          The most specific assignment wins: an amount threshold, then a specific role, then "any role". Modules with no matching assignment apply changes immediately.
        </p>
        <Button onClick={() => onEdit(null)} disabled={!canAdd} title={canAdd ? undefined : "Create a workflow first."}>
          <AddCircleIcon fontSize={16} aria-hidden /> New assignment
        </Button>
      </div>
      {data.assignments.length === 0 ? (
        <EmptyState
          icon={WorkflowIcon}
          title="No assignments yet."
          description={canAdd ? "Every module applies changes immediately. Add an assignment to require approval." : "Create a workflow first, then assign it to modules here."}
        />
      ) : (
        <div className="mt-4 overflow-auto rounded-xl border border-gray-200">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-gray-50 text-[11px] font-bold uppercase tracking-wide text-gray-500">
              <tr>
                <th scope="col" className="px-3 py-2">Modules</th>
                <th scope="col" className="px-3 py-2">Submitted by</th>
                <th scope="col" className="px-3 py-2">Amount</th>
                <th scope="col" className="px-3 py-2">Workflow</th>
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.assignments.map((a) => {
                const wf = byId.get(a.workflowId);
                return (
                  <tr key={a.id} className="animate-panel-in align-top hover:bg-gray-50/60">
                    <td className="max-w-xs px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        {a.modules.map((m) => (
                          <Badge key={m} tone="info">
                            {data.modules.find((x) => x.key === m)?.label ?? m}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      {a.roleIds.length ? (
                        <div className="flex flex-wrap gap-1">
                          {a.roleIds.map((r) => (
                            <AssigneeChip key={r} assignee={{ type: "role", id: r }} label={roleName(data.dir, r)} />
                          ))}
                        </div>
                      ) : (
                        <span className="text-gray-500">Any role</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-ink">{a.minAmount === null ? <span className="text-gray-500">Any amount</span> : `≥ ${formatCurrency(a.minAmount)}`}</td>
                    <td className="px-3 py-3">
                      <div className="font-semibold text-ink">{wf?.name ?? "—"}</div>
                      {wf && <div className="text-xs text-gray-500">{wf.chain.join(" → ")}</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right">
                      <button type="button" aria-label="Edit assignment" onClick={() => onEdit(a)} className="rounded-md p-1.5 text-gray-500 hover:bg-white hover:text-ink">
                        <EditIcon fontSize={16} />
                      </button>
                      <button type="button" aria-label="Remove assignment" onClick={() => onRemove(a)} className="rounded-md p-1.5 text-gray-500 hover:bg-white hover:text-accent">
                        <DeleteIcon fontSize={16} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <OverviewMatrix data={data} />
    </>
  );
}

// --- Test a scenario --------------------------------------------------------------------

function ScenarioTab({ data }: { data: Data }) {
  const [module, setModule] = useState<ApprovalModule>(data.modules[0]?.key ?? "capitalization");
  const [roleId, setRoleId] = useState<number | null>(data.dir.roles.find((r) => r.active)?.id ?? null);
  const [amount, setAmount] = useState("");
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasAmount = data.modules.find((m) => m.key === module)?.hasAmount ?? false;

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      testScenario(module, roleId, hasAmount && amount !== "" ? Number(amount) : null)
        .then((r) => live && (setResult(r), setError(null)))
        .catch((err) => live && (setResult(null), setError(errText(err))));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [module, roleId, amount, hasAmount]);

  return (
    <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
      <div className="space-y-4 rounded-xl border border-gray-200 bg-gray-50/50 p-5">
        <label className={labelClass}>
          Module
          <select value={module} onChange={(e) => setModule(e.target.value as ApprovalModule)} className={inputClass}>
            {data.modules.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Submitter's role
          <select value={roleId ?? ""} onChange={(e) => setRoleId(e.target.value === "" ? null : Number(e.target.value))} className={inputClass}>
            {data.dir.roles
              .filter((r) => r.active)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            <option value="">A role not listed</option>
          </select>
        </label>
        <label className={labelClass}>
          Amount (₹)
          <input type="number" min={0} disabled={!hasAmount} value={hasAmount ? amount : ""} onChange={(e) => setAmount(e.target.value)} placeholder={hasAmount ? "e.g. 250000" : "This module has no amount"} className={inputClass} />
        </label>
      </div>
      <div aria-live="polite">
        {error ? (
          <p className="flex items-start gap-2 rounded-xl border border-accent/30 bg-accent-light px-4 py-3 text-sm text-accent-hover">
            <WarningIcon fontSize={18} className="mt-0.5 shrink-0" aria-hidden /> {error}
          </p>
        ) : !result ? (
          <div className="h-32 animate-pulse rounded-xl bg-gray-100" />
        ) : !result.applies ? (
          <div key="none" className="animate-panel-in flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 px-5 py-4">
            <PassIcon fontSize={24} className="text-green-700" aria-hidden />
            <div>
              <p className="font-heading font-bold text-ink">No approval, applies immediately</p>
              <p className="text-sm text-gray-600">No assignment matches this module, role and amount.</p>
            </div>
          </div>
        ) : (
          <div key={result.workflow!.id} className="animate-panel-in rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-bold uppercase tracking-wide text-gray-500">Needs approval through</p>
            <p className="mt-0.5 font-heading text-lg font-bold text-ink">{result.workflow!.name}</p>
            <ol className="mt-4 space-y-3">
              {result.steps!.map((s, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink text-xs font-bold text-white">{i + 1}</span>
                  <div>
                    <div className="flex flex-wrap gap-1">
                      {s.assignees.map((a) => (
                        <AssigneeChip key={`${a.type}:${a.id}`} assignee={a} label={a.label} />
                      ))}
                    </div>
                    {s.assignees.length > 1 && <p className="mt-1 text-xs text-gray-500">{s.rule === "all" ? "All must approve" : "Any one approves"}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Settings + page ---------------------------------------------------------------------

function AgingSetting({ initial }: { initial: number }) {
  const { showToast } = useToast();
  const [days, setDays] = useState(initial);
  const [saved, setSaved] = useState(initial);
  return (
    <form
      className="flex items-center gap-2 text-xs text-gray-600"
      onSubmit={(e) => {
        e.preventDefault();
        saveAgingDays(days)
          .then(() => {
            setSaved(days);
            showToast(`Requests waiting more than ${days} days will be flagged in Tasks.`, "success");
          })
          .catch((err) => showToast(errText(err), "error"));
      }}
    >
      <ClockIcon fontSize={15} className="text-gray-400" aria-hidden />
      <label htmlFor="aging-days">Flag requests waiting longer than</label>
      <input id="aging-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} className={`${inputClass} w-16 py-1`} />
      <span>days</span>
      {days !== saved && (
        <Button type="submit" size="sm" variant="secondary">
          Save
        </Button>
      )}
    </form>
  );
}

export function WorkflowsPage() {
  const { showToast } = useToast();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "workflows") as Tab;
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flowEditor, setFlowEditor] = useState<{ initial: WorkflowInput; editing: Workflow | null } | null>(null);
  const [assignmentEditor, setAssignmentEditor] = useState<{ initial: AssignmentInput; id: number | null } | null>(null);
  const [removing, setRemoving] = useState<Assignment | null>(null);

  const load = useCallback(() => {
    Promise.all([fetchApprovalModules(), fetchDirectory(), fetchWorkflows()])
      .then(([modules, dir, w]) => {
        setData({ modules, dir, workflows: w.workflows, assignments: w.assignments, agingDays: w.agingDays });
        setError(null);
      })
      .catch((err) => setError(errText(err)));
  }, []);
  useEffect(load, [load]);

  const counts = useMemo(() => ({ workflows: data?.workflows.length, assignments: data?.assignments.length }), [data]);

  async function toggle(wf: Workflow) {
    try {
      await setWorkflowActive(wf.id, !wf.active);
      showToast(`“${wf.name}” ${wf.active ? "deactivated" : "reactivated"}.`, "success");
      load();
    } catch (err) {
      showToast(errText(err), "error");
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <PageHeader
        icon={WorkflowIcon}
        title="Approval Workflows"
        subtitle="Build reusable approval chains, then assign them to modules and roles. Anything unassigned applies immediately."
        actions={data && <AgingSetting initial={data.agingDays} />}
      />
      <div className="border-b border-gray-200 px-8">
        <div role="tablist" aria-label="Approval Workflows" className="flex gap-6">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              id={`tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls={`panel-${t.key}`}
              onClick={() => setParams({ tab: t.key }, { replace: true })}
              className={`-mb-px flex items-center gap-2 border-b-2 py-3 text-sm font-semibold transition-colors ${
                tab === t.key ? "border-accent text-ink" : "border-transparent text-gray-500 hover:text-ink"
              }`}
            >
              {t.key === "test" && <ScenarioIcon fontSize={15} aria-hidden />}
              {t.label}
              {t.key !== "test" && counts[t.key] !== undefined && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{counts[t.key]}</span>}
            </button>
          ))}
        </div>
      </div>

      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className="min-h-0 flex-1 overflow-auto px-8 py-6">
        {error && (
          <p className="mb-4 flex items-center gap-2 text-sm text-accent-hover" role="alert">
            <ErrorIcon fontSize={15} aria-hidden /> {error}
            <Button variant="ghost" size="sm" onClick={load}>
              <RetryIcon fontSize={14} aria-hidden /> Retry
            </Button>
          </p>
        )}
        {!data ? (
          !error && (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-48 animate-pulse rounded-xl bg-gray-100" />
              ))}
            </div>
          )
        ) : tab === "workflows" ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-gray-600">A workflow is an ordered chain of approval steps. One workflow can serve many modules.</p>
              <Button onClick={() => setFlowEditor({ initial: { name: "", description: "", steps: [{ rule: "any", assignees: [] }] }, editing: null })}>
                <AddCircleIcon fontSize={16} aria-hidden /> Create workflow
              </Button>
            </div>
            {data.workflows.length === 0 ? (
              <EmptyState icon={WorkflowIcon} title="No workflows yet." description="Create one, then assign it to modules on the Assignments tab. Until then, every change applies immediately." />
            ) : (
              <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {data.workflows.map((wf) => (
                  <WorkflowCard
                    key={wf.id}
                    wf={wf}
                    modules={data.modules}
                    onEdit={() => setFlowEditor({ initial: { name: wf.name, description: wf.description, steps: wf.steps }, editing: wf })}
                    onDuplicate={() => setFlowEditor({ initial: { name: `Copy of ${wf.name}`, description: wf.description, steps: wf.steps }, editing: null })}
                    onToggle={() => toggle(wf)}
                  />
                ))}
              </div>
            )}
          </>
        ) : tab === "assignments" ? (
          <AssignmentsTab
            data={data}
            onEdit={(a) =>
              setAssignmentEditor(
                a
                  ? { initial: { modules: a.modules, roleIds: a.roleIds, minAmount: a.minAmount, workflowId: a.workflowId }, id: a.id }
                  : { initial: { modules: [], roleIds: [], minAmount: null, workflowId: data.workflows.find((w) => w.active)?.id ?? 0 }, id: null }
              )
            }
            onRemove={setRemoving}
          />
        ) : (
          <ScenarioTab data={data} />
        )}
      </div>

      {flowEditor && data && (
        <WorkflowEditor
          initial={flowEditor.initial}
          editing={flowEditor.editing}
          dir={data.dir}
          modules={data.modules}
          onClose={() => setFlowEditor(null)}
          onSave={async (input) => {
            await saveWorkflow(flowEditor.editing?.id ?? null, input);
            showToast(flowEditor.editing ? `“${input.name}” saved. Requests already in progress keep the version they started with.` : `“${input.name}” created.`, "success");
            setFlowEditor(null);
            load();
          }}
        />
      )}
      {assignmentEditor && data && (
        <AssignmentEditor
          initial={assignmentEditor.initial}
          id={assignmentEditor.id}
          data={data}
          onClose={() => setAssignmentEditor(null)}
          onSaved={() => {
            showToast("Assignment saved. It applies to new submissions.", "success");
            setAssignmentEditor(null);
            load();
          }}
        />
      )}
      {removing && data && (
        <Modal onClose={() => setRemoving(null)}>
          <h2 className="font-heading text-lg font-bold text-ink">Remove this assignment?</h2>
          <p className="mt-2 text-sm text-gray-600">
            {assignmentSummary(removing, data.workflows.find((w) => w.id === removing.workflowId)?.steps ?? [], data.modules, data.dir)}
          </p>
          <p className="mt-2 text-sm text-gray-600">Matching entries will fall back to the next most specific assignment, or apply immediately if none matches. Requests already in progress are unaffected.</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                deleteAssignment(removing.id)
                  .then(() => {
                    showToast("Assignment removed.", "success");
                    setRemoving(null);
                    load();
                  })
                  .catch((err) => showToast(errText(err), "error"))
              }
            >
              Remove
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
