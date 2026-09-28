import { z } from "zod";
import type pg from "pg";
import { logMasterActivity } from "../routes/masterActivityLog.js";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;

// Every module that can require approval. Bulk file types are their own modules so each
// can have its own workflow (a 200,000-row file often warrants a different reviewer than
// one capitalization). `hasAmount`: whether a rupee threshold makes sense as an
// assignment condition for this module.
export const APPROVAL_MODULES = {
  capitalization: { label: "Capitalization", hasAmount: true },
  additions: { label: "Additions", hasAmount: true },
  disposals: { label: "Disposals", hasAmount: true },
  transfers: { label: "Transfers", hasAmount: false },
  editAsset: { label: "Edit Asset", hasAmount: false },
  bulkCapitalization: { label: "Bulk Upload: Capitalization", hasAmount: true },
  bulkDisposals: { label: "Bulk Upload: Disposals", hasAmount: true },
  bulkTransfers: { label: "Bulk Upload: Transfers", hasAmount: false },
  bulkMerge: { label: "Bulk Upload: Merge", hasAmount: false },
  masters: { label: "Masters", hasAmount: false }
} as const;
export type ApprovalModule = keyof typeof APPROVAL_MODULES;
export const APPROVAL_MODULE_KEYS = Object.keys(APPROVAL_MODULES) as ApprovalModule[];

export function isApprovalModule(value: string): value is ApprovalModule {
  return value in APPROVAL_MODULES;
}

export interface Assignee {
  type: "user" | "role";
  id: number;
}
export interface Step {
  rule: "any" | "all";
  assignees: Assignee[];
}

/** The frozen copy stored on a request at submission. Labels are captured too, so the
 *  timeline still reads "Finance Manager" even if that role is renamed later. */
export interface SnapshotAssignee extends Assignee {
  label: string;
}
export interface WorkflowSnapshot {
  workflowId: number;
  name: string;
  /** The workflow's version when the request was submitted (absent on older requests). */
  version?: number;
  steps: Array<{ rule: "any" | "all"; assignees: SnapshotAssignee[] }>;
}

/** A reusable workflow: a named chain of approval steps. */
export interface Flow {
  id: number;
  name: string;
  description: string;
  active: boolean;
  steps: Step[];
  version: number;
  updatedAt: string;
}
/** Which modules and submitter roles use a workflow. roleIds empty = any role. */
export interface Assignment {
  id: number;
  modules: ApprovalModule[];
  roleIds: number[];
  minAmount: number | null;
  workflowId: number;
  updatedAt: string;
}
type AssignmentShape = Pick<Assignment, "modules" | "roleIds" | "minAmount">;

const assigneeSchema = z.object({ type: z.enum(["user", "role"]), id: z.coerce.number().int().positive() });
const stepSchema = z.object({
  rule: z.enum(["any", "all"]).default("any"),
  assignees: z.array(assigneeSchema).min(1, "Every step needs at least one approver.")
});
export const flowInputSchema = z.object({
  name: z.string().trim().min(1, "Give the workflow a name.").max(120),
  description: z.string().trim().max(500).default(""),
  steps: z.array(stepSchema).min(1, "A workflow needs at least one approval step.")
});
export const assignmentInputSchema = z.object({
  modules: z
    .array(z.string().refine(isApprovalModule, "Unknown module."))
    .min(1, "Pick at least one module.")
    .transform((m) => [...new Set(m)] as ApprovalModule[]),
  roleIds: z
    .array(z.coerce.number().int().positive())
    .default([])
    .transform((r) => [...new Set(r)].sort((a, b) => a - b)),
  minAmount: z.coerce.number().nonnegative().nullable().default(null),
  workflowId: z.coerce.number({ message: "Pick a workflow." }).int().positive("Pick a workflow.")
});
export type FlowInput = z.infer<typeof flowInputSchema>;
export type AssignmentInput = z.infer<typeof assignmentInputSchema>;

function httpError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

interface FlowRow {
  id: string;
  name: string;
  description: string;
  active: boolean;
  steps: Step[];
  version: number;
  updated_at: Date;
}
interface AssignmentRow {
  id: string;
  modules: ApprovalModule[];
  role_ids: string[];
  min_amount: string | null;
  workflow_id: string;
  updated_at: Date;
}
const toFlow = (r: FlowRow): Flow => ({
  id: Number(r.id),
  name: r.name,
  description: r.description,
  active: r.active,
  steps: r.steps,
  version: r.version,
  updatedAt: new Date(r.updated_at).toISOString()
});
const toAssignment = (r: AssignmentRow): Assignment => ({
  id: Number(r.id),
  modules: r.modules,
  roleIds: r.role_ids.map(Number),
  minAmount: r.min_amount === null ? null : Number(r.min_amount),
  workflowId: Number(r.workflow_id),
  updatedAt: new Date(r.updated_at).toISOString()
});

