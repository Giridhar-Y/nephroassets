import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import assetsExportRoutes, { EXPORT_ROW_LIMIT } from "./assetsExport.js";
import assetsRoutes from "./assets.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";
import { generateAssets, generateTransfers } from "../loadtest/generateAssets.js";
import { bulkInsertAssets, bulkInsertTransfers } from "../loadtest/bulkInsert.js";

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

/** Splits one CSV line into fields, honoring RFC4180 quoting — the read-side mirror of
 *  assetsExport.ts's own csvField/csvLine (and the same algorithm as the client's
 *  splitCsvFields in csvChunking.ts), ported here since server and client share no
 *  package boundary. */
function splitCsvFields(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** Parses the export's CSV response into rows of string fields. 1-based row/column
 *  accessors below (readRow/cell) match the row/column numbering this file used when it
 *  parsed an xlsx workbook via ExcelJS's own 1-based API (NOTE_ROW=1 etc.) — most
 *  assertions below only needed their VALUE comparisons updated for the move to CSV
 *  (every field is a plain string now — no native number or null/blank distinction),
 *  not their row/column arithmetic. */
function readCsv(payload: Buffer): string[][] {
  const text = payload.toString("utf-8");
  const lines = text.split("\r\n").filter((l) => l.length > 0);
  return lines.map(splitCsvFields);
}

function readRow(rows: string[][], rowNumber: number): string[] {
  return rows[rowNumber - 1] ?? [];
}

function cell(rows: string[][], rowNumber: number, colNumber: number): string {
  return readRow(rows, rowNumber)[colNumber - 1] ?? "";
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
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(assetsExportRoutes);
    // Also registered here (not just assetsExportRoutes) so the exception drill-through
    // tests below can prove the export's row set matches GET /api/assets's for the same
    // ?exception=<key> — the same "same predicate, same answer" property
    // reports.test.ts's dashboard-summary/GET /api/assets cross-check already proves,
    // extended to the third and last consumer of exceptionPredicates.ts.
    await app.register(assetsRoutes);
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
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");

    const rows = readCsv(res.rawPayload);
    // note row + totals row + group band row + column name row + 3 data rows
    expect(rows.length).toBe(7);
    expect(cell(rows, TOTALS_ROW, 1)).toBe("TOTAL");
    expect(cell(rows, GROUP_ROW, 1)).toBe("Asset Identification");
    const headerRow = readRow(rows, HEADER_ROW);
    expect(headerRow).toContain("FAR ID");
    // 40 columns, dates as DD-MM-YYYY. (Bold/italic fonts, per-group fill color, merged
    // cells, and column number formatting were the old ExcelJS export's styling — none
    // of it survives a plain CSV, by design; see assetsExport.ts's own comment on why
    // this is one format for every export size now instead of two parallel ones.)
    expect(headerRow.length).toBe(40);
    expect(cell(rows, FIRST_DATA_ROW, 3)).toBe("01-01-2020"); // Date Acquired
  });

  it("excludes an asset from the export when AS_AT is before its own capitalization date", async () => {
    await insertAsset("EXP-OLD", { date_acquired: "2020-01-01" });
    await insertAsset("EXP-NEW", { date_acquired: "2026-06-01" });

    const res = await authedInject(app, { method: "GET", url: "/api/assets/export?asAt=2026-03-31" });
    const rows = readCsv(res.rawPayload);
    // note + totals + group band + header + only EXP-OLD (EXP-NEW isn't capitalized yet)
    expect(rows.length).toBe(5);
    const dataRow = readRow(rows, FIRST_DATA_ROW);
    expect(dataRow).toContain("EXP-OLD");
    expect(dataRow).not.toContain("EXP-NEW");
  });

  it("applies filters (center) so only matching rows are exported", async () => {
    await insertAsset("EXP-4");
    await insertAsset("EXP-5", { location: "Center-Other" });

    const res = await authedInject(app, { method: "GET", url: "/api/assets/export?center=Center-Export" });
    const rows = readCsv(res.rawPayload);
    expect(rows.length).toBe(5);
    expect(readRow(rows, FIRST_DATA_ROW)).toContain("EXP-4");
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
    const rows = readCsv(res.rawPayload);
    expect(rows.length).toBe(5);
    expect(readRow(rows, FIRST_DATA_ROW)).toContain("EXP-CAPLOC-1");
  });

  it("sums numeric columns (Qty and C1 Opening Cost) into the totals row, respecting the same filters", async () => {
    await insertAsset("EXP-TOTALS-1", { qty: 2, c1_opening_cost: 10000 });
    await insertAsset("EXP-TOTALS-2", { qty: 3, c1_opening_cost: 25000, location: "Center-Other" });

    const res = await authedInject(app, { method: "GET", url: "/api/assets/export?center=Center-Export" });
    const rows = readCsv(res.rawPayload);
    // Qty is column 11, C1 Opening Cost is column 14 (see EXPORT_COLUMNS order).
    expect(cell(rows, TOTALS_ROW, 11)).toBe("2");
    expect(cell(rows, TOTALS_ROW, 14)).toBe("10000");
  });

  it("blanks the totals row for non-numeric and non-totalable columns (Useful Life)", async () => {
    await insertAsset("EXP-BLANK-1", { useful_life_c1_years: 7 });
    const res = await authedInject(app, { method: "GET", url: "/api/assets/export" });
    const rows = readCsv(res.rawPayload);
    expect(cell(rows, TOTALS_ROW, 2)).toBe(""); // Sub Classification
    expect(cell(rows, TOTALS_ROW, 12)).toBe(""); // Useful Life C1 (Yrs)
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
      const rows = readCsv(res.rawPayload);
      const note = cell(rows, NOTE_ROW, 1);
      expect(note).toContain("Filters applied: No filters applied");
      expect(note).toMatch(/Exported: \d{2}-\d{2}-\d{4} \d{2}:\d{2} IST/);
    });

    it("describes an applied named filter (Status)", async () => {
      await insertAsset("EXP-NOTE-2", { status: "Disposed" });
      const res = await authedInject(app, { method: "GET", url: "/api/assets/export?status=Disposed" });
      const rows = readCsv(res.rawPayload);
      expect(cell(rows, NOTE_ROW, 1)).toContain("Filters applied: Status: Disposed");
    });

    it("describes an applied column condition, including a computed column (C1 NBV)", async () => {
      await insertAsset("EXP-NOTE-3", { c1_opening_cost: 900000, useful_life_c1_years: 1000 });
      const res = await authedInject(app, {
        method: "GET",
        url: `/api/assets/export?${conditionsParam([{ columnId: "c1Nbv", op: "gt", value: "500000" }])}`
      });
      const rows = readCsv(res.rawPayload);
      expect(cell(rows, NOTE_ROW, 1)).toContain("Filters applied: C1 NBV: greater than ₹5,00,000");
    });

    it("combines a named filter and a condition in one note, semicolon-separated", async () => {
      await insertAsset("EXP-NOTE-4", { status: "Active", c1_opening_cost: 900000, useful_life_c1_years: 1000 });
      const res = await authedInject(app, {
        method: "GET",
        url: `/api/assets/export?status=Active&${conditionsParam([{ columnId: "c1Nbv", op: "gt", value: "500000" }])}`
      });
      const rows = readCsv(res.rawPayload);
      expect(cell(rows, NOTE_ROW, 1)).toContain("Filters applied: Status: Active; C1 NBV: greater than ₹5,00,000");
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
      const rows = readCsv(res.rawPayload);
      expect(rows.length).toBe(5);
      expect(readRow(rows, FIRST_DATA_ROW)).toContain("EXP-COND-1");
    });

    it("a number condition on a computed field (C1 NBV) filters via the same far_calc_component CTE the grid uses", async () => {
      await insertAsset("EXP-COND-LOW", { c1_opening_cost: 50000, useful_life_c1_years: 1000 });
      await insertAsset("EXP-COND-HIGH", { c1_opening_cost: 900000, useful_life_c1_years: 1000 });

      const res = await authedInject(app, {
        method: "GET",
        url: `/api/assets/export?${conditionsParam([{ columnId: "c1Nbv", op: "gt", value: "500000" }])}`
      });
      const rows = readCsv(res.rawPayload);
      expect(rows.length).toBe(5);
      const dataRow = readRow(rows, FIRST_DATA_ROW);
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
      const rows = readCsv(res.rawPayload);
      expect(cell(rows, TOTALS_ROW, 11)).toBe("3"); // Qty total — only the HIGH asset counted
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
      const rows = readCsv(res.rawPayload);
      const farIds: string[] = [];
      for (let r = FIRST_DATA_ROW; r <= rows.length; r++) {
        farIds.push(cell(rows, r, 1));
      }
      expect(farIds.sort()).toEqual(Array.from({ length: 5 }, (_, i) => `EXP-COND-BATCH-MATCH-${i}`).sort());
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
      const rows = readCsv(res.rawPayload);
      expect(rows.length).toBe(5);
      const dataRow = readRow(rows, FIRST_DATA_ROW);
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
      const rows = readCsv(res.rawPayload);
      const headerRow = readRow(rows, HEADER_ROW);
      // 40 columns total normally, 12 of them Component 2 — see assetsExport.ts's
      // C2_EXPORT_KEYS.
      expect(headerRow.length).toBe(28);
      expect(headerRow.some((h) => /\bC2\b/.test(h))).toBe(false);
      expect(headerRow.some((h) => /\bC1\b/.test(h))).toBe(true);
    });

    it("keeps every column when filtered to a Sub Classification that has Component 2", async () => {
      await insertAsset("EXP-MIXED-1", { sub_classification: "Mixed-Export" });

      const res = await authedInject(app, { method: "GET", url: "/api/assets/export?subClassification=Mixed-Export" });
      const rows = readCsv(res.rawPayload);
      const headerRow = readRow(rows, HEADER_ROW);
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
      const rows = readCsv(res.rawPayload);
      const headerRow = readRow(rows, HEADER_ROW);
      expect(headerRow.length).toBe(40);
      expect(headerRow.some((h) => /\bC2\b/.test(h))).toBe(true);
    });

    it("keeps every column with no Sub Classification filter at all, even if every asset happens to be C1-only", async () => {
      await insertAsset("EXP-UNFILTERED-1", { sub_classification: "C1-Only-Export" });

      const res = await authedInject(app, { method: "GET", url: "/api/assets/export" });
      const rows = readCsv(res.rawPayload);
      expect(readRow(rows, HEADER_ROW).length).toBe(40);
    });
  });

  // Temporary safety cap while this deployment stays on Vercel's Hobby plan (fixed 60s
  // function timeout, not raisable) — see EXPORT_ROW_LIMIT's own comment in
  // assetsExport.ts for the real Supabase Pro timing measurement it's sized against.
  // Exercised here via a mocked count rather than actually inserting 400,000+ real
  // rows — this is a fast, targeted test of the threshold check's own logic (does it
  // reject/accept at the right boundary, with a clean JSON error instead of ever
  // reaching reply.send(stream)); the real full-scale numbers are scale.loadtest.ts's
  // job.
  describe("row-count safety limit (temporary — see EXPORT_ROW_LIMIT's own comment)", () => {
    async function withMockedRowCount(rowCount: number, run: () => Promise<void>) {
      await insertAsset("EXP-ROWLIMIT-1");
      const db = await getPool();
      const originalQuery = db.query.bind(db);
      const spy = vi.spyOn(db, "query").mockImplementation(async (...args: unknown[]) => {
        const sql = args[0];
        const result = (await (originalQuery as (...a: unknown[]) => Promise<unknown>)(...args)) as {
          rows: Array<Record<string, unknown>>;
        };
        // Only countMatchingRows' own plain-count query (the fast path, no computed
        // condition here) is touched — every other query, including the totals query
        // and the batch loop's own row-fetching query, is left completely alone.
        if (typeof sql === "string" && sql.includes("COUNT(*) AS count FROM assets") && result.rows[0]) {
          result.rows[0]!.count = String(rowCount);
        }
        return result;
      });
      try {
        await run();
      } finally {
        spy.mockRestore();
      }
    }

    it(`rejects with a clean 400 (never reaching reply.send(stream)) when the filtered count exceeds EXPORT_ROW_LIMIT (${EXPORT_ROW_LIMIT.toLocaleString()})`, async () => {
      await withMockedRowCount(EXPORT_ROW_LIMIT + 1, async () => {
        const res = await authedInject(app, { method: "GET", url: "/api/assets/export" });
        expect(res.statusCode).toBe(400);
        expect(res.headers["content-type"]).not.toContain("text/csv"); // a real JSON error, not a file
        const body = res.json();
        expect(body.error).toContain(`${(EXPORT_ROW_LIMIT + 1).toLocaleString()} rows`);
        expect(body.error).toMatch(/narrow your filters/i);
      });
    });

    it("accepts a filtered count right at EXPORT_ROW_LIMIT itself (the check is exclusive on the high side)", async () => {
      await withMockedRowCount(EXPORT_ROW_LIMIT, async () => {
        const res = await authedInject(app, { method: "GET", url: "/api/assets/export" });
        expect(res.statusCode).toBe(200);
        const rows = readCsv(res.rawPayload);
        expect(rows.length).toBe(FIRST_DATA_ROW); // note + totals + group + header + the 1 real row
      });
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

  // Finance FAR Dashboard drill-through: exceptionPredicates.ts's buildExceptionPredicate
  // is shared by dashboard-summary's counts, GET /api/assets?exception=, and this export
  // route — these tests are the export route's share of "same predicate, same answer",
  // proving its row set agrees exactly with GET /api/assets's for the same key, rather
  // than trusting that wiring the same import in also means it's wired correctly.
  describe("exception=<key> drill-through (shared with GET /api/assets and dashboard-summary)", () => {
    it("filters to exactly the rows matching exception=missingData, same row set GET /api/assets returns", async () => {
      await insertAsset("EXP-EXC-MISSING", { serial_no: null });
      await insertAsset("EXP-EXC-HEALTHY", { serial_no: "SN-1" });

      const exportRes = await authedInject(app, { method: "GET", url: "/api/assets/export?exception=missingData" });
      expect(exportRes.statusCode).toBe(200);
      const rows = readCsv(exportRes.rawPayload);
      expect(rows.length).toBe(FIRST_DATA_ROW);
      expect(cell(rows, FIRST_DATA_ROW, 1)).toBe("EXP-EXC-MISSING");

      const registerRes = await authedInject(app, { method: "GET", url: "/api/assets?exception=missingData" });
      const registerFarIds = registerRes.json().items.map((i: { asset: { farId: string } }) => i.asset.farId);
      expect(registerFarIds).toEqual(["EXP-EXC-MISSING"]);
    });

    it("filters to exactly the rows matching exception=pastUsefulLifeActive, same row set GET /api/assets returns", async () => {
      // Default fixture (useful_life_c1/c2_years: 5, date_acquired: 2020-01-01) has
      // already expired by AS_AT (2026-08-17) — a real, not contrived, past-life case.
      await insertAsset("EXP-EXC-EXPIRED");
      await insertAsset("EXP-EXC-NOTEXPIRED", { useful_life_c1_years: 20, useful_life_c2_years: 20 });

      const exportRes = await authedInject(app, { method: "GET", url: "/api/assets/export?exception=pastUsefulLifeActive" });
      expect(exportRes.statusCode).toBe(200);
      const rows = readCsv(exportRes.rawPayload);
      expect(rows.length).toBe(FIRST_DATA_ROW);
      expect(cell(rows, FIRST_DATA_ROW, 1)).toBe("EXP-EXC-EXPIRED");

      const registerRes = await authedInject(app, { method: "GET", url: "/api/assets?exception=pastUsefulLifeActive" });
      const registerFarIds = registerRes.json().items.map((i: { asset: { farId: string } }) => i.asset.farId);
      expect(registerFarIds).toEqual(["EXP-EXC-EXPIRED"]);
    });

    it("names the exception in the filter-summary note, so the file is never mistaken for the full register", async () => {
      await insertAsset("EXP-EXC-NOTE", { serial_no: null });

      const res = await authedInject(app, { method: "GET", url: "/api/assets/export?exception=missingData" });
      const rows = readCsv(res.rawPayload);
      expect(cell(rows, NOTE_ROW, 1)).toMatch(/Dashboard Exception: Missing Data/);
    });

    it("combines with a named filter in the note, semicolon-separated, same as an Excel-style condition would", async () => {
      await insertAsset("EXP-EXC-COMBINED", { serial_no: null, status: "Active" });

      const res = await authedInject(app, { method: "GET", url: "/api/assets/export?status=Active&exception=missingData" });
      const rows = readCsv(res.rawPayload);
      const note = cell(rows, NOTE_ROW, 1);
      expect(note).toMatch(/Status: Active/);
      expect(note).toMatch(/Dashboard Exception: Missing Data/);
    });

    it("rejects an unknown exception key with 400, matching GET /api/assets", async () => {
      const res = await authedInject(app, { method: "GET", url: "/api/assets/export?exception=notARealException" });
      expect(res.statusCode).toBe(400);
    });
  });

  // Regression coverage for a reported production bug: a corrupted "far-register-....xlsx"
  // download once the register held 217,000+ real assets. The full-scale timing
  // measurement lives in loadtest/scale.loadtest.ts (npm run test:scale) since seeding
  // that many rows takes minutes; this file's own fixtures never exceeded
  // EXPORT_BATCH_SIZE before now, so the batch-cursor loop's row-continuity across a
  // real page boundary — and each asset's transfers being matched to the right FAR ID
  // after the Map-based rewrite (previously an O(n²) `.filter()`) — had never actually
  // been exercised here at more than a token handful of rows.
  describe(`multi-batch export (thousands of rows, spans a real EXPORT_BATCH_SIZE page) produces a complete, well-formed CSV`, () => {
    it("every asset appears exactly once, in FAR ID order, with each asset's own transfers correctly matched across a batch boundary", async () => {
      const ASSET_COUNT = 4500; // spans a real batch boundary regardless of EXPORT_BATCH_SIZE's exact value
      const assets = generateAssets(ASSET_COUNT, 555);
      const db = await getPool();
      await bulkInsertAssets(db, assets, 1000);
      const transfers = generateTransfers(assets, 999);
      await bulkInsertTransfers(db, transfers, 1000);

      const res = await authedInject(app, { method: "GET", url: "/api/assets/export" });
      expect(res.statusCode).toBe(200);

      // A killed-mid-stream write would leave the payload not ending in a line
      // terminator, or with fewer lines than expected — the direct proof this is a
      // complete file, not just "some bytes came back" (the exact failure mode the
      // reported bug produced: a 200 response that then turned out incomplete).
      const text = res.rawPayload.toString("utf-8");
      expect(text.endsWith("\r\n")).toBe(true);
      const rows = readCsv(res.rawPayload);
      expect(rows.length).toBe(FIRST_DATA_ROW - 1 + ASSET_COUNT);

      const exportedFarIds: string[] = [];
      for (let r = FIRST_DATA_ROW; r <= rows.length; r++) {
        exportedFarIds.push(cell(rows, r, 1));
      }
      // No row dropped or duplicated across the batch cursor walk.
      expect(exportedFarIds).toEqual([...assets].map((a) => a.farId).sort());

      // Current Location (column 6) reflects each asset's OWN latest transfer, not a
      // neighbor's from the same batch — exactly what the old per-row `.filter()` (and
      // the Map-based rewrite replacing it) both have to get right. Picks one asset
      // known to have at least one transfer rather than asserting on all 4,500.
      const transferredFarId = transfers[0]!.farId;
      const rowIndex = exportedFarIds.indexOf(transferredFarId);
      const expectedLocation = [...transfers]
        .filter((t) => t.farId === transferredFarId)
        .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate))
        .at(-1)!.location;
      expect(cell(rows, FIRST_DATA_ROW + rowIndex, 6)).toBe(expectedLocation);
    }, 30_000);
  });

  // A DB error genuinely thrown WHILE the process is still running (a bad query, a
  // dropped connection) — not the same failure mode as a Vercel platform timeout/OOM
  // kill, which terminates the process outright and never reaches this catch block at
  // all (see assetsExport.ts's own comment on why that class of failure can't be made
  // visible this way).
  //
  // Empirically found while writing this test (not assumed): `light-my-request`
  // (Fastify's own injection library, which models real Node HTTP response semantics
  // closely) rejects the whole request with "response destroyed before completion"
  // when `stream.destroy(err)` runs after `reply.send(stream)` — it does NOT hand back
  // a "successful" 200 with a merely-truncated body. That's real signal: destroying the
  // stream is not the do-nothing-useful gesture it might look like — over a real HTTP
  // connection this almost certainly aborts the response at the transport level (an
  // abrupt close a browser's fetch()/download manager should surface as a failed
  // request), not a completed-but-corrupted download. This sharpens where the actual
  // silent-corruption risk lives: NOT the catchable-JS-error path this test covers
  // (which already fails loudly, transport-level, on top of the app's own log line) —
  // it's specifically a platform-level timeout/OOM kill, which skips this catch block
  // (and therefore this transport-level abort) entirely, because the process is
  // terminated outright rather than throwing.
  describe("a genuine mid-stream DB failure (after headers are already sent) aborts the response and logs loudly, rather than completing a corrupted file silently", () => {
    it("destroys the response (light-my-request surfaces this as a rejected request, the same signal a real client's aborted connection would give) and logs the failure server-side", async () => {
      await insertAsset("EXP-MIDFAIL-1");
      const db = await getPool();
      const originalQuery = db.query.bind(db);
      const spy = vi.spyOn(db, "query").mockImplementation((...args: unknown[]) => {
        const sql = args[0];
        // Only the per-batch row-fetching query fails — matches either the fast
        // no-CTE branch or the CTE branch (both end the same way), so this stays
        // correct regardless of which one a given request takes. The totals query
        // (which runs BEFORE reply.send(stream), so a failure there is still a normal
        // 500 today, already covered above) and the row-count check are left alone.
        if (typeof sql === "string" && sql.includes("ORDER BY far_id LIMIT")) {
          return Promise.reject(new Error("simulated mid-stream DB failure"));
        }
        return (originalQuery as (...a: unknown[]) => unknown)(...args);
      });
      const errorLogSpy = vi.spyOn(app.log, "error");

      try {
        await expect(authedInject(app, { method: "GET", url: "/api/assets/export" })).rejects.toThrow(/destroyed/i);
        expect(errorLogSpy).toHaveBeenCalledWith(expect.anything(), "Register export failed mid-stream");
      } finally {
        spy.mockRestore();
        errorLogSpy.mockRestore();
      }
    });
  });
});
