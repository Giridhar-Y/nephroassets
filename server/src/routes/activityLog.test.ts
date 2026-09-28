import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "./assets.js";
import transfersRoutes from "./transfers.js";
import bulkUploadRoutes from "./bulkUpload.js";
import bulkTransfersRoutes from "./bulkTransfers.js";
import bulkDisposalsRoutes from "./bulkDisposals.js";
import mastersRoutes from "./masters.js";
import bulkMastersRoutes from "./bulkMasters.js";
import activityLogRoutes, { resolveFinancialYear, setXlsxMaxEntriesForTests, XLSX_MAX_ENTRIES } from "./activityLog.js";
import { createActivityWorkbook } from "./activityLogExport.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";
import { csvPayload } from "./bulkTestHelpers.js";

// Pure function, no app/DB needed — isolated from the rest of this file's Fastify+DB
// suite so the boundary math itself is pinned down directly rather than only inferred
// from whatever dates happen to land in a live export test. All timestamps are picked
// well clear of the IST offset (UTC+5:30) so there's no ambiguity about which calendar
// day they fall on in Asia/Kolkata.
describe("resolveFinancialYear (FY boundary math)", () => {
  it("a date exactly on the FY start date belongs to the new FY", () => {
    expect(resolveFinancialYear("2026-04-01T10:00:00Z", 4, 1)).toBe("FY 2026-27");
  });

  it("the day before FY start belongs to the previous FY — a different label from the start date itself", () => {
    expect(resolveFinancialYear("2026-03-31T10:00:00Z", 4, 1)).toBe("FY 2025-26");
  });

  it("the day after FY start stays in the same FY as the start date", () => {
    expect(resolveFinancialYear("2026-04-02T10:00:00Z", 4, 1)).toBe("FY 2026-27");
  });

  it("the last day of an FY (the day before the NEXT year's start date) still belongs to the earlier FY", () => {
    expect(resolveFinancialYear("2027-03-31T10:00:00Z", 4, 1)).toBe("FY 2026-27");
  });

  it("a date several years before the configured fy_start still resolves correctly — the year-rollback math doesn't drift for older entries", () => {
    expect(resolveFinancialYear("2020-04-01T10:00:00Z", 4, 1)).toBe("FY 2020-21");
    expect(resolveFinancialYear("2020-03-31T10:00:00Z", 4, 1)).toBe("FY 2019-20");
    expect(resolveFinancialYear("2015-06-15T10:00:00Z", 4, 1)).toBe("FY 2015-16");
    expect(resolveFinancialYear("2015-01-15T10:00:00Z", 4, 1)).toBe("FY 2014-15");
  });

  it("respects a non-April FY start configured in Settings, not a hardcoded April 1", () => {
    // A July 1 FY start: June 30 is the last day of the OLD FY, July 1 starts the new one.
    expect(resolveFinancialYear("2026-06-30T10:00:00Z", 7, 1)).toBe("FY 2025-26");
    expect(resolveFinancialYear("2026-07-01T10:00:00Z", 7, 1)).toBe("FY 2026-27");
  });

  it("a timestamp near the IST day boundary still resolves against the IST calendar date, not UTC's", () => {
    // 2026-03-31T19:00:00Z is already 2026-04-01 00:30 IST (UTC+5:30) — the new FY.
    expect(resolveFinancialYear("2026-03-31T19:00:00Z", 4, 1)).toBe("FY 2026-27");
    // 2026-03-31T17:00:00Z is still 2026-03-31 22:30 IST — the old FY.
    expect(resolveFinancialYear("2026-03-31T17:00:00Z", 4, 1)).toBe("FY 2025-26");
  });
});

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