export async function listFlows(db: Db): Promise<Flow[]> {
  return (await db.query<FlowRow>(`SELECT * FROM approval_flows ORDER BY active DESC, LOWER(name)`)).rows.map(toFlow);
}
export async function listAssignments(db: Db): Promise<Assignment[]> {
  return (await db.query<AssignmentRow>(`SELECT * FROM approval_assignments ORDER BY id`)).rows.map(toAssignment);
}

// --- Matching -------------------------------------------------------------------------
// The most specific assignment wins: an amount threshold beats a specific role, which
// beats "any role"; between two thresholds that both apply, the higher one wins. Two
// assignments equally specific for the same submission are a conflict: blocked when
// saved (assignmentsConflict), and refused at submission rather than guessed
// (pickAssignment).

type Specificity = [number, number, number];
function specificity(a: AssignmentShape): Specificity {
  return [a.minAmount === null ? 0 : 1, a.minAmount ?? 0, a.roleIds.length ? 1 : 0];
}
function compareSpecificity(x: Specificity, y: Specificity): number {
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

export function assignmentApplies(a: AssignmentShape, module: ApprovalModule, roleId: number | null, amount: number | null): boolean {
  if (!a.modules.includes(module)) return false;
  if (a.roleIds.length && (roleId === null || !a.roleIds.includes(roleId))) return false;
  return a.minAmount === null || (amount !== null && amount >= a.minAmount);
}

/** The winning assignment (pass only ones whose workflow is active). Throws 409 on an
 *  equally specific tie: never guess which workflow applies. */
export function pickAssignment<A extends AssignmentShape>(assignments: A[], module: ApprovalModule, roleId: number | null, amount: number | null): A | null {
  const candidates = assignments.filter((a) => assignmentApplies(a, module, roleId, amount));
  if (candidates.length === 0) return null;
  candidates.sort((x, y) => compareSpecificity(specificity(y), specificity(x)));
  if (candidates.length > 1 && compareSpecificity(specificity(candidates[0]!), specificity(candidates[1]!)) === 0) {
    throw httpError(
      "Two approval assignments match this entry equally, so it isn't clear which workflow applies. Ask an admin to fix it in Approval Workflows.",
      409
    );
  }
  return candidates[0]!;
}

/** Two assignments conflict when one submission could match both equally: a shared
 *  module, the same threshold, and overlapping roles (or both "any role"). */
export function assignmentsConflict(x: AssignmentShape, y: AssignmentShape): boolean {
  if (!x.modules.some((m) => y.modules.includes(m))) return false;
  if (x.minAmount !== y.minAmount) return false;
  if (x.roleIds.length === 0 || y.roleIds.length === 0) return x.roleIds.length === 0 && y.roleIds.length === 0;
  return x.roleIds.some((r) => y.roleIds.includes(r));
}

export async function roleIdForName(db: Db, roleName: string): Promise<number | null> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM roles WHERE LOWER(name) = LOWER($1)`, [roleName]);
  return rows[0] ? Number(rows[0].id) : null;
}

async function activeAssignments(db: Db): Promise<Assignment[]> {
  return (
    await db.query<AssignmentRow>(`SELECT a.* FROM approval_assignments a JOIN approval_flows f ON f.id = a.workflow_id WHERE f.active ORDER BY a.id`)
  ).rows.map(toAssignment);
}

/** The workflow for an entry in `module` by a submitter with this role id (null: a role
 *  with no roles row) and amount. null = no workflow applies: the entry is applied
 *  immediately, exactly as before approvals existed. */
export async function matchWorkflow(db: Db, module: ApprovalModule, roleId: number | null, amount: number | null) {
  const assignment = pickAssignment(await activeAssignments(db), module, roleId, amount);
  if (!assignment) return null;
  const { rows } = await db.query<FlowRow>(`SELECT * FROM approval_flows WHERE id = $1`, [assignment.workflowId]);
  return { assignment, flow: toFlow(rows[0]!) };
}

export async function matchForRole(db: Db, module: ApprovalModule, makerRole: string, amount: number | null) {
  return matchWorkflow(db, module, await roleIdForName(db, makerRole), amount);
}

/** Could any workflow apply to this role in this module, at some amount? (A bulk file is
 *  captured before the whole file's amount is known.) */
export async function roleMayNeedApproval(db: Db, module: ApprovalModule, makerRole: string): Promise<boolean> {
  const roleId = await roleIdForName(db, makerRole);
  return (await activeAssignments(db)).some(
    (a) => a.modules.includes(module) && (a.roleIds.length === 0 || (roleId !== null && a.roleIds.includes(roleId)))
  );
}

export async function snapshotFlow(db: Db, flow: Pick<Flow, "id" | "name" | "steps" | "version">): Promise<WorkflowSnapshot> {
  return { workflowId: flow.id, name: flow.name, version: flow.version, steps: await labelSteps(db, flow.steps) };
}

// --- Saving, logged in the Activity Log -------------------------------------------------

const CONFIG_LOCK_ID = 727502;

async function checkRefs(db: Db, roleIds: number[], userIds: number[]): Promise<void> {
  const roles = [...new Set(roleIds)];
  const users = [...new Set(userIds)];
  if (roles.length && (await db.query(`SELECT id FROM roles WHERE id = ANY($1)`, [roles])).rows.length !== roles.length) {
    throw httpError("This refers to a role that no longer exists. Refresh and try again.", 400);
  }
  if (users.length && (await db.query(`SELECT id FROM users WHERE id = ANY($1)`, [users])).rows.length !== users.length) {
    throw httpError("This refers to a user who no longer exists. Refresh and try again.", 400);
  }
}

async function roleNames(db: Db): Promise<Map<number, string>> {
  return new Map((await db.query<{ id: string; name: string }>(`SELECT id, name FROM roles`)).rows.map((r) => [Number(r.id), r.name]));
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

function describeAssignment(a: AssignmentShape, roles: Map<number, string>, workflowName: string): Record<string, string> {
  return {
    modules: a.modules.map((m) => APPROVAL_MODULES[m].label).join(", "),
    submitterRoles: a.roleIds.length ? a.roleIds.map((id) => roles.get(id) ?? `Role #${id}`).join(", ") : "Any role",
    amountThreshold: a.minAmount === null ? "Any amount" : `${rupees(a.minAmount)} or more`,
    workflow: workflowName
  };
}

