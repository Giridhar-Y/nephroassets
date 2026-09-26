import { useEffect, useState } from "react";
import {
  fetchApprovalModules,
  fetchDirectory,
  fetchWorkflows,
  saveAgingDays,
  saveModuleRules,
  type ApprovalModule,
  type Directory,
  type ModuleInfo,
  type WorkflowRule,
  type WorkflowStep
} from "../api/approvals.js";
import { formatCurrency } from "../lib/format.js";
import { AddCircleIcon, DeleteIcon, ErrorIcon, MoveDownIcon, MoveUpIcon, StepArrowIcon, WorkflowIcon } from "../lib/icons.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { Card } from "../components/ui/Card.js";
import { Button } from "../components/ui/Button.js";
import { useToast } from "../components/Toast.js";
import { AssigneePicker, assigneeLabel } from "../components/approvals/AssigneePicker.js";

// Admin workflow builder: one card per module; each rule says which roles it applies to,
// an optional amount threshold, and an ordered row of approval steps. The first rule
// (top to bottom) that matches a submission is used; no match = applied immediately.

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

function stepText(step: WorkflowStep, dir: Directory): string {
  const names = step.assignees.map((a) => assigneeLabel(a, dir));
  if (names.length === 0) return "(no approver yet)";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} (${step.rule === "all" ? "all must approve" : "any one"})`;
}

export function ruleSummary(rule: WorkflowRule, moduleLabel: string, dir: Directory): string {
  const roles = rule.initiatorRoleIds.map((id) => dir.roles.find((r) => r.id === id)?.name ?? `Role #${id}`);
  const who = roles.length ? `When ${/^[aeiou]/i.test(roles[0]!) ? "an" : "a"} ${joinNames(roles)} submits ${/^[aeiou]/i.test(moduleLabel) ? "an" : "a"} ${moduleLabel}` : `When someone submits ${moduleLabel}`;
  const threshold = rule.minAmount !== null ? ` of ${formatCurrency(rule.minAmount)} or more` : "";
  return `${who}${threshold}: ${rule.steps.map((s) => stepText(s, dir)).join(" → ")}`;
}

function validate(rules: WorkflowRule[]): string | null {
  for (const [i, r] of rules.entries()) {
    if (r.initiatorRoleIds.length === 0) return `Rule ${i + 1}: pick at least one role it applies to.`;
    if (r.steps.length === 0) return `Rule ${i + 1}: add at least one approval step.`;
    const empty = r.steps.findIndex((s) => s.assignees.length === 0);
    if (empty >= 0) return `Rule ${i + 1}, step ${empty + 1}: add at least one approver.`;
  }
  return null;
}

const newStep = (): WorkflowStep => ({ rule: "any", assignees: [] });
const newRule = (): WorkflowRule => ({ name: "", initiatorRoleIds: [], minAmount: null, steps: [newStep()] });

