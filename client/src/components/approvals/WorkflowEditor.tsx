import { useState } from "react";
import type { Directory, ModuleInfo, Workflow, WorkflowInput, WorkflowStep } from "../../api/approvals.js";
import { chainText, stepText } from "../../lib/approvalWorkflows.js";
import { AddCircleIcon, DeleteIcon, ErrorIcon, InfoIcon, MoveDownIcon, MoveUpIcon, PassIcon, StepArrowIcon } from "../../lib/icons.js";
import { Modal } from "../ui/Modal.js";
import { Button } from "../ui/Button.js";
import { AssigneePicker } from "./AssigneePicker.js";

// Create / edit / duplicate a reusable workflow as a short stepper: Name → Steps →
// Review. Saving an edit to a workflow in use only affects new requests (each request
// keeps the snapshot it was submitted with).

const newStep = (): WorkflowStep => ({ rule: "any", assignees: [] });
const STAGES = ["Name", "Steps", "Review"] as const;

export const inputClass =
  "rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm font-normal normal-case tracking-normal text-ink focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue disabled:bg-gray-50 disabled:text-gray-400";
export const labelClass = "flex flex-col gap-1 text-[11px] font-bold uppercase tracking-wide text-gray-500";

export function StepsBuilder({ steps, onChange, dir }: { steps: WorkflowStep[]; onChange: (s: WorkflowStep[]) => void; dir: Directory }) {
  const setStep = (i: number, s: WorkflowStep) => onChange(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, delta: -1 | 1) => {
    const next = [...steps];
    [next[i], next[i + delta]] = [next[i + delta]!, next[i]!];
    onChange(next);
  };
  // Wraps rather than scrolling sideways: a scroll container would clip the approver dropdowns.
  return (
    <ol className="flex flex-wrap items-stretch gap-2 gap-y-3">
      {steps.map((s, i) => (
        <li key={i} className="flex items-stretch gap-2">
          <div className="animate-panel-in flex w-72 shrink-0 flex-col gap-2 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wide text-brand-blue">Step {i + 1}</span>
              <span className="flex">
                <button type="button" aria-label={`Move step ${i + 1} earlier`} disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 text-gray-400 hover:text-ink disabled:opacity-30">
                  <MoveUpIcon fontSize={14} className="-rotate-90" />
                </button>
                <button
                  type="button"
                  aria-label={`Move step ${i + 1} later`}
                  disabled={i === steps.length - 1}
                  onClick={() => move(i, 1)}
                  className="rounded p-1 text-gray-400 hover:text-ink disabled:opacity-30"
                >
                  <MoveDownIcon fontSize={14} className="-rotate-90" />
                </button>
                <button
                  type="button"
                  aria-label={`Remove step ${i + 1}`}
                  disabled={steps.length === 1}
                  onClick={() => onChange(steps.filter((_, j) => j !== i))}
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
          {i < steps.length - 1 && <StepArrowIcon fontSize={18} className="shrink-0 self-center text-gray-300" aria-hidden />}
        </li>
      ))}
      <li className="flex shrink-0 items-center">
        <button
          type="button"
          onClick={() => onChange([...steps, newStep()])}
          className="flex h-full min-h-[120px] w-28 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-gray-300 text-xs font-semibold text-gray-500 transition-colors hover:border-brand-blue hover:text-brand-blue"
        >
          <AddCircleIcon fontSize={20} aria-hidden /> Add step
        </button>
      </li>
    </ol>
  );
}

