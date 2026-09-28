import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import ExcelJS from "exceljs";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "../routes/assets.js";
import transfersRoutes from "../routes/transfers.js";
import bulkUploadRoutes from "../routes/bulkUpload.js";
import mastersRoutes from "../routes/masters.js";
import approvalsRoutes from "../routes/approvals.js";
import activityLogRoutes from "../routes/activityLog.js";
import { getPool } from "../db/pool.js";
import { authedInject, authHeaderFor, createTestUser } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";
import { csvPayload } from "../routes/bulkTestHelpers.js";
import { advanceBulkApply, approvalApplyContextHook, setApprovalsApp } from "./engine.js";
import { convertLegacyRules, matchWorkflow, migrateLegacyRules, type LegacyRule } from "./workflows.js";

// Approval workflows end to end, through the real routes: a maker's entry is captured as a
// change request instead of written; approvers act step by step; the final approval
// replays the original request through its own route as the maker.

const ASSET = {
  farId: "APR-1",
  subClassification: "Test-Sub",
  assetDescription: "Approval Test Asset",
  status: "Active",
  dateAcquired: "2026-01-01",
  location: "Center-Test",
  usefulLifeC1Years: 5,
  usefulLifeC2Years: 5,
  c1OpeningCost: 10000,
  c2OpeningCost: 10000
};

type User = { id: number; username: string };
let app: FastifyInstance;
let editor: User, fm1: User, fm2: User, cfo: User, fmScoped: User;
let roleId: Record<string, number>;

const as = (u: User, opts: InjectOptions) => app.inject({ ...opts, headers: { cookie: authHeaderFor(u.id, u.username), ...opts.headers } });

/** Replaces a module's assignments: one workflow + one assignment per rule. */
let flowSeq = 0;
async function setRules(module: string, rules: Array<{ name?: string; initiatorRoleIds: Array<number | undefined>; minAmount?: number | null; steps: unknown[] }>) {
  await (await getPool()).query(`DELETE FROM approval_assignments WHERE $1 = ANY(modules)`, [module]);
  for (const r of rules) {
    const flow = await authedInject(app, { method: "POST", url: "/api/approvals/workflows", payload: { name: `${r.name ?? "Rule"} ${++flowSeq}`, steps: r.steps } });
    expect(flow.statusCode, flow.body).toBe(200);
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/approvals/assignments",
      payload: { modules: [module], roleIds: r.initiatorRoleIds, minAmount: r.minAmount ?? null, workflowId: flow.json().id }
    });
    expect(res.statusCode, res.body).toBe(200);
  }
}
const step = (rule: "any" | "all", ...assignees: Array<["user" | "role", number]>) => ({ rule, assignees: assignees.map(([type, id]) => ({ type, id })) });
async function detail(id: number, u: User = fm1) {
  return (await as(u, { method: "GET", url: `/api/approvals/requests/${id}` })).json();
}
async function decideAs(u: User, id: number, decision: "approve" | "reject", comment?: string) {
  const d = await detail(id, u);
  return as(u, { method: "POST", url: `/api/approvals/requests/${id}/${decision}`, payload: { step: d.currentStep, cycle: d.cycle, comment } });
}
async function assetExists(farId: string) {
  const { rows } = await (await getPool()).query(`SELECT 1 FROM assets WHERE far_id = $1 AND deleted_at IS NULL`, [farId]);
  return rows.length === 1;
}

beforeAll(async () => {
  app = Fastify();
  app.decorateRequest("user", null);
  app.addHook("preHandler", authGateHook);
  app.addHook("preHandler", approvalApplyContextHook);
  await app.register(cookie);
  await app.register(multipart);
  await app.register(assetsRoutes);
  await app.register(transfersRoutes);
  await app.register(bulkUploadRoutes);
  await app.register(mastersRoutes);
  await app.register(approvalsRoutes);
  await app.register(activityLogRoutes);
  await app.ready();
  setApprovalsApp(app);

  const db = await getPool();
  await authedInject(app, { method: "GET", url: "/api/approvals/modules" }); // seeds built-in roles + the shared admin
  await db.query(`INSERT INTO roles (name) VALUES ('Finance Manager'), ('CFO') ON CONFLICT (LOWER(name)) DO NOTHING`);
  await db.query(`DELETE FROM user_center_access WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'apr-%')`);
  await db.query(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'apr-%')`);
  await db.query(`DELETE FROM change_request_actions WHERE actor_id IN (SELECT id FROM users WHERE username LIKE 'apr-%')`);
  await db.query(`DELETE FROM change_requests`);
  await db.query(`DELETE FROM users WHERE username LIKE 'apr-%'`);
  await db.query(`INSERT INTO centers (code) VALUES ('Center-Test'), ('Center-Other') ON CONFLICT DO NOTHING`);
  editor = await createTestUser({ username: "apr-editor", role: "editor" });
  fm1 = await createTestUser({ username: "apr-fm1", role: "Finance Manager" });
  fm2 = await createTestUser({ username: "apr-fm2", role: "Finance Manager" });
  cfo = await createTestUser({ username: "apr-cfo", role: "CFO" });
  fmScoped = await createTestUser({ username: "apr-fm-scoped", role: "Finance Manager", centerAccess: ["Center-Other"] });
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM roles`);
  roleId = Object.fromEntries(rows.map((r) => [r.name.toLowerCase(), Number(r.id)]));
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  const db = await getPool();
  await db.query(`DELETE FROM change_requests`);
  await db.query(`DELETE FROM approval_assignments`);
  await db.query(`DELETE FROM approval_flows`);
  await db.query(`DELETE FROM approval_workflows`);
  await db.query(`DELETE FROM notifications`);
  await db.query(`DELETE FROM asset_activity_log`);
  await db.query(`DELETE FROM transfers`);
  await db.query(`DELETE FROM assets`);
  await db.query(`DELETE FROM sub_classifications`);
  await db.query(`DELETE FROM statuses`);
  await db.query(`UPDATE centers SET active = TRUE`);
  await db.query(`DELETE FROM centers WHERE code NOT IN ('Center-Test', 'Center-Other')`);
  await db.query(`INSERT INTO sub_classifications (name) VALUES ('Test-Sub')`);
  await db.query(`INSERT INTO statuses (name, system_managed) VALUES ('Active', FALSE), ('Disposed', TRUE)`);
  await db.query(
    `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, '2026-08-17', '2026-04-01', '2027-03-31', 365)
     ON CONFLICT (id) DO UPDATE SET as_at = '2026-08-17', fy_start = '2026-04-01', fy_end = '2027-03-31', days_in_fy = 365`
  );
});

