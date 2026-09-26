import { createHmac, timingSafeEqual } from "node:crypto";
import { applyingRequest } from "../routes/assetActivityLog.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { signSession, SESSION_COOKIE_NAME } from "../auth/session.js";
import type { AuthedUser } from "../auth/middleware.js";
import { getPool } from "../db/pool.js";
import { APPROVAL_MODULES, describeStep, labelSteps, roleIdForName, type ApprovalModule, type Assignee, type WorkflowSnapshot } from "./workflows.js";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;

export type RequestStatus = "draft" | "pending" | "in_review" | "applying" | "applied" | "rejected" | "needs_attention" | "withdrawn";
export const OPEN_STATUSES: RequestStatus[] = ["pending", "in_review"];

export interface RequestRow {
  id: string;
  module: ApprovalModule;
  kind: "single" | "bulk";
  summary: string;
  far_ids: string[];
  centers: string[];
  amount: string | null;
  payload: { method?: string; url?: string; body?: unknown; path?: string; filename?: string };
  before: unknown;
  status: RequestStatus;
  workflow_snapshot: WorkflowSnapshot | null;
  current_step: number;
  cycle: number;
  step_started_at: Date | null;
  maker_id: string;
  batch_token: string | null;
  apply_progress: BulkProgress | null;
  apply_lease_until: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  applied_at: Date | null;
}

export interface ActionRow {
  id: string;
  request_id: string;
  cycle: number;
  step: number | null;
  actor_id: string | null;
  action: string;
  comment: string | null;
  details: { roleId?: number | null; from?: unknown; to?: unknown; [k: string]: unknown } | null;
  created_at: Date;
}

export interface BulkProgress {
  phase: "validating" | "applying" | "done";
  chunksDone: number;
  chunksTotal: number;
  rowsDone: number;
  rowsTotal: number;
  errors: Array<{ row: number; message: string }>;
}

export class ApprovalError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

type Actor = Pick<AuthedUser, "id" | "role" | "centerScope" | "permissions">;

// ---------------------------------------------------------------------------------------
// The app instance, so a final approval can replay the original request through its own
// route (validation, center checks, writes, activity logging — all unchanged). Set once
// in app.ts.
let appRef: FastifyInstance | null = null;
export function setApprovalsApp(app: FastifyInstance): void {
  appRef = app;
}

// A replay carries this header so the route knows to apply instead of re-submitting for
// approval. HMAC over (request id, cycle) with the session secret: unforgeable from
// outside, and only honoured while the request row is actually in 'applying'.
function applySignature(requestId: number, cycle: number): string {
  return createHmac("sha256", process.env.JWT_SECRET ?? "").update(`approval-apply:${requestId}:${cycle}`).digest("hex");
}
export function applyHeaderValue(requestId: number, cycle: number): string {
  return `${requestId}.${cycle}.${applySignature(requestId, cycle)}`;
}
export function parseApplyHeader(value: unknown): { requestId: number; cycle: number } | null {
  if (typeof value !== "string") return null;
  const [id, cycle, sig] = value.split(".");
  const requestId = Number(id);
  const c = Number(cycle);
  if (!Number.isInteger(requestId) || !Number.isInteger(c) || !sig) return null;
  const expected = Buffer.from(applySignature(requestId, c));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { requestId, cycle: c };
}

async function replayAsMaker(
  request: RequestRow,
  opts: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }
) {
  if (!appRef) throw new Error("Approvals app reference not set.");
  const db = await getPool();
  const { rows } = await db.query<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [request.maker_id]);
  const token = signSession({ sub: Number(request.maker_id), username: rows[0]?.username ?? "" });
  return appRef.inject({
    method: opts.method as "POST",
    url: opts.url,
    // A JSON body (object) for single entries, a multipart Buffer for bulk chunks.
    payload: opts.payload as Buffer | Record<string, unknown> | undefined,
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      "x-approval-apply": applyHeaderValue(Number(request.id), request.cycle),
      ...opts.headers
    }
  });
}