function RuleEditor({
  rule,
  index,
  total,
  module,
  dir,
  onChange,
  onMove,
  onRemove
}: {
  rule: WorkflowRule;
  index: number;
  total: number;
  module: ModuleInfo;
  dir: Directory;
  onChange: (r: WorkflowRule) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const setStep = (i: number, s: WorkflowStep) => onChange({ ...rule, steps: rule.steps.map((x, j) => (j === i ? s : x)) });
  const moveStep = (i: number, delta: -1 | 1) => {
    const steps = [...rule.steps];
    [steps[i], steps[i + delta]] = [steps[i + delta]!, steps[i]!];
    onChange({ ...rule, steps });
  };
  return (
    <div className="animate-panel-in rounded-xl border border-gray-200 bg-gray-50/50 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-1.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink text-xs font-bold text-white" aria-label={`Rule ${index + 1}`}>
          {index + 1}
        </span>
        <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[11px] font-bold uppercase tracking-wide text-gray-500">
          Rule name (optional)
          <input
            value={rule.name}
            onChange={(e) => onChange({ ...rule, name: e.target.value })}
            placeholder="e.g. Editors — standard"
            className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm font-normal normal-case tracking-normal text-ink focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue"
          />
        </label>
        <div className="flex min-w-[240px] flex-[2] flex-col gap-1">
          <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">When submitted by</span>
          <AssigneePicker
            roleOnly
            placeholder="Pick roles…"
            directory={dir}
            value={rule.initiatorRoleIds.map((id) => ({ type: "role" as const, id }))}
            onChange={(v) => onChange({ ...rule, initiatorRoleIds: v.map((a) => a.id) })}
          />
        </div>
        {module.hasAmount && (
          <label className="flex w-44 flex-col gap-1 text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Only if amount ≥ (₹)
            <input
              type="number"
              min={0}
              value={rule.minAmount ?? ""}
              onChange={(e) => onChange({ ...rule, minAmount: e.target.value === "" ? null : Number(e.target.value) })}
              placeholder="Any amount"
              className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm font-normal normal-case tracking-normal text-ink focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue"
            />
          </label>
        )}
        <div className="ml-auto flex gap-1 pt-5">
          <button type="button" aria-label="Move rule up" disabled={index === 0} onClick={() => onMove(-1)} className="rounded-md p-1.5 text-gray-500 hover:bg-white hover:text-ink disabled:opacity-30">
            <MoveUpIcon fontSize={16} />
          </button>
          <button type="button" aria-label="Move rule down" disabled={index === total - 1} onClick={() => onMove(1)} className="rounded-md p-1.5 text-gray-500 hover:bg-white hover:text-ink disabled:opacity-30">
            <MoveDownIcon fontSize={16} />
          </button>
          <button type="button" aria-label="Delete rule" onClick={onRemove} className="rounded-md p-1.5 text-gray-500 hover:bg-white hover:text-accent">
            <DeleteIcon fontSize={16} />
          </button>
        </div>
      </div>

      {/* Wraps rather than scrolling sideways: a scroll container would clip the
          approver dropdowns. */}
      <div className="mt-4">
        <ol className="flex flex-wrap items-stretch gap-2 gap-y-3">
          {rule.steps.map((s, i) => (
            <li key={i} className="flex items-stretch gap-2">
              <div className="animate-panel-in flex w-72 shrink-0 flex-col gap-2 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wide text-brand-blue">Step {i + 1}</span>
                  <span className="flex">
                    <button type="button" aria-label={`Move step ${i + 1} earlier`} disabled={i === 0} onClick={() => moveStep(i, -1)} className="rounded p-1 text-gray-400 hover:text-ink disabled:opacity-30">
                      <MoveUpIcon fontSize={14} className="-rotate-90" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move step ${i + 1} later`}
                      disabled={i === rule.steps.length - 1}
                      onClick={() => moveStep(i, 1)}
                      className="rounded p-1 text-gray-400 hover:text-ink disabled:opacity-30"
                    >
                      <MoveDownIcon fontSize={14} className="-rotate-90" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove step ${i + 1}`}
                      disabled={rule.steps.length === 1}
                      onClick={() => onChange({ ...rule, steps: rule.steps.filter((_, j) => j !== i) })}
                      className="rounded p-1 text-gray-400 hover:text-accent disabled:opacity-30"
                    >
                      <DeleteIcon fontSize={14} />
                    </button>
                  </span>
                </div>
                <AssigneePicker value={s.assignees} onChange={(assignees) => setStep(i, { ...s, assignees })} directory={dir} placeholder="Approvers…" />
                <div role="radiogroup" aria-label={`Step ${i + 1} completion rule`} className="inline-flex self-start rounded-md border border-gray-200 p-0.5 text-xs font-semibold">
                  {(["any", "all"] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      role="radio"
                      aria-checked={s.rule === r}
                      onClick={() => setStep(i, { ...s, rule: r })}
                      className={`rounded px-2.5 py-1 transition-colors ${s.rule === r ? "bg-ink text-white" : "text-gray-500 hover:bg-gray-50"}`}
                    >
                      {r === "any" ? "Any one approves" : "All must approve"}
                    </button>
                  ))}
                </div>
              </div>
              {i < rule.steps.length - 1 && <StepArrowIcon fontSize={18} className="shrink-0 self-center text-gray-300" aria-hidden />}
            </li>
          ))}
          <li className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => onChange({ ...rule, steps: [...rule.steps, newStep()] })}
              className="flex h-full min-h-[120px] w-28 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-gray-300 text-xs font-semibold text-gray-500 transition-colors hover:border-brand-blue hover:text-brand-blue"
            >
              <AddCircleIcon fontSize={20} aria-hidden /> Add step
            </button>
          </li>
        </ol>
      </div>
      <p className="mt-3 rounded-lg bg-white px-3 py-2 text-sm text-ink" aria-live="polite">
        {ruleSummary(rule, module.label, dir)}
      </p>
    </div>
  );
}

