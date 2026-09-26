import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { getPool } from "../db/pool.js";
import {
  loadActions,
  loadRequest,
  nextStepText,
  notify,
  parseApplyHeader,
  recordAction,
  stepRecipients,
  type RequestRow
} from "./engine.js";
import { APPROVAL_MODULES, matchRule, snapshotRule, type ApprovalModule } from "./workflows.js";

// Called by each write route AFTER its own validation and just before it would write.
// Returns null when the route should go ahead and write (no workflow applies to this
// maker, or this is the approved replay of a request), or a response object when the
// entry has been captured as a change request instead (the route returns it as-is).

export interface SubmitSpec {
  module: ApprovalModule;
  summary: string;
  farIds?: string[];
  centers?: string[];
  amount?: number | null;
  /** What the entry changes, as it stands now — for the approver's before/after view. */
  before?: unknown;
}

const OPEN_FOR_CONFLICT = ["draft", "pending", "in_review", "applying", "rejected", "needs_attention"];

/** The approved replay: only honoured with a valid signature, for this module, while the
 *  request is actually being applied. Anything else carrying the header is refused. */
async function verifyApplyHeader(req: FastifyRequest, module: ApprovalModule): Promise<"none" | "valid" | "invalid"> {
  const raw = req.headers["x-approval-apply"];
  if (raw === undefined) return "none";
  const parsed = parseApplyHeader(raw);
  if (!parsed) return "invalid";
  const request = await loadRequest(await getPool(), parsed.requestId);
  const ok =
    request &&
    request.status === "applying" &&
    request.module === module &&
    request.cycle === parsed.cycle &&
    Number(request.maker_id) === req.user!.id;
  return ok ? "valid" : "invalid";
}

function pendingResponse(reply: FastifyReply, request: Pick<RequestRow, "id" | "workflow_snapshot">, resubmitted: boolean) {
  const reviewer = nextStepText(request.workflow_snapshot, 0);
  reply.code(202);
  return {
    pendingApproval: {
      requestId: Number(request.id),
      nextReviewers: reviewer,
      message: `${resubmitted ? "Resubmitted and sent" : "Sent"} to ${reviewer} for approval.`
    }
  };
}

export async function submitIfWorkflow(req: FastifyRequest, reply: FastifyReply, spec: SubmitSpec): Promise<Record<string, unknown> | null> {
  const apply = await verifyApplyHeader(req, spec.module);
  if (apply === "valid") return null;
  if (apply === "invalid") {
    reply.code(403);
    return { error: "This approval replay is not valid." };
  }
  const db = await getPool();
  const user = req.user!;
  const payload = { method: req.method, url: req.url, body: req.body ?? null };
  const farIds = spec.farIds ?? [];
  const centers = [...new Set((spec.centers ?? []).filter(Boolean))];

  const resubmitId = Number(req.headers["x-approval-resubmit"]);
  if (resubmitId) return resubmit(db, reply, resubmitId, user.id, spec, payload, farIds, centers);

  const rule = await matchRule(db, spec.module, user.role, spec.amount ?? null);
  if (!rule) return null;

  // One open request per asset: two pending changes to the same asset (a disposal and
  // an edit, say) would each have been reviewed against a state the other is about to
  // change. Also reserves a pending capitalization's FAR ID.
  if (farIds.length > 0) {
    const { rows } = await db.query<{ id: string; far_ids: string[] }>(
      `SELECT id, far_ids FROM change_requests WHERE status = ANY($1) AND far_ids && $2 LIMIT 1`,
      [OPEN_FOR_CONFLICT, farIds]
    );
    if (rows[0]) {
      const clash = rows[0].far_ids.find((f) => farIds.includes(f));
      reply.code(409);
      return { error: `${clash} already has a request waiting for approval (#${rows[0].id}). Finish or withdraw that one first.` };
    }
  }

  const snapshot = await snapshotRule(db, rule);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<RequestRow>(
      `INSERT INTO change_requests (module, kind, summary, far_ids, centers, amount, payload, before, status, workflow_snapshot, step_started_at, maker_id)
       VALUES ($1, 'single', $2, $3, $4, $5, $6, $7, 'pending', $8, now(), $9) RETURNING *`,
      [spec.module, spec.summary, farIds, centers, spec.amount ?? null, JSON.stringify(payload), JSON.stringify(spec.before ?? null), JSON.stringify(snapshot), user.id]
    );
    const request = rows[0]!;
    await recordAction(client, request, "submit", user.id, { step: 0 });
    await notify(client, await stepRecipients(client, snapshot.steps[0], centers, user.id), "task", `Waiting for your approval: ${spec.summary}`, Number(request.id));
    await client.query("COMMIT");
    return pendingResponse(reply, request, false);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The maker's corrected entry, re-sent through the same route (so it's validated again)
 *  with x-approval-resubmit: <id>. Same request and history; restarts at step 1 of the
 *  workflow it was originally submitted under. */
