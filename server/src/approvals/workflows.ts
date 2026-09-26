import { z } from "zod";
import type pg from "pg";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;

// Every module that can require approval. Bulk file types are their own modules so each
// can have its own workflow (a 200,000-row file often warrants a different reviewer than
// one capitalization). `hasAmount`: whether a rupee threshold makes sense as a rule
// condition for this module.
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
export interface WorkflowRule {
  id?: number;
  module: ApprovalModule;
  name: string;
  initiatorRoleIds: number[];
  minAmount: number | null;
  steps: Step[];
}

/** The frozen copy stored on a request at submission. Labels are captured too, so the
 *  timeline still reads "Finance Manager" even if that role is renamed later. */
export interface SnapshotAssignee extends Assignee {
  label: string;
}
export interface WorkflowSnapshot {
  workflowId: number;
  name: string;
  steps: Array<{ rule: "any" | "all"; assignees: SnapshotAssignee[] }>;
}

const assigneeSchema = z.object({ type: z.enum(["user", "role"]), id: z.coerce.number().int().positive() });
const stepSchema = z.object({
  rule: z.enum(["any", "all"]).default("any"),
  assignees: z.array(assigneeSchema).min(1, "Every step needs at least one approver.")
});
export const ruleInputSchema = z.object({
  name: z.string().trim().max(120).default(""),
  initiatorRoleIds: z.array(z.coerce.number().int().positive()).min(1, "Pick at least one role this rule applies to."),
  minAmount: z.coerce.number().nonnegative().nullable().default(null),
  steps: z.array(stepSchema).min(1, "A rule needs at least one approval step.")
});
export const moduleRulesSchema = z.object({ rules: z.array(ruleInputSchema) });

interface WorkflowRow {
  id: string;
  module: ApprovalModule;
  name: string;
  position: number;
  initiator_role_ids: string[];
  min_amount: string | null;
  steps: Step[];
  updated_at: Date;
}

function toRule(r: WorkflowRow): WorkflowRule & { position: number; updatedAt: string } {
  return {
    id: Number(r.id),
    module: r.module,
    name: r.name,
    position: r.position,
    initiatorRoleIds: r.initiator_role_ids.map(Number),
    minAmount: r.min_amount === null ? null : Number(r.min_amount),
    steps: r.steps,
    updatedAt: new Date(r.updated_at).toISOString()
  };
}

export async function listRules(db: Db, module?: ApprovalModule) {
  const { rows } = await db.query<WorkflowRow>(
    `SELECT * FROM approval_workflows ${module ? "WHERE module = $1" : ""} ORDER BY module, position, id`,
    module ? [module] : []
  );
  return rows.map(toRule);
}

/** Replaces a module's whole rule list (the builder saves one module card at a time).
 *  Validates that every referenced role/user exists, so a rule can't point at nothing. */
export async function replaceModuleRules(
  db: pg.Pool,
  module: ApprovalModule,
  rules: z.infer<typeof ruleInputSchema>[],
  actorId: number
): Promise<string | null> {
  const roleIds = new Set<number>();
  const userIds = new Set<number>();
  for (const r of rules) {
    r.initiatorRoleIds.forEach((id) => roleIds.add(id));
    for (const s of r.steps) for (const a of s.assignees) (a.type === "role" ? roleIds : userIds).add(a.id);
    if (r.minAmount !== null && !APPROVAL_MODULES[module].hasAmount) return `${APPROVAL_MODULES[module].label} entries have no amount, so a rule can't use an amount threshold.`;
  }
  if (roleIds.size) {
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM roles WHERE id = ANY($1)`, [[...roleIds]]);
    if (rows.length !== roleIds.size) return "A rule refers to a role that no longer exists. Refresh and try again.";
  }
  if (userIds.size) {
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1)`, [[...userIds]]);
    if (rows.length !== userIds.size) return "A rule refers to a user who no longer exists. Refresh and try again.";
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM approval_workflows WHERE module = $1`, [module]);
    for (const [position, r] of rules.entries()) {
      await client.query(
        `INSERT INTO approval_workflows (module, name, position, initiator_role_ids, min_amount, steps, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [module, r.name, position, r.initiatorRoleIds, r.minAmount, JSON.stringify(r.steps), actorId]
      );
    }
    await client.query("COMMIT");
    return null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function roleIdForName(db: Db, roleName: string): Promise<number | null> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM roles WHERE LOWER(name) = LOWER($1)`, [roleName]);
  return rows[0] ? Number(rows[0].id) : null;
}

/** The first rule (in the admin's order) for this module whose initiator roles include
 *  the maker's role and whose threshold, if any, the amount meets. null = no workflow
 *  applies: the entry is applied immediately, exactly as before approvals existed. */
export async function matchRule(db: Db, module: ApprovalModule, makerRole: string, amount: number | null) {
  const roleId = await roleIdForName(db, makerRole);
  if (roleId === null) return null;
  for (const rule of await listRules(db, module)) {
    if (!rule.initiatorRoleIds.includes(roleId)) continue;
    if (rule.minAmount !== null && (amount === null || amount < rule.minAmount)) continue;
    return rule;
  }
  return null;
}

export async function snapshotRule(db: Db, rule: WorkflowRule & { id?: number }): Promise<WorkflowSnapshot> {
  return { workflowId: rule.id ?? 0, name: rule.name, steps: await labelSteps(db, rule.steps) };
}

export async function labelSteps(db: Db, steps: Step[]): Promise<WorkflowSnapshot["steps"]> {
  const userIds = steps.flatMap((s) => s.assignees.filter((a) => a.type === "user").map((a) => a.id));
  const roleIds = steps.flatMap((s) => s.assignees.filter((a) => a.type === "role").map((a) => a.id));
  const users = new Map(
    (
      await db.query<{ id: string; display_name: string | null; username: string }>(
        `SELECT id, display_name, username FROM users WHERE id = ANY($1)`,
        [userIds]
      )
    ).rows.map((u) => [Number(u.id), u.display_name || u.username])
  );
  const roles = new Map(
    (await db.query<{ id: string; name: string }>(`SELECT id, name FROM roles WHERE id = ANY($1)`, [roleIds])).rows.map((r) => [
      Number(r.id),
      r.name
    ])
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