async function describeFlow(db: Db, f: Pick<Flow, "name" | "description" | "steps">): Promise<Record<string, string>> {
  return { name: f.name, description: f.description, steps: (await labelSteps(db, f.steps)).map(describeStep).join(" → ") };
}

/** { record, ...changed new values, previous: { their old values } }: the shape the
 *  Activity Log shows as Field: Old → New. */
function diffDetails(record: string, before: Record<string, string>, after: Record<string, string>) {
  const previous = Object.fromEntries(Object.entries(before).filter(([k, v]) => after[k] !== v));
  return { record, ...Object.fromEntries(Object.keys(previous).map((k) => [k, after[k]])), previous };
}

/** Every configuration write runs under one lock, so two admins saving at once can't
 *  each pass the conflict check and together create a conflict. */
async function inConfigTx<T>(db: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [CONFIG_LOCK_ID]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if ((err as { code?: string }).code === "23505") throw httpError("A workflow with this name already exists. Pick another name.", 409);
    throw err;
  } finally {
    client.release();
  }
}

/** Creates (id null) or edits a workflow. An edit bumps its version; requests already
 *  submitted keep the snapshot they started with. */
export async function saveFlow(db: pg.Pool, id: number | null, input: FlowInput, actorId: number): Promise<Flow> {
  const assignees = input.steps.flatMap((s) => s.assignees);
  return inConfigTx(db, async (client) => {
    await checkRefs(
      client,
      assignees.filter((a) => a.type === "role").map((a) => a.id),
      assignees.filter((a) => a.type === "user").map((a) => a.id)
    );
    if (id === null) {
      const { rows } = await client.query<FlowRow>(`INSERT INTO approval_flows (name, description, steps, updated_by) VALUES ($1, $2, $3, $4) RETURNING *`, [
        input.name,
        input.description,
        JSON.stringify(input.steps),
        actorId
      ]);
      const flow = toFlow(rows[0]!);
      await logMasterActivity(client, { actorUserId: actorId, action: "approval_workflow_create", details: { record: flow.name, ...(await describeFlow(client, flow)) } });
      return flow;
    }
    const old = (await client.query<FlowRow>(`SELECT * FROM approval_flows WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!old) throw httpError("Workflow not found.", 404);
    const before = await describeFlow(client, toFlow(old));
    const after = await describeFlow(client, input);
    const details = diffDetails(input.name, before, after);
    if (Object.keys(details.previous).length === 0) return toFlow(old);
    const { rows } = await client.query<FlowRow>(
      `UPDATE approval_flows SET name = $2, description = $3, steps = $4, version = version + 1, updated_by = $5, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, input.name, input.description, JSON.stringify(input.steps), actorId]
    );
    await logMasterActivity(client, { actorUserId: actorId, action: "approval_workflow_update", details });
    return toFlow(rows[0]!);
  });
}