/** Editor → Finance Manager (any one) → CFO. */
async function twoStepCapitalization() {
  await setRules("capitalization", [{ name: "Editors", initiatorRoleIds: [roleId.editor], steps: [step("any", ["role", roleId["finance manager"]!]), step("any", ["user", cfo.id])] }]);
}
async function submitAsset(payload = ASSET) {
  const res = await as(editor, { method: "POST", url: "/api/assets", payload });
  expect(res.statusCode, res.body).toBe(202);
  return res.json().pendingApproval as { requestId: number; message: string; nextReviewers: string };
}

describe("state machine", () => {
  it("captures instead of writing, walks the steps, and applies on the final approval", async () => {
    await twoStepCapitalization();
    const pending = await submitAsset();
    expect(pending.message).toBe("Sent to Finance Manager for approval.");
    expect(await assetExists("APR-1")).toBe(false); // pending data never touches the asset tables

    expect((await detail(pending.requestId)).status).toBe("pending");
    expect((await decideAs(fm1, pending.requestId, "approve", "Matches the PO")).statusCode).toBe(200);
    let d = await detail(pending.requestId, cfo);
    expect(d.status).toBe("in_review");
    expect(d.currentStep).toBe(1);
    expect(await assetExists("APR-1")).toBe(false);

    expect((await decideAs(cfo, pending.requestId, "approve")).statusCode).toBe(200);
    d = await detail(pending.requestId, cfo);
    expect(d.status).toBe("applied");
    expect(await assetExists("APR-1")).toBe(true);
    expect(d.timeline.map((t: { action: string }) => t.action)).toEqual(["submit", "approve", "approve", "apply"]);

    // The applied row is logged as the maker's capitalization, like any other.
    const { rows } = await (await getPool()).query(`SELECT actor_user_id FROM asset_activity_log WHERE far_id = 'APR-1' AND action = 'capitalization_create'`);
    expect(Number(rows[0].actor_user_id)).toBe(editor.id);
    // ...and linked to its approvers: every step, who, when, and the comment.
    const log = (await authedInject(app, { method: "GET", url: "/api/audit-log/activity?search=APR-1" })).json();
    const entry = log.items.find((i: { farId: string; action: string }) => i.farId === "APR-1" && i.action === "capitalization_create");
    expect(entry.actorUsername).toBe(editor.username);
    expect(entry.approval.requestId).toBe(pending.requestId);
    expect(entry.approval.approvals).toMatchObject([
      { step: 1, by: fm1.username, comment: "Matches the PO" },
      { step: 2, by: cfo.username, comment: null }
    ]);
    expect(entry.details.approvedBy).toMatch(/^Step 1: .*\("Matches the PO"\); Step 2: /);
    // ...and in the export's Events sheet: submitter, every approver, and the request.
    const xlsx = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export?farId=APR-1" });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(xlsx.rawPayload as any);
    const eventsSheet = book.getWorksheet("Events")!;
    const eventRow = eventsSheet.getRow(6);
    expect(eventRow.getCell(9).value).toBe(editor.username); // Submitted By
    expect(String(eventRow.getCell(10).value)).toMatch(/^Step 1: .*\("Matches the PO"\); Step 2: /); // Approved By
    const request = eventRow.getCell(11).value as { text: string; hyperlink: string };
    expect(request.text).toBe(`#${pending.requestId}`);
    expect(request.hyperlink).toContain(`request=${pending.requestId}`);
    // Notifications: CFO got a task, the maker got "applied".
    const notes = (await as(editor, { method: "GET", url: "/api/notifications" })).json();
    expect(notes.items[0].message).toMatch(/^Approved and applied/);
  });

  it("reject needs a comment; the maker resubmits the same request, which restarts at step 1 with history kept", async () => {
    await twoStepCapitalization();
    const { requestId } = await submitAsset();
    await decideAs(fm1, requestId, "approve");
    expect((await decideAs(cfo, requestId, "reject")).statusCode).toBe(400);
    expect((await decideAs(cfo, requestId, "reject", "Wrong cost centre")).statusCode).toBe(200);
    expect((await detail(requestId, editor)).status).toBe("rejected");

    const res = await as(editor, {
      method: "POST",
      url: "/api/assets",
      payload: { ...ASSET, assetDescription: "Corrected description" },
      headers: { "x-approval-resubmit": String(requestId) }
    });
    expect(res.statusCode, res.body).toBe(202);
    const d = await detail(requestId, editor);
    expect(d.status).toBe("pending");
    expect(d.currentStep).toBe(0);
    expect(d.cycle).toBe(2);
    expect(d.payload.body.assetDescription).toBe("Corrected description");
    expect(d.timeline.map((t: { action: string }) => t.action)).toEqual(["submit", "approve", "reject", "resubmit"]);
    // fm1 approved step 1 in cycle 1; in cycle 2 they may approve step 1 again.
    expect((await decideAs(fm1, requestId, "approve")).statusCode).toBe(200);
  });

  it("the maker can withdraw; nothing is applied", async () => {
    await twoStepCapitalization();
    const { requestId } = await submitAsset();
    expect((await as(editor, { method: "POST", url: `/api/approvals/requests/${requestId}/withdraw` })).statusCode).toBe(200);
    expect((await detail(requestId, editor)).status).toBe("withdrawn");
    expect(await assetExists("APR-1")).toBe(false);
  });
});