/** Global preHandler: inside an approved replay (signed header), tag the rest of that
 *  request's async work with its change request id, so the activity-log rows it writes
 *  link back to the request and its approvers. Set here rather than around inject()
 *  because Fastify parses the body from stream events outside the caller's context.
 *  The signature alone is enough for a tag; routes still fully verify the header. */
export async function approvalApplyContextHook(req: FastifyRequest): Promise<void> {
  const parsed = parseApplyHeader(req.headers["x-approval-apply"]);
  if (parsed) applyingRequest.enterWith(parsed.requestId);
}

// ---------------------------------------------------------------------------------------
// Who can act

export function centersInScope(centers: string[], scope: Set<string> | null): boolean {
  return scope === null || centers.every((c) => scope.has(c));
}

function matchesAssignee(a: Assignee, actor: Actor, actorRoleId: number | null): boolean {
  return a.type === "user" ? a.id === actor.id : actorRoleId !== null && a.id === actorRoleId;
}

/** Why `actor` can't approve/reject the current step, or null if they can. Separation of
 *  duties: never the maker, and never someone who already approved a DIFFERENT step of
 *  this request in the current cycle. */
export function blockReason(request: RequestRow, cycleActions: ActionRow[], actor: Actor, actorRoleId: number | null): string | null {
  if (!OPEN_STATUSES.includes(request.status)) return "This request isn't waiting for approval.";
  if (Number(request.maker_id) === actor.id) return "You can't approve your own request.";
  if (!centersInScope(request.centers, actor.centerScope)) return "This request involves a center outside your access.";
  const step = request.workflow_snapshot?.steps[request.current_step];
  if (!step || !step.assignees.some((a) => matchesAssignee(a, actor, actorRoleId))) return "You're not an approver for this step.";
  const approvals = cycleActions.filter((a) => a.action === "approve" && Number(a.actor_id) === actor.id);
  if (approvals.some((a) => a.step !== request.current_step)) return "You already approved an earlier step of this request.";
  if (approvals.some((a) => a.step === request.current_step)) return "You've already approved this step.";
  return null;
}

/** "any": one approval completes the step. "all": every listed assignee must be covered —
 *  a user entry by that user's approval, a role entry by an approval from someone who
 *  held that role when they approved. */
export function stepComplete(step: WorkflowSnapshot["steps"][number], stepApprovals: ActionRow[]): boolean {
  if (stepApprovals.length === 0) return false;
  if (step.rule === "any") return true;
  return step.assignees.every((a) =>
    stepApprovals.some((ap) => (a.type === "user" ? Number(ap.actor_id) === a.id : ap.details?.roleId === a.id))
  );
}

// ---------------------------------------------------------------------------------------
// Loading

export async function loadRequest(db: Db, id: number, forUpdate = false): Promise<RequestRow | null> {
  const { rows } = await db.query<RequestRow>(`SELECT * FROM change_requests WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [id]);
  return rows[0] ?? null;
}

export async function loadActions(db: Db, id: number): Promise<ActionRow[]> {
  const { rows } = await db.query<ActionRow>(`SELECT * FROM change_request_actions WHERE request_id = $1 ORDER BY id`, [id]);
  return rows;
}

export async function recordAction(
  db: Db,
  request: Pick<RequestRow, "id" | "cycle">,
  action: string,
  actorId: number | null,
  opts: { step?: number | null; comment?: string | null; details?: unknown } = {}
): Promise<void> {
  await db.query(
    `INSERT INTO change_request_actions (request_id, cycle, step, actor_id, action, comment, details) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [request.id, request.cycle, opts.step ?? null, actorId, action, opts.comment ?? null, opts.details ? JSON.stringify(opts.details) : null]
  );
}

// ---------------------------------------------------------------------------------------
// Notifications

/** Active users who can act on this step: named users plus everyone holding a named
 *  role, limited to those whose center access covers the request. */