async function resubmit(
  db: pg.Pool,
  reply: FastifyReply,
  requestId: number,
  userId: number,
  spec: SubmitSpec,
  payload: unknown,
  farIds: string[],
  centers: string[]
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const request = await loadRequest(client, requestId, true);
    if (!request || Number(request.maker_id) !== userId) {
      reply.code(404);
      await client.query("ROLLBACK");
      return { error: "No request of yours found to resubmit." };
    }
    if (request.module !== spec.module || request.kind !== "single" || !["rejected", "needs_attention"].includes(request.status)) {
      reply.code(409);
      await client.query("ROLLBACK");
      return { error: "Only a returned request can be resubmitted." };
    }
    const next = { ...request, cycle: request.cycle + 1 };
    await client.query(
      `UPDATE change_requests SET summary = $2, far_ids = $3, centers = $4, amount = $5, payload = $6, before = $7,
         status = 'pending', current_step = 0, cycle = cycle + 1, step_started_at = now(), last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [requestId, spec.summary, farIds, centers, spec.amount ?? null, JSON.stringify(payload), JSON.stringify(spec.before ?? null)]
    );
    await recordAction(client, next, "resubmit", userId, { step: 0 });
    await notify(client, await stepRecipients(client, request.workflow_snapshot?.steps[0], centers, userId), "task", `Resubmitted for your approval: ${spec.summary}`, requestId);
    await client.query("COMMIT");
    return pendingResponse(reply, request, true);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------------------
// Bulk files. The client already sends a large file as sequential chunk uploads; each
// chunk carries x-bulk-batch (one token per file) and x-bulk-row-offset. When a workflow
// could apply to the maker, each validated chunk is stored (bytes + rows) under one draft
// request instead of being written, and POST /api/approvals/bulk/finalize submits the
// whole file. The threshold is matched at finalize, against the WHOLE file's amount.

export interface BulkRowSpec {
  row: number;
  farId?: string | null;
  center?: string | null;
  amount?: number | null;
  data: Record<string, unknown>;
}

async function roleHasAnyRule(db: pg.Pool, module: ApprovalModule, role: string): Promise<boolean> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM approval_workflows w JOIN roles r ON r.id = ANY(w.initiator_role_ids)
     WHERE w.module = $1 AND LOWER(r.name) = LOWER($2)`,
    [module, role]
  );
  return Number(rows[0]!.n) > 0;
}