describe("completion rules", () => {
  it("'all': every listed assignee must approve before the step completes", async () => {
    await setRules("capitalization", [{ initiatorRoleIds: [roleId.editor], steps: [step("all", ["user", fm1.id], ["user", fm2.id])] }]);
    const { requestId } = await submitAsset();
    await decideAs(fm1, requestId, "approve");
    expect((await detail(requestId)).status).toBe("pending");
    expect(await assetExists("APR-1")).toBe(false);
    expect((await decideAs(fm1, requestId, "approve")).statusCode).toBe(403); // can't approve twice
    await decideAs(fm2, requestId, "approve");
    expect((await detail(requestId)).status).toBe("applied");
  });

  it("'any': one approval completes the step", async () => {
    await setRules("capitalization", [{ initiatorRoleIds: [roleId.editor], steps: [step("any", ["user", fm1.id], ["user", fm2.id])] }]);
    const { requestId } = await submitAsset();
    await decideAs(fm2, requestId, "approve");
    expect((await detail(requestId, fm2)).status).toBe("applied");
  });
});

describe("separation of duties", () => {
  it("the maker can't approve their own request, even when their role is an assignee", async () => {
    await setRules("capitalization", [{ initiatorRoleIds: [roleId.editor], steps: [step("any", ["role", roleId.editor!])] }]);
    const { requestId } = await submitAsset();
    const res = await decideAs(editor, requestId, "approve");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/your own request/);
  });

  it("nobody approves more than one step of the same request", async () => {
    await setRules("capitalization", [
      { initiatorRoleIds: [roleId.editor], steps: [step("any", ["role", roleId["finance manager"]!]), step("any", ["role", roleId["finance manager"]!])] }
    ]);
    const { requestId } = await submitAsset();
    await decideAs(fm1, requestId, "approve");
    const res = await decideAs(fm1, requestId, "approve");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/earlier step/);
    expect((await decideAs(fm2, requestId, "approve")).statusCode).toBe(200);
    expect((await detail(requestId, fm2)).status).toBe("applied");
  });

  it("approvers only see and act on requests for centers they can access", async () => {
    await setRules("capitalization", [{ initiatorRoleIds: [roleId.editor], steps: [step("any", ["role", roleId["finance manager"]!])] }]);
    const { requestId } = await submitAsset(); // Center-Test
    expect((await as(fmScoped, { method: "GET", url: "/api/approvals/tasks?tab=mine" })).json().items).toHaveLength(0);
    expect((await as(fm1, { method: "GET", url: "/api/approvals/tasks?tab=mine" })).json().items.map((i: { id: number }) => i.id)).toEqual([requestId]);
    expect((await as(fmScoped, { method: "GET", url: `/api/approvals/requests/${requestId}` })).statusCode).toBe(404);
  });
});

describe("initiator-role rule matching", () => {
  it("no rule for the maker's role → applied immediately, exactly as before", async () => {
    await setRules("capitalization", [{ initiatorRoleIds: [roleId["finance manager"]!], steps: [step("any", ["user", cfo.id])] }]);
    const res = await as(editor, { method: "POST", url: "/api/assets", payload: ASSET });
    expect(res.statusCode).toBe(200);
    expect(await assetExists("APR-1")).toBe(true);
  });

  it("the amount threshold wins over the plain role rule when the entry meets it", async () => {
    await setRules("capitalization", [
      { name: "Large", initiatorRoleIds: [roleId.editor], minAmount: 100000, steps: [step("any", ["user", fm1.id]), step("any", ["user", cfo.id])] },
      { name: "Standard", initiatorRoleIds: [roleId.editor], steps: [step("any", ["user", fm1.id])] }
    ]);
    const small = await submitAsset(); // 20,000
    expect((await detail(small.requestId)).stepsTotal).toBe(1);
    const big = await submitAsset({ ...ASSET, farId: "APR-BIG", c1OpeningCost: 150000 });
    expect((await detail(big.requestId)).stepsTotal).toBe(2);

    const preview = (await as(editor, { method: "GET", url: "/api/approvals/preview?module=capitalization&amount=500000" })).json();
    expect(preview).toMatchObject({ applies: true, steps: [expect.stringMatching(/apr-fm1/), expect.stringMatching(/apr-cfo/)] });
  });
});

describe("workflow snapshot at submission", () => {
  it("editing the workflow later doesn't change a request already in flight", async () => {
    await twoStepCapitalization();
    const { requestId } = await submitAsset();
    await setRules("capitalization", [{ initiatorRoleIds: [roleId.editor], steps: [step("any", ["user", cfo.id])] }]);
    const d = await detail(requestId);
    expect(d.stepsTotal).toBe(2);
    expect(d.steps[0].label).toBe("Finance Manager");
    expect((await decideAs(fm1, requestId, "approve")).statusCode).toBe(200); // still the old step 1
  });
});

describe("concurrency", () => {
  it("two approvers acting on the same step at once: exactly one transition wins", async () => {
    await setRules("capitalization", [
      { initiatorRoleIds: [roleId.editor], steps: [step("any", ["role", roleId["finance manager"]!]), step("any", ["user", cfo.id])] }
    ]);
    const { requestId } = await submitAsset();
    const d = await detail(requestId);
    const body = { step: d.currentStep, cycle: d.cycle };
    const results = await Promise.all([
      as(fm1, { method: "POST", url: `/api/approvals/requests/${requestId}/approve`, payload: body }),
      as(fm2, { method: "POST", url: `/api/approvals/requests/${requestId}/approve`, payload: body })
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const after = await detail(requestId, cfo);
    expect(after.currentStep).toBe(1);
    expect(after.timeline.filter((t: { action: string }) => t.action === "approve")).toHaveLength(1);
  });
});

describe("re-validation at apply", () => {
  it("if the data changed since submission, nothing is written and the request needs attention", async () => {
    await setRules("capitalization", [{ initiatorRoleIds: [roleId.editor], steps: [step("any", ["user", fm1.id])] }]);
    const { requestId } = await submitAsset();
    // Meanwhile an admin (no workflow for admins) capitalizes the same FAR ID directly.
    expect((await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...ASSET, assetDescription: "Direct" } })).statusCode).toBe(200);
    await decideAs(fm1, requestId, "approve");
    const d = await detail(requestId, editor);
    expect(d.status).toBe("needs_attention");
    expect(d.lastError).toMatch(/already exists/);
    const { rows } = await (await getPool()).query(`SELECT asset_description FROM assets WHERE far_id = 'APR-1'`);
    expect(rows[0].asset_description).toBe("Direct"); // the pending version never overwrote it
    expect(d.permissions.canResubmit).toBe(true);
  });

  it("an asset can only have one open request at a time", async () => {
    await setRules("capitalization", [{ initiatorRoleIds: [roleId.editor], steps: [step("any", ["user", fm1.id])] }]);
    await submitAsset();
    const res = await as(editor, { method: "POST", url: "/api/assets", payload: ASSET });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already has a request waiting/);
  });
});

