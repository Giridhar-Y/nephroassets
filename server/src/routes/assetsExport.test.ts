import Fastify, { type FastifyInstance } from "fastify";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

function conditionsParam(conditions: unknown[]): string {
  return `conditions=${encodeURIComponent(JSON.stringify(conditions))}`;
}

// Row layout as of the filter-summary note (this round): 1 = note, 2 = totals,
// 3 = group band, 4 = column names, 5+ = data. Every row-number assertion below is
// relative to NOTE_ROW so a future layout change only needs updating in one place.
const NOTE_ROW = 1;
const TOTALS_ROW = 2;
const GROUP_ROW = 3;
const HEADER_ROW = 4;
const FIRST_DATA_ROW = 5;

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
    // note row + totals row + group band row + column name row + 3 data rows
    expect(worksheet.rowCount).toBe(7);
    expect(worksheet.getRow(TOTALS_ROW).getCell(1).value).toBe("TOTAL");
    expect(worksheet.getRow(GROUP_ROW).getCell(1).value).toBe("Asset Identification");
    const headerRow = worksheet.getRow(HEADER_ROW).values as unknown[];
    expect(headerRow).toContain("FAR ID");
    expect(worksheet.getRow(TOTALS_ROW).getCell(1).font?.bold).toBe(true);
    expect(worksheet.getRow(GROUP_ROW).getCell(1).font?.bold).toBe(true);
    expect(worksheet.getRow(HEADER_ROW).getCell(1).font?.bold).toBe(true);
    // Group band keeps a distinct fill per group (color stays in the export even though
    // the on-screen Register table dropped it) — column 1 (Asset ID) and column 14 (C1
    // Opening, Gross Block group) must differ.
    const g1Fill = worksheet.getRow(GROUP_ROW).getCell(1).fill as { fgColor?: { argb?: string } };
    const g2Fill = worksheet.getRow(GROUP_ROW).getCell(14).fill as { fgColor?: { argb?: string } };
    expect(g1Fill.fgColor?.argb).toBeTruthy();
    expect(g1Fill.fgColor?.argb).not.toBe(g2Fill.fgColor?.argb);
    // 40 columns, dates as DD-MM-YYYY, currency with 2 decimals
    expect((worksheet.getRow(HEADER_ROW).values as unknown[]).length - 1).toBe(40);
    const firstDataRow = worksheet.getRow(FIRST_DATA_ROW);
    expect(firstDataRow.getCell(3).value).toBe("01-01-2020"); // Date Acquired
    expect(worksheet.getColumn(14).numFmt).toBe("#,##0.00"); // C1 Opening (a numeric column)
  });

  it("excludes an asset from the export when AS_AT is before its own capitalization date", async () => {
    await insertAsset("EXP-OLD", { date_acquired: "2020-01-01" });
    await insertAsset("EXP-NEW", { date_acquired: "2026-06-01" });

    const res = await authedInject(app, { method: "GET", url: "/api/assets/export?asAt=2026-03-31" });
    const worksheet = await readWorkbook(res.rawPayload);
    // note + totals + group band + header + only EXP-OLD (EXP-NEW isn't capitalized yet)
    expect(worksheet.rowCount).toBe(5);
    const dataRow = worksheet.getRow(FIRST_DATA_ROW).values as unknown[];
    expect(dataRow).toContain("EXP-OLD");
    expect(dataRow).not.toContain("EXP-NEW");
  });

  it("applies filters (center) so only matching rows are exported", async () => {
    await insertAsset("EXP-4");
    await insertAsset("EXP-5", { location: "Center-Other" });

    const res = await authedInject(app, { method: "GET", url: "/api/assets/export?center=Center-Export" });
    const worksheet = await readWorkbook(res.rawPayload);
    expect(worksheet.rowCount).toBe(5);
    const dataRow = worksheet.getRow(FIRST_DATA_ROW).values as unknown[];
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
    expect(worksheet.rowCount).toBe(5);
    const dataRow = worksheet.getRow(FIRST_DATA_ROW).values as unknown[];
    expect(dataRow).toContain("EXP-CAPLOC-1");
  });

  it("sums numeric columns (Qty and C1 Opening Cost) into the totals row, respecting the same filters", async () => {
    await insertAsset("EXP-TOTALS-1", { qty: 2, c1_opening_cost: 10000 });
    await insertAsset("EXP-TOTALS-2", { qty: 3, c1_opening_cost: 25000, location: "Center-Other" });

    const res = await authedInject(app, { method: "GET", url: "/api/assets/export?center=Center-Export" });
    const worksheet = await readWorkbook(res.rawPayload);
    const totalsRow = worksheet.getRow(TOTALS_ROW);
    // Qty is column 11, C1 Opening Cost is column 14 (see EXPORT_COLUMNS order).
    expect(totalsRow.getCell(11).value).toBe(2);
    expect(totalsRow.getCell(14).value).toBe(10000);
  });

  it("blanks the totals row for non-numeric and non-totalable columns (Useful Life)", async () => {
    await insertAsset("EXP-BLANK-1", { useful_life_c1_years: 7 });
    const res = await authedInject(app, { method: "GET", url: "/api/assets/export" });
    const worksheet = await readWorkbook(res.rawPayload);
    const totalsRow = worksheet.getRow(TOTALS_ROW);
    expect(totalsRow.getCell(2).value).toBeNull(); // Sub Classification
    expect(totalsRow.getCell(12).value).toBeNull(); // Useful Life C1 (Yrs)
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

  describe("filter-summary note (row 1)", () => {
    it("reads 'No filters applied' plus an export timestamp when nothing is filtered", async () => {
      await insertAsset("EXP-NOTE-1");
      const res = await authedInject(app, { method: "GET", url: "/api/assets/export" });
      const worksheet = await readWorkbook(res.rawPayload);
      const note = worksheet.getRow(NOTE_ROW).getCell(1).value as string;
      expect(note).toContain("Filters applied: No filters applied");
      expect(note).toMatch(/Exported: \d{2}-\d{2}-\d{4} \d{2}:\d{2} IST/);
    });

    it("describes an applied named filter (Status)", async () => {
      await insertAsset("EXP-NOTE-2", { status: "Disposed" });
      const res = await authedInject(app, { method: "GET", url: "/api/assets/export?status=Disposed" });
      const worksheet = await readWorkbook(res.rawPayload);
      const note = worksheet.getRow(NOTE_ROW).getCell(1).value as string;
      expect(note).toContain("Filters applied: Status: Disposed");
    });

    it("describes an applied column condition, including a computed column (C1 NBV)", async () => {
      await insertAsset("EXP-NOTE-3", { c1_opening_cost: 900000, useful_life_c1_years: 1000 });
      const res = await authedInject(app, {
        method: "GET",
        url: `/api/assets/export?${conditionsParam([{ columnId: "c1Nbv", op: "gt", value: "500000" }])}`
      });
      const worksheet = await readWorkbook(res.rawPayload);
      const note = worksheet.getRow(NOTE_ROW).getCell(1).value as string;
      expect(note).toContain("Filters applied: C1 NBV: greater than ₹5,00,000");
    });

    it("combines a named filter and a condition in one note, semicolon-separated", async () => {
      await insertAsset("EXP-NOTE-4", { status: "Active", c1_opening_cost: 900000, useful_life_c1_years: 1000 });
      const res = await authedInject(app, {
        method: "GET",
        url: `/api/assets/export?status=Active&${conditionsParam([{ columnId: "c1Nbv", op: "gt", value: "500000" }])}`
      });
      const worksheet = await readWorkbook(res.rawPayload);
      const note = worksheet.getRow(NOTE_ROW).getCell(1).value as string;
      expect(note).toContain("Filters applied: Status: Active; C1 NBV: greater than ₹5,00,000");
    });

    it("is styled as italic metadata, not a bold data/header row", async () => {
      await insertAsset("EXP-NOTE-STYLE-1");
      const res = await authedInject(app, { method: "GET", url: "/api/assets/export" });
      const worksheet = await readWorkbook(res.rawPayload);
      const noteCell = worksheet.getRow(NOTE_ROW).getCell(1);
      expect(noteCell.font?.italic).toBe(true);
      expect(noteCell.font?.bold).not.toBe(true);
    });
  });

  describe("column-condition filtering (conditions param)", () => {
    it("a text condition (contains) filters the exported rows, same as the named filters", async () => {
      await insertAsset("EXP-COND-1", { asset_description: "Dialysis Machine" });
      await insertAsset("EXP-COND-2", { asset_description: "Office Chair" });

      const res = await authedInject(app, {
        method: "GET",
        url: `/api/assets/export?${conditionsParam([{ columnId: "assetDescription", op: "contains", value: "dialysis" }])}`
      });
      const worksheet = await readWorkbook(res.rawPayload);
      expect(worksheet.rowCount).toBe(5);
      const dataRow = worksheet.getRow(FIRST_DATA_ROW).values as unknown[];
      expect(dataRow).toContain("EXP-COND-1");
    });

    it("a number condition on a computed field (C1 NBV) filters via the same far_calc_component CTE the grid uses", async () => {
      await insertAsset("EXP-COND-LOW", { c1_opening_cost: 50000, useful_life_c1_years: 1000 });
      await insertAsset("EXP-COND-HIGH", { c1_opening_cost: 900000, useful_life_c1_years: 1000 });

      const res = await authedInject(app, {
        method: "GET",
        url: `/api/assets/export?${conditionsParam([{ columnId: "c1Nbv", op: "gt", value: "500000" }])}`
      });
      const worksheet = await readWorkbook(res.rawPayload);
      expect(worksheet.rowCount).toBe(5);
      const dataRow = worksheet.getRow(FIRST_DATA_ROW).values as unknown[];
      expect(dataRow).toContain("EXP-COND-HIGH");
      expect(dataRow).not.toContain("EXP-COND-LOW");
    });

    it("the totals row reflects the computed-column-filtered subset, not the whole table", async () => {
      await insertAsset("EXP-COND-TOT-LOW", { qty: 100, c1_opening_cost: 50000, useful_life_c1_years: 1000 });
      await insertAsset("EXP-COND-TOT-HIGH", { qty: 3, c1_opening_cost: 900000, useful_life_c1_years: 1000 });

      const res = await authedInject(app, {
        method: "GET",
        url: `/api/assets/export?${conditionsParam([{ columnId: "c1Nbv", op: "gt", value: "500000" }])}`
      });
      const worksheet = await readWorkbook(res.rawPayload);
      const totalsRow = worksheet.getRow(TOTALS_ROW);
      expect(totalsRow.getCell(11).value).toBe(3); // Qty total — only the HIGH asset counted
    });

    it("an unknown columnId is rejected with 400, matching GET /api/assets", async () => {
      const res = await authedInject(app, {
        method: "GET",
        url: `/api/assets/export?${conditionsParam([{ columnId: "notARealColumn", op: "equals", value: "x" }])}`
      });
      expect(res.statusCode).toBe(400);
    });

    it("more than EXPORT_BATCH_SIZE-spanning results still all export correctly under a computed filter (batch loop composes with filtering)", async () => {
      // Small enough to run fast, big enough to exercise more than a trivial one-row
      // result — proves the per-batch CTE + WHERE + cursor combination doesn't drop or
      // duplicate rows across iterations, not just that it filters within one page.
      for (let i = 0; i < 5; i++) {
        await insertAsset(`EXP-COND-BATCH-MATCH-${i}`, { c1_opening_cost: 900000, useful_life_c1_years: 1000 });
      }
      for (let i = 0; i < 5; i++) {
        await insertAsset(`EXP-COND-BATCH-SKIP-${i}`, { c1_opening_cost: 1000 });
      }

      const res = await authedInject(app, {
        method: "GET",
        url: `/api/assets/export?${conditionsParam([{ columnId: "c1Nbv", op: "gt", value: "500000" }])}`
      });
      const worksheet = await readWorkbook(res.rawPayload);
      const farIds: string[] = [];
      for (let r = FIRST_DATA_ROW; r <= worksheet.rowCount; r++) {
        farIds.push(worksheet.getRow(r).getCell(1).value as string);
      }
      expect(farIds.sort()).toEqual(
        Array.from({ length: 5 }, (_, i) => `EXP-COND-BATCH-MATCH-${i}`).sort()
      );
    });

    it("filters on Last Transaction Date (regression — shares assetColumnFilters.ts's buildCalcCteExtras with GET /api/assets, so the same column-name collision would have broken this route too)", async () => {
      await insertAsset("EXP-LTD-OLD");
      await insertAsset("EXP-LTD-NEW");
      const db = await getPool();
      await db.query(`INSERT INTO transfers (far_id, transaction_date, location) VALUES ('EXP-LTD-NEW', '2026-08-01', 'Center-Other')`);

      const res = await authedInject(app, {
        method: "GET",
        url: `/api/assets/export?${conditionsParam([{ columnId: "lastDateOfTransaction", op: "after", value: "2026-01-01" }])}`
      });
      expect(res.statusCode).toBe(200);
      const worksheet = await readWorkbook(res.rawPayload);
      expect(worksheet.rowCount).toBe(5);
      const dataRow = worksheet.getRow(FIRST_DATA_ROW).values as unknown[];
      expect(dataRow).toContain("EXP-LTD-NEW");
      expect(dataRow).not.toContain("EXP-LTD-OLD");
    });
  });

  describe("Has Component 2: hides C2 columns only when filtered to Sub Classification(s) that are all C1-only", () => {
    beforeEach(async () => {
      const db = await getPool();
      await db.query(`DELETE FROM sub_classifications`);
      await db.query(`INSERT INTO sub_classifications (name, has_component2) VALUES ('C1-Only-Export', FALSE), ('Mixed-Export', TRUE)`);
    });

    it("drops every C2 column when filtered to a single C1-only Sub Classification", async () => {
      await insertAsset("EXP-C1ONLY-1", { sub_classification: "C1-Only-Export" });

      const res = await authedInject(app, {
        method: "GET",
        url: "/api/assets/export?subClassification=C1-Only-Export"
      });
      expect(res.statusCode).toBe(200);
      const worksheet = await readWorkbook(res.rawPayload);
      const headerRow = (worksheet.getRow(HEADER_ROW).values as unknown[]).slice(1) as string[];
      // 40 columns total normally, 12 of them Component 2 — see assetsExport.ts's
      // C2_EXPORT_KEYS.
      expect(headerRow.length).toBe(28);
      expect(headerRow.some((h) => /\bC2\b/.test(h))).toBe(false);
      expect(headerRow.some((h) => /\bC1\b/.test(h))).toBe(true);
    });

    it("keeps every column when filtered to a Sub Classification that has Component 2", async () => {
      await insertAsset("EXP-MIXED-1", { sub_classification: "Mixed-Export" });

      const res = await authedInject(app, { method: "GET", url: "/api/assets/export?subClassification=Mixed-Export" });
      const worksheet = await readWorkbook(res.rawPayload);
      const headerRow = (worksheet.getRow(HEADER_ROW).values as unknown[]).slice(1) as string[];
      expect(headerRow.length).toBe(40);
      expect(headerRow.some((h) => /\bC2\b/.test(h))).toBe(true);
    });

    it("keeps every column when filtered to a mix of C1-only and C1+C2 classifications", async () => {
      await insertAsset("EXP-MIX-A", { sub_classification: "C1-Only-Export" });
      await insertAsset("EXP-MIX-B", { sub_classification: "Mixed-Export" });

      const res = await authedInject(app, {
        method: "GET",
        url: "/api/assets/export?subClassification=C1-Only-Export,Mixed-Export"
      });
      const worksheet = await readWorkbook(res.rawPayload);
      const headerRow = (worksheet.getRow(HEADER_ROW).values as unknown[]).slice(1) as string[];
      expect(headerRow.length).toBe(40);
      expect(headerRow.some((h) => /\bC2\b/.test(h))).toBe(true);
    });

    it("keeps every column with no Sub Classification filter at all, even if every asset happens to be C1-only", async () => {
      await insertAsset("EXP-UNFILTERED-1", { sub_classification: "C1-Only-Export" });

      const res = await authedInject(app, { method: "GET", url: "/api/assets/export" });
      const worksheet = await readWorkbook(res.rawPayload);
      const headerRow = worksheet.getRow(HEADER_ROW).values as unknown[];
      expect(headerRow.length - 1).toBe(40);
    });
  });

  describe("an unexpected DB-level query failure is reported gracefully, not as a raw 500", () => {
    it("the totals query throwing returns a plain-language JSON error, never the raw driver error text", async () => {
      await insertAsset("EXP-DBFAIL-1");
      const db = await getPool();
      const originalQuery = db.query.bind(db);
      const spy = vi.spyOn(db, "query").mockImplementation((...args: unknown[]) => {
        const sql = args[0];
        if (typeof sql === "string" && sql.includes("SUM(")) {
          return Promise.reject(
            Object.assign(new Error('column reference "some_column" is ambiguous'), { code: "42702" })
          );
        }
        return (originalQuery as (...a: unknown[]) => unknown)(...args);
      });

      try {
        const res = await authedInject(app, { method: "GET", url: "/api/assets/export" });
        expect(res.statusCode).toBe(500);
        const body = res.json();
        expect(body.error).not.toMatch(/ambiguous|42702|column reference/i);
        expect(body.error).toMatch(/could not export the register/i);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
