import Fastify, { type FastifyInstance } from "fastify";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsExportRoutes from "./assetsExport.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";

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

    const res = await authedInject(app, { method: "GET", url: "/api/assets/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.headers["content-disposition"]).toContain("attachment");

    const worksheet = await readWorkbook(res.rawPayload);
    // totals row + group band row + column name row + 3 data rows
    expect(worksheet.rowCount).toBe(6);
    expect(worksheet.getRow(1).getCell(1).value).toBe("TOTAL");
    expect(worksheet.getRow(2).getCell(1).value).toBe("Asset Identification");
    const headerRow = worksheet.getRow(3).values as unknown[];
    expect(headerRow).toContain("FAR ID");
    expect(worksheet.getRow(1).getCell(1).font?.bold).toBe(true);
    expect(worksheet.getRow(2).getCell(1).font?.bold).toBe(true);
    expect(worksheet.getRow(3).getCell(1).font?.bold).toBe(true);
    // Group band keeps a distinct fill per group (color stays in the export even though
    // the on-screen Register table dropped it) — column 1 (Asset ID) and column 13 (C1
    // Opening, Gross Block group) must differ.
    const g1Fill = worksheet.getRow(2).getCell(1).fill as { fgColor?: { argb?: string } };
    const g2Fill = worksheet.getRow(2).getCell(13).fill as { fgColor?: { argb?: string } };
    expect(g1Fill.fgColor?.argb).toBeTruthy();
    expect(g1Fill.fgColor?.argb).not.toBe(g2Fill.fgColor?.argb);
    // 39 columns, dates as DD-MM-YYYY, currency with 2 decimals
    expect((worksheet.getRow(3).values as unknown[]).length - 1).toBe(39);
    const firstDataRow = worksheet.getRow(4);
    expect(firstDataRow.getCell(3).value).toBe("01-01-2020"); // Date Acquired
    expect(worksheet.getColumn(13).numFmt).toBe("#,##0.00"); // C1 Opening (a numeric column)
  });

  it("excludes an asset from the export when AS_AT is before its own capitalization date", async () => {
    await insertAsset("EXP-OLD", { date_acquired: "2020-01-01" });
    await insertAsset("EXP-NEW", { date_acquired: "2026-06-01" });

    const res = await authedInject(app, { method: "GET", url: "/api/assets/export?asAt=2026-03-31" });
    const worksheet = await readWorkbook(res.rawPayload);
    // totals + group band + header + only EXP-OLD (EXP-NEW isn't capitalized yet as at 2026-03-31)
    expect(worksheet.rowCount).toBe(4);
    const dataRow = worksheet.getRow(4).values as unknown[];
    expect(dataRow).toContain("EXP-OLD");
    expect(dataRow).not.toContain("EXP-NEW");
  });

  it("applies filters (center) so only matching rows are exported", async () => {
    await insertAsset("EXP-4");
    await insertAsset("EXP-5", { location: "Center-Other" });

    const res = await authedInject(app, { method: "GET", url: "/api/assets/export?center=Center-Export" });
    const worksheet = await readWorkbook(res.rawPayload);
    expect(worksheet.rowCount).toBe(4);
    const dataRow = worksheet.getRow(4).values as unknown[];
    expect(dataRow).toContain("EXP-4");
  });

  it("applies capLocation (raw capitalization location, not the current post-transfer one)", async () => {
    await insertAsset("EXP-CAPLOC-1");
    await insertAsset("EXP-CAPLOC-2", { location: "Center-Other" });
    const db = await getPool();
    // EXP-CAPLOC-1 has since moved away — capLocation should still find it under its
    // original Center-Export, proving it filters the raw column, not the COALESCE'd
    // current-location one (which `center` already covers).
    await db.query(`UPDATE assets SET revised_location = 'Center-Other' WHERE far_id = 'EXP-CAPLOC-1'`);

    const res = await authedInject(app, { method: "GET", url: "/api/assets/export?capLocation=Center-Export" });
    const worksheet = await readWorkbook(res.rawPayload);
    expect(worksheet.rowCount).toBe(4);
    const dataRow = worksheet.getRow(4).values as unknown[];
    expect(dataRow).toContain("EXP-CAPLOC-1");
  });

  it("sums numeric columns (Qty and C1 Opening Cost) into the totals row, respecting the same filters", async () => {
    await insertAsset("EXP-TOTALS-1", { qty: 2, c1_opening_cost: 10000 });
    await insertAsset("EXP-TOTALS-2", { qty: 3, c1_opening_cost: 25000, location: "Center-Other" });

    const res = await authedInject(app, { method: "GET", url: "/api/assets/export?center=Center-Export" });
    const worksheet = await readWorkbook(res.rawPayload);
    const totalsRow = worksheet.getRow(1);
    // Qty is column 10, C1 Opening Cost is column 13 (see EXPORT_COLUMNS order).
    expect(totalsRow.getCell(10).value).toBe(2);
    expect(totalsRow.getCell(13).value).toBe(10000);
  });

  it("blanks the totals row for non-numeric and non-totalable columns (Useful Life)", async () => {
    await insertAsset("EXP-BLANK-1", { useful_life_c1_years: 7 });
    const res = await authedInject(app, { method: "GET", url: "/api/assets/export" });
    const worksheet = await readWorkbook(res.rawPayload);
    const totalsRow = worksheet.getRow(1);
    expect(totalsRow.getCell(2).value).toBeNull(); // Sub Classification
    expect(totalsRow.getCell(11).value).toBeNull(); // Useful Life C1 (Yrs)
  });

  it("409s when financial year settings are missing", async () => {
    const db = await getPool();
    await db.query(`DELETE FROM settings`);
    const res = await authedInject(app, { method: "GET", url: "/api/assets/export" });
    expect(res.statusCode).toBe(409);

    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, $4)`,
      [AS_AT, FY_START, FY_END, DAYS_IN_FY]
    );
  });
});