describe("reassignment", () => {
  it("an admin reassigns the current step; it's logged, the new approver can act, the old can't", async () => {
    await twoStepCapitalization();
    const { requestId } = await submitAsset();
    const res = await authedInject(app, {
      method: "POST",
      url: `/api/approvals/requests/${requestId}/reassign`,
      payload: { assignees: [{ type: "user", id: fm2.id }] }
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await decideAs(fm1, requestId, "approve")).statusCode).not.toBe(200); // fm1 no longer involved
    expect((await as(fm1, { method: "GET", url: "/api/approvals/tasks?tab=mine" })).json().items).toHaveLength(0);
    expect((await decideAs(fm2, requestId, "approve")).statusCode).toBe(200);
    const d = await detail(requestId, cfo);
    const reassigned = d.timeline.find((t: { action: string }) => t.action === "reassign");
    expect(reassigned.details.from.assignees[0].label).toBe("Finance Manager");
    expect(reassigned.details.to.assignees[0].label).toBe("apr-fm2");
    expect(reassigned.by).toBeTruthy();
  });

  it("only users with the reassign permission can reassign", async () => {
    await twoStepCapitalization();
    const { requestId } = await submitAsset();
    const res = await as(fm1, { method: "POST", url: `/api/approvals/requests/${requestId}/reassign`, payload: { assignees: [{ type: "user", id: fm2.id }] } });
    expect(res.statusCode).toBe(403);
  });
});

