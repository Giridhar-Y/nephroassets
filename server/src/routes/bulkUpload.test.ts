import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bulkUploadRoutes from "./bulkUpload.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";
import { csvPayload, emptyMultipartPayload } from "./bulkTestHelpers.js";
import { createTestUser, authHeaderFor } from "../testHelpers/authTestUtils.js";

const HEADER =
  "farId,subClassification,assetDescription,status,dateAcquired,location,usefulLifeC1Years,usefulLifeC2Years,c1OpeningCost,c2OpeningCost";

describe("Bulk Upload: POST /api/assets/bulk-upload", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(multipart);
    await app.register(bulkUploadRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    // status/subClassification/location are now validated against the active Masters
    // lists (routes/masters.ts) — seed what these fixtures use.
    await db.query(`DELETE FROM centers`);
    await db.query(`DELETE FROM sub_classifications`);
    await db.query(`DELETE FROM statuses`);
    await db.query(`INSERT INTO centers (code) VALUES ('Center-A')`);
    await db.query(`INSERT INTO sub_classifications (name) VALUES ('Test-Sub')`);
    await db.query(`INSERT INTO sub_classifications (name, has_component2) VALUES ('C1-Only-Sub', FALSE)`);
    await db.query(
      `INSERT INTO statuses (name, system_managed) VALUES ('Active', FALSE), ('Under Repair', FALSE), ('Disposed', TRUE)`
    );
  });

  it("upserts valid rows and reports errors for invalid ones", async () => {
    const csv = [
      HEADER,
      "BULK-1,Test-Sub,Bulk Asset One,Active,2020-01-01,Center-A,5,5,1000,1000",
      "BULK-2,,Bulk Asset Missing Sub,Active,2020-01-01,Center-A,5,5,1000,1000"
    ].join("\n");

    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.processed).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].farId).toBe("BULK-2");

    const db = await getPool();
    const { rows } = await db.query(`SELECT far_id FROM assets WHERE far_id = 'BULK-1'`);
    expect(rows).toHaveLength(1);
  });

  it("reports how many rows were added vs. updated", async () => {
    const first = [HEADER, "BULK-ADD,Test-Sub,First Asset,Active,2020-01-01,Center-A,5,5,1000,1000"].join("\n");
    await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(first) });

    const second = [
      HEADER,
      "BULK-ADD,Test-Sub,First Asset Updated,Active,2020-01-01,Center-A,5,5,1000,1000",
      "BULK-NEW,Test-Sub,Second Asset,Active,2020-01-01,Center-A,5,5,1000,1000"
    ].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(second) });
    const body = res.json();
    expect(body.processed).toBe(2);
    expect(body.added).toBe(1);
    expect(body.updated).toBe(1);
  });

  it("re-uploading the same FAR ID updates the existing asset instead of erroring", async () => {
    const first = [HEADER, "BULK-3,Test-Sub,Original,Active,2020-01-01,Center-A,5,5,1000,1000"].join("\n");
    await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(first) });

    const second = [HEADER, "BULK-3,Test-Sub,Updated Description,Active,2020-01-01,Center-A,5,5,2000,2000"].join(
      "\n"
    );
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(second) });
    expect(res.json().processed).toBe(1);

    const db = await getPool();
    const { rows } = await db.query(`SELECT asset_description, c1_opening_cost FROM assets WHERE far_id = 'BULK-3'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].asset_description).toBe("Updated Description");
    expect(rows[0].c1_opening_cost).toBe("2000");
  });

  it("400s when no file is uploaded", async () => {
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...emptyMultipartPayload() });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a dateOfDisposal whose status isn't \"Disposed\" (silently split from the Disposals screen and the calc engine)", async () => {
    const withDisposalHeader = HEADER + ",dateOfDisposal";
    const csv = [withDisposalHeader, "BULK-MISMATCH-1,Test-Sub,Bad Combo,Under Repair,2020-01-01,Center-A,5,5,1000,1000,01-08-2026"].join(
      "\n"
    );
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors[0].message).toMatch(/dateOfDisposal is set but status is "Under Repair"/);
  });

  it('rejects status "Disposed" with no dateOfDisposal', async () => {
    const csv = [HEADER, "BULK-MISMATCH-2,Test-Sub,Bad Combo,Disposed,2020-01-01,Center-A,5,5,1000,1000"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors[0].message).toMatch(/status is "Disposed" but dateOfDisposal is not set/);
  });

  it("rejects a dateOfDisposal before dateAcquired within the same row", async () => {
    const withDisposalHeader = HEADER + ",dateOfDisposal";
    const csv = [
      withDisposalHeader,
      "BULK-EARLY-DISPOSAL,Test-Sub,Bad Dates,Disposed,01-04-2026,Center-A,5,5,1000,1000,15-03-2026"
    ].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors[0].message).toMatch(/Disposal date cannot be before the capitalization date \(01-04-2026\)/);
  });

  it("rejects a dateOfDisposal before dateOfAddition within the same row", async () => {
    const withAdditionAndDisposalHeader = HEADER + ",additionsC1,dateOfAddition,dateOfDisposal";
    const csv = [
      withAdditionAndDisposalHeader,
      "BULK-ADD-AFTER-DISPOSAL,Test-Sub,Bad Dates,Disposed,01-01-2020,Center-A,5,5,1000,1000,5000,15-08-2026,01-04-2026"
    ].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors[0].message).toMatch(/Disposal date cannot be before the addition date \(15-08-2026\)/);
  });

  it("allows a dateOfDisposal exactly on dateAcquired within the same row (boundary is >=, not >)", async () => {
    const withDisposalHeader = HEADER + ",dateOfDisposal";
    const csv = [
      withDisposalHeader,
      "BULK-BOUNDARY-DISPOSAL,Test-Sub,Same-Day Disposal,Disposed,01-04-2026,Center-A,5,5,1000,1000,01-04-2026"
    ].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    expect(res.json().processed).toBe(1);
  });

  // No character-set restriction — a real-world source system's FAR ID could be
  // anything, so both a lowercase/mixed one and a hyphenated one must succeed equally.
  it("accepts FAR IDs in any format — lowercase, mixed case, and hyphenated all succeed", async () => {
    const csv = [
      HEADER,
      "temp1234,Test-Sub,Lowercase Format,Active,2020-01-01,Center-A,5,5,1000,1000",
      "616-PB-BTI-GNR-C,Test-Sub,Real-World Format,Active,2020-01-01,Center-A,5,5,1000,1000"
    ].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(2);
    expect(body.errors).toHaveLength(0);

    const db = await getPool();
    const { rows } = await db.query(
      `SELECT far_id FROM assets WHERE far_id IN ('temp1234', '616-PB-BTI-GNR-C') ORDER BY far_id`
    );
    expect(rows).toHaveLength(2);
  });

  it("still rejects a blank FAR ID", async () => {
    const csv = [HEADER, ",Test-Sub,Missing FAR ID,Active,2020-01-01,Center-A,5,5,1000,1000"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors).toHaveLength(1);
  });

  it("rejects a subClassification/status/location that isn't in the active Masters lists", async () => {
    const csv = [HEADER, "BULK-UNKNOWN,Not A Real Sub,Bad Combo,Not A Real Status,2020-01-01,Not-A-Real-Center,5,5,1000,1000"].join(
      "\n"
    );
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors[0].message).toMatch(/Sub Classification "Not A Real Sub" not recognized/);
    expect(body.errors[0].message).toMatch(/Status "Not A Real Status" not recognized/);
    expect(body.errors[0].message).toMatch(/Location "Not-A-Real-Center" not recognized/);
  });

  it("matches a master value case-insensitively but stores the master list's own canonical casing", async () => {
    const csv = [HEADER, "BULK-CASING,test-sub,Casing Test,ACTIVE,2020-01-01,center-a,5,5,1000,1000"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    expect(res.json().processed).toBe(1);

    const db = await getPool();
    const { rows } = await db.query(
      `SELECT sub_classification, status, location FROM assets WHERE far_id = 'BULK-CASING'`
    );
    expect(rows[0]).toEqual({ sub_classification: "Test-Sub", status: "Active", location: "Center-A" });
  });

  it("rejects additionsC1 with no dateOfAddition (would silently never depreciate)", async () => {
    const withAdditionsHeader = HEADER + ",additionsC1";
    const csv = [withAdditionsHeader, "BULK-MISMATCH-3,Test-Sub,Bad Combo,Active,2020-01-01,Center-A,5,5,1000,1000,5000"].join(
      "\n"
    );
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors[0].message).toMatch(/dateOfAddition is required/);
  });

  it("rejects Opening Acc Dep exceeding Opening Cost for either component", async () => {
    const withAccDepHeader = HEADER + ",accDepC1Opening,accDepC2Opening";
    const csv = [
      withAccDepHeader,
      "BULK-BAD-ACCDEP,Test-Sub,Bad Acc Dep,Active,2020-01-01,Center-A,5,5,1000,1000,1001,0",
      "BULK-OK-ACCDEP,Test-Sub,Boundary OK,Active,2020-01-01,Center-A,5,5,1000,1000,1000,1000"
    ].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].farId).toBe("BULK-BAD-ACCDEP");
    expect(body.errors[0].message).toMatch(/cannot exceed Component 1 Opening Cost/);

    const db = await getPool();
    const { rows } = await db.query(`SELECT far_id FROM assets WHERE far_id LIKE 'BULK-%ACCDEP'`);
    expect(rows.map((r) => r.far_id)).toEqual(["BULK-OK-ACCDEP"]);
  });

  describe("Has Component 2", () => {
    it("rejects a row with non-zero C2 opening cost against a C1-only Sub Classification", async () => {
      const csv = [
        HEADER,
        "BULK-C1ONLY-1,C1-Only-Sub,Real C2 Data,Active,2020-01-01,Center-A,5,5,1000,500",
        "BULK-C1ONLY-OK,C1-Only-Sub,No C2 Data,Active,2020-01-01,Center-A,5,0,1000,0"
      ].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      const body = res.json();
      expect(body.processed).toBe(1);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].farId).toBe("BULK-C1ONLY-1");
      expect(body.errors[0].message).toContain("C1-Only-Sub");

      const db = await getPool();
      const { rows } = await db.query(`SELECT far_id FROM assets WHERE far_id LIKE 'BULK-C1ONLY%'`);
      expect(rows.map((r) => r.far_id)).toEqual(["BULK-C1ONLY-OK"]);
    });

    it("rejects on non-zero deletionsC2/accDepC2Opening/additionsC2 too, not just opening cost", async () => {
      const withExtraCols = HEADER + ",additionsC2,dateOfAddition,deletionsC2,accDepC2Opening";
      const csv = [
        withExtraCols,
        "BULK-C1ONLY-ADD,C1-Only-Sub,Real Addition,Active,2020-01-01,Center-A,5,0,1000,0,500,01-05-2026,0,0",
        "BULK-C1ONLY-DEP,C1-Only-Sub,Real Acc Dep,Active,2020-01-01,Center-A,5,0,1000,0,0,,0,50"
      ].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      const body = res.json();
      expect(body.processed).toBe(0);
      expect(body.errors).toHaveLength(2);
      expect(body.errors.map((e: { farId: string }) => e.farId).sort()).toEqual(["BULK-C1ONLY-ADD", "BULK-C1ONLY-DEP"]);
    });

    it("does not reject on a leftover non-zero usefulLifeC2Years alone", async () => {
      const csv = [HEADER, "BULK-C1ONLY-LIFE,C1-Only-Sub,Stale Life Only,Active,2020-01-01,Center-A,5,5,1000,0"].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      const body = res.json();
      expect(body.processed).toBe(1);
      expect(body.errors).toHaveLength(0);
    });
  });

  it("accepts DD-MM-YYYY dates, and reports a clear error for a malformed one", async () => {
    const csv = [
      HEADER,
      "BULK-DMY,Test-Sub,DD-MM-YYYY Asset,Active,25-12-2023,Center-A,5,5,1000,1000",
      "BULK-BAD,Test-Sub,Bad Date Asset,Active,31-13-2023,Center-A,5,5,1000,1000"
    ].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.processed).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].message).toMatch(/Invalid date '31-13-2023' — expected DD-MM-YYYY/);

    const db = await getPool();
    const { rows } = await db.query(`SELECT date_acquired FROM assets WHERE far_id = 'BULK-DMY'`);
    expect(String(rows[0].date_acquired)).toMatch(/^2023-12-25/);
  });

  it("also accepts a plain ISO date (e.g. a real Date-typed .xlsx cell already normalized)", async () => {
    const csv = [HEADER, "BULK-ISO,Test-Sub,ISO Date Asset,Active,2023-12-25,Center-A,5,5,1000,1000"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    expect(res.json().processed).toBe(1);

    const db = await getPool();
    const { rows } = await db.query(`SELECT date_acquired FROM assets WHERE far_id = 'BULK-ISO'`);
    expect(String(rows[0].date_acquired)).toMatch(/^2023-12-25/);
  });

  it("rejects a duplicate FAR ID within the same file, keeping the first row's values", async () => {
    const csv = [
      HEADER,
      "BULK-DUP,Test-Sub,First Occurrence,Active,2020-01-01,Center-A,5,5,1000,1000",
      "BULK-DUP,Test-Sub,Second Occurrence,Active,2020-01-01,Center-A,5,5,9999,9999"
    ].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.processed).toBe(1);
    expect(body.added).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].message).toMatch(/Duplicate FAR ID "BULK-DUP" — already appears earlier in this file/);

    // The first occurrence's values are what actually got written, not silently
    // overwritten by the (rejected) second one.
    const db = await getPool();
    const { rows } = await db.query(`SELECT asset_description, c1_opening_cost FROM assets WHERE far_id = 'BULK-DUP'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].asset_description).toBe("First Occurrence");
    expect(rows[0].c1_opening_cost).toBe("1000");
  });

  it("preview mode also catches a duplicate FAR ID within the file, with accurate new/update counts", async () => {
    const csv = [
      HEADER,
      "BULK-DUP-PREVIEW,Test-Sub,First Occurrence,Active,2020-01-01,Center-A,5,5,1000,1000",
      "BULK-DUP-PREVIEW,Test-Sub,Second Occurrence,Active,2020-01-01,Center-A,5,5,9999,9999"
    ].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload?preview=true", ...csvPayload(csv) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Exactly one "new" row (not two, which would misleadingly imply two independent
    // assets are about to be created), plus the duplicate reported as an error.
    expect(body.summary).toEqual({ new: 1, update: 0, error: 1 });
    const errorRow = body.rows.find((r: { status: string }) => r.status === "error");
    expect(errorRow.message).toMatch(/Duplicate FAR ID "BULK-DUP-PREVIEW" — already appears earlier in this file/);
  });

  it("isolates a DB-level failure on one row: earlier successful rows in the same file survive, and the failing row is reported individually — not a schema-validation failure, the row is schema-valid but its DB write throws", async () => {
    const db = await getPool();
    const originalQuery = db.query.bind(db);
    const spy = vi.spyOn(db, "query").mockImplementation((...args: unknown[]) => {
      const sql = args[0];
      const params = args[1] as unknown[] | undefined;
      if (typeof sql === "string" && sql.includes("INSERT INTO assets") && params?.[0] === "BULK-DB-FAIL") {
        return Promise.reject(new Error("simulated DB-level failure"));
      }
      return (originalQuery as (...a: unknown[]) => unknown)(...args);
    });

    try {
      const csv = [
        HEADER,
        "BULK-DB-OK-1,Test-Sub,Before The Failure,Active,2020-01-01,Center-A,5,5,1000,1000",
        "BULK-DB-FAIL,Test-Sub,Fails At The DB,Active,2020-01-01,Center-A,5,5,1000,1000",
        "BULK-DB-OK-2,Test-Sub,After The Failure,Active,2020-01-01,Center-A,5,5,1000,1000"
      ].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalRows).toBe(3);
      expect(body.processed).toBe(2);
      expect(body.added).toBe(2);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].farId).toBe("BULK-DB-FAIL");
      expect(body.errors[0].message).toMatch(/simulated DB-level failure/);
    } finally {
      spy.mockRestore();
    }

    // Both rows on either side of the failing one actually made it into the database —
    // the old whole-transaction-rollback behavior would have discarded BULK-DB-OK-1 too.
    const { rows } = await db.query(`SELECT far_id FROM assets WHERE far_id LIKE 'BULK-DB-%' ORDER BY far_id`);
    expect(rows.map((r: { far_id: string }) => r.far_id)).toEqual(["BULK-DB-OK-1", "BULK-DB-OK-2"]);
  });

  it("preview mode classifies new vs. update rows without writing anything", async () => {
    const csv = [
      HEADER,
      "BULK-1,Test-Sub,Bulk Asset One,Active,2020-01-01,Center-A,5,5,1000,1000",
      "BULK-2,,Bulk Asset Missing Sub,Active,2020-01-01,Center-A,5,5,1000,1000"
    ].join("\n");
    await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });

    const second = [
      HEADER,
      "BULK-1,Test-Sub,Bulk Asset One Updated,Active,2020-01-01,Center-A,5,5,1000,1000",
      "BULK-4,Test-Sub,Bulk Asset Four,Active,2020-01-01,Center-A,5,5,1000,1000"
    ].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload?preview=true", ...csvPayload(second) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toEqual({ new: 1, update: 1, error: 0 });
    expect(body.rows.find((r: { farId: string }) => r.farId === "BULK-1").status).toBe("update");
    expect(body.rows.find((r: { farId: string }) => r.farId === "BULK-4").status).toBe("new");

    const db = await getPool();
    const { rows } = await db.query(`SELECT asset_description FROM assets WHERE far_id = 'BULK-1'`);
    expect(rows[0].asset_description).toBe("Bulk Asset One");
    const { rows: notCreated } = await db.query(`SELECT far_id FROM assets WHERE far_id = 'BULK-4'`);
    expect(notCreated).toHaveLength(0);
  });

  describe("Unrecognized columns", () => {
    it("rejects the whole file up front when the header has a column outside the known set", async () => {
      const csv = [HEADER + ",totallyMadeUpColumn", "BULK-BADCOL,Test-Sub,Bad Column,Active,2020-01-01,Center-A,5,5,1000,1000,whatever"].join(
        "\n"
      );
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toMatch(/Unrecognized column: "totallyMadeUpColumn"/);

      // Nothing from the file was written — this is a whole-file rejection, not a
      // per-row one.
      const db = await getPool();
      const { rows } = await db.query(`SELECT far_id FROM assets WHERE far_id = 'BULK-BADCOL'`);
      expect(rows).toHaveLength(0);
    });

    it("names every unrecognized column when there's more than one", async () => {
      const csv = [HEADER + ",foo,bar", "BULK-BADCOLS,Test-Sub,Bad Columns,Active,2020-01-01,Center-A,5,5,1000,1000,1,2"].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Unrecognized columns: "foo", "bar"/);
    });

    it("still accepts every real optional column together (no false positive against the full known set)", async () => {
      const fullHeader =
        "farId,subClassification,assetDescription,status,dateAcquired,location,usefulLifeC1Years,usefulLifeC2Years,serialNo,qty,c1OpeningCost,c2OpeningCost,additionsC1,additionsC2,dateOfAddition,accDepC1Opening,accDepC2Opening,dateOfDisposal,deletionsC1,deletionsC2,saleValue";
      const csv = [
        fullHeader,
        // saleValue 0 — deletionsC1/C2 (1500) already consume the full opening cost +
        // additions (1500) here, leaving 0 Written Down Value at disposal; a nonzero
        // saleValue would now correctly trip the WDV ceiling check below, which isn't
        // what this test is about (it's checking every column name is accepted, not
        // dollar-amount consistency).
        "BULK-FULLCOLS,Test-Sub,All Columns,Disposed,2020-01-01,Center-A,5,5,SN-1,1,1000,1000,500,500,01-06-2020,200,200,01-01-2021,1500,1500,0"
      ].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      expect(res.statusCode).toBe(200);
      expect(res.json().processed).toBe(1);
    });
  });

  describe("Disposal fields restricted to new FAR IDs", () => {
    async function disposeExisting(farId: string, dateOfDisposal = "2020-06-01") {
      const db = await getPool();
      await db.query(
        `UPDATE assets SET status = 'Disposed', date_of_disposal = $2, deletions_c1 = c1_opening_cost, deletions_c2 = c2_opening_cost WHERE far_id = $1`,
        [farId, dateOfDisposal]
      );
    }

    it("a brand-new FAR ID may still set dateOfDisposal/deletions/saleValue (the historical-import case)", async () => {
      const withDisposalHeader = HEADER + ",dateOfDisposal,deletionsC1,deletionsC2,saleValue";
      // saleValue 0 — deletionsC1/C2 (1000) already consume the full opening cost here
      // (accDepC1/C2Opening default to 0, not in HEADER), leaving 0 Written Down Value;
      // a nonzero saleValue would now correctly trip the WDV ceiling check.
      const csv = [
        withDisposalHeader,
        "BULK-HIST-IMPORT,Test-Sub,Historical Import,Disposed,2018-01-01,Center-A,5,5,1000,1000,01-06-2020,1000,1000,0"
      ].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.processed).toBe(1);
      expect(body.added).toBe(1);

      const db = await getPool();
      const { rows } = await db.query(`SELECT status, date_of_disposal FROM assets WHERE far_id = 'BULK-HIST-IMPORT'`);
      expect(rows[0].status).toBe("Disposed");
    });

    it("THE SILENT-UN-DISPOSAL CASE: re-uploading an already-disposed FAR ID without disposal columns does not revive it", async () => {
      // First, capitalize it, then dispose it exactly the way the dedicated Disposal
      // flow would (status + date_of_disposal + deletions all set together).
      const csv = [HEADER, "BULK-ALREADY-DISPOSED,Test-Sub,Will Be Disposed,Active,2020-01-01,Center-A,5,5,1000,1000"].join("\n");
      await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      await disposeExisting("BULK-ALREADY-DISPOSED");

      // An innocent re-upload correcting an unrelated field (asset description), using
      // the plain template with no disposal columns at all — status defaults back to
      // "Active" here, which is exactly the scenario that used to silently revive it.
      const correction = [
        HEADER,
        "BULK-ALREADY-DISPOSED,Test-Sub,Fixed Description,Active,2020-01-01,Center-A,5,5,1000,1000"
      ].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(correction) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.processed).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].message).toMatch(/has already been disposed — its particulars can no longer be changed/);

      // The asset in the database is completely untouched — still disposed, description
      // unchanged, deletions/status intact.
      const db = await getPool();
      const { rows } = await db.query(
        `SELECT status, date_of_disposal, asset_description, deletions_c1 FROM assets WHERE far_id = 'BULK-ALREADY-DISPOSED'`
      );
      expect(rows[0].status).toBe("Disposed");
      expect(rows[0].date_of_disposal).not.toBeNull();
      expect(rows[0].asset_description).toBe("Will Be Disposed");
      expect(rows[0].deletions_c1).toBe("1000");
    });

    it("preview mode also rejects a correction row against an already-disposed asset, not just commit", async () => {
      const csv = [HEADER, "BULK-DISPOSED-PREVIEW,Test-Sub,Will Be Disposed,Active,2020-01-01,Center-A,5,5,1000,1000"].join("\n");
      await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      await disposeExisting("BULK-DISPOSED-PREVIEW");

      const correction = [HEADER, "BULK-DISPOSED-PREVIEW,Test-Sub,Fixed Description,Active,2020-01-01,Center-A,5,5,1000,1000"].join(
        "\n"
      );
      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets/bulk-upload?preview=true",
        ...csvPayload(correction)
      });
      const body = res.json();
      expect(body.summary).toEqual({ new: 0, update: 0, error: 1 });
      expect(body.rows[0].message).toMatch(/has already been disposed/);
    });

    it("an existing, not-yet-disposed asset is blocked from setting dateOfDisposal — must go through Bulk Disposals instead", async () => {
      const csv = [HEADER, "BULK-EXISTING-LIVE,Test-Sub,Still Active,Active,2020-01-01,Center-A,5,5,1000,1000"].join("\n");
      await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });

      const withDisposalHeader = HEADER + ",dateOfDisposal";
      const attempt = [
        withDisposalHeader,
        "BULK-EXISTING-LIVE,Test-Sub,Still Active,Disposed,2020-01-01,Center-A,5,5,1000,1000,01-06-2020"
      ].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(attempt) });
      const body = res.json();
      expect(body.processed).toBe(0);
      expect(body.errors[0].message).toMatch(/must go through Bulk Disposals/);

      const db = await getPool();
      const { rows } = await db.query(`SELECT status, date_of_disposal FROM assets WHERE far_id = 'BULK-EXISTING-LIVE'`);
      expect(rows[0].status).toBe("Active");
      expect(rows[0].date_of_disposal).toBeNull();
    });

    it("an existing, not-yet-disposed asset is also blocked on deletions/saleValue alone, without dateOfDisposal", async () => {
      const csv = [HEADER, "BULK-EXISTING-LIVE-2,Test-Sub,Still Active,Active,2020-01-01,Center-A,5,5,1000,1000"].join("\n");
      await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });

      const withDeletionsHeader = HEADER + ",saleValue";
      const attempt = [
        withDeletionsHeader,
        "BULK-EXISTING-LIVE-2,Test-Sub,Still Active,Active,2020-01-01,Center-A,5,5,1000,1000,250"
      ].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(attempt) });
      const body = res.json();
      expect(body.processed).toBe(0);
      expect(body.errors[0].message).toMatch(/must go through Bulk Disposals/);
    });

    it("an existing, not-yet-disposed asset can still be corrected normally when the row doesn't touch disposal fields at all", async () => {
      const csv = [HEADER, "BULK-EXISTING-OK,Test-Sub,Original Description,Active,2020-01-01,Center-A,5,5,1000,1000"].join("\n");
      await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });

      const correction = [HEADER, "BULK-EXISTING-OK,Test-Sub,Corrected Description,Active,2020-01-01,Center-A,5,5,1500,1500"].join(
        "\n"
      );
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(correction) });
      expect(res.json().processed).toBe(1);

      const db = await getPool();
      const { rows } = await db.query(`SELECT asset_description, c1_opening_cost FROM assets WHERE far_id = 'BULK-EXISTING-OK'`);
      expect(rows[0].asset_description).toBe("Corrected Description");
      expect(rows[0].c1_opening_cost).toBe("1500");
    });

    it("an out-of-scope center-scoped user gets a 'not found' error, not an 'already disposed' one that would leak the asset's existence", async () => {
      await getPool().then((db) => db.query(`INSERT INTO centers (code) VALUES ('Center-B') ON CONFLICT DO NOTHING`));
      const csv = [HEADER, "BULK-OUTOFSCOPE-DISPOSED,Test-Sub,Hidden Asset,Active,2020-01-01,Center-A,5,5,1000,1000"].join("\n");
      await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      await disposeExisting("BULK-OUTOFSCOPE-DISPOSED");

      const scopedUser = await createTestUser({ username: "bulk-scoped-user", role: "editor", centerAccess: ["Center-B"] });
      const correction = [
        HEADER,
        "BULK-OUTOFSCOPE-DISPOSED,Test-Sub,Attempted Correction,Active,2020-01-01,Center-A,5,5,1000,1000"
      ].join("\n");
      const payload = csvPayload(correction);
      const res = await app.inject({
        method: "POST",
        url: "/api/assets/bulk-upload",
        ...payload,
        headers: { ...payload.headers, cookie: authHeaderFor(scopedUser.id, scopedUser.username) }
      });
      const body = res.json();
      expect(body.errors[0].message).toBe(`No asset found with FAR ID "BULK-OUTOFSCOPE-DISPOSED".`);
      expect(body.errors[0].message).not.toMatch(/has already been disposed/i);
    });
  });

  describe("Historical-import Sale Value / Deletions ceiling (2026-09-03)", () => {
    const HIST_HEADER =
      "farId,subClassification,assetDescription,status,dateAcquired,location,usefulLifeC1Years,usefulLifeC2Years,c1OpeningCost,c2OpeningCost,additionsC1,additionsC2,accDepC1Opening,accDepC2Opening,dateOfDisposal,deletionsC1,deletionsC2,saleValue";

    it("rejects the reported row: Sale Value exceeds the Written Down Value computed from the row's own fields", async () => {
      // Exact reproduction row: deletionsC1/C2 alone (118830/235390) already dwarf
      // c1/c2OpeningCost (11883/23539), so WDV floors at 0 per component — any positive
      // saleValue, including 1598, must be rejected. subClassification is deliberately
      // left unrecognized (not seeded) — this check runs at the schema level, before any
      // Masters lookup, so the row is rejected for the Sale Value reason specifically,
      // not a "Sub Classification not recognized" one.
      const csv = [
        HIST_HEADER,
        "FAR-003007,Medical Equipment-Dialysis,Dialysis Machine,Disposed,23-08-2021,Center-A,,,11883,23539,,,1483,150,27-05-2026,118830,235390,1598"
      ].join("\n");
      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets/bulk-upload?preview=true",
        ...csvPayload(csv)
      });
      const body = res.json();
      expect(body.summary).toEqual({ new: 0, update: 0, error: 1 });
      expect(body.rows[0].message).toMatch(
        /Sale Value \(1598\) cannot exceed the asset's Written Down Value at disposal \(0\)/
      );

      // Also rejected on commit, not just preview — and writes nothing.
      const commit = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      expect(commit.json().processed).toBe(0);
      const db = await getPool();
      const { rows } = await db.query(`SELECT far_id FROM assets WHERE far_id = 'FAR-003007'`);
      expect(rows).toHaveLength(0);
    });

    it("accepts a legitimate counterpart where Sale Value is within the row's own computed WDV", async () => {
      // c1OpeningCost 10000 - accDepC1Opening 2000 - deletionsC1 6000 = 2000 WDV; 1500 <= 2000.
      const csv = [
        HIST_HEADER,
        "FAR-VALID-WDV,Test-Sub,Valid Historical Import,Disposed,23-08-2021,Center-A,5,0,10000,0,,,2000,0,27-05-2026,6000,0,1500"
      ].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.processed).toBe(1);
      expect(body.added).toBe(1);

      const db = await getPool();
      const { rows } = await db.query(`SELECT status, sale_value FROM assets WHERE far_id = 'FAR-VALID-WDV'`);
      expect(rows[0].status).toBe("Disposed");
      expect(Number(rows[0].sale_value)).toBe(1500);
    });

    it("rejects Deletions that exceed Opening Cost + Additions, independent of Sale Value", async () => {
      // saleValue 0 isolates this from the WDV-ceiling check above — deletionsC1 alone
      // (118830) already exceeds c1OpeningCost + additionsC1 (11883), which is
      // nonsensical regardless of what Sale Value is entered.
      const csv = [
        HIST_HEADER,
        "FAR-BAD-DELETIONS,Test-Sub,Bad Deletions,Disposed,23-08-2021,Center-A,5,0,11883,0,,,1483,0,27-05-2026,118830,0,0"
      ].join("\n");
      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets/bulk-upload?preview=true",
        ...csvPayload(csv)
      });
      const body = res.json();
      expect(body.summary).toEqual({ new: 0, update: 0, error: 1 });
      expect(body.rows[0].message).toMatch(
        /Component 1 Deletions \(118830\) cannot exceed Component 1 Opening Cost \+ Additions \(11883\)/
      );
    });

    it("confirms both problem rows from the reported CSV produce the correct errors, in one preview call", async () => {
      // Row 1: status Active but disposal fields set (pre-existing status/dateOfDisposal
      // pairing check). Row 2: the exact WDV-exceeding row from the report.
      const csv = [
        HIST_HEADER,
        "FAR-003007-ACTIVE,Medical Equipment-Dialysis,Dialysis Machine,Active,23-08-2021,Center-A,,,11883,23539,,,1483,150,27-05-2026,118830,235390,1598",
        "FAR-003007,Medical Equipment-Dialysis,Dialysis Machine,Disposed,23-08-2021,Center-A,,,11883,23539,,,1483,150,27-05-2026,118830,235390,1598"
      ].join("\n");
      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets/bulk-upload?preview=true",
        ...csvPayload(csv)
      });
      const body = res.json();
      expect(body.summary).toEqual({ new: 0, update: 0, error: 2 });
      const activeRow = body.rows.find((r: { farId: string }) => r.farId === "FAR-003007-ACTIVE");
      const disposedRow = body.rows.find((r: { farId: string }) => r.farId === "FAR-003007");
      expect(activeRow.message).toMatch(/dateOfDisposal is set but status is "Active", not "Disposed"/);
      expect(disposedRow.message).toMatch(
        /Sale Value \(1598\) cannot exceed the asset's Written Down Value at disposal \(0\)/
      );
    });
  });

  describe("Useful Life fallback (a row that omits it falls back to its Sub Classification's default)", () => {
    it("falls back to the Sub Classification's default Useful Life C1/C2 when a row omits both", async () => {
      const db = await getPool();
      await db.query(
        `INSERT INTO sub_classifications (name, default_useful_life_c1_years, default_useful_life_c2_years) VALUES ('Sub-With-Defaults', 7, 3)`
      );
      // usefulLifeC1Years/usefulLifeC2Years cells left blank — parseWorksheetRows omits
      // a blank cell's key entirely, which is what the fallback logic looks for.
      const csv = [HEADER, "BULK-UL-FALLBACK,Sub-With-Defaults,Fallback Asset,Active,2020-01-01,Center-A,,,1000,1000"].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ processed: 1, added: 1, errors: [] });

      const { rows } = await db.query(
        `SELECT useful_life_c1_years, useful_life_c2_years FROM assets WHERE far_id = 'BULK-UL-FALLBACK'`
      );
      expect(Number(rows[0].useful_life_c1_years)).toBe(7);
      expect(Number(rows[0].useful_life_c2_years)).toBe(3);
    });

    it("rejects a row that omits Useful Life C1 when its Sub Classification has no default set", async () => {
      // Test-Sub (seeded in beforeEach) has no default Useful Life at all.
      const csv = [HEADER, "BULK-UL-NO-DEFAULT-C1,Test-Sub,No Default Asset,Active,2020-01-01,Center-A,,5,1000,1000"].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      const body = res.json();
      expect(body.processed).toBe(0);
      expect(body.errors[0].message).toMatch(/Useful Life C1 is required.*Sub Classification "Test-Sub" has no default Useful Life C1 set/);

      const db = await getPool();
      const { rows } = await db.query(`SELECT far_id FROM assets WHERE far_id = 'BULK-UL-NO-DEFAULT-C1'`);
      expect(rows).toHaveLength(0);
    });

    it("rejects a row that omits Useful Life C2 when its Sub Classification has Component 2 and no C2 default", async () => {
      const csv = [HEADER, "BULK-UL-NO-DEFAULT-C2,Test-Sub,No Default C2 Asset,Active,2020-01-01,Center-A,5,,1000,1000"].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      const body = res.json();
      expect(body.processed).toBe(0);
      expect(body.errors[0].message).toMatch(/Useful Life C2 is required.*Sub Classification "Test-Sub" has no default Useful Life C2 set/);
    });

    it("defaults Useful Life C2 to 0 (no rejection, no master lookup needed) when the Sub Classification has no Component 2", async () => {
      // C1-Only-Sub (seeded in beforeEach) has has_component2 = FALSE and no default
      // Useful Life either — omitting C2 here must not be treated as an error.
      const csv = [HEADER, "BULK-UL-C1-ONLY,C1-Only-Sub,C1 Only Asset,Active,2020-01-01,Center-A,5,,1000,0"].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ processed: 1, added: 1, errors: [] });

      const db = await getPool();
      const { rows } = await db.query(`SELECT useful_life_c2_years FROM assets WHERE far_id = 'BULK-UL-C1-ONLY'`);
      expect(Number(rows[0].useful_life_c2_years)).toBe(0);
    });
  });
});