// GET /api/audit-log/activity: one consolidated feed over asset_activity_log (every
// Capitalization/Addition/Transfer/Disposal CREATE event), asset_delete_audit_log
// (every Global-Admin delete/undo — the former standalone Delete Log, now the "delete"
// category here instead of its own page), and master_activity_log (every Masters
// create/rename/deactivate/reactivate, the "masters" category). Editor+ enforcement is
// covered in roles.test.ts; this file covers that each write path actually logs, the
// category filter groups things correctly, and listing/filtering/pagination work across
// all three sources merged together.
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
    await app.register(mastersRoutes);
    await app.register(bulkMastersRoutes);
    await app.register(activityLogRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM asset_activity_log`);
    await db.query(`DELETE FROM asset_delete_audit_log`);
    await db.query(`DELETE FROM master_activity_log`);
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
    expect(items[0]).toMatchObject({ action: "capitalization_create", category: "capitalization", farId: "ACT-TEST-1" });
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

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=addition" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].details).toMatchObject({ additionsC1: 1000, additionsC2: 0, dateOfAddition: "2026-06-01" });
    // previous state, captured from the same pre-write SELECT the route already ran for
    // its own validation — an asset can't reach this route with a prior addition, so
    // these are always 0/0/null, but diffPrevious still skips additionsC2 here since 0
    // (old) === 0 (new), the same skip-if-unchanged convention masters.ts's own diff uses.
    expect(items[0].details.previous).toEqual({ additionsC1: 0, dateOfAddition: null });
  });

  it("logs a single-item Disposal, with the pre-disposal status/sale value/date as previous", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/ACT-TEST-1/disposal",
      payload: { dateOfDisposal: "2026-07-01", saleValue: 500 }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=disposal" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].details).toMatchObject({ status: "Disposed", dateOfDisposal: "2026-07-01", saleValue: 500 });
    expect(items[0].details.previous).toEqual({ status: "Active", saleValue: 0, dateOfDisposal: null });
  });

  it("logs a single-item Transfer, one row per FAR ID moved, with each asset's prior location as previous", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "ACT-TEST-2" } });
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["ACT-TEST-1", "ACT-TEST-2"], toLocation: "Center-Other", transactionDate: "2026-06-01" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=transfer" });
    const { items } = res.json();
    expect(items).toHaveLength(2);
    expect(items.map((i: { farId: string }) => i.farId).sort()).toEqual(["ACT-TEST-1", "ACT-TEST-2"]);
    expect(items[0].details).toMatchObject({ location: "Center-Other", transactionDate: "2026-06-01" });
    expect(items[0].details.previous).toEqual({ location: "Center-Test" });
  });

  it("logs a Bulk Upload Capitalization (new rows only, not updates)", async () => {
    const csv = [BULK_HEADER, "ACT-BULK-1,Test-Sub,Bulk Asset,Active,2020-01-01,Center-Test,5,5,1000,1000"].join("\n");
    await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    // Re-uploading the same row is an update, not a create — must not log a second time.
    await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=capitalization" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].farId).toBe("ACT-BULK-1");
    expect(items[0].details).toMatchObject({ source: "bulk", sourceFilename: "upload.csv" });
  });

  it("logs a Bulk Transfer", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    const csv = "farId,toLocation,transactionDate\nACT-TEST-1,Center-Other,01-06-2026";
    await authedInject(app, { method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=transfer" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].details).toMatchObject({ source: "bulk", sourceFilename: "upload.csv" });
  });

  it("logs a Bulk Disposal", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    const csv = "farId,dateOfDisposal,saleValue\nACT-TEST-1,01-07-2026,500";
    await authedInject(app, { method: "POST", url: "/api/assets/bulk-dispose", ...csvPayload(csv) });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=disposal" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].details).toMatchObject({ source: "bulk", sourceFilename: "upload.csv" });
  });

  describe("Delete category — merged in from the former standalone Delete Log", () => {
    it("groups all four delete/undo actions under one 'delete' category, with reason preserved", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, {
        method: "DELETE",
        url: "/api/assets/ACT-TEST-1",
        payload: { reason: "created by mistake" }
      });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=delete" });
      const { items } = res.json();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ action: "capitalization_delete", category: "delete", farId: "ACT-TEST-1" });
      expect(items[0].details.reason).toBe("created by mistake");
      expect(items[0].details.type).toBe("Capitalization Delete");
    });

    it("excludes delete-category rows when filtering by a create category, and vice versa", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, { method: "DELETE", url: "/api/assets/ACT-TEST-1", payload: { reason: "test" } });

      const capOnly = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=capitalization" });
      expect(capOnly.json().items.map((i: { category: string }) => i.category)).toEqual(["capitalization"]);

      const deleteOnly = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=delete" });
      expect(deleteOnly.json().items.map((i: { category: string }) => i.category)).toEqual(["delete"]);

      const all = await authedInject(app, { method: "GET", url: "/api/audit-log/activity" });
      expect(all.json().items).toHaveLength(2);
    });

    it("a transfer delete still carries its farId and reason", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["ACT-TEST-1"], toLocation: "Center-Other", transactionDate: "2026-06-01" }
      });
      const db = await getPool();
      const { rows } = await db.query<{ id: string }>(`SELECT id FROM transfers WHERE far_id = 'ACT-TEST-1'`);
      await authedInject(app, {
        method: "DELETE",
        url: `/api/transfers/${rows[0]!.id}`,
        payload: { reason: "recorded in error" }
      });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=delete" });
      const { items } = res.json();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ action: "transfer_delete", farId: "ACT-TEST-1" });
      expect(items[0].details.reason).toBe("recorded in error");
    });
  });

  describe("Masters category", () => {
    it("logs a single-item Center create and update, with a null FAR ID", async () => {
      const create = await authedInject(app, {
        method: "POST",
        url: "/api/masters/centers",
        payload: { code: "Center-New", description: "A new center" }
      });
      const { id } = create.json();
      await authedInject(app, {
        method: "PATCH",
        url: `/api/masters/centers/${id}`,
        payload: { description: "Renamed description" }
      });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=masters" });
      const { items } = res.json();
      expect(items).toHaveLength(2);
      expect(items.every((i: { farId: string | null }) => i.farId === null)).toBe(true);
      expect(items[0]).toMatchObject({ action: "center_update", category: "masters" });
      expect(items[0].details.type).toBe("Center Updated");
      expect(items[1]).toMatchObject({ action: "center_create", category: "masters" });
      expect(items[1].details.type).toBe("Center Created");
    });

    it("logs a Sub Classification and a Status change too", async () => {
      await authedInject(app, {
        method: "POST",
        url: "/api/masters/sub-classifications",
        payload: { name: "New-Sub" }
      });
      await authedInject(app, { method: "POST", url: "/api/masters/statuses", payload: { name: "New-Status" } });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=masters" });
      const actions = res.json().items.map((i: { action: string }) => i.action).sort();
      expect(actions).toEqual(["status_create", "sub_classification_create"]);
    });

    it("logs a Bulk Masters Upload create", async () => {
      const csv = "code,description\nCenter-Bulk,Bulk-created center";
      await authedInject(app, { method: "POST", url: "/api/masters/centers/bulk-upload", ...csvPayload(csv) });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=masters" });
      const { items } = res.json();
      expect(items).toHaveLength(1);
      expect(items[0].action).toBe("center_create");
      expect(items[0].details).toMatchObject({ code: "Center-Bulk", source: "bulk", sourceFilename: "upload.csv" });
    });

    it("does not log a Bulk Masters row that matched with nothing to change", async () => {
      const csv = "code,description\nCenter-Test,";
      await authedInject(app, { method: "POST", url: "/api/masters/centers/bulk-upload", ...csvPayload(csv) });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=masters" });
      expect(res.json().items).toHaveLength(0);
    });

    it("a FAR ID filter never matches a Masters entry", async () => {
      await authedInject(app, { method: "POST", url: "/api/masters/centers", payload: { code: "Center-New" } });
      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?farId=Center-New" });
      expect(res.json().items).toHaveLength(0);
    });
  });

  it("filters by FAR ID (contains, case-insensitive)", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "ACT-MATCH-1" } });
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "OTHER-2" } });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?farId=match" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].farId).toBe("ACT-MATCH-1");
  });

  it("filters by actor (contains, case-insensitive)", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });

    const match = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?actor=HARNESS" });
    expect(match.json().items).toHaveLength(1);

    const noMatch = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?actor=nobody-with-this-name" });
    expect(noMatch.json().items).toHaveLength(0);
  });

  describe("GET /api/audit-log/activity/summary", () => {
    it("counts each category correctly, unaffected by which category (if any) is separately selected on screen", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, { method: "POST", url: "/api/masters/centers", payload: { code: "Center-Summary" } });
      await authedInject(app, { method: "DELETE", url: "/api/assets/ACT-TEST-1", payload: { reason: "test" } });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/summary" });
      expect(res.json()).toEqual({
        counts: { capitalization: 1, addition: 0, transfer: 0, disposal: 0, edit: 0, delete: 1, masters: 1, approvals: 0 },
        total: 3
      });
    });

    it("respects farId/actor/date filters but not category, so the strip stays meaningful while one category is selected", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "ACT-SUM-1" } });
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "OTHER-SUM" } });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/summary?farId=ACT-SUM" });
      expect(res.json().counts).toMatchObject({ capitalization: 1 });
      expect(res.json().total).toBe(1);
    });
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

  it("paginates correctly across mixed sources (activity + delete + masters) in one newest-first feed", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET }); // activity
    await authedInject(app, { method: "POST", url: "/api/masters/centers", payload: { code: "Center-New" } }); // masters
    await authedInject(app, { method: "DELETE", url: "/api/assets/ACT-TEST-1", payload: { reason: "test" } }); // delete

    const page1 = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?limit=2" });
    const body1 = page1.json();
    expect(body1.items).toHaveLength(2);
    expect(body1.items.map((i: { category: string }) => i.category)).toEqual(["delete", "masters"]);
    expect(body1.nextCursor).toBeTruthy();

    const page2 = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/activity?limit=2&cursor=${body1.nextCursor}`
    });
    const body2 = page2.json();
    expect(body2.items).toHaveLength(1);
    expect(body2.items[0].category).toBe("capitalization");
    expect(body2.nextCursor).toBeNull();
  });

  it("rejects an invalid category query with 400", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=not-a-real-category" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed cursor with 400", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?cursor=not-a-real-cursor" });
    expect(res.statusCode).toBe(400);
  });

  // GET /api/audit-log/activity/export — permission gating (activityLog:export) is
  // covered by permissionEnforcement.test.ts's shared registry; these tests cover that
  // the export actually contains the right rows and columns, sharing the same
  // buildActivityLogConditions/shapeRow the list endpoint uses.
  it("paging through entries that share one microsecond timestamp returns every entry exactly once (no skips)", async () => {
    const db = await getPool();
    await db.query(
      `INSERT INTO assets (far_id, sub_classification, asset_description, status, date_acquired, location, useful_life_c1_years, useful_life_c2_years, c1_opening_cost, c2_opening_cost)
       SELECT 'PAGETS-' || g, 'Test-Sub', 'Same-timestamp test', 'Active', '2025-01-01', 'Center-Test', 5, 5, 1000, 0 FROM generate_series(1, 5) g`
    );
    await db.query(
      `INSERT INTO asset_activity_log (action, far_id, details, created_at)
       SELECT 'capitalization_create', 'PAGETS-' || g, NULL, '2026-01-01 10:00:00.123456+00' FROM generate_series(1, 5) g`
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res = await authedInject(app, {
        method: "GET",
        url: `/api/audit-log/activity?limit=2&farId=PAGETS${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      });
      const body = res.json();
      seen.push(...body.items.map((i: { farId: string }) => i.farId));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(["PAGETS-1", "PAGETS-2", "PAGETS-3", "PAGETS-4", "PAGETS-5"]);
  });

  describe("Export to Excel (GET /api/audit-log/activity/export): Events + Changes sheets", () => {
    // Both sheets: row 1 title band, row 2 generated-by, row 3 filter summary, row 4
    // blank, row 5 headers, row 6+ data.
    const HEADER_ROW = 5;
    const FIRST_DATA_ROW = 6;

    async function readBook(payload: Buffer) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(payload as any);
      return { events: workbook.getWorksheet("Events")!, changes: workbook.getWorksheet("Changes")! };
    }
    const values = (sheet: ExcelJS.Worksheet, row: number) => (sheet.getRow(row).values as unknown[]).slice(1);
    const text = (v: unknown) => (v && typeof v === "object" && "text" in v ? (v as { text: string }).text : v);
    /** Changes rows as [eventId, record, field, old, new], with hyperlinks read as their text. */
    function changeRows(sheet: ExcelJS.Worksheet) {
      const out: unknown[][] = [];
      for (let r = FIRST_DATA_ROW; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        out.push([1, 2, 3, 4, 5].map((c) => text(row.getCell(c).value) ?? null));
      }
      return out;
    }

    it("has a branded header band and the Events/Changes headers; a create is one event with its entered fields as New Value", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      expect(res.headers["content-disposition"]).toMatch(/attachment; filename="activity-log-\d{4}-\d{2}-\d{2}\.xlsx"/);
      const { events, changes } = await readBook(res.rawPayload);

      expect(values(events, 1)[0]).toBe("NephroPlus - Activity Log Export: Events");
      expect(values(events, 2)[0]).toMatch(/^Generated by .+ on \d{2}-\d{2}-\d{4} \d{2}:\d{2} IST$/);
      expect(values(events, 3)[0]).toBe("Filters: None - showing all activity");
      expect(values(events, HEADER_ROW)).toEqual([
        "Event ID", "Date & Time (IST)", "Financial Year", "User", "Module", "Action", "FAR ID / Master", "Center",
        "Submitted By", "Approved By", "Request", "Reason", "Notes"
      ]);
      expect(values(changes, HEADER_ROW)).toEqual(["Event ID", "FAR ID / Master", "Field", "Old Value", "New Value"]);

      expect(events.rowCount).toBe(FIRST_DATA_ROW);
      const event = values(events, FIRST_DATA_ROW);
      expect(event[0]).toMatch(/^A-\d+$/);
      expect(event.slice(4, 8)).toEqual(["Capitalization", "Capitalization Create", "ACT-TEST-1", "Center-Test"]);

      const rows = changeRows(changes);
      expect(rows.every((r) => r[0] === event[0] && r[1] === "ACT-TEST-1")).toBe(true);
      const byField = Object.fromEntries(rows.map((r) => [r[2], r]));
      expect(byField["Component 1 Opening Cost"]).toEqual([event[0], "ACT-TEST-1", "Component 1 Opening Cost", null, 10000]);
      expect(byField["Date Acquired"]![4]).toBe("01-01-2026");
      expect(byField["Source"]).toBeUndefined(); // bookkeeping, not a field
      // A create lists only what was filled in: zero amounts and empty fields are left out.
      expect(byField["Additions C1"]).toBeUndefined();
      expect(byField["Serial No"]).toBeUndefined();
      // Amounts are number cells with 2 decimals; the Event ID links back to Events.
      const amountCell = changes.getRow(FIRST_DATA_ROW + rows.findIndex((r) => r[2] === "Component 1 Opening Cost")).getCell(5);
      expect(amountCell.numFmt).toBe("#,##0.00;(#,##0.00);0.00");
      // Qty and Useful Life are numbers but not amounts: no money format.
      const lifeCell = changes.getRow(FIRST_DATA_ROW + rows.findIndex((r) => r[2] === "Component 1 Useful Life (Years)")).getCell(5);
      expect(lifeCell.value).toBe(5);
      expect(lifeCell.numFmt ?? "General").not.toContain("0.00");
      expect((changes.getRow(FIRST_DATA_ROW).getCell(1).value as { hyperlink: string }).hyperlink).toBe(`#'Events'!A${FIRST_DATA_ROW}`);
    });

    it("the filter summary line reflects the category filter actually applied", async () => {
      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export?category=masters" });
      const { events } = await readBook(res.rawPayload);
      expect(values(events, 3)[0]).toBe("Filters: Category: Masters");
    });

    it("a Masters update is Old -> New on its own field, with the master named in FAR ID / Master", async () => {
      const create = await authedInject(app, { method: "POST", url: "/api/masters/centers", payload: { code: "Center-ExportDiff", description: "Old description" } });
      await authedInject(app, { method: "PATCH", url: `/api/masters/centers/${create.json().id}`, payload: { description: "New description" } });
      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export?category=masters" });
      const { events, changes } = await readBook(res.rawPayload);
      const updateEvent = values(events, FIRST_DATA_ROW + 1);
      expect(updateEvent[5]).toBe("Center Updated");
      expect(updateEvent[6]).toBe("Center-ExportDiff");
      const rows = changeRows(changes).filter((r) => r[0] === updateEvent[0]);
      expect(rows.find((r) => r[2] === "Description")).toEqual([updateEvent[0], "Center-ExportDiff", "Description", "Old description", "New description"]);
    });

    it("a Disposal shows Status (to Disposed), Disposal Date and Sale Value as Old -> New, the sale value as a number", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, { method: "PATCH", url: "/api/assets/ACT-TEST-1/disposal", payload: { dateOfDisposal: "2026-07-01", saleValue: 500.5 } });
      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export?category=disposal" });
      const { events, changes } = await readBook(res.rawPayload);
      expect(events.rowCount).toBe(FIRST_DATA_ROW);
      const byField = Object.fromEntries(changeRows(changes).map((r) => [r[2], [r[3], r[4]]]));
      expect(byField["Status"]).toEqual(["Active", "Disposed"]);
      expect(byField["Disposal Date"]![1]).toBe("01-07-2026");
      expect(byField["Sale Value"]![1]).toBe(500.5);
    });

    it("an Edit Asset event lists every changed field with its before and after values (not read before)", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, accDepC1Opening: 1234.56 } });
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/ACT-TEST-1",
        payload: {
          farId: "ACT-TEST-1", subClassification: "Test-Sub", assetDescription: "Renamed", serialNo: "",
          usefulLifeC1Years: 5, usefulLifeC2Years: 5, accDepC1Opening: 0, accDepC2Opening: 0, parentFarId: null
        }
      });
      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export?category=edit" });
      const { events, changes } = await readBook(res.rawPayload);
      expect(values(events, FIRST_DATA_ROW)[4]).toBe("Asset Edit");
      const byField = Object.fromEntries(changeRows(changes).map((r) => [r[2], [r[3], r[4]]]));
      expect(byField["Asset Description"]).toEqual(["Activity Log Test Asset", "Renamed"]);
      // Changed to zero still appears, as numbers.
      expect(byField["Opening Accumulated Depreciation (Component 1)"]).toEqual([1234.56, 0]);
    });

    it("a Delete event carries its Reason, and what was removed as Old Value", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, { method: "DELETE", url: "/api/assets/ACT-TEST-1", payload: { reason: "created by mistake" } });
      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export" });
      const { events, changes } = await readBook(res.rawPayload);
      const createEvent = values(events, FIRST_DATA_ROW);
      const deleteEvent = values(events, FIRST_DATA_ROW + 1);
      expect(createEvent[11]).toBeFalsy();
      expect(deleteEvent[5]).toBe("Capitalization Delete");
      expect(deleteEvent[0]).toMatch(/^D-\d+$/);
      expect(deleteEvent[11]).toBe("created by mistake");
      const removed = changeRows(changes).filter((r) => r[0] === deleteEvent[0]);
      expect(removed.find((r) => r[2] === "Component 1 Opening Cost")).toEqual([deleteEvent[0], "ACT-TEST-1", "Component 1 Opening Cost", 10000, null]);
    });

    it("respects the same category filter as the list endpoint", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, { method: "POST", url: "/api/masters/centers", payload: { code: "Center-ExportFilter" } });
      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export?category=capitalization" });
      const { events } = await readBook(res.rawPayload);
      expect(events.rowCount).toBe(FIRST_DATA_ROW);
      expect(values(events, FIRST_DATA_ROW)[4]).toBe("Capitalization");
    });

    it("refuses a workbook too large for Excel with a clear message pointing to the CSV", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, { method: "POST", url: "/api/masters/centers", payload: { code: "Center-TooBig" } });
      setXlsxMaxEntriesForTests(1);
      try {
        const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export" });
        expect(res.statusCode).toBe(413);
        expect(res.json().code).toBe("TOO_LARGE_FOR_XLSX");
        expect(res.json().error).toMatch(/use the CSV export/);
      } finally {
        setXlsxMaxEntriesForTests(XLSX_MAX_ENTRIES);
      }
    });

    it("format=csv streams the Changes layout (any size)", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export?format=csv" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      const lines = res.rawPayload.toString("utf-8").split("\r\n").filter((l) => l.length > 0);
      expect(lines[0]!.charCodeAt(0)).toBe(0xfeff);
      expect(lines[1]).toBe("Event ID,Date & Time (IST),User,FAR ID / Master,Module,Action,Field,Old Value,New Value,Request");
      expect(lines.some((l) => /ACT-TEST-1,Capitalization,Capitalization Create,Component 1 Opening Cost,,10000,$/.test(l))).toBe(true);
    });

    it("an empty result still returns a valid workbook with just the header band on both sheets", async () => {
      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export" });
      expect(res.statusCode).toBe(200);
      const { events, changes } = await readBook(res.rawPayload);
      expect(events.rowCount).toBe(HEADER_ROW);
      expect(changes.rowCount).toBe(HEADER_ROW);
    });
  });
});