describe("bulk files: whole-file approval, background apply with resume", () => {
  const HEADER =
    "farId,subClassification,assetDescription,status,dateAcquired,location,usefulLifeC1Years,usefulLifeC2Years,c1OpeningCost,c2OpeningCost";
  const line = (i: number, center = "Center-Test") => `BLK-${i},Test-Sub,Bulk asset ${i},Active,2026-01-01,${center},5,5,1000,0`;

  async function uploadInTwoChunks(batch: string, extraSecond: string[] = []) {
    const first = await as(editor, {
      method: "POST",
      url: "/api/assets/bulk-upload",
      ...csvPayload([HEADER, line(1), line(2), line(3)].join("\n"), "file.csv"),
      headers: { ...csvPayload("", "x").headers, "x-bulk-batch": batch, "x-bulk-row-offset": "0" }
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().approvalDraft).toBeTruthy();
    const second = await as(editor, {
      method: "POST",
      url: "/api/assets/bulk-upload",
      ...csvPayload([HEADER, line(4, "Center-Other"), line(5), ...extraSecond].join("\n"), "file.csv"),
      headers: { ...csvPayload("", "x").headers, "x-bulk-batch": batch, "x-bulk-row-offset": "3" }
    });
    expect(second.statusCode, second.body).toBe(200);
    const fin = await as(editor, { method: "POST", url: "/api/approvals/bulk/finalize", payload: { batchToken: batch } });
    expect(fin.statusCode, fin.body).toBe(200);
    return fin.json() as { requestId: number; status: string; message: string };
  }

  it("captures chunks, shows totals + a searchable paged preview, and applies in resumable slices after approval", async () => {
    await setRules("bulkCapitalization", [{ initiatorRoleIds: [roleId.editor], steps: [step("any", ["user", fm1.id])] }]);
    const fin = await uploadInTwoChunks("batch-ok");
    expect(fin.status).toBe("pending");
    expect(await assetExists("BLK-1")).toBe(false);

    const d = await detail(fin.requestId);
    expect(d.bulk).toMatchObject({ rows: 5, amount: 5000, creates: 5, updates: 0 });
    expect(d.bulk.byCenter).toEqual(expect.arrayContaining([{ center: "Center-Test", rows: 4, amount: 4000 }, { center: "Center-Other", rows: 1, amount: 1000 }]));
    const page = (await as(fm1, { method: "GET", url: `/api/approvals/requests/${fin.requestId}/rows?page=1&pageSize=10&q=BLK-4` })).json();
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({ row: 5, farId: "BLK-4", center: "Center-Other" }); // spreadsheet row: header is row 1

    // Approve, then drive the job with a tiny budget so each slice does ~one chunk.
    const d0 = await detail(fin.requestId);
    await as(fm1, { method: "POST", url: `/api/approvals/requests/${fin.requestId}/approve`, payload: { step: d0.currentStep, cycle: d0.cycle } });
    const db = await getPool();
    await db.query(`UPDATE change_requests SET apply_lease_until = NULL WHERE id = $1`, [fin.requestId]);
    // A live lease (another slice running) means this call does nothing.
    await db.query(`UPDATE change_requests SET apply_lease_until = now() + interval '1 minute' WHERE id = $1`, [fin.requestId]);
    expect(await advanceBulkApply(db, fin.requestId, 0)).toBe(false);
    await db.query(`UPDATE change_requests SET apply_lease_until = NULL WHERE id = $1`, [fin.requestId]);

    let slices = 0;
    while (await advanceBulkApply(db, fin.requestId, -1)) slices++;
    expect(slices).toBeGreaterThan(1); // resumed across several slices
    const done = await detail(fin.requestId);
    expect(done.status).toBe("applied");
    for (const i of [1, 2, 3, 4, 5]) expect(await assetExists(`BLK-${i}`)).toBe(true);
    const linked = await db.query(`SELECT COUNT(*)::int AS n FROM asset_activity_log WHERE far_id LIKE 'BLK-%' AND approval_request_id = $1`, [fin.requestId]);
    expect(linked.rows[0].n).toBe(5); // every row of the file links back to its approval

    // Replaying an already-applied chunk (a slice that died after writing) is harmless.
    await db.query(`UPDATE change_request_chunks SET applied_at = NULL WHERE request_id = $1 AND chunk_no = 0`, [fin.requestId]);
    await db.query(`UPDATE change_requests SET status = 'applying', apply_progress = jsonb_set(apply_progress, '{phase}', '"applying"') WHERE id = $1`, [fin.requestId]);
    while (await advanceBulkApply(db, fin.requestId, -1));
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM assets WHERE far_id LIKE 'BLK-%'`);
    expect(rows[0].n).toBe(5);
  });

  it("a stalled job (nudge lost, nobody viewing) is finished by any signed-in user's badge poll", async () => {
    await setRules("bulkCapitalization", [{ initiatorRoleIds: [roleId.editor], steps: [step("any", ["user", fm1.id])] }]);
    const fin = await uploadInTwoChunks("batch-stall");
    const d0 = await detail(fin.requestId);
    await as(fm1, { method: "POST", url: `/api/approvals/requests/${fin.requestId}/approve`, payload: { step: d0.currentStep, cycle: d0.cycle } });
    const db = await getPool();
    await db.query(`UPDATE change_requests SET apply_lease_until = NULL WHERE id = $1`, [fin.requestId]);
    // cfo isn't involved in this request at all; their sidebar badge still drives it.
    for (let i = 0; i < 10 && (await db.query(`SELECT status FROM change_requests WHERE id = $1`, [fin.requestId])).rows[0].status === "applying"; i++) {
      const res = await as(cfo, { method: "GET", url: "/api/approvals/tasks/count" });
      expect(res.statusCode).toBe(200);
    }
    expect((await detail(fin.requestId)).status).toBe("applied");
    for (const i of [1, 2, 3, 4, 5]) expect(await assetExists(`BLK-${i}`)).toBe(true);
  });

  it("if any row no longer validates at apply time, NOTHING is applied and the file needs attention", async () => {
    await setRules("bulkCapitalization", [{ initiatorRoleIds: [roleId.editor], steps: [step("any", ["user", fm1.id])] }]);
    const fin = await uploadInTwoChunks("batch-bad");
    // After submission, the center used by row 4 is deactivated.
    await (await getPool()).query(`UPDATE centers SET active = FALSE WHERE code = 'Center-Other'`);
    const d0 = await detail(fin.requestId);
    await as(fm1, { method: "POST", url: `/api/approvals/requests/${fin.requestId}/approve`, payload: { step: d0.currentStep, cycle: d0.cycle } });
    const db = await getPool();
    await db.query(`UPDATE change_requests SET apply_lease_until = NULL WHERE id = $1`, [fin.requestId]);
    while (await advanceBulkApply(db, fin.requestId, -1));
    const d = await detail(fin.requestId, editor);
    expect(d.status).toBe("needs_attention");
    expect(d.lastError).toMatch(/nothing was applied/);
    expect(d.bulk.progress.errors[0].row).toBe(5); // BLK-4, spreadsheet row 5
    for (const i of [1, 2, 3, 4, 5]) expect(await assetExists(`BLK-${i}`)).toBe(false);
  });
});

describe("Masters approval", () => {
  it("a new center goes through the Masters workflow and is created on approval", async () => {
    await setRules("masters", [{ initiatorRoleIds: [roleId.editor], steps: [step("any", ["user", fm1.id])] }]);
    const res = await as(editor, { method: "POST", url: "/api/masters/centers", payload: { code: "Center-New" } });
    expect(res.statusCode, res.body).toBe(202);
    const db = await getPool();
    expect((await db.query(`SELECT 1 FROM centers WHERE code = 'Center-New'`)).rows).toHaveLength(0);
    await decideAs(fm1, res.json().pendingApproval.requestId, "approve");
    expect((await db.query(`SELECT 1 FROM centers WHERE code = 'Center-New'`)).rows).toHaveLength(1);
    const { rows } = await db.query(`SELECT actor_user_id, approval_request_id FROM master_activity_log WHERE action = 'center_create' ORDER BY id DESC LIMIT 1`);
    expect(Number(rows[0].actor_user_id)).toBe(editor.id);
    expect(Number(rows[0].approval_request_id)).toBe(res.json().pendingApproval.requestId);
  });
});

describe("Masters duplicates at submission", () => {
  it("a clash with an existing row or another open request is refused before anyone has to review it", async () => {
    await setRules("masters", [{ initiatorRoleIds: [roleId.editor], steps: [step("any", ["user", fm1.id])] }]);
    const existing = await as(editor, { method: "POST", url: "/api/masters/centers", payload: { code: "center-test" } });
    expect(existing.statusCode).toBe(409);
    expect(existing.json().error).toBe('A center with code "center-test" already exists.');

    const first = await as(editor, { method: "POST", url: "/api/masters/centers", payload: { code: "Center-Dup" } });
    expect(first.statusCode, first.body).toBe(202);
    const second = await as(editor, { method: "POST", url: "/api/masters/centers", payload: { code: "CENTER-DUP" } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe(`A center with code "CENTER-DUP" is already waiting for approval (#${first.json().pendingApproval.requestId}).`);

    // The approved replay isn't blocked by its own open request.
    await decideAs(fm1, first.json().pendingApproval.requestId, "approve");
    expect((await detail(first.json().pendingApproval.requestId)).status).toBe("applied");
  });
});

describe("Edit Asset logging", () => {
  const EDIT = { farId: "APR-1", subClassification: "Test-Sub", assetDescription: "Renamed", serialNo: "", usefulLifeC1Years: 7, usefulLifeC2Years: 5, accDepC1Opening: 0, accDepC2Opening: 0, parentFarId: null };

  it("every edit is logged with before/after of the changed fields, with or without a workflow", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: ASSET });
    expect((await authedInject(app, { method: "PATCH", url: "/api/assets/APR-1", payload: EDIT })).statusCode).toBe(200);
    const { rows } = await (await getPool()).query(`SELECT details FROM asset_activity_log WHERE action = 'asset_edit' AND far_id = 'APR-1'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toEqual({
      changed: ["assetDescription", "usefulLifeC1Years"],
      before: { assetDescription: "Approval Test Asset", usefulLifeC1Years: 5 },
      after: { assetDescription: "Renamed", usefulLifeC1Years: 7 }
    });
  });

  it("with a workflow, the edit waits for approval, shows before/after, and is logged when applied", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: ASSET });
    await setRules("editAsset", [{ initiatorRoleIds: [roleId.editor], steps: [step("any", ["user", fm1.id])] }]);
    const res = await as(editor, { method: "PATCH", url: "/api/assets/APR-1", payload: EDIT });
    expect(res.statusCode, res.body).toBe(202);
    const id = res.json().pendingApproval.requestId;
    const d = await detail(id);
    expect(d.before).toMatchObject({ assetDescription: "Approval Test Asset", usefulLifeC1Years: 5 });
    expect(d.payload.body).toMatchObject({ assetDescription: "Renamed" });
    expect(d.summary).toMatch(/^Edit APR-1: .*Asset Description/); // form labels, not field names
    expect(d.summary).not.toMatch(/assetDescription/);
    const db = await getPool();
    expect((await db.query(`SELECT asset_description FROM assets WHERE far_id = 'APR-1'`)).rows[0].asset_description).toBe("Approval Test Asset");
    await decideAs(fm1, id, "approve");
    expect((await db.query(`SELECT asset_description FROM assets WHERE far_id = 'APR-1'`)).rows[0].asset_description).toBe("Renamed");
    const log = await db.query(`SELECT actor_user_id FROM asset_activity_log WHERE action = 'asset_edit'`);
    expect(Number(log.rows[0].actor_user_id)).toBe(editor.id);
  });
});

describe("safety", () => {
  it("with no workflows configured, every route behaves exactly as today", async () => {
    const res = await as(editor, { method: "POST", url: "/api/assets", payload: ASSET });
    expect(res.statusCode).toBe(200);
    await expect((await getPool()).query(`SELECT COUNT(*)::int AS n FROM change_requests`).then((r) => r.rows[0].n)).resolves.toBe(0);
  });

  it("a forged approval-replay header is refused", async () => {
    const res = await as(editor, { method: "POST", url: "/api/assets", payload: ASSET, headers: { "x-approval-apply": "1.1.deadbeef" } });
    expect(res.statusCode).toBe(403);
    expect(await assetExists("APR-1")).toBe(false);
  });
});

// --- Reusable workflows + assignments ----------------------------------------------------

async function createFlow(name: string, steps: unknown[], description = "") {
  const res = await authedInject(app, { method: "POST", url: "/api/approvals/workflows", payload: { name, description, steps } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: number; version: number };
}
function assign(body: { modules: string[]; roleIds?: number[]; minAmount?: number | null; workflowId: number }, id?: number) {
  return authedInject(app, { method: id ? "PUT" : "POST", url: id ? `/api/approvals/assignments/${id}` : "/api/approvals/assignments", payload: body });
}
async function scenario(module: string, role: string | null, amount?: number) {
  const q = new URLSearchParams({ module });
  if (role) q.set("roleId", String(roleId[role]));
  if (amount !== undefined) q.set("amount", String(amount));
  const res = await authedInject(app, { method: "GET", url: `/api/approvals/test?${q}` });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json();
  return body.applies ? (body.workflow.name as string) : null;
}

describe("assignment matching precedence", () => {
  it("amount threshold > specific role > any role; the higher of two met thresholds wins", async () => {
    const anyRole = await createFlow("Any role", [step("any", ["user", fm1.id])]);
    const editors = await createFlow("Editors", [step("any", ["user", fm1.id])]);
    const editorsLarge = await createFlow("Editors large", [step("any", ["user", fm1.id]), step("any", ["user", cfo.id])]);
    const veryLarge = await createFlow("Very large", [step("all", ["user", fm1.id], ["user", cfo.id])]);
    const mods = ["capitalization", "additions", "disposals", "bulkCapitalization"];
    for (const body of [
      { modules: mods, workflowId: anyRole.id },
      { modules: mods, roleIds: [roleId.editor!], workflowId: editors.id },
      { modules: ["capitalization"], roleIds: [roleId.editor!], minAmount: 100000, workflowId: editorsLarge.id },
      { modules: ["capitalization"], minAmount: 1000000, workflowId: veryLarge.id }
    ]) {
      const res = await assign(body);
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(await scenario("capitalization", "editor", 20000)).toBe("Editors");
    expect(await scenario("capitalization", "finance manager", 20000)).toBe("Any role");
    expect(await scenario("capitalization", "editor", 200000)).toBe("Editors large");
    expect(await scenario("capitalization", "finance manager", 200000)).toBe("Any role"); // the 1L threshold is editors-only
    expect(await scenario("capitalization", "editor", 2000000)).toBe("Very large"); // the higher threshold beats the role match
    expect(await scenario("additions", "editor", 2000000)).toBe("Editors"); // the overrides are Capitalization-only
    expect(await scenario("transfers", "editor")).toBeNull(); // not assigned: applies immediately

    // The real submission path agrees with the scenario tester.
    const { requestId } = await submitAsset({ ...ASSET, farId: "APR-PREC", c1OpeningCost: 150000 });
    expect((await detail(requestId)).stepsTotal).toBe(2);
  });

  it("an assignment can't use an inactive workflow", async () => {
    const f = await createFlow("Soon inactive", [step("any", ["user", fm1.id])]);
    expect((await authedInject(app, { method: "POST", url: `/api/approvals/workflows/${f.id}/active`, payload: { active: false } })).statusCode).toBe(200);
    const res = await assign({ modules: ["capitalization"], workflowId: f.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/inactive/);
  });
});

describe("assignment conflicts are blocked", () => {
  it("same module, overlapping role, same threshold is refused with a clear message; a different threshold is fine", async () => {
    const a = await createFlow("Flow A", [step("any", ["user", fm1.id])]);
    const b = await createFlow("Flow B", [step("any", ["user", cfo.id])]);
    expect((await assign({ modules: ["capitalization", "additions"], roleIds: [roleId.editor!], workflowId: a.id })).statusCode).toBe(200);

    const clash = await assign({ modules: ["additions", "disposals"], roleIds: [roleId.editor!, roleId.cfo!], workflowId: b.id });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toMatch(/Conflicts with the assignment that uses "Flow A" \(Additions, submitted by editor, at any amount\)/i);

    expect((await assign({ modules: ["additions"], roleIds: [roleId.editor!], minAmount: 50000, workflowId: b.id })).statusCode).toBe(200);
    expect((await assign({ modules: ["additions"], roleIds: [roleId.cfo!], workflowId: b.id })).statusCode).toBe(200);
    // "Any role" only conflicts with another "any role" at the same threshold.
    const any1 = await assign({ modules: ["disposals"], workflowId: a.id });
    expect(any1.statusCode).toBe(200);
    expect((await assign({ modules: ["disposals"], workflowId: b.id })).statusCode).toBe(409);
    // Editing an assignment in place isn't a conflict with itself; editing it into one is refused.
    expect((await assign({ modules: ["disposals"], workflowId: b.id }, any1.json().id)).statusCode).toBe(200);
    expect((await assign({ modules: ["capitalization"], roleIds: [roleId.editor!], workflowId: b.id }, any1.json().id)).statusCode).toBe(409);
  });

  it("an amount threshold on a module without amounts is refused", async () => {
    const a = await createFlow("Flow T", [step("any", ["user", fm1.id])]);
    const res = await assign({ modules: ["capitalization", "transfers"], minAmount: 1000, workflowId: a.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Transfers has no amount/);
  });

  it("an equally specific tie that reached the database anyway is refused at submission, never guessed", async () => {
    const a = await createFlow("Tie A", [step("any", ["user", fm1.id])]);
    const b = await createFlow("Tie B", [step("any", ["user", cfo.id])]);
    await (await getPool()).query(
      `INSERT INTO approval_assignments (modules, role_ids, workflow_id) VALUES ('{capitalization}', $1, $2), ('{capitalization}', $1, $3)`,
      [[roleId.editor], a.id, b.id]
    );
    const res = await as(editor, { method: "POST", url: "/api/assets", payload: ASSET });
    expect(res.statusCode).toBe(409);
    expect(await assetExists("APR-1")).toBe(false);
  });
});

describe("workflow edits and deactivation", () => {
  it("editing a workflow mid-request: the request keeps its version-1 snapshot; new requests get version 2", async () => {
    const f = await createFlow("Two step", [step("any", ["role", roleId["finance manager"]!]), step("any", ["user", cfo.id])]);
    expect((await assign({ modules: ["capitalization"], roleIds: [roleId.editor!], workflowId: f.id })).statusCode).toBe(200);
    const first = await submitAsset();
    const edit = await authedInject(app, { method: "PUT", url: `/api/approvals/workflows/${f.id}`, payload: { name: "Two step", steps: [step("any", ["user", cfo.id])] } });
    expect(edit.json().version).toBe(2);

    const db = await getPool();
    const snap = async (id: number) => (await db.query(`SELECT workflow_snapshot FROM change_requests WHERE id = $1`, [id])).rows[0].workflow_snapshot;
    expect(await snap(first.requestId)).toMatchObject({ workflowId: f.id, version: 1, steps: [{ assignees: [{ label: "Finance Manager" }] }, {}] });
    expect((await decideAs(fm1, first.requestId, "approve")).statusCode).toBe(200); // the old step 1 still applies
    expect((await decideAs(cfo, first.requestId, "approve")).statusCode).toBe(200);
    expect((await detail(first.requestId, cfo)).status).toBe("applied");

    const second = await submitAsset({ ...ASSET, farId: "APR-2" });
    expect(await snap(second.requestId)).toMatchObject({ version: 2, steps: [{ assignees: [{ label: "apr-cfo" }] }] });
  });

  it("deactivating a workflow that's still assigned is blocked; once unassigned it deactivates", async () => {
    const f = await createFlow("Guarded", [step("any", ["user", fm1.id])]);
    const a = await assign({ modules: ["capitalization", "masters"], workflowId: f.id });
    const res = await authedInject(app, { method: "POST", url: `/api/approvals/workflows/${f.id}/active`, payload: { active: false } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/still used by 1 assignment \(Capitalization, Masters\)/);
    expect(await scenario("capitalization", "editor", 1)).toBe("Guarded"); // still guarded

    expect((await authedInject(app, { method: "DELETE", url: `/api/approvals/assignments/${a.json().id}` })).statusCode).toBe(200);
    const off = await authedInject(app, { method: "POST", url: `/api/approvals/workflows/${f.id}/active`, payload: { active: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json().active).toBe(false);
  });

  it("workflow names are unique, ignoring case", async () => {
    await createFlow("Standard", [step("any", ["user", fm1.id])]);
    const res = await authedInject(app, { method: "POST", url: "/api/approvals/workflows", payload: { name: "standard", steps: [step("any", ["user", fm1.id])] } });
    expect(res.statusCode).toBe(409);
  });
});

describe("Activity Log: workflow and assignment changes", () => {
  it("create, edit, deactivate and assignment changes are logged with before and after, under Approval Workflows", async () => {
    await (await getPool()).query(`DELETE FROM master_activity_log`);
    const f = await createFlow("Audited", [step("any", ["user", fm1.id])]);
    await authedInject(app, {
      method: "PUT",
      url: `/api/approvals/workflows/${f.id}`,
      payload: { name: "Audited", description: "Now two steps", steps: [step("any", ["user", fm1.id]), step("any", ["user", cfo.id])] }
    });
    const a = await assign({ modules: ["capitalization"], workflowId: f.id });
    await assign({ modules: ["capitalization", "additions"], roleIds: [roleId.editor!], workflowId: f.id }, a.json().id);
    await authedInject(app, { method: "DELETE", url: `/api/approvals/assignments/${a.json().id}` });
    await authedInject(app, { method: "POST", url: `/api/approvals/workflows/${f.id}/active`, payload: { active: false } });

    const log = (await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=approvals&limit=50" })).json();
    const items = [...log.items].reverse() as Array<{ category: string; action: string; actorUsername: string; details: Record<string, unknown> }>;
    expect(items.map((i) => i.action)).toEqual([
      "approval_workflow_create",
      "approval_workflow_update",
      "approval_assignment_create",
      "approval_assignment_update",
      "approval_assignment_delete",
      "approval_workflow_deactivate"
    ]);
    expect(items.every((i) => i.category === "approvals" && i.actorUsername)).toBe(true);
    expect(items[1]!.details).toMatchObject({
      record: "Audited",
      type: "Workflow Edited",
      steps: "apr-fm1 → apr-cfo",
      description: "Now two steps",
      previous: { steps: "apr-fm1", description: "" }
    });
    expect(items[3]!.details).toMatchObject({ modules: "Capitalization, Additions", submitterRoles: "editor", previous: { modules: "Capitalization", submitterRoles: "Any role" } });
    expect(items[5]!.details).toMatchObject({ active: false, previous: { active: true } });
    // Kept out of the Masters category.
    expect((await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=masters" })).json().items).toHaveLength(0);
  });
});

describe("migration of the legacy per-module rules", () => {
  /** The old matcher: per module, the first rule by position whose roles include the
   *  maker's and whose threshold the amount meets. */
  function legacyMatch(rules: LegacyRule[], module: string, role: number, amount: number | null) {
    return [...rules]
      .filter((r) => r.module === module)
      .sort((a, b) => a.position - b.position)
      .find((r) => r.initiatorRoleIds.includes(role) && (r.minAmount === null || (amount !== null && amount >= r.minAmount)));
  }

  it("converts once, merges identical chains into one shared workflow, and routes every case exactly as before", async () => {
    const db = await getPool();
    const fmId = roleId["finance manager"]!;
    const chainA = [step("any", ["role", fmId]), step("any", ["user", cfo.id])];
    const chainB = [step("any", ["user", fm1.id])];
    const chainC = [step("all", ["user", fm1.id], ["user", cfo.id])];
    const legacy = [
      // The same chain on three modules: one workflow, one assignment covering all three.
      { module: "capitalization", name: "Standard", position: 1, initiatorRoleIds: [roleId.editor!], minAmount: null, steps: chainA },
      { module: "additions", name: "", position: 0, initiatorRoleIds: [roleId.editor!], minAmount: null, steps: chainA },
      { module: "disposals", name: "Std", position: 0, initiatorRoleIds: [roleId.editor!], minAmount: null, steps: chainA },
      // A threshold rule listed first: reachable, and it wins under most-specific too.
      { module: "capitalization", name: "Large", position: 0, initiatorRoleIds: [roleId.editor!, fmId], minAmount: 100000, steps: chainC },
      // Shadowed for editor (an earlier editor rule has a lower threshold); still live for CFO.
      { module: "capitalization", name: "Huge", position: 2, initiatorRoleIds: [roleId.editor!, roleId.cfo!], minAmount: 1000000, steps: chainB },
      // Fully shadowed: an earlier no-threshold rule for the same role.
      { module: "additions", name: "Dead", position: 1, initiatorRoleIds: [roleId.editor!], minAmount: 5000, steps: chainB },
      { module: "masters", name: "Masters", position: 0, initiatorRoleIds: [fmId], minAmount: null, steps: chainB }
    ] as LegacyRule[];
    for (const r of legacy) {
      await db.query(`INSERT INTO approval_workflows (module, name, position, initiator_role_ids, min_amount, steps) VALUES ($1, $2, $3, $4, $5, $6)`, [
        r.module,
        r.name,
        r.position,
        r.initiatorRoleIds,
        r.minAmount,
        JSON.stringify(r.steps)
      ]);
    }
    await db.query(`UPDATE approval_config SET legacy_rules_migrated = FALSE`);
    await migrateLegacyRules(db);
    await migrateLegacyRules(db); // a second boot: no-op

    const flows = (await db.query(`SELECT name FROM approval_flows ORDER BY id`)).rows.map((f) => f.name);
    expect(flows).toHaveLength(3); // chainA once, chainB shared by Huge/Masters, chainC
    expect(flows).toEqual(expect.arrayContaining(["Large", "Huge"]));
    const assignments = (await db.query(`SELECT modules, role_ids, min_amount FROM approval_assignments ORDER BY id`)).rows;
    expect(assignments).toContainEqual({ modules: expect.arrayContaining(["capitalization", "additions", "disposals"]), role_ids: [String(roleId.editor)], min_amount: null });
    expect(assignments.some((a) => a.modules.includes("additions") && a.min_amount === "5000")).toBe(false); // the unreachable rule is gone

    for (const module of ["capitalization", "additions", "disposals", "masters", "transfers"])
      for (const role of [roleId.editor!, fmId, roleId.cfo!])
        for (const amount of [0, 5000, 99999, 100000, 999999, 1000000, 5000000]) {
          const old = legacyMatch(legacy, module, role, amount);
          const got = await matchWorkflow(db, module as never, role, amount);
          expect(got?.flow.steps ?? null, `${module}, role ${role}, amount ${amount}`).toEqual(old?.steps ?? null);
        }
    await db.query(`DELETE FROM approval_workflows`);
    await db.query(`UPDATE approval_config SET legacy_rules_migrated = TRUE`);
  });

  it("an empty legacy table (the company database) converts to nothing and is marked done", async () => {
    const db = await getPool();
    await db.query(`UPDATE approval_config SET legacy_rules_migrated = FALSE`);
    await migrateLegacyRules(db);
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM approval_flows`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT legacy_rules_migrated FROM approval_config`)).rows[0].legacy_rules_migrated).toBe(true);
  });

  it("converted workflows get unique names", () => {
    const { flows } = convertLegacyRules([
      { module: "capitalization", name: "Same", position: 0, initiatorRoleIds: [1], minAmount: null, steps: [step("any", ["user", 1])] },
      { module: "additions", name: "Same", position: 0, initiatorRoleIds: [1], minAmount: null, steps: [step("any", ["user", 2])] },
      { module: "masters", name: "", position: 0, initiatorRoleIds: [1], minAmount: null, steps: [step("all", ["user", 3])] }
    ]);
    expect(flows.map((f) => f.name)).toEqual(["Same", "Same (2)", "Workflow 3"]);
  });
});
