import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "../routes/assets.js";
import transfersRoutes from "../routes/transfers.js";
import bulkUploadRoutes from "../routes/bulkUpload.js";
import mastersRoutes from "../routes/masters.js";
import approvalsRoutes from "../routes/approvals.js";
import { getPool } from "../db/pool.js";
import { authedInject, authHeaderFor, createTestUser } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";
import { csvPayload } from "../routes/bulkTestHelpers.js";
import { advanceBulkApply, setApprovalsApp } from "./engine.js";

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

async function setRules(module: string, rules: unknown[]) {
  const res = await authedInject(app, { method: "PUT", url: `/api/approvals/workflows/${module}`, payload: { rules } });
  expect(res.statusCode, res.body).toBe(200);
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
  await app.register(cookie);
  await app.register(multipart);
  await app.register(assetsRoutes);
  await app.register(transfersRoutes);
  await app.register(bulkUploadRoutes);
  await app.register(mastersRoutes);
  await app.register(approvalsRoutes);
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
    expect((await decideAs(fm1, pending.requestId, "approve")).statusCode).toBe(200);
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

  it("first matching rule wins, with the amount threshold as a condition", async () => {
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

    // Replaying an already-applied chunk (a slice that died after writing) is harmless.
    await db.query(`UPDATE change_request_chunks SET applied_at = NULL WHERE request_id = $1 AND chunk_no = 0`, [fin.requestId]);
    await db.query(`UPDATE change_requests SET status = 'applying', apply_progress = jsonb_set(apply_progress, '{phase}', '"applying"') WHERE id = $1`, [fin.requestId]);
    while (await advanceBulkApply(db, fin.requestId, -1));
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM assets WHERE far_id LIKE 'BLK-%'`);
    expect(rows[0].n).toBe(5);
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
    const { rows } = await db.query(`SELECT actor_user_id FROM master_activity_log WHERE action = 'center_create' ORDER BY id DESC LIMIT 1`);
    expect(Number(rows[0].actor_user_id)).toBe(editor.id);
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
