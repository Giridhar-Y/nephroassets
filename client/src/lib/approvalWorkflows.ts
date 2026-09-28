import type { ApprovalModule, Assignment, Directory, ModuleInfo, WorkflowStep } from "../api/approvals.js";
import { assigneeLabel } from "../components/approvals/AssigneePicker.js";
import { formatCurrency } from "./format.js";

// Plain-English text and the matching rule for the Approval Workflows screen. The
// matching mirrors server/src/approvals/workflows.ts (pickAssignment) so the overview
// matrix shows exactly what a submission would get; "Test a scenario" asks the server.

export function stepText(step: WorkflowStep, dir: Directory): string {
  const names = step.assignees.map((a) => assigneeLabel(a, dir));
  if (names.length === 0) return "(no approver yet)";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} (${step.rule === "all" ? "all must approve" : "any one"})`;
}

export function chainText(steps: WorkflowStep[], dir: Directory): string {
  return steps.map((s) => stepText(s, dir)).join(" → ");
}

function joinOr(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}
const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

/** "When an Editor submits a Capitalization of ₹1,00,000 or more: Finance Manager → CFO". */
export function assignmentSummary(
  a: { roleIds: number[]; minAmount: number | null; modules: ApprovalModule[] },
  steps: WorkflowStep[],
  modules: ModuleInfo[],
  dir: Directory
): string {
  const labels = a.modules.map((m) => modules.find((x) => x.key === m)?.label ?? m);
  const what = labels.length === 1 ? `${article(labels[0]!)} ${labels[0]}` : joinOr(labels);
  const roles = a.roleIds.map((id) => dir.roles.find((r) => r.id === id)?.name ?? `Role #${id}`);
  const who = roles.length ? `${article(roles[0]!)} ${joinOr(roles)}` : "anyone";
  const threshold = a.minAmount !== null ? ` of ${formatCurrency(a.minAmount)} or more` : "";
  return `When ${who} submits ${what}${threshold}: ${chainText(steps, dir)}`;
}

type Shape = Pick<Assignment, "modules" | "roleIds" | "minAmount">;
const specificity = (a: Shape): [number, number, number] => [a.minAmount === null ? 0 : 1, a.minAmount ?? 0, a.roleIds.length ? 1 : 0];
const compare = (x: Shape, y: Shape) => {
  const [a, b] = [specificity(x), specificity(y)];
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
};

/** The winning assignment; "conflict" on an equally specific tie (the server blocks
 *  saving one, so this only shows if the data is already inconsistent). */
export function pickAssignment<A extends Shape>(list: A[], module: ApprovalModule, roleId: number | null, amount: number | null): A | null | "conflict" {
  const candidates = list
    .filter((a) => a.modules.includes(module))
    .filter((a) => a.roleIds.length === 0 || (roleId !== null && a.roleIds.includes(roleId)))
    .filter((a) => a.minAmount === null || (amount !== null && amount >= a.minAmount))
    .sort((x, y) => compare(y, x));
  if (candidates.length > 1 && compare(candidates[0]!, candidates[1]!) === 0) return "conflict";
  return candidates[0] ?? null;
}

/** One overview-matrix cell: what applies at any amount, plus each higher-amount tier. */
export interface MatrixCell {
  base: number | null | "conflict";
  tiers: Array<{ minAmount: number; workflowId: number | null | "conflict" }>;
}
export function matrixCell(list: Assignment[], module: ApprovalModule, roleId: number | null): MatrixCell {
  const pick = (amount: number | null) => {
    const hit = pickAssignment(list, module, roleId, amount);
    return hit === "conflict" ? hit : (hit?.workflowId ?? null);
  };
  const thresholds = [
    ...new Set(
      list
        .filter((a) => a.minAmount !== null && a.modules.includes(module) && (a.roleIds.length === 0 || (roleId !== null && a.roleIds.includes(roleId))))
        .map((a) => a.minAmount!)
    )
  ].sort((a, b) => a - b);
  return { base: pick(null), tiers: thresholds.map((t) => ({ minAmount: t, workflowId: pick(t) })) };
}