export async function captureBulkChunkIfWorkflow(
  req: FastifyRequest,
  reply: FastifyReply,
  spec: { module: ApprovalModule; path: string; filename: string; content: Buffer; rows: BulkRowSpec[]; totalRows: number; errors: unknown[] }
): Promise<Record<string, unknown> | null> {
  const apply = await verifyApplyHeader(req, spec.module);
  if (apply === "valid") return null;
  if (apply === "invalid") {
    reply.code(403);
    return { error: "This approval replay is not valid." };
  }
  const db = await getPool();
  const user = req.user!;
  const headerToken = typeof req.headers["x-bulk-batch"] === "string" ? req.headers["x-bulk-batch"] : null;

  // A resubmission (or a later chunk of this file) already has its draft.
  let draft = headerToken
    ? (
        await db.query<RequestRow>(`SELECT * FROM change_requests WHERE maker_id = $1 AND batch_token = $2 AND status = 'draft'`, [user.id, headerToken])
      ).rows[0]
    : undefined;
  if (!draft) {
    if (!(await roleHasAnyRule(db, spec.module, user.role))) return null;
    const { rows } = await db.query<RequestRow>(
      `INSERT INTO change_requests (module, kind, summary, payload, status, maker_id, batch_token)
       VALUES ($1, 'bulk', $2, $3, 'draft', $4, $5) RETURNING *`,
      [spec.module, `${APPROVAL_MODULES[spec.module].label}: ${spec.filename}`, JSON.stringify({ path: spec.path, filename: spec.filename }), user.id, headerToken ?? randomUUID()]
    );
    draft = rows[0]!;
  }

  const rowOffset = Number(req.headers["x-bulk-row-offset"] ?? 0) || 0;
  const farIds = spec.rows.map((r) => r.farId).filter((f): f is string => !!f);
  const before = new Map(
    farIds.length
      ? (
          await db.query<{ far_id: string; snapshot: unknown }>(
            `SELECT far_id, jsonb_build_object(
               'location', COALESCE(revised_location, location), 'status', status, 'subClassification', sub_classification,
               'assetDescription', asset_description, 'c1OpeningCost', c1_opening_cost, 'c2OpeningCost', c2_opening_cost,
               'usefulLifeC1Years', useful_life_c1_years, 'dateOfDisposal', date_of_disposal, 'parentFarId', parent_far_id) AS snapshot
             FROM assets WHERE far_id = ANY($1) AND deleted_at IS NULL`,
            [farIds]
          )
        ).rows.map((r) => [r.far_id, r.snapshot])
      : []
  );
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: n } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(chunk_no) + 1, 0) AS next FROM change_request_chunks WHERE request_id = $1`,
      [draft.id]
    );
    const chunkNo = n[0]!.next;
    await client.query(
      `INSERT INTO change_request_chunks (request_id, chunk_no, filename, content, row_offset, row_count) VALUES ($1, $2, $3, $4, $5, $6)`,
      [draft.id, chunkNo, spec.filename, spec.content, rowOffset, spec.rows.length]
    );
    for (let i = 0; i < spec.rows.length; i += 500) {
      const slice = spec.rows.slice(i, i + 500);
      const values: unknown[] = [];
      const tuples = slice.map((r, j) => {
        const snap = (r.farId ? before.get(r.farId) : undefined) as { location?: string; c1OpeningCost?: number; c2OpeningCost?: number } | undefined;
        // Rows that act on an existing asset (disposals, transfers, merges) take their
        // center — and, for amount-based modules, their amount (the gross being disposed)
        // — from the asset itself when the route didn't supply one.
        const center = r.center ?? snap?.location ?? null;
        const amount =
          r.amount ?? (APPROVAL_MODULES[spec.module].hasAmount && snap ? Number(snap.c1OpeningCost ?? 0) + Number(snap.c2OpeningCost ?? 0) : null);
        values.push(draft!.id, r.row + rowOffset, chunkNo, r.farId ?? null, center, amount, JSON.stringify(r.data), JSON.stringify(snap ?? null));
        const b = j * 8;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
      });
      await client.query(
        `INSERT INTO change_request_rows (request_id, row_no, chunk_no, far_id, center, amount, data, before) VALUES ${tuples.join(", ")}
         ON CONFLICT (request_id, row_no) DO NOTHING`,
        values
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const result = { approvalDraft: { requestId: Number(draft.id), batchToken: draft.batch_token }, totalRows: spec.totalRows, processed: 0, added: 0, updated: 0, captured: spec.rows.length, errors: spec.errors };
  // No batch header (a single small upload from an older client): submit right away.
  if (!headerToken) return { ...result, ...(await finalizeBulk(db, user, draft.batch_token!)) };
  return result;
}

export interface BulkFinalizeResult {
  requestId: number;
  status: "pending" | "applying" | "empty";
  message: string;
}

/** Submits a captured file for approval — or, if no rule matches once the WHOLE file's
 *  amount is known (e.g. every rule for the maker's role has a higher threshold), hands
 *  it straight to the apply job with no approval, exactly as an unmatched entry is
 *  applied directly. A resubmitted file keeps its original workflow and restarts at
 *  step 1. */
export async function finalizeBulk(db: pg.Pool, user: { id: number; role: string }, batchToken: string): Promise<BulkFinalizeResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<RequestRow>(
      `SELECT * FROM change_requests WHERE maker_id = $1 AND batch_token = $2 AND status = 'draft' FOR UPDATE`,
      [user.id, batchToken]
    );
    const draft = rows[0];
    if (!draft) throw Object.assign(new Error("No uploaded file is waiting to be submitted."), { status: 404 });
    const { rows: t } = await client.query<{ rows: string; amount: string | null; centers: string[]; far_ids: string[] }>(
      `SELECT COUNT(*) AS rows, SUM(amount) AS amount,
              (SELECT COALESCE(array_agg(DISTINCT c) FILTER (WHERE c IS NOT NULL), '{}') FROM (
                 SELECT center AS c FROM change_request_rows WHERE request_id = $1
                 UNION SELECT before->>'location' FROM change_request_rows WHERE request_id = $1) x) AS centers,
              COALESCE(array_agg(DISTINCT far_id) FILTER (WHERE far_id IS NOT NULL), '{}') AS far_ids
       FROM change_request_rows WHERE request_id = $1`,
      [draft.id]
    );
    const totals = t[0]!;
    const rowCount = Number(totals.rows);
    if (rowCount === 0) {
      await client.query(`UPDATE change_requests SET status = 'withdrawn', updated_at = now() WHERE id = $1`, [draft.id]);
      await client.query("COMMIT");
      return { requestId: Number(draft.id), status: "empty", message: "No valid rows to submit." };
    }
    const amount = totals.amount === null ? null : Number(totals.amount);
    const summary = `${APPROVAL_MODULES[draft.module].label}: ${rowCount.toLocaleString("en-IN")} row${rowCount === 1 ? "" : "s"} from ${draft.payload.filename}`;
    const resubmitted = (await loadActions(client, Number(draft.id))).length > 0;
    let snapshot = draft.workflow_snapshot;
    if (!resubmitted) {
      const rule = await matchRule(client, draft.module, (await client.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [user.id])).rows[0]!.role, amount);
      snapshot = rule ? await snapshotRule(client, rule) : null;
    }
    // A capture's centers/FAR IDs can be large; kept for scoping (approvers need access
    // to every center the file touches) and the asset-history "pending" strip.
    const common = [draft.id, summary, totals.far_ids, totals.centers, amount];
    if (!snapshot) {
      await client.query(
        `UPDATE change_requests SET summary = $2, far_ids = $3, centers = $4, amount = $5, status = 'applying', updated_at = now() WHERE id = $1`,
        common
      );
      await client.query("COMMIT");
      return { requestId: Number(draft.id), status: "applying", message: "No approval needed for this file. Applying it now." };
    }
    await client.query(
      `UPDATE change_requests SET summary = $2, far_ids = $3, centers = $4, amount = $5, status = 'pending', workflow_snapshot = $6,
         current_step = 0, cycle = cycle + $7, step_started_at = now(), last_error = NULL, apply_progress = NULL, updated_at = now()
       WHERE id = $1`,
      [...common, JSON.stringify(snapshot), resubmitted ? 1 : 0]
    );
    const fresh = (await loadRequest(client, Number(draft.id)))!;
    await recordAction(client, fresh, resubmitted ? "resubmit" : "submit", user.id, { step: 0 });
    await notify(client, await stepRecipients(client, snapshot.steps[0], totals.centers, user.id), "task", `Waiting for your approval: ${summary}`, Number(draft.id));
    await client.query("COMMIT");
    const reviewer = nextStepText(snapshot, 0);
    return { requestId: Number(draft.id), status: "pending", message: `${resubmitted ? "Resubmitted and sent" : "Sent"} to ${reviewer} for approval.` };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Starts a corrected upload for a returned bulk request: clears the stored file and
 *  hands back a batch token for the new chunks. History is kept. */
export async function startBulkResubmit(db: pg.Pool, requestId: number, userId: number): Promise<string> {
  const request = await loadRequest(db, requestId);
  if (!request || Number(request.maker_id) !== userId || request.kind !== "bulk") throw Object.assign(new Error("No bulk request of yours found."), { status: 404 });
  if (!["rejected", "needs_attention"].includes(request.status)) throw Object.assign(new Error("Only a returned file can be re-uploaded."), { status: 409 });
  const token = randomUUID();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM change_request_chunks WHERE request_id = $1`, [requestId]);
    await client.query(`DELETE FROM change_request_rows WHERE request_id = $1`, [requestId]);
    await client.query(`UPDATE change_requests SET status = 'draft', batch_token = $2, apply_progress = NULL, updated_at = now() WHERE id = $1`, [requestId, token]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return token;
}
