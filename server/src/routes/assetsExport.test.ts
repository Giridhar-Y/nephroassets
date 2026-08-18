import Fastify, { type FastifyInstance } from "fastify";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsExportRoutes from "./assetsExport.js";
import { getPool } from "../db/pool.js";

const AS_AT = "2026-08-17";
const FY_START = "2026-04-01";
const FY_END = "2027-03-31";
const DAYS_IN_FY = 365;

async function insertAsset(farId: string, overrides: Record<string, unknown> = {}) {
  const db = await getPool();
  const row = {
    far_id: farId,
    sub_classification: "Test-Sub",
    asset_description: `Export test ${farId}`,
    status: "Active",
    date_acquired: "2020-01-01",
    location: "Center-Export",
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

async function readWorkbook(payload: Buffer) {
  const workbook = new ExcelJS.Workbook();
  // Same upstream exceljs typings bug as bulkUpload.ts (global Buffer redeclaration).
  await workbook.xlsx.load(payload as any);
  return workbook.worksheets[0]!;
}

describe("Register Export: GET /api/assets/export", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(assetsExportRoutes);
    await app.ready();

    const db = await getPool();
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET as_at = $1, fy_start = $2, fy_end = $3, days_in_fy = $4`,
      [AS_AT, FY_START, FY_END, DAYS_IN_FY]
    );
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
  });

  it("exports every matching row with no filters applied", async () => {
    await insertAsset("EXP-1");
    await insertAsset("EXP-2");
    await insertAsset("EXP-3", { location: "Center-Other" });

    const res = await app.inject({ method: "GET", url: "/api/assets/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.headers["content-disposition"]).toContain("attachment");

    const worksheet = await readWorkbook(res.rawPayload);
    // header row + 3 data rows
    expect(worksheet.rowCount).toBe(4);
    const headerRow = worksheet.getRow(1).values as unknown[];
    expect(headerRow).toContain("FAR ID");
  });

  it("applies filters (center) so only matching rows are exported", async () => {
    await insertAsset("EXP-4");
    await insertAsset("EXP-5", { location: "Center-Other" });

    const res = await app.inject({ method: "GET", url: "/api/assets/export?center=Center-Export" });
    const worksheet = await readWorkbook(res.rawPayload);
    expect(worksheet.rowCount).toBe(2);
    const dataRow = worksheet.getRow(2).values as unknown[];
    expect(dataRow).toContain("EXP-4");
  });

  it("409s when financial year settings are missing", async () => {
    const db = await getPool();
    await db.query(`DELETE FROM settings`);
    const res = await app.inject({ method: "GET", url: "/api/assets/export" });
    expect(res.statusCode).toBe(409);

    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, $4)`,
      [AS_AT, FY_START, FY_END, DAYS_IN_FY]
    );
  });
});
