import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bulkDisposalsRoutes from "./bulkDisposals.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { csvPayload, emptyMultipartPayload } from "./bulkTestHelpers.js";

async function insertAsset(farId: string, overrides: Record<string, unknown> = {}) {
  const db = await getPool();
  const row = {
    far_id: farId,
    sub_classification: "Test-Sub",
    asset_description: `Bulk disposal test ${farId}`,
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

const HEADER = "farId,dateOfDisposal,saleValue";

describe("Bulk Disposals: POST /api/assets/bulk-dispose", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(multipart);
    await app.register(bulkDisposalsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
  });

  it("fully disposes valid rows and reports errors for the rest", async () => {
    await insertAsset("BDISP-1");
    await insertAsset("BDISP-2", { status: "Disposed", date_of_disposal: "2026-01-01" });

    const csv = [HEADER, "BDISP-1,2026-08-01,500", "BDISP-2,2026-08-01,100", "BDISP-3,2026-08-01,0"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-dispose", ...csvPayload(csv) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRows).toBe(3);
    expect(body.processed).toBe(1);
    expect(body.errors).toHaveLength(2);
    expect(body.errors.find((e: { farId: string }) => e.farId === "BDISP-2").message).toMatch(/already been disposed/);
    expect(body.errors.find((e: { farId: string }) => e.farId === "BDISP-3").message).toMatch(/No asset found/);

    const db = await getPool();
    const { rows } = await db.query(
      `SELECT status, deletions_c1, sale_value FROM assets WHERE far_id = 'BDISP-1'`
    );
    expect(rows[0].status).toBe("Disposed");
    expect(rows[0].deletions_c1).toBe("10000");
    expect(Number(rows[0].sale_value)).toBe(500);
  });

  it("400s when no file is uploaded", async () => {
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-dispose", ...emptyMultipartPayload() });
    expect(res.statusCode).toBe(400);
  });

  it("preview mode classifies rows without disposing anything", async () => {
    await insertAsset("BDISP-1");
    await insertAsset("BDISP-2", { status: "Disposed", date_of_disposal: "2026-01-01" });

    const csv = [HEADER, "BDISP-1,2026-08-01,500", "BDISP-2,2026-08-01,100", "BDISP-3,2026-08-01,0"].join("\n");
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets/bulk-dispose?preview=true",
      ...csvPayload(csv)
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toEqual({ new: 0, update: 1, error: 2 });
    expect(body.rows.find((r: { farId: string }) => r.farId === "BDISP-1").status).toBe("update");
    expect(body.rows.find((r: { farId: string }) => r.farId === "BDISP-2").message).toMatch(/already been disposed/);
    expect(body.rows.find((r: { farId: string }) => r.farId === "BDISP-3").message).toMatch(/No asset found/);

    const db = await getPool();
    const { rows } = await db.query(`SELECT status FROM assets WHERE far_id = 'BDISP-1'`);
    expect(rows[0].status).toBe("Active");
  });

  it("accepts a DD-MM-YYYY disposal date and rejects a malformed one with a clear message", async () => {
    await insertAsset("BDISP-DMY");
    await insertAsset("BDISP-BAD");

    const csv = [HEADER, "BDISP-DMY,01-08-2026,500", "BDISP-BAD,32-01-2026,0"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-dispose", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(1);
    expect(body.errors[0].message).toMatch(/Invalid date '32-01-2026' — expected DD-MM-YYYY/);

    const db = await getPool();
    const { rows } = await db.query(`SELECT date_of_disposal FROM assets WHERE far_id = 'BDISP-DMY'`);
    expect(String(rows[0].date_of_disposal)).toMatch(/^2026-08-01/);
  });
});
