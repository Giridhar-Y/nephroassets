import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bulkMergeRoutes from "./bulkMerge.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";
import { csvPayload } from "./bulkTestHelpers.js";

async function insertAsset(farId: string, overrides: Record<string, unknown> = {}) {
  const db = await getPool();
  const row = {
    far_id: farId,
    sub_classification: "Test-Sub",
    asset_description: `Bulk merge test ${farId}`,
    status: "Active",
    date_acquired: "2020-01-01",
    location: "Center-A",
    useful_life_c1_years: 5,
    useful_life_c2_years: 5,
    c1_opening_cost: 10000,
    c2_opening_cost: 0,
    ...overrides
  };
  const columns = Object.keys(row);
  const values = Object.values(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  await db.query(`INSERT INTO assets (${columns.join(", ")}) VALUES (${placeholders})`, values);
}

const HEADER = "parentFarId,childFarId";

describe("Bulk Merge: POST /api/assets/bulk-merge", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(multipart);
    await app.register(bulkMergeRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    // asset_bulk_action_log.actor_user_id references the shared test-harness-admin (see
    // authTestUtils.ts) with no ON DELETE clause (matching user_audit_log/
    // settings_audit_log's own FK, same as every other audit table in this app) — a row
    // left behind after this file's last test would make a *later* test file's own
    // `DELETE FROM users` fail with a foreign key violation. beforeEach below already
    // clears this between this file's own tests; this is the same cleanup for the final
    // one, so nothing survives past this file's own describe block.
    const db = await getPool();
    await db.query(`DELETE FROM asset_bulk_action_log`);
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM asset_bulk_action_log`);
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
  });

  it("(rule 1) rejects a row where the parent or child FAR ID doesn't exist", async () => {
    await insertAsset("BM-P1");
    const csv = [HEADER, "BM-P1,NOT-REAL", "NOT-REAL-2,BM-P1"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-merge", ...csvPayload(csv) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors).toHaveLength(2);
    expect(body.errors.find((e: { farId: string }) => e.farId === "NOT-REAL").message).toMatch(/No asset found with FAR ID "NOT-REAL"/);
  });

  it("(rule 2) rejects self-merge", async () => {
    await insertAsset("BM-SELF");
    const csv = [HEADER, "BM-SELF,BM-SELF"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-merge", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors[0].message).toMatch(/cannot be its own parent/);
  });

  it("(rule 3) rejects a disposed parent and a disposed child", async () => {
    await insertAsset("BM-P-DISPOSED", { status: "Disposed", date_of_disposal: "2026-01-01" });
    await insertAsset("BM-C-DISPOSED", { status: "Disposed", date_of_disposal: "2026-01-01" });
    await insertAsset("BM-OK-1");
    const csv = [HEADER, "BM-P-DISPOSED,BM-OK-1", "BM-OK-1,BM-C-DISPOSED"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-merge", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors.find((e: { farId: string; message: string }) => e.farId === "BM-OK-1" && /disposed and can't be used as a parent/.test(e.message))).toBeTruthy();
    expect(body.errors.find((e: { farId: string }) => e.farId === "BM-C-DISPOSED")).toBeTruthy();
  });

  it("(rule 4) treats re-requesting the child's existing parent as a no-op", async () => {
    await insertAsset("BM-P1");
    await insertAsset("BM-C1", { parent_far_id: "BM-P1" });
    const csv = [HEADER, "BM-P1,BM-C1"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-merge", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(1);
    expect(body.errors).toHaveLength(0);
  });

  it("(rule 4) rejects re-parenting a child that already has a different parent", async () => {
    await insertAsset("BM-P1");
    await insertAsset("BM-P2");
    await insertAsset("BM-C1", { parent_far_id: "BM-P1" });
    const csv = [HEADER, "BM-P2,BM-C1"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-merge", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors[0].message).toMatch(/already a child of "BM-P1"/);
  });

  it("(rule 5) rejects a parent that is itself already a child", async () => {
    await insertAsset("BM-GRANDPARENT");
    await insertAsset("BM-PARENT", { parent_far_id: "BM-GRANDPARENT" });
    await insertAsset("BM-CHILD");
    const csv = [HEADER, "BM-PARENT,BM-CHILD"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-merge", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors[0].message).toMatch(/only one level of parent\/child/);
  });

  it("(rule 6) rejects a child that already has its own children", async () => {
    await insertAsset("BM-PARENT");
    await insertAsset("BM-MIDDLE");
    await insertAsset("BM-LEAF", { parent_far_id: "BM-MIDDLE" });
    const csv = [HEADER, "BM-PARENT,BM-MIDDLE"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-merge", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors[0].message).toMatch(/already has its own child assets/);
  });

  it("(rule 7) rejects every row for a child FAR ID that appears more than once in the file", async () => {
    await insertAsset("BM-P1");
    await insertAsset("BM-P2");
    await insertAsset("BM-C1");
    const csv = [HEADER, "BM-P1,BM-C1", "BM-P2,BM-C1"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-merge", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors).toHaveLength(2);
    expect(body.errors.every((e: { message: string }) => /appears 2 times in this file/.test(e.message))).toBe(true);
  });

  it("(rule 8) rejects a two-row cycle (A parent of B, B parent of A)", async () => {
    await insertAsset("BM-A");
    await insertAsset("BM-B");
    const csv = [HEADER, "BM-A,BM-B", "BM-B,BM-A"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-merge", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors.some((e: { message: string }) => /Cycle detected/.test(e.message))).toBe(true);
  });

  it("(rule 9) applies the merge but surfaces a warning when location or sub classification differ", async () => {
    await insertAsset("BM-P1", { location: "Center-A", sub_classification: "Test-Sub" });
    await insertAsset("BM-C1", { location: "Center-B", sub_classification: "Other-Sub" });
    const csv = [HEADER, "BM-P1,BM-C1"].join("\n");
    const preview = await authedInject(app, {
      method: "POST",
      url: "/api/assets/bulk-merge?preview=true",
      ...csvPayload(csv)
    });
    const previewBody = preview.json();
    expect(previewBody.summary.update).toBe(1);
    expect(previewBody.summary.error).toBe(0);
    expect(previewBody.rows[0].message).toMatch(/Warning:.*different locations/);
    expect(previewBody.rows[0].message).toMatch(/different Sub Classifications/);

    const commit = await authedInject(app, { method: "POST", url: "/api/assets/bulk-merge", ...csvPayload(csv) });
    expect(commit.json().processed).toBe(1);
    const db = await getPool();
    const { rows } = await db.query(`SELECT parent_far_id FROM assets WHERE far_id = 'BM-C1'`);
    expect(rows[0].parent_far_id).toBe("BM-P1");
  });

  it("preview mode never writes to the database", async () => {
    await insertAsset("BM-P1");
    await insertAsset("BM-C1");
    const csv = [HEADER, "BM-P1,BM-C1"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-merge?preview=true", ...csvPayload(csv) });
    expect(res.json().summary.update).toBe(1);
    const db = await getPool();
    const { rows } = await db.query(`SELECT parent_far_id FROM assets WHERE far_id = 'BM-C1'`);
    expect(rows[0].parent_far_id).toBeNull();
  });

  it("mixed batch: applies only the valid rows, reports the rest as skipped, and logs the run", async () => {
    await insertAsset("BM-P1");
    await insertAsset("BM-C1");
    await insertAsset("BM-C2", { status: "Disposed", date_of_disposal: "2026-01-01" });
    const csv = [HEADER, "BM-P1,BM-C1", "BM-P1,BM-C2", "BM-P1,NOT-REAL"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-merge", ...csvPayload(csv) });
    const body = res.json();
    expect(body.totalRows).toBe(3);
    expect(body.processed).toBe(1);
    expect(body.errors).toHaveLength(2);

    const db = await getPool();
    const { rows: c1 } = await db.query(`SELECT parent_far_id FROM assets WHERE far_id = 'BM-C1'`);
    expect(c1[0].parent_far_id).toBe("BM-P1");
    const { rows: c2 } = await db.query(`SELECT parent_far_id FROM assets WHERE far_id = 'BM-C2'`);
    expect(c2[0].parent_far_id).toBeNull();

    const { rows: log } = await db.query(`SELECT action, source_filename, details FROM asset_bulk_action_log`);
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("bulk_merge");
    expect(log[0].source_filename).toBe("upload.csv");
    expect(log[0].details.rowsApplied).toBe(1);
    expect(log[0].details.rowsSkipped).toBe(2);
  });
});