function ModuleCard({ module, initial, dir }: { module: ModuleInfo; initial: WorkflowRule[]; dir: Directory }) {
  const { showToast } = useToast();
  const [rules, setRules] = useState<WorkflowRule[]>(initial);
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(rules) !== saved;

  async function save() {
    const problem = validate(rules);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await saveModuleRules(
        module.key,
        rules.map(({ name, initiatorRoleIds, minAmount, steps }) => ({ name, initiatorRoleIds, minAmount, steps }))
      );
      const next = res.rules.map(({ name, initiatorRoleIds, minAmount, steps }) => ({ name, initiatorRoleIds, minAmount, steps }));
      setRules(next);
      setSaved(JSON.stringify(next));
      showToast(`${module.label} workflow saved. Requests already in progress keep the workflow they started with.`, "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-base font-bold text-ink">{module.label}</h2>
          <p className="text-xs text-gray-500">
            {rules.length === 0 ? "No approval needed. Changes apply immediately, as today." : `${rules.length} rule${rules.length === 1 ? "" : "s"}. The first match (top to bottom) is used; anyone else applies directly.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && <span className="text-xs font-medium text-amber-700">Unsaved changes</span>}
          <Button variant="secondary" size="sm" onClick={() => setRules((r) => [...r, newRule()])}>
            <AddCircleIcon fontSize={14} aria-hidden /> Add rule
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {error && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-accent-hover" role="alert">
          <ErrorIcon fontSize={15} aria-hidden /> {error}
        </p>
      )}
      {rules.length > 0 && (
        <div className="mt-4 space-y-3">
          {rules.map((r, i) => (
            <RuleEditor
              key={i}
              rule={r}
              index={i}
              total={rules.length}
              module={module}
              dir={dir}
              onChange={(next) => setRules((list) => list.map((x, j) => (j === i ? next : x)))}
              onMove={(delta) =>
                setRules((list) => {
                  const copy = [...list];
                  [copy[i], copy[i + delta]] = [copy[i + delta]!, copy[i]!];
                  return copy;
                })
              }
              onRemove={() => setRules((list) => list.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

export function WorkflowsPage() {
  const { showToast } = useToast();
  const [modules, setModules] = useState<ModuleInfo[] | null>(null);
  const [dir, setDir] = useState<Directory | null>(null);
  const [rulesByModule, setRulesByModule] = useState<Record<string, WorkflowRule[]>>({});
  const [agingDays, setAgingDays] = useState(3);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchApprovalModules(), fetchDirectory(), fetchWorkflows()])
      .then(([m, d, w]) => {
        setModules(m);
        setDir(d);
        setAgingDays(w.agingDays);
        const grouped: Record<string, WorkflowRule[]> = {};
        for (const r of w.rules) (grouped[r.module] ??= []).push({ name: r.name, initiatorRoleIds: r.initiatorRoleIds, minAmount: r.minAmount, steps: r.steps });
        setRulesByModule(grouped);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load workflows."));
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <PageHeader
        icon={WorkflowIcon}
        title="Approval Workflows"
        subtitle="Choose who approves what. A module with no rules applies changes immediately, as today."
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-8 py-6">
        {error && (
          <p className="flex items-center gap-1.5 text-sm text-accent-hover">
            <ErrorIcon fontSize={15} aria-hidden /> {error}
          </p>
        )}
        <Card className="flex flex-wrap items-end gap-3 p-5">
          <label className="flex flex-col gap-1 text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Flag requests waiting longer than (days)
            <input
              type="number"
              min={1}
              max={365}
              value={agingDays}
              onChange={(e) => setAgingDays(Number(e.target.value))}
              className="w-40 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm font-normal text-ink focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue"
            />
          </label>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              saveAgingDays(agingDays)
                .then(() => showToast(`Requests waiting more than ${agingDays} days will be flagged in Tasks.`, "success"))
                .catch((err) => showToast(err instanceof Error ? err.message : "Couldn't save.", "error"))
            }
          >
            Save
          </Button>
        </Card>
        {!modules || !dir
          ? !error && [0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-gray-100" />)
          : modules.map((m) => <ModuleCard key={m.key} module={m} initial={rulesByModule[m.key as ApprovalModule] ?? []} dir={dir} />)}
      </div>
    </div>
  );
}