export function WorkflowEditor({
  initial,
  editing,
  dir,
  modules,
  onSave,
  onClose
}: {
  initial: WorkflowInput;
  /** The workflow being edited (null: creating or duplicating). */
  editing: Workflow | null;
  dir: Directory;
  modules: ModuleInfo[];
  onSave: (input: WorkflowInput) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<WorkflowInput>(initial);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function problem(at: number): string | null {
    if (!draft.name.trim()) return "Give the workflow a name.";
    if (at >= 1) {
      if (draft.steps.length === 0) return "Add at least one approval step.";
      const empty = draft.steps.findIndex((s) => s.assignees.length === 0);
      if (empty >= 0) return `Step ${empty + 1}: add at least one approver.`;
    }
    return null;
  }
  function next() {
    const p = problem(stage);
    setError(p);
    if (!p) setStage((s) => s + 1);
  }
  async function save() {
    const p = problem(1);
    if (p) return setError(p);
    setBusy(true);
    setError(null);
    try {
      await onSave({ ...draft, name: draft.name.trim(), description: draft.description.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
      setBusy(false);
    }
  }

  const usedModules = editing?.modules.map((m) => modules.find((x) => x.key === m)?.label ?? m) ?? [];

  return (
    <Modal onClose={onClose} widthClassName="max-w-4xl">
      <div className="flex max-h-[85vh] flex-col">
        <h2 className="font-heading text-lg font-bold text-ink">{editing ? `Edit “${editing.name}”` : "New workflow"}</h2>
        <ol className="mt-4 flex flex-wrap items-center gap-2" aria-label="Progress">
          {STAGES.map((label, i) => (
            <li key={label} className="flex items-center gap-2" aria-current={i === stage ? "step" : undefined}>
              <button
                type="button"
                disabled={i > stage}
                onClick={() => setStage(i)}
                className={`flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-xs font-semibold transition-colors ${
                  i === stage ? "bg-ink text-white" : i < stage ? "bg-brand-blue/10 text-ink hover:bg-brand-blue/20" : "bg-gray-100 text-gray-400"
                }`}
              >
                <span
                  className={`grid h-5 w-5 place-items-center rounded-full text-[11px] ${i === stage ? "bg-white text-ink" : i < stage ? "bg-brand-blue text-white" : "bg-white text-gray-400"}`}
                >
                  {i < stage ? <PassIcon fontSize={12} aria-hidden /> : i + 1}
                </span>
                {label}
              </button>
              {i < STAGES.length - 1 && <span className="h-px w-8 bg-gray-200" aria-hidden />}
            </li>
          ))}
        </ol>

        {usedModules.length > 0 && (
          <p className="mt-4 flex items-start gap-2 rounded-lg bg-brand-blue/10 px-3 py-2 text-sm text-ink" role="note">
            <InfoIcon fontSize={16} className="mt-0.5 shrink-0 text-brand-blue" aria-hidden />
            <span>
              <strong>
                Used by {usedModules.length} module{usedModules.length === 1 ? "" : "s"}.
              </strong>{" "}
              Changes apply to new requests only. <span className="text-gray-600">({usedModules.join(", ")})</span>
            </span>
          </p>
        )}

        <div key={stage} className="animate-panel-in mt-5 min-h-[220px] flex-1 overflow-auto">
          {stage === 0 && (
            <div className="flex max-w-lg flex-col gap-4">
              <label className={labelClass}>
                Name
                <input
                  autoFocus
                  value={draft.name}
                  maxLength={120}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && next()}
                  placeholder="e.g. Standard finance review"
                  className={inputClass}
                />
              </label>
              <label className={labelClass}>
                Description (optional)
                <textarea
                  value={draft.description}
                  maxLength={500}
                  rows={3}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="When to use it, e.g. everyday entries up to ₹1 lakh"
                  className={inputClass}
                />
              </label>
            </div>
          )}
          {stage === 1 && (
            <>
              <p className="mb-3 text-sm text-gray-600">Steps run in order. Each step names people and/or roles; choose whether any one of them or all must approve.</p>
              <StepsBuilder steps={draft.steps} onChange={(steps) => setDraft({ ...draft, steps })} dir={dir} />
            </>
          )}
          {stage === 2 && (
            <dl className="grid max-w-2xl grid-cols-[8rem_1fr] gap-x-4 gap-y-3 text-sm">
              <dt className="font-semibold text-gray-500">Name</dt>
              <dd className="font-semibold text-ink">{draft.name}</dd>
              <dt className="font-semibold text-gray-500">Description</dt>
              <dd className="text-ink">{draft.description || "—"}</dd>
              <dt className="font-semibold text-gray-500">Steps</dt>
              <dd>
                <ol className="space-y-1.5">
                  {draft.steps.map((s, i) => (
                    <li key={i} className="flex items-baseline gap-2 text-ink">
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ink text-[11px] font-bold text-white">{i + 1}</span>
                      {stepText(s, dir)}
                    </li>
                  ))}
                </ol>
              </dd>
              <dt className="font-semibold text-gray-500">In short</dt>
              <dd className="rounded-lg bg-gray-50 px-3 py-2 text-ink" aria-live="polite">
                Each request goes to {chainText(draft.steps, dir)}, in that order.
              </dd>
            </dl>
          )}
        </div>

        {error && (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-accent-hover" role="alert">
            <ErrorIcon fontSize={15} aria-hidden /> {error}
          </p>
        )}
        <div className="mt-5 flex items-center justify-between border-t border-gray-100 pt-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <div className="flex gap-2">
            {stage > 0 && (
              <Button variant="secondary" onClick={() => setStage((s) => s - 1)}>
                Back
              </Button>
            )}
            {stage < STAGES.length - 1 ? (
              <Button onClick={next}>Next</Button>
            ) : (
              <Button onClick={save} disabled={busy}>
                {busy ? "Saving…" : editing ? "Save changes" : "Create workflow"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