describe("Activity Log workbook: never past Excel's row limit", () => {
  it("continues on 'Changes (2)', 'Changes (3)' instead of truncating, each with its header band", async () => {
    // A tiny limit stands in for Excel's 1,048,576: 5 header rows + 3 data rows per sheet.
    const book = createActivityWorkbook({ generatedLine: "g", filterLine: "f", appUrl: null }, 8);
    const event = (i: number) => ({
      eventId: `A-${i}`, timestamp: "t", financialYear: "FY", user: "u", module: "m", action: "a", record: `R-${i}`,
      center: "", submittedBy: "", approvedBy: "", requestId: null, reason: "", notes: ""
    });
    for (let i = 1; i <= 4; i++) {
      book.addEvent(event(i), [1, 2].map((n) => ({ field: `F${n}`, oldValue: null, newValue: n, amount: false })));
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await book.finish()) as any);
    expect(workbook.worksheets.map((w) => w.name).sort()).toEqual(["Changes", "Changes (2)", "Changes (3)", "Events", "Events (2)"]);
    const dataRows = (name: string) => {
      const sheet = workbook.getWorksheet(name)!;
      const out: string[] = [];
      for (let r = 6; r <= sheet.rowCount; r++) out.push(String((sheet.getRow(r).getCell(3).value ?? sheet.getRow(r).getCell(1).value) as string));
      return out;
    };
    // 8 change rows in total, 3 per sheet, none lost; every sheet has its own header.
    expect([...dataRows("Changes"), ...dataRows("Changes (2)"), ...dataRows("Changes (3)")]).toHaveLength(8);
    expect(workbook.getWorksheet("Changes (3)")!.getRow(5).getCell(3).value).toBe("Field");
    expect(workbook.getWorksheet("Events (2)")!.getRow(6).getCell(1).value).toBe("A-4");
  });
});