export async function stepRecipients(db: Db, step: WorkflowSnapshot["steps"][number] | undefined, centers: string[], excludeUserId?: number): Promise<number[]> {
  if (!step) return [];
  const userIds = step.assignees.filter((a) => a.type === "user").map((a) => a.id);
  const roleIds = step.assignees.filter((a) => a.type === "role").map((a) => a.id);
  const { rows } = await db.query<{ id: string }>(
    `SELECT u.id FROM users u
     WHERE u.status = 'active'
       AND (u.id = ANY($1) OR LOWER(u.role) IN (SELECT LOWER(name) FROM roles WHERE id = ANY($2)))
       AND (NOT EXISTS (SELECT 1 FROM user_center_access a WHERE a.user_id = u.id)
            OR NOT EXISTS (
              SELECT 1 FROM unnest($3::text[]) c(code)
              WHERE c.code NOT IN (SELECT ce.code FROM user_center_access a JOIN centers ce ON ce.id = a.center_id WHERE a.user_id = u.id)))`,
    [userIds, roleIds, centers]
  );
  return rows.map((r) => Number(r.id)).filter((id) => id !== excludeUserId);
}

export async function notify(db: Db, userIds: number[], kind: string, message: string, requestId: number): Promise<void> {
  for (const userId of new Set(userIds)) {
    await db.query(`INSERT INTO notifications (user_id, kind, message, link, request_id) VALUES ($1, $2, $3, $4, $5)`, [
      userId,
      kind,
      message,
      `#/tasks?request=${requestId}`,
      requestId
    ]);
  }
}

export function nextStepText(snapshot: WorkflowSnapshot | null, stepIndex: number): string {
  const step = snapshot?.steps[stepIndex];
  return step ? describeStep(step) : "the next approver";
}

// ---------------------------------------------------------------------------------------
// Decisions

/** Approve or reject the current step. Runs under a row lock on the request, and the
 *  caller must name the step/cycle it was looking at: if two approvers act at once, the
 *  second finds the step already moved on and gets a 409 instead of a double transition.
 *  Returns whether the request now needs applying (final approval). */