/** Deactivating a workflow that assignments still use is refused: those modules would
 *  silently stop needing approval. The admin moves or removes the assignments first. */
export async function setFlowActive(db: pg.Pool, id: number, active: boolean, actorId: number): Promise<Flow> {
  return inConfigTx(db, async (client) => {
    const old = (await client.query<FlowRow>(`SELECT * FROM approval_flows WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!old) throw httpError("Workflow not found.", 404);
    if (old.active === active) return toFlow(old);
    if (!active) {
      const used = (await client.query<AssignmentRow>(`SELECT * FROM approval_assignments WHERE workflow_id = $1`, [id])).rows.map(toAssignment);
      if (used.length) {
        const modules = [...new Set(used.flatMap((a) => a.modules))].map((m) => APPROVAL_MODULES[m].label);
        throw httpError(
          `"${old.name}" is still used by ${used.length} assignment${used.length === 1 ? "" : "s"} (${modules.join(", ")}). Move ${used.length === 1 ? "it" : "them"} to another workflow or remove ${used.length === 1 ? "it" : "them"} first, so those modules aren't left without approval.`,
          409
        );
      }
    }
    const { rows } = await client.query<FlowRow>(`UPDATE approval_flows SET active = $2, updated_by = $3, updated_at = now() WHERE id = $1 RETURNING *`, [
      id,
      active,
      actorId
    ]);
    await logMasterActivity(client, {
      actorUserId: actorId,
      action: active ? "approval_workflow_activate" : "approval_workflow_deactivate",
      details: { record: old.name, active, previous: { active: old.active } }
    });
    return toFlow(rows[0]!);
  });
}

