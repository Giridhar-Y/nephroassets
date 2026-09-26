import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requirePermission, type AuthedUser } from "../auth/middleware.js";
import { fireSelfNudge } from "./assetsExportJobs.js";
import {
  advanceBulkApply,
  applySingle,
  ApprovalError,
  blockReason,
  centersInScope,
  decide,
  loadActions,
  loadRequest,
  moduleLabel,
  nextStepText,
  OPEN_STATUSES,
  reassign,
  withdraw,
  type ActionRow,
  type RequestRow
} from "../approvals/engine.js";
import { finalizeBulk, startBulkResubmit } from "../approvals/intercept.js";
import {
  APPROVAL_MODULE_KEYS,
  APPROVAL_MODULES,
  describeStep,
  isApprovalModule,
  listRules,
  matchRule,
  moduleRulesSchema,
  replaceModuleRules,
  roleIdForName,
  snapshotRule
} from "../approvals/workflows.js";

// Approval workflows HTTP API. Who may APPROVE is never a permission check here — it's
// whoever the request's frozen workflow step names (engine.ts's blockReason). The
// `approvals` permissions only cover administration: configuring workflows
// (manageWorkflows), seeing every request (viewAll) and reassigning a step (reassign).

function send(reply: FastifyReply, err: unknown) {
  if (err instanceof ApprovalError) {
    reply.code(err.status);
    return { error: err.message };
  }
  const status = (err as { status?: number }).status;
  if (status) {
    reply.code(status);
    return { error: (err as Error).message };
  }
  throw err;
}

async function agingDays(): Promise<number> {
  const { rows } = await (await getPool()).query<{ aging_days: number }>(`SELECT aging_days FROM approval_config WHERE id = TRUE`);
  return rows[0]?.aging_days ?? 3;
}

function ageDays(r: RequestRow): number {
  const since = OPEN_STATUSES.includes(r.status) ? (r.step_started_at ?? r.created_at) : r.created_at;
  return Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000);
}

async function userNames(ids: Array<string | number | null>): Promise<Map<number, string>> {
  const list = [...new Set(ids.filter((i): i is string | number => i !== null).map(Number))];
  if (list.length === 0) return new Map();
  const { rows } = await (await getPool()).query<{ id: string; display_name: string | null; username: string }>(
    `SELECT id, display_name, username FROM users WHERE id = ANY($1)`,
    [list]
  );
  return new Map(rows.map((u) => [Number(u.id), u.display_name || u.username]));
}

/** Everything a list row needs; `canAct` computed by the caller. */
function toListItem(r: RequestRow, names: Map<number, string>, aging: number, canAct: boolean) {
  const steps = r.workflow_snapshot?.steps ?? [];
  const age = ageDays(r);
  return {
    id: Number(r.id),
    module: r.module,
    moduleLabel: moduleLabel(r.module),
    kind: r.kind,
    summary: r.summary,
    farIds: r.far_ids.slice(0, 5),
    farIdCount: r.far_ids.length,
    centers: r.centers.slice(0, 5),
    amount: r.amount === null ? null : Number(r.amount),
    status: r.status,
    currentStep: r.current_step,
    stepsTotal: steps.length,
    currentStepLabel: OPEN_STATUSES.includes(r.status) ? nextStepText(r.workflow_snapshot, r.current_step) : null,
    makerId: Number(r.maker_id),
    makerName: names.get(Number(r.maker_id)) ?? "Unknown user",
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    ageDays: age,
    aging: OPEN_STATUSES.includes(r.status) && age >= aging,
    canAct
  };
}

async function actionsByRequest(ids: number[]): Promise<Map<number, ActionRow[]>> {
  const map = new Map<number, ActionRow[]>();
  if (ids.length === 0) return map;
  const { rows } = await (await getPool()).query<ActionRow>(
    `SELECT * FROM change_request_actions WHERE request_id = ANY($1) ORDER BY id`,
    [ids]
  );
  for (const a of rows) {
    const list = map.get(Number(a.request_id)) ?? [];
    list.push(a);
    map.set(Number(a.request_id), list);
  }
  return map;
}

async function canView(r: RequestRow, user: AuthedUser, actions: ActionRow[], roleId: number | null): Promise<boolean> {
  if (Number(r.maker_id) === user.id) return true;
  if (!centersInScope(r.centers, user.centerScope)) return false;
  if (user.permissions.has("approvals:viewAll")) return true;
  if (actions.some((a) => Number(a.actor_id) === user.id)) return true;
  return (r.workflow_snapshot?.steps ?? []).some((s) =>
    s.assignees.some((a) => (a.type === "user" ? a.id === user.id : roleId !== null && a.id === roleId))
  );
}