export async function decide(
  db: pg.Pool,
  requestId: number,
  actor: Actor,
  input: { decision: "approve" | "reject"; step: number; cycle: number; comment?: string | null }
): Promise<{ request: RequestRow; readyToApply: boolean }> {
  const comment = input.comment?.trim() || null;
  if (input.decision === "reject" && !comment) throw new ApprovalError("Please say why you're rejecting this, so the submitter can fix it.", 400);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const request = await loadRequest(client, requestId, true);
    if (!request) throw new ApprovalError("No request found with that id.", 404);
    if (request.cycle !== input.cycle || request.current_step !== input.step || !OPEN_STATUSES.includes(request.status)) {
      throw new ApprovalError("Someone else has already acted on this step. The latest status is shown now.", 409);
    }
    const actorRoleId = await roleIdForName(client, actor.role);
    const cycleActions = (await loadActions(client, requestId)).filter((a) => a.cycle === request.cycle);
    const reason = blockReason(request, cycleActions, actor, actorRoleId);
    if (reason) throw new ApprovalError(reason, 403);
    const snapshot = request.workflow_snapshot!;

    if (input.decision === "reject") {
      await recordAction(client, request, "reject", actor.id, { step: request.current_step, comment });
      await client.query(`UPDATE change_requests SET status = 'rejected', updated_at = now() WHERE id = $1`, [requestId]);
      await notify(client, [Number(request.maker_id)], "rejected", `Returned for changes: ${request.summary}. "${comment}"`, requestId);
      await client.query("COMMIT");
      return { request: (await loadRequest(db, requestId))!, readyToApply: false };
    }

    await recordAction(client, request, "approve", actor.id, { step: request.current_step, comment, details: { roleId: actorRoleId } });
    const stepApprovals = [...cycleActions, { action: "approve", actor_id: String(actor.id), step: request.current_step, details: { roleId: actorRoleId } } as ActionRow].filter(
      (a) => a.action === "approve" && a.step === request.current_step
    );
    const step = snapshot.steps[request.current_step]!;
    let readyToApply = false;
    if (stepComplete(step, stepApprovals)) {
      if (request.current_step + 1 >= snapshot.steps.length) {
        readyToApply = true;
        await client.query(
          `UPDATE change_requests SET status = 'applying', updated_at = now(), apply_progress = CASE WHEN kind = 'bulk' THEN $2::jsonb ELSE NULL END WHERE id = $1`,
          [requestId, JSON.stringify(await initialBulkProgress(client, requestId))]
        );
      } else {
        const next = request.current_step + 1;
        await client.query(
          `UPDATE change_requests SET status = 'in_review', current_step = $2, step_started_at = now(), updated_at = now() WHERE id = $1`,
          [requestId, next]
        );
        await notify(
          client,
          await stepRecipients(client, snapshot.steps[next], request.centers, Number(request.maker_id)),
          "task",
          `Waiting for your approval: ${request.summary}`,
          requestId
        );
      }
    } else {
      await client.query(`UPDATE change_requests SET updated_at = now() WHERE id = $1`, [requestId]);
    }
    await client.query("COMMIT");
    return { request: (await loadRequest(db, requestId))!, readyToApply };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function initialBulkProgress(db: Db, requestId: number): Promise<BulkProgress> {
  const { rows } = await db.query<{ chunks: string; rows: string }>(
    `SELECT (SELECT COUNT(*) FROM change_request_chunks WHERE request_id = $1) AS chunks,
            (SELECT COUNT(*) FROM change_request_rows WHERE request_id = $1) AS rows`,
    [requestId]
  );
  return { phase: "validating", chunksDone: 0, chunksTotal: Number(rows[0]!.chunks), rowsDone: 0, rowsTotal: Number(rows[0]!.rows), errors: [] };
}

/** Final approval of a single entry: replay the original request as the maker. If the
 *  route refuses it now (the data changed since submission — e.g. the asset was disposed
 *  meanwhile), nothing is written and the request goes to Needs attention with the
 *  route's own error message. */
export async function applySingle(db: pg.Pool, requestId: number): Promise<RequestRow> {
  const request = await loadRequest(db, requestId);
  if (!request || request.status !== "applying" || request.kind !== "single") return request!;
  const { method, url, body } = request.payload;
  let ok = false;
  let error = "";
  try {
    const res = await replayAsMaker(request, { method: method!, url: url!, payload: body ?? undefined });
    ok = res.statusCode < 300;
    if (!ok) error = (res.json() as { error?: string }).error ?? `The change could not be applied (${res.statusCode}).`;
  } catch (err) {
    error = err instanceof Error ? err.message : "The change could not be applied.";
  }
  await finishApply(db, request, ok, error);
  return (await loadRequest(db, requestId))!;
}

async function finishApply(db: pg.Pool, request: RequestRow, ok: boolean, error: string, details?: unknown): Promise<void> {
  if (ok) {
    await db.query(`UPDATE change_requests SET status = 'applied', applied_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`, [request.id]);
    await recordAction(db, request, "apply", null, { details });
    await notify(db, [Number(request.maker_id)], "applied", `Approved and applied: ${request.summary}`, Number(request.id));
  } else {
    await db.query(`UPDATE change_requests SET status = 'needs_attention', last_error = $2, updated_at = now() WHERE id = $1`, [request.id, error]);
    await recordAction(db, request, "apply_failed", null, { comment: error, details });
    await notify(db, [Number(request.maker_id)], "needs_attention", `Approved, but couldn't be applied: ${request.summary}. ${error}`, Number(request.id));
  }
}

// ---------------------------------------------------------------------------------------
// Bulk apply: a background job, advanced in time-limited slices (the same pattern as the
// Register background export) so a 200,000-row file never has to fit in one 60s request.
//
// Phase 1 dry-runs every stored chunk through its route's own preview mode. If ANY row
// would fail now, nothing is applied and the request goes to Needs attention — so a file
// is never half-applied because some rows turned invalid after approval. Phase 2 applies
// chunk by chunk, recording each chunk as applied. A slice that dies mid-chunk simply
// replays that chunk next time: every bulk route is idempotent on replay (capitalization
// upserts; a disposal of an already-disposed asset, a transfer to the current location
// and a duplicate master are refused per row), so nothing is applied twice.

const BULK_SLICE_BUDGET_MS = 40_000;

function multipartFile(filename: string, content: Buffer): { payload: Buffer; contentType: string } {
  const boundary = `----nephroassets${Date.now().toString(16)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

interface ChunkRow {
  chunk_no: number;
  filename: string;
  content: Buffer;
  row_offset: number;
  row_count: number;
  validated_at: Date | null;
  applied_at: Date | null;
}

/** Advances a bulk request's apply job by at most one slice. Safe to call concurrently
 *  from several places (the approver's polling, a self-nudge): a short lease makes sure
 *  only one slice runs at a time. Returns true if more work remains. */
export async function advanceBulkApply(db: pg.Pool, requestId: number, budgetMs = BULK_SLICE_BUDGET_MS): Promise<boolean> {
  const { rows: leased } = await db.query<RequestRow>(
    `UPDATE change_requests SET apply_lease_until = now() + interval '75 seconds'
     WHERE id = $1 AND kind = 'bulk' AND status = 'applying' AND (apply_lease_until IS NULL OR apply_lease_until < now())
     RETURNING *`,
    [requestId]
  );
  const request = leased[0];
  if (!request) return false;
  const started = Date.now();
  let slicedChunks = 0;
  const progress: BulkProgress = request.apply_progress ?? (await initialBulkProgress(db, requestId));
  const path = request.payload.path!;
  try {
    const { rows: chunks } = await db.query<ChunkRow>(`SELECT * FROM change_request_chunks WHERE request_id = $1 ORDER BY chunk_no`, [requestId]);

    if (progress.phase === "validating") {
      for (const chunk of chunks) {
        if (chunk.validated_at) continue;
        // At least one chunk per slice, so even a tiny budget always makes progress.
        if (slicedChunks > 0 && Date.now() - started > budgetMs) return await saveProgress(db, requestId, progress, true);
        slicedChunks += 1;
        const { payload, contentType } = multipartFile(chunk.filename, chunk.content);
        const res = await replayAsMaker(request, { method: "POST", url: `${path}?preview=true`, payload, headers: { "content-type": contentType } });
        if (res.statusCode >= 300) {
          progress.errors.push({ row: chunk.row_offset + 1, message: (res.json() as { error?: string }).error ?? `Rows ${chunk.row_offset + 1}+ could not be checked.` });
        } else {
          const body = res.json() as { rows?: Array<{ row: number; status: string; message?: string }> };
          for (const r of body.rows ?? []) if (r.status === "error") progress.errors.push({ row: r.row + chunk.row_offset, message: r.message ?? "Invalid row." });
        }
        await db.query(`UPDATE change_request_chunks SET validated_at = now() WHERE request_id = $1 AND chunk_no = $2`, [requestId, chunk.chunk_no]);
        progress.chunksDone += 1;
        progress.rowsDone += chunk.row_count;
        await saveProgress(db, requestId, progress, true); // so the approver's progress bar moves
      }
      if (progress.errors.length > 0) {
        await saveProgress(db, requestId, { ...progress, phase: "done", errors: progress.errors.slice(0, 500) }, false);
        await finishApply(
          db,
          request,
          false,
          `${progress.errors.length.toLocaleString("en-IN")} row(s) no longer pass validation, so nothing was applied. Fix them and resubmit.`,
          { errors: progress.errors.slice(0, 500) }
        );
        return false;
      }
      progress.phase = "applying";
      progress.chunksDone = 0;
      progress.rowsDone = 0;
    }

    if (progress.phase === "applying") {
      for (const chunk of chunks) {
        if (chunk.applied_at) continue;
        // At least one chunk per slice, so even a tiny budget always makes progress.
        if (slicedChunks > 0 && Date.now() - started > budgetMs) return await saveProgress(db, requestId, progress, true);
        slicedChunks += 1;
        const { payload, contentType } = multipartFile(chunk.filename, chunk.content);
        const res = await replayAsMaker(request, { method: "POST", url: path, payload, headers: { "content-type": contentType } });
        const body = res.json() as { error?: string; errors?: Array<{ row: number; message: string }> };
        if (res.statusCode >= 300) {
          // The whole chunk was refused (e.g. the maker lost access). Stop here — later
          // chunks would fail the same way — and let a person look at it.
          await saveProgress(db, requestId, { ...progress, phase: "done" }, false);
          await finishApply(db, request, false, body.error ?? `Rows ${chunk.row_offset + 1}+ could not be applied.`);
          return false;
        }
        for (const e of body.errors ?? []) progress.errors.push({ row: e.row + chunk.row_offset, message: e.message });
        await db.query(`UPDATE change_request_chunks SET applied_at = now(), result = $3 WHERE request_id = $1 AND chunk_no = $2`, [
          requestId,
          chunk.chunk_no,
          JSON.stringify(body)
        ]);
        progress.chunksDone += 1;
        progress.rowsDone += chunk.row_count;
        await saveProgress(db, requestId, progress, true);
      }
      await saveProgress(db, requestId, { ...progress, phase: "done", errors: progress.errors.slice(0, 500) }, false);
      // Rows refused only at this stage changed in the seconds between the dry run and
      // their chunk — rare; the rest of the file is applied and the maker is told which.
      const failed = progress.errors.length;
      await finishApply(
        db,
        request,
        failed === 0,
        `${failed.toLocaleString("en-IN")} row(s) changed during apply and were skipped; everything else was applied.`,
        { rowsApplied: progress.rowsTotal - failed, errors: progress.errors.slice(0, 500) }
      );
    }
    return false;
  } finally {
    await db.query(`UPDATE change_requests SET apply_lease_until = NULL WHERE id = $1`, [requestId]);
  }
}

async function saveProgress(db: Db, requestId: number, progress: BulkProgress, more: boolean): Promise<boolean> {
  await db.query(`UPDATE change_requests SET apply_progress = $2, updated_at = now() WHERE id = $1`, [requestId, JSON.stringify(progress)]);
  return more;
}

// ---------------------------------------------------------------------------------------
// Maker / admin actions

export async function withdraw(db: pg.Pool, requestId: number, actor: Actor): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const request = await loadRequest(client, requestId, true);
    if (!request) throw new ApprovalError("No request found with that id.", 404);
    if (Number(request.maker_id) !== actor.id) throw new ApprovalError("Only the person who submitted this can withdraw it.", 403);
    if (!["draft", "pending", "in_review", "rejected", "needs_attention"].includes(request.status)) {
      throw new ApprovalError("This request can't be withdrawn any more.", 409);
    }
    await client.query(`UPDATE change_requests SET status = 'withdrawn', updated_at = now() WHERE id = $1`, [requestId]);
    await recordAction(client, request, "withdraw", actor.id, { step: request.current_step });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Admin replaces the assignees of the current step (an approver on leave, or
 *  deactivated). Edits only this request's snapshot, logs who changed what, and tells the
 *  new assignees. */
export async function reassign(db: pg.Pool, requestId: number, actor: Actor, assignees: Assignee[], rule?: "any" | "all"): Promise<void> {
  if (assignees.length === 0) throw new ApprovalError("Pick at least one approver.", 400);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const request = await loadRequest(client, requestId, true);
    if (!request) throw new ApprovalError("No request found with that id.", 404);
    if (!OPEN_STATUSES.includes(request.status) || !request.workflow_snapshot) throw new ApprovalError("Only a request waiting for approval can be reassigned.", 409);
    const snapshot = request.workflow_snapshot;
    const current = snapshot.steps[request.current_step]!;
    const [labelled] = await labelSteps(client, [{ rule: rule ?? current.rule, assignees }]);
    const nextSnapshot: WorkflowSnapshot = { ...snapshot, steps: snapshot.steps.map((s, i) => (i === request.current_step ? labelled! : s)) };
    await client.query(`UPDATE change_requests SET workflow_snapshot = $2, updated_at = now() WHERE id = $1`, [requestId, JSON.stringify(nextSnapshot)]);
    await recordAction(client, request, "reassign", actor.id, {
      step: request.current_step,
      details: { from: current, to: labelled }
    });
    await notify(
      client,
      await stepRecipients(client, labelled, request.centers, Number(request.maker_id)),
      "task",
      `Reassigned to you for approval: ${request.summary}`,
      requestId
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function moduleLabel(module: ApprovalModule): string {
  return APPROVAL_MODULES[module].label;
}
