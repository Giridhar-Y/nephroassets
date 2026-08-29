import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "./assets.js";
import transfersRoutes from "./transfers.js";
import bulkUploadRoutes from "./bulkUpload.js";
import bulkTransfersRoutes from "./bulkTransfers.js";
import bulkDisposalsRoutes from "./bulkDisposals.js";
import activityLogRoutes from "./activityLog.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";
import { csvPayload } from "./bulkTestHelpers.js";

const NEW_ASSET = {
  farId: "ACT-TEST-1",
  subClassification: "Test-Sub",
  assetDescription: "Activity Log Test Asset",
  status: "Active",
  dateAcquired: "2026-01-01",
  location: "Center-Test",
  usefulLifeC1Years: 5,
  usefulLifeC2Years: 5,
  c1OpeningCost: 10000,
  c2OpeningCost: 10000
};

const BULK_HEADER =
  "farId,subClassification,assetDescription,status,dateAcquired,location,usefulLifeC1Years,usefulLifeC2Years,c1OpeningCost,c2OpeningCost";

async function seedMasters() {
  const db = await getPool();
  await db.query(`DELETE FROM centers`);
  await db.query(`DELETE FROM sub_classifications`);
  await db.query(`DELETE FROM statuses`);
  await db.query(`INSERT INTO centers (code) VALUES ('Center-Test'), ('Center-Other')`);
  await db.query(`INSERT INTO sub_classifications (name) VALUES ('Test-Sub')`);
  await db.query(`INSERT INTO statuses (name, system_managed) VALUES ('Active', FALSE), ('Disposed', TRUE)`);
}

// GET /api/audit-log/activity: read-only view of asset_activity_log — the record of
// every Capitalization/Addition/Transfer/Disposal CREATE event, single-item and bulk
// alike. Editor+ enforcement is covered in roles.test.ts alongside every other
// FAR-module route; this file covers that each write path actually logs, plus
// listing/filtering/pagination correctness.
describe("Activity Log", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(multipart);
    await app.register(assetsRoutes);
    await app.register(transfersRoutes);
    await app.register(bulkUploadRoutes);
    await app.register(bulkTransfersRoutes);
    await app.register(bulkDisposalsRoutes);
    await app.register(activityLogRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM asset_activity_log`);
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    await seedMasters();
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, '2026-08-17', '2026-04-01', '2027-03-31', 365)
       ON CONFLICT (id) DO UPDATE SET as_at = '2026-08-17', fy_start = '2026-04-01', fy_end = '2027-03-31', days_in_fy = 365`
    );
  });

  it("returns an empty list before any activity", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], nextCursor: null });
  });

  it("logs a single-item Capitalization with actor and entered details", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ action: "capitalization_create", farId: "ACT-TEST-1" });
    expect(items[0].actorUsername).toBeTruthy();
    expect(items[0].details.assetDescription).toBe("Activity Log Test Asset");
    expect(items[0].details.source).toBe("single");
  });

  it("logs a single-item Addition", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/ACT-TEST-1/addition",
      payload: { additionsC1: 1000, additionsC2: 0, dateOfAddition: "2026-06-01" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?action=addition_create" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].details).toMatchObject({ additionsC1: 1000, additionsC2: 0, dateOfAddition: "2026-06-01" });
  });

  it("logs a single-item Disposal", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/ACT-TEST-1/disposal",
      payload: { dateOfDisposal: "2026-07-01", saleValue: 500 }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?action=disposal_create" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].details).toMatchObject({ dateOfDisposal: "2026-07-01", saleValue: 500 });
  });

  it("logs a single-item Transfer, one row per FAR ID moved", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "ACT-TEST-2" } });
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["ACT-TEST-1", "ACT-TEST-2"], toLocation: "Center-Other", transactionDate: "2026-06-01" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?action=transfer_create" });
    const { items } = res.json();
    expect(items).toHaveLength(2);
    expect(items.map((i: { farId: string }) => i.farId).sort()).toEqual(["ACT-TEST-1", "ACT-TEST-2"]);
    expect(items[0].details).toMatchObject({ location: "Center-Other", transactionDate: "2026-06-01" });
  });

  it("logs a Bulk Upload Capitalization (new rows only, not updates)", async () => {
    const csv = [BULK_HEADER, "ACT-BULK-1,Test-Sub,Bulk Asset,Active,2020-01-01,Center-Test,5,5,1000,1000"].join("\n");
    await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    // Re-uploading the same row is an update, not a create — must not log a second time.
    await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?action=capitalization_create" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].farId).toBe("ACT-BULK-1");
    expect(items[0].details).toMatchObject({ source: "bulk", sourceFilename: "upload.csv" });
  });

  it("logs a Bulk Transfer", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    const csv = "farId,toLocation,transactionDate\nACT-TEST-1,Center-Other,01-06-2026";
    await authedInject(app, { method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?action=transfer_create" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].details).toMatchObject({ source: "bulk", sourceFilename: "upload.csv" });
  });

  it("logs a Bulk Disposal", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    const csv = "farId,dateOfDisposal,saleValue\nACT-TEST-1,01-07-2026,500";
    await authedInject(app, { method: "POST", url: "/api/assets/bulk-dispose", ...csvPayload(csv) });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?action=disposal_create" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].details).toMatchObject({ source: "bulk", sourceFilename: "upload.csv" });
  });

  it("filters by FAR ID (contains, case-insensitive)", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "ACT-MATCH-1" } });
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "OTHER-2" } });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?farId=match" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].farId).toBe("ACT-MATCH-1");
  });

  it("filters by date range", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const past = "2000-01-01";
    const future = "2999-01-01";

    const withinRange = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/activity?dateFrom=${past}&dateTo=${future}`
    });
    expect(withinRange.json().items).toHaveLength(1);

    const outsideRange = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/activity?dateFrom=${future}`
    });
    expect(outsideRange.json().items).toHaveLength(0);

    const fromToday = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/activity?dateFrom=${today}&dateTo=${today}`
    });
    expect(fromToday.json().items).toHaveLength(1);
  });

  it("returns newest first and paginates with a keyset cursor", async () => {
    for (const farId of ["ACT-PAGE-1", "ACT-PAGE-2", "ACT-PAGE-3"]) {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId } });
    }

    const page1 = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?limit=1" });
    const body1 = page1.json();
    expect(body1.items).toHaveLength(1);
    expect(body1.items[0].farId).toBe("ACT-PAGE-3");
    expect(body1.nextCursor).toBeTruthy();

    const page2 = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/activity?limit=1&cursor=${body1.nextCursor}`
    });
    expect(page2.json().items[0].farId).toBe("ACT-PAGE-2");
  });

  it("rejects an invalid query with 400", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?action=not-a-real-action" });
    expect(res.statusCode).toBe(400);
  });
});
