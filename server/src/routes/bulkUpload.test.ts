import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bulkUploadRoutes from "./bulkUpload.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";
import { csvPayload, emptyMultipartPayload } from "./bulkTestHelpers.js";

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

  it("rejects a FAR ID containing lowercase letters, accepts one mixing letters/digits/hyphens", async () => {
    const csv = [
      HEADER,
      "Temp1234,Test-Sub,Bad Format,Active,2020-01-01,Center-A,5,5,1000,1000",
      "616-PB-BTI-GNR-C,Test-Sub,Real-World Format,Active,2020-01-01,Center-A,5,5,1000,1000"
    ].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].farId).toBe("Temp1234");
    expect(body.errors[0].message).toMatch(/FAR ID can only contain uppercase letters, numbers, and hyphens/);

    const db = await getPool();
    const { rows } = await db.query(`SELECT far_id FROM assets WHERE far_id = '616-PB-BTI-GNR-C'`);
    expect(rows).toHaveLength(1);
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
});