export default async function approvalsRoutes(app: FastifyInstance) {
  app.get("/api/approvals/modules", async () =>
    APPROVAL_MODULE_KEYS.map((key) => ({ key, label: APPROVAL_MODULES[key].label, hasAmount: APPROVAL_MODULES[key].hasAmount }))
  );

  // --- Configuration ------------------------------------------------------------------

  app.get("/api/approvals/workflows", { preHandler: requirePermission("approvals", "manageWorkflows") }, async () => {
    const db = await getPool();
    const [rules, config] = await Promise.all([listRules(db), db.query<{ aging_days: number }>(`SELECT aging_days FROM approval_config WHERE id = TRUE`)]);
    return { rules, agingDays: config.rows[0]?.aging_days ?? 3 };
  });

  app.put("/api/approvals/workflows/:module", { preHandler: requirePermission("approvals", "manageWorkflows") }, async (req, reply) => {
    const { module } = req.params as { module: string };
    if (!isApprovalModule(module)) {
      reply.code(404);
      return { error: "Unknown module." };
    }
    const parsed = moduleRulesSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? "Invalid workflow.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    const error = await replaceModuleRules(db, module, parsed.data.rules, req.user!.id);
    if (error) {
      reply.code(400);
      return { error };
    }
    return { rules: await listRules(db, module) };
  });

  app.put("/api/approvals/config", { preHandler: requirePermission("approvals", "manageWorkflows") }, async (req, reply) => {
    const parsed = z.object({ agingDays: z.coerce.number().int().min(1).max(365) }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Flag requests after 1 to 365 days." };
    }
    await (await getPool()).query(`UPDATE approval_config SET aging_days = $1 WHERE id = TRUE`, [parsed.data.agingDays]);
    return { agingDays: parsed.data.agingDays };
  });

  /** Users and roles for the assignee pickers (builder and reassignment). */
  app.get("/api/approvals/directory", async (req, reply) => {
    const user = req.user!;
    if (!user.permissions.has("approvals:manageWorkflows") && !user.permissions.has("approvals:reassign")) {
      reply.code(403);
      return { error: "You don't have access to this." };
    }
    const db = await getPool();
    const [users, roles] = await Promise.all([
      db.query<{ id: string; display_name: string | null; username: string; role: string; status: string }>(
        `SELECT id, display_name, username, role, status FROM users ORDER BY COALESCE(display_name, username)`
      ),
      db.query<{ id: string; name: string; active: boolean }>(`SELECT id, name, active FROM roles ORDER BY name`)
    ]);
    return {
      users: users.rows.map((u) => ({ id: Number(u.id), name: u.display_name || u.username, username: u.username, role: u.role, active: u.status === "active" })),
      roles: roles.rows.map((r) => ({ id: Number(r.id), name: r.name, active: r.active }))
    };
  });

  /** Would an entry by me in this module need approval, and who reviews it first? Drives
   *  the "Submit for approval" button label on forms. */
  app.get("/api/approvals/preview", async (req, reply) => {
    const parsed = z.object({ module: z.string(), amount: z.coerce.number().optional() }).safeParse(req.query);
    if (!parsed.success || !isApprovalModule(parsed.data.module)) {
      reply.code(400);
      return { error: "Unknown module." };
    }
    const db = await getPool();
    const rule = await matchRule(db, parsed.data.module, req.user!.role, parsed.data.amount ?? null);
    if (!rule) return { applies: false };
    const snapshot = await snapshotRule(db, rule);
    return { applies: true, nextReviewers: describeStep(snapshot.steps[0]!), steps: snapshot.steps.map(describeStep) };
  });

  // --- Tasks --------------------------------------------------------------------------

  async function listFor(user: AuthedUser, tab: "mine" | "requests" | "all") {
    const db = await getPool();
    const roleId = await roleIdForName(db, user.role);
    let rows: RequestRow[];
    if (tab === "mine") {
      rows = (await db.query<RequestRow>(`SELECT * FROM change_requests WHERE status = ANY($1) ORDER BY step_started_at, id`, [OPEN_STATUSES])).rows;
    } else if (tab === "requests") {
      rows = (await db.query<RequestRow>(`SELECT * FROM change_requests WHERE maker_id = $1 AND status <> 'draft' ORDER BY updated_at DESC LIMIT 500`, [user.id])).rows;
    } else {
      rows = (await db.query<RequestRow>(`SELECT * FROM change_requests WHERE status <> 'draft' ORDER BY updated_at DESC LIMIT 1000`)).rows.filter((r) =>
        centersInScope(r.centers, user.centerScope)
      );
    }
    // ponytail: filtered in JS — fine for hundreds of open requests; move the step/role
    // matching into SQL if the open queue ever reaches the tens of thousands.
    const actions = await actionsByRequest(rows.map((r) => Number(r.id)));
    const withAct = rows.map((r) => {
      const cycleActions = (actions.get(Number(r.id)) ?? []).filter((a) => a.cycle === r.cycle);
      return { r, canAct: blockReason(r, cycleActions, user, roleId) === null };
    });
    return tab === "mine" ? withAct.filter((x) => x.canAct) : withAct;
  }

  app.get("/api/approvals/tasks", async (req, reply) => {
    const parsed = z
      .object({
        tab: z.enum(["mine", "requests", "all"]).default("mine"),
        module: z.string().optional(),
        center: z.string().optional(),
        status: z.string().optional(),
        aging: z.enum(["true", "false"]).optional()
      })
      .safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid filters." };
    }
    const { tab, module, center, status, aging } = parsed.data;
    if (tab === "all" && !req.user!.permissions.has("approvals:viewAll")) {
      reply.code(403);
      return { error: "You don't have access to all requests." };
    }
    const agingThreshold = await agingDays();
    const list = await listFor(req.user!, tab);
    const names = await userNames(list.map((x) => x.r.maker_id));
    const items = list
      .map(({ r, canAct }) => toListItem(r, names, agingThreshold, canAct))
      .filter((i) => (!module || i.module === module) && (!status || i.status === status) && (aging !== "true" || i.aging))
      .filter((i) => !center || list.find((x) => Number(x.r.id) === i.id)!.r.centers.includes(center));
    return { items, agingDays: agingThreshold };
  });

  app.get("/api/approvals/tasks/count", async (req) => {
    const list = await listFor(req.user!, "mine");
    const agingThreshold = await agingDays();
    return { awaiting: list.length, aging: list.filter((x) => ageDays(x.r) >= agingThreshold).length };
  });

  /** Open requests touching an asset or module — the "Awaiting approval" strip on module
   *  logs and asset history. Center-scoped like everything else. */
  app.get("/api/approvals/open", async (req) => {
    const q = req.query as { module?: string; farId?: string };
    const db = await getPool();
    const params: unknown[] = [["pending", "in_review", "applying", "rejected", "needs_attention"]];
    let where = "status = ANY($1)";
    if (q.module) {
      params.push(q.module.split(","));
      where += ` AND module = ANY($${params.length})`;
    }
    if (q.farId) {
      params.push([q.farId]);
      where += ` AND far_ids && $${params.length}`;
    }
    const { rows } = await db.query<RequestRow>(`SELECT * FROM change_requests WHERE ${where} ORDER BY created_at DESC LIMIT 50`, params);
    const visible = rows.filter((r) => centersInScope(r.centers, req.user!.centerScope));
    const names = await userNames(visible.map((r) => r.maker_id));
    const agingThreshold = await agingDays();
    return { items: visible.map((r) => toListItem(r, names, agingThreshold, false)) };
  });

  // --- One request --------------------------------------------------------------------

  async function detail(req: FastifyRequest, reply: FastifyReply, id: number, advance = true) {
    const db = await getPool();
    let request = await loadRequest(db, id);
    const user = req.user!;
    const roleId = await roleIdForName(db, user.role);
    let actions = request ? await loadActions(db, id) : [];
    if (!request || !(await canView(request, user, actions, roleId))) {
      reply.code(404);
      return { error: "No request found with that id." };
    }
    // Viewing a file that's being applied also moves its job along (one time-limited
    // slice), then hands the next slice to a fresh request, same as the export job.
    if (advance && request.kind === "bulk" && request.status === "applying") {
      const more = await advanceBulkApply(db, id);
      request = (await loadRequest(db, id))!;
      actions = await loadActions(db, id);
      if (more || request.status === "applying") fireSelfNudge(req, `/api/approvals/requests/${id}`);
    }
    const names = await userNames([request.maker_id, ...actions.map((a) => a.actor_id)]);
    const agingThreshold = await agingDays();
    const cycleActions = actions.filter((a) => a.cycle === request!.cycle);
    const reason = blockReason(request, cycleActions, user, roleId);
    const steps = (request.workflow_snapshot?.steps ?? []).map((s, i) => ({
      rule: s.rule,
      label: describeStep(s),
      assignees: s.assignees,
      state:
        request!.status === "applied" || request!.status === "applying" || i < request!.current_step
          ? "done"
          : i === request!.current_step && OPEN_STATUSES.includes(request!.status)
            ? "current"
            : i === request!.current_step && request!.status === "rejected"
              ? "rejected"
              : "upcoming",
      approvals: cycleActions
        .filter((a) => a.action === "approve" && a.step === i)
        .map((a) => ({ by: names.get(Number(a.actor_id)) ?? "Unknown user", at: new Date(a.created_at).toISOString() }))
    }));
    let bulk = null;
    if (request.kind === "bulk") {
      const { rows: totals } = await db.query<{ rows: string; amount: string | null; updates: string }>(
        `SELECT COUNT(*) AS rows, SUM(amount) AS amount, COUNT(*) FILTER (WHERE before IS NOT NULL AND before <> 'null'::jsonb) AS updates
         FROM change_request_rows WHERE request_id = $1`,
        [id]
      );
      const { rows: byCenter } = await db.query<{ center: string | null; rows: string; amount: string | null }>(
        `SELECT center, COUNT(*) AS rows, SUM(amount) AS amount FROM change_request_rows WHERE request_id = $1
         GROUP BY center ORDER BY COUNT(*) DESC LIMIT 50`,
        [id]
      );
      const t = totals[0]!;
      bulk = {
        rows: Number(t.rows),
        amount: t.amount === null ? null : Number(t.amount),
        updates: Number(t.updates),
        creates: Number(t.rows) - Number(t.updates),
        byCenter: byCenter.map((c) => ({ center: c.center ?? "—", rows: Number(c.rows), amount: c.amount === null ? null : Number(c.amount) })),
        progress: request.apply_progress
      };
    }
    return {
      ...toListItem(request, names, agingThreshold, reason === null),
      blockReason: reason,
      farIds: request.far_ids.slice(0, 50),
      centers: request.centers,
      payload: request.kind === "single" ? request.payload : { filename: request.payload.filename },
      before: request.before,
      lastError: request.last_error,
      cycle: request.cycle,
      appliedAt: request.applied_at ? new Date(request.applied_at).toISOString() : null,
      steps,
      timeline: actions.map((a) => ({
        id: Number(a.id),
        action: a.action,
        cycle: a.cycle,
        step: a.step,
        by: a.actor_id === null ? "System" : (names.get(Number(a.actor_id)) ?? "Unknown user"),
        comment: a.comment,
        details: a.details,
        at: new Date(a.created_at).toISOString()
      })),
      permissions: {
        canWithdraw: Number(request.maker_id) === user.id && ["pending", "in_review", "rejected", "needs_attention"].includes(request.status),
        canResubmit: Number(request.maker_id) === user.id && ["rejected", "needs_attention"].includes(request.status),
        canReassign: user.permissions.has("approvals:reassign") && OPEN_STATUSES.includes(request.status)
      },
      bulk
    };
  }

  const idParam = (req: FastifyRequest) => Number((req.params as { id: string }).id);

  app.get("/api/approvals/requests/:id", async (req, reply) => detail(req, reply, idParam(req)));

  app.get("/api/approvals/requests/:id/rows", async (req, reply) => {
    const id = idParam(req);
    const q = z
      .object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(10).max(200).default(50), q: z.string().default("") })
      .parse(req.query);
    const db = await getPool();
    const request = await loadRequest(db, id);
    const roleId = await roleIdForName(db, req.user!.role);
    if (!request || request.kind !== "bulk" || !(await canView(request, req.user!, await loadActions(db, id), roleId))) {
      reply.code(404);
      return { error: "No file found with that id." };
    }
    const params: unknown[] = [id];
    let where = "request_id = $1";
    if (q.q.trim()) {
      params.push(`%${q.q.trim()}%`);
      where += ` AND (far_id ILIKE $2 OR center ILIKE $2 OR data::text ILIKE $2)`;
    }
    const [{ rows: count }, { rows }] = await Promise.all([
      db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM change_request_rows WHERE ${where}`, params),
      db.query<{ row_no: number; far_id: string | null; center: string | null; amount: string | null; data: Record<string, unknown>; before: Record<string, unknown> | null }>(
        `SELECT row_no, far_id, center, amount, data, before FROM change_request_rows WHERE ${where} ORDER BY row_no
         LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
        params
      )
    ]);
    return {
      total: Number(count[0]!.n),
      page: q.page,
      pageSize: q.pageSize,
      rows: rows.map((r) => ({ row: r.row_no, farId: r.far_id, center: r.center, amount: r.amount === null ? null : Number(r.amount), data: r.data, before: r.before }))
    };
  });

  const decisionSchema = z.object({ step: z.coerce.number().int().min(0), cycle: z.coerce.number().int().min(1), comment: z.string().max(2000).optional() });

  for (const decision of ["approve", "reject"] as const) {
    app.post(`/api/approvals/requests/:id/${decision}`, async (req, reply) => {
      const parsed = decisionSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "Invalid request." };
      }
      const id = idParam(req);
      const db = await getPool();
      try {
        const { request, readyToApply } = await decide(db, id, req.user!, { decision, ...parsed.data });
        if (readyToApply && request.kind === "single") await applySingle(db, id);
        if (readyToApply && request.kind === "bulk") fireSelfNudge(req, `/api/approvals/requests/${id}`);
        // Not advancing a bulk job inline here: the approver gets an answer straight
        // away, and the nudge (or their next status poll) runs the first slice.
        return detail(req, reply, id, false);
      } catch (err) {
        return send(reply, err);
      }
    });
  }

  app.post("/api/approvals/requests/:id/withdraw", async (req, reply) => {
    try {
      await withdraw(await getPool(), idParam(req), req.user!);
      return detail(req, reply, idParam(req));
    } catch (err) {
      return send(reply, err);
    }
  });

  app.post("/api/approvals/requests/:id/reassign", { preHandler: requirePermission("approvals", "reassign") }, async (req, reply) => {
    const parsed = z
      .object({ assignees: z.array(z.object({ type: z.enum(["user", "role"]), id: z.coerce.number().int().positive() })).min(1), rule: z.enum(["any", "all"]).optional() })
      .safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Pick at least one approver." };
    }
    try {
      await reassign(await getPool(), idParam(req), req.user!, parsed.data.assignees, parsed.data.rule);
      return detail(req, reply, idParam(req));
    } catch (err) {
      return send(reply, err);
    }
  });

  app.post("/api/approvals/bulk/finalize", async (req, reply) => {
    const parsed = z.object({ batchToken: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid request." };
    }
    try {
      const result = await finalizeBulk(await getPool(), req.user!, parsed.data.batchToken);
      if (result.status === "applying") fireSelfNudge(req, `/api/approvals/requests/${result.requestId}`);
      return result;
    } catch (err) {
      return send(reply, err);
    }
  });

  app.post("/api/approvals/requests/:id/bulk-resubmit", async (req, reply) => {
    try {
      return { batchToken: await startBulkResubmit(await getPool(), idParam(req), req.user!.id) };
    } catch (err) {
      return send(reply, err);
    }
  });

  // --- Notifications ------------------------------------------------------------------

  app.get("/api/notifications", async (req) => {
    const db = await getPool();
    const { rows } = await db.query<{ id: string; kind: string; message: string; link: string | null; read_at: Date | null; created_at: Date }>(
      `SELECT id, kind, message, link, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user!.id]
    );
    return {
      items: rows.map((n) => ({ id: Number(n.id), kind: n.kind, message: n.message, link: n.link, read: n.read_at !== null, createdAt: new Date(n.created_at).toISOString() })),
      unread: rows.filter((n) => n.read_at === null).length
    };
  });

  app.post("/api/notifications/read", async (req) => {
    const ids = (req.body as { ids?: number[] } | null)?.ids;
    const db = await getPool();
    await db.query(
      `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL ${ids?.length ? "AND id = ANY($2)" : ""}`,
      ids?.length ? [req.user!.id, ids] : [req.user!.id]
    );
    return { ok: true };
  });

  app.post("/api/notifications/clear", async (req) => {
    await (await getPool()).query(`DELETE FROM notifications WHERE user_id = $1`, [req.user!.id]);
    return { ok: true };
  });
}