export async function saveAssignment(db: pg.Pool, id: number | null, input: AssignmentInput, actorId: number): Promise<Assignment> {
  const noAmount = input.modules.filter((m) => !APPROVAL_MODULES[m].hasAmount);
  if (input.minAmount !== null && noAmount.length) {
    throw httpError(
      `${noAmount.map((m) => APPROVAL_MODULES[m].label).join(", ")} ${noAmount.length === 1 ? "has" : "have"} no amount, so this assignment can't use an amount threshold. Remove the threshold or those modules.`,
      400
    );
  }
  return inConfigTx(db, async (client) => {
    await checkRefs(client, input.roleIds, []);
    const flow = (await client.query<FlowRow>(`SELECT * FROM approval_flows WHERE id = $1`, [input.workflowId])).rows[0];
    if (!flow) throw httpError("That workflow no longer exists. Refresh and try again.", 400);
    if (!flow.active) throw httpError(`"${flow.name}" is inactive. Reactivate it or pick another workflow.`, 400);
    const roles = await roleNames(client);
    const others = (
      await client.query<AssignmentRow & { workflow_name: string }>(
        `SELECT a.*, f.name AS workflow_name FROM approval_assignments a JOIN approval_flows f ON f.id = a.workflow_id WHERE a.id IS DISTINCT FROM $1::bigint`,
        [id]
      )
    ).rows;
    const clash = others.find((o) => assignmentsConflict(input, toAssignment(o)));
    if (clash) {
      const c = toAssignment(clash);
      const shared = input.modules.filter((m) => c.modules.includes(m)).map((m) => APPROVAL_MODULES[m].label);
      const who = input.roleIds.length ? input.roleIds.filter((r) => c.roleIds.includes(r)).map((r) => roles.get(r) ?? `Role #${r}`).join(", ") : "any role";
      const amount = input.minAmount === null ? "at any amount" : `at ${rupees(input.minAmount)} or more`;
      throw httpError(
        `Conflicts with the assignment that uses "${clash.workflow_name}" (${shared.join(", ")}, submitted by ${who}, ${amount}). Both are equally specific, so it wouldn't be clear which workflow applies. Change the roles or the amount, or edit that assignment instead.`,
        409
      );
    }
    let old: AssignmentRow | undefined;
    let row: AssignmentRow;
    const values = [input.modules, input.roleIds, input.minAmount, input.workflowId, actorId];
    if (id === null) {
      row = (
        await client.query<AssignmentRow>(
          `INSERT INTO approval_assignments (modules, role_ids, min_amount, workflow_id, updated_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          values
        )
      ).rows[0]!;
    } else {
      old = (await client.query<AssignmentRow>(`SELECT * FROM approval_assignments WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!old) throw httpError("Assignment not found.", 404);
      row = (
        await client.query<AssignmentRow>(
          `UPDATE approval_assignments SET modules = $2, role_ids = $3, min_amount = $4, workflow_id = $5, updated_by = $6, updated_at = now() WHERE id = $1 RETURNING *`,
          [id, ...values]
        )
      ).rows[0]!;
    }
    const saved = toAssignment(row);
    const after = describeAssignment(saved, roles, flow.name);
    if (!old) {
      await logMasterActivity(client, { actorUserId: actorId, action: "approval_assignment_create", details: { record: `Assignment #${saved.id}`, ...after } });
    } else {
      const oldFlow = (await client.query<{ name: string }>(`SELECT name FROM approval_flows WHERE id = $1`, [old.workflow_id])).rows[0]?.name ?? "";
      const details = diffDetails(`Assignment #${saved.id}`, describeAssignment(toAssignment(old), roles, oldFlow), after);
      if (Object.keys(details.previous).length) await logMasterActivity(client, { actorUserId: actorId, action: "approval_assignment_update", details });
    }
    return saved;
  });
}

export async function deleteAssignment(db: pg.Pool, id: number, actorId: number): Promise<void> {
  await inConfigTx(db, async (client) => {
    const old = (
      await client.query<AssignmentRow & { workflow_name: string }>(
        `DELETE FROM approval_assignments a USING approval_flows f WHERE a.id = $1 AND f.id = a.workflow_id RETURNING a.*, f.name AS workflow_name`,
        [id]
      )
    ).rows[0];
    if (!old) throw httpError("Assignment not found.", 404);
    await logMasterActivity(client, {
      actorUserId: actorId,
      action: "approval_assignment_delete",
      details: { record: `Assignment #${id}`, previous: describeAssignment(toAssignment(old), await roleNames(client), old.workflow_name) }
    });
  });
}

// --- One-time conversion of the legacy per-module rules ---------------------------------

export interface LegacyRule {
  module: ApprovalModule;
  name: string;
  position: number;
  initiatorRoleIds: number[];
  minAmount: number | null;
  steps: Step[];
}

/** The legacy rules (per module, first match top to bottom) as workflows + assignments
 *  that route exactly the same submissions under most-specific-wins.
 *
 *  Per module and role, a later rule is unreachable ("shadowed") when an earlier rule for
 *  that role has a threshold at or below its own (no threshold counts as lowest), so the
 *  role is dropped from it. What's left has, per module and role, strictly falling
 *  thresholds in the old order: the same order most-specific-wins picks them in, and no
 *  two equally specific. Identical step chains become one shared workflow; assignments
 *  identical but for the module merge into one. */
export function convertLegacyRules(rules: LegacyRule[]) {
  const rank = (t: number | null) => (t === null ? -Infinity : t);
  const kept: Array<{ module: ApprovalModule; roleIds: number[]; minAmount: number | null; steps: Step[]; name: string }> = [];
  const byModule = new Map<ApprovalModule, LegacyRule[]>();
  for (const r of rules) byModule.set(r.module, [...(byModule.get(r.module) ?? []), r]);
  for (const [module, list] of byModule) {
    const lowest = new Map<number, number>(); // role -> lowest threshold rank an earlier rule claimed
    for (const r of [...list].sort((a, b) => a.position - b.position)) {
      const roles = [...new Set(r.initiatorRoleIds)].filter((role) => (lowest.get(role) ?? Infinity) > rank(r.minAmount));
      for (const role of roles) lowest.set(role, Math.min(lowest.get(role) ?? Infinity, rank(r.minAmount)));
      if (roles.length) kept.push({ module, roleIds: roles.sort((a, b) => a - b), minAmount: r.minAmount, steps: r.steps, name: r.name.trim() });
    }
  }
  const flows: Array<{ name: string; steps: Step[] }> = [];
  const flowByChain = new Map<string, number>();
  const assignments: Array<{ modules: ApprovalModule[]; roleIds: number[]; minAmount: number | null; flow: number }> = [];
  for (const k of kept) {
    const chain = JSON.stringify(k.steps.map((s) => ({ rule: s.rule, assignees: s.assignees.map((a) => ({ type: a.type, id: Number(a.id) })) })));
    let flow = flowByChain.get(chain);
    if (flow === undefined) {
      flow = flows.push({ name: k.name, steps: k.steps }) - 1;
      flowByChain.set(chain, flow);
    } else if (!flows[flow]!.name) flows[flow]!.name = k.name;
    const same = assignments.find((a) => a.flow === flow && a.minAmount === k.minAmount && a.roleIds.join() === k.roleIds.join());
    if (same) same.modules.push(k.module);
    else assignments.push({ modules: [k.module], roleIds: k.roleIds, minAmount: k.minAmount, flow });
  }
  const used = new Set<string>();
  flows.forEach((f, i) => {
    const base = f.name || `Workflow ${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    used.add(name.toLowerCase());
    f.name = name;
  });
  return { flows, assignments };
}

/** Runs once per database (approval_config.legacy_rules_migrated), inside applySchema's
 *  locked transaction. Forward-only: the legacy rows are left untouched. */
export async function migrateLegacyRules(db: Db): Promise<void> {
  const { rows: cfg } = await db.query<{ legacy_rules_migrated: boolean }>(`SELECT legacy_rules_migrated FROM approval_config WHERE id = TRUE FOR UPDATE`);
  if (cfg[0]?.legacy_rules_migrated) return;
  const { rows } = await db.query<{ module: string; name: string; position: number; initiator_role_ids: string[]; min_amount: string | null; steps: Step[] }>(
    `SELECT module, name, position, initiator_role_ids, min_amount, steps FROM approval_workflows ORDER BY module, position, id`
  );
  const { flows, assignments } = convertLegacyRules(
    rows
      .filter((r) => isApprovalModule(r.module))
      .map((r) => ({
        module: r.module as ApprovalModule,
        name: r.name,
        position: r.position,
        initiatorRoleIds: r.initiator_role_ids.map(Number),
        minAmount: r.min_amount === null ? null : Number(r.min_amount),
        steps: r.steps
      }))
  );
  const ids: number[] = [];
  for (const f of flows) {
    const { rows: ins } = await db.query<{ id: string }>(
      `INSERT INTO approval_flows (name, description, steps) VALUES ($1, 'Converted from the earlier per-module rules.', $2) RETURNING id`,
      [f.name, JSON.stringify(f.steps)]
    );
    ids.push(Number(ins[0]!.id));
  }
  for (const a of assignments) {
    await db.query(`INSERT INTO approval_assignments (modules, role_ids, min_amount, workflow_id) VALUES ($1, $2, $3, $4)`, [a.modules, a.roleIds, a.minAmount, ids[a.flow]]);
  }
  await db.query(`UPDATE approval_config SET legacy_rules_migrated = TRUE WHERE id = TRUE`);
}

// --- Labels ---------------------------------------------------------------------------

export async function labelSteps(db: Db, steps: Step[]): Promise<WorkflowSnapshot["steps"]> {
  const userIds = steps.flatMap((s) => s.assignees.filter((a) => a.type === "user").map((a) => a.id));
  const roleIds = steps.flatMap((s) => s.assignees.filter((a) => a.type === "role").map((a) => a.id));
  const users = new Map(
    (
      await db.query<{ id: string; display_name: string | null; username: string }>(`SELECT id, display_name, username FROM users WHERE id = ANY($1)`, [userIds])
    ).rows.map((u) => [Number(u.id), u.display_name || u.username])
  );
  const roles = new Map(
    (await db.query<{ id: string; name: string }>(`SELECT id, name FROM roles WHERE id = ANY($1)`, [roleIds])).rows.map((r) => [Number(r.id), r.name])
  );
  return steps.map((s) => ({
    rule: s.rule,
    assignees: s.assignees.map((a) => ({
      ...a,
      label: (a.type === "user" ? users.get(a.id) : roles.get(a.id)) ?? `Unknown ${a.type} #${a.id}`
    }))
  }));
}

/** "Finance Manager (any one)" / "Finance Manager and CFO (all)" — the plain-English
 *  step label used in the builder summary, toasts and notifications. */
export function describeStep(step: WorkflowSnapshot["steps"][number]): string {
  const names = step.assignees.map((a) => a.label);
  if (names.length === 1) return names[0]!;
  const list = names.length === 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} (${step.rule === "all" ? "all must approve" : "any one"})`;
}
