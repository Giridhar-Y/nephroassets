import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import settingsRoutes from "./settings.js";
import { getPool } from "../db/pool.js";
import { authGateHook } from "../auth/middleware.js";
import { authedInject, authHeaderFor, createTestUser } from "../testHelpers/authTestUtils.js";

// Scoped to this file's own FAR IDs only — the assets/transfers tables are shared with
// every other test file in the same run, so a blanket DELETE FROM assets here would (and
// did) hit a foreign-key violation against transfers rows other files' tests own. Delete-
// then-insert (rather than relying on a shared beforeEach) also makes this idempotent
// against leftover rows from a previous interrupted run of the persistent test database.
async function insertAsset(overrides: {
  farId: string;
  dateAcquired?: string;
  c1OpeningCost?: number;
  usefulLifeC1Years?: number;
}) {
  const db = await getPool();
  await db.query(`DELETE FROM assets WHERE far_id = $1`, [overrides.farId]);
  await db.query(
    `INSERT INTO assets (
       far_id, sub_classification, asset_description, status, date_acquired, location,
       useful_life_c1_years, useful_life_c2_years, c1_opening_cost
     ) VALUES ($1, 'Test-Sub', 'DAYS_FY Preview Asset', 'Active', $2, 'Center-A', $3, 5, $4)`,
    [
      overrides.farId,
      overrides.dateAcquired ?? "2020-01-01",
      overrides.usefulLifeC1Years ?? 5,
      overrides.c1OpeningCost ?? 10000
    ]
  );
}

describe("Settings", () => {
  let app: FastifyInstance;
  let nonAdminCookie: string;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(settingsRoutes);
    await app.ready();

    const nonAdmin = await createTestUser({ username: "settings-non-admin", role: "editor" });
    nonAdminCookie = authHeaderFor(nonAdmin.id, nonAdmin.username);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM settings`);
    await db.query(`DELETE FROM settings_audit_log`);
  });

  it("returns 404 before any settings exist", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(404);
  });

  it("saves and returns a valid financial year", async () => {
    const put = await authedInject(app, {
      method: "PUT",
      url: "/api/settings",
      payload: { asAt: "2026-08-17", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365 }
    });
    expect(put.statusCode).toBe(200);

    const get = await authedInject(app, { method: "GET", url: "/api/settings" });
    expect(get.json()).toEqual({ asAt: "2026-08-17", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365 });
  });

  it("rejects a Financial Year End that is not after Financial Year Start", async () => {
    const res = await authedInject(app, {
      method: "PUT",
      url: "/api/settings",
      payload: { asAt: "2026-04-01", fyStart: "2026-04-01", fyEnd: "2026-04-01", daysInFy: 365 }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Financial Year End must be after Financial Year Start");
  });

  it("rejects an AS_AT outside the financial year", async () => {
    const res = await authedInject(app, {
      method: "PUT",
      url: "/api/settings",
      payload: { asAt: "2027-04-01", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365 }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("AS_AT must fall within the financial year");
  });

  it("accepts a leap-year day count of 366", async () => {
    const res = await authedInject(app, {
      method: "PUT",
      url: "/api/settings",
      payload: { asAt: "2027-06-01", fyStart: "2027-04-01", fyEnd: "2028-03-31", daysInFy: 366 }
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a non-admin on the full-form save", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { cookie: nonAdminCookie },
      payload: { asAt: "2026-08-17", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365 }
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets any role change AS_AT via the lightweight endpoint (the header's picker)", async () => {
    await authedInject(app, {
      method: "PUT",
      url: "/api/settings",
      payload: { asAt: "2026-08-17", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365 }
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings/as-at",
      headers: { cookie: nonAdminCookie },
      payload: { asAt: "2026-09-01" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ asAt: "2026-09-01", fyStart: "2026-04-01", fyEnd: "2027-03-31" });
  });

  it("rejects an AS_AT outside the financial year on the lightweight endpoint too", async () => {
    await authedInject(app, {
      method: "PUT",
      url: "/api/settings",
      payload: { asAt: "2026-08-17", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365 }
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings/as-at",
      headers: { cookie: nonAdminCookie },
      payload: { asAt: "2027-04-01" }
    });
    expect(res.statusCode).toBe(400);
  });

  describe("Depreciation Formula Settings: DAYS_FY", () => {
    beforeEach(async () => {
      await authedInject(app, {
        method: "PUT",
        url: "/api/settings",
        payload: { asAt: "2027-03-31", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365 }
      });
    });

    it("admin can change it, and the change is audited", async () => {
      const patch = await authedInject(app, {
        method: "PATCH",
        url: "/api/settings/days-in-fy",
        payload: { daysInFy: 366 }
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().daysInFy).toBe(366);

      const audit = await authedInject(app, { method: "GET", url: "/api/settings/audit-log" });
      expect(audit.statusCode).toBe(200);
      const entries = audit.json().items;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ field: "daysInFy", oldValue: "365", newValue: "366" });
      expect(entries[0].username).toBeTruthy();
    });

    it("rejects a non-admin", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/settings/days-in-fy",
        headers: { cookie: nonAdminCookie },
        payload: { daysInFy: 366 }
      });
      expect(res.statusCode).toBe(403);
    });

    it("rejects an out-of-range value", async () => {
      const tooLow = await authedInject(app, {
        method: "PATCH",
        url: "/api/settings/days-in-fy",
        payload: { daysInFy: 0 }
      });
      expect(tooLow.statusCode).toBe(400);

      const tooHigh = await authedInject(app, {
        method: "PATCH",
        url: "/api/settings/days-in-fy",
        payload: { daysInFy: 367 }
      });
      expect(tooHigh.statusCode).toBe(400);
    });

    it("preview reports no change when the proposed value equals the current one", async () => {
      await insertAsset({ farId: "DAYSFY-NOCHANGE" });
      const res = await authedInject(app, { method: "GET", url: "/api/settings/days-in-fy/preview?daysInFy=365" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ assetsChanged: 0, delta: 0 });
    });

    it("preview computes the real depreciation delta for a proposed value", async () => {
      // The assets table is shared with every other test file in this run (a blanket
      // DELETE here caused the exact FK violation this comment now warns against — see
      // insertAsset above), so this asserts the *differential* effect of adding one known
      // asset rather than an absolute totalAssets/assetsChanged count, which would be
      // whatever ambient rows the rest of the suite happens to have left behind.
      const before = await authedInject(app, { method: "GET", url: "/api/settings/days-in-fy/preview?daysInFy=366" });
      expect(before.statusCode).toBe(200);
      const beforeBody = before.json();

      // dateAcquired well before FY Start (so the whole FY is Opening, dep = (cost/
      // usefulLife) * (daysHeld/daysInFy), matching engine.ts's splitTranche exactly) but
      // recent enough that eol (dateAcquired + usefulLife) lands safely after fyEnd —
      // keeps this asset in the flat-rate branch of the end-of-life taper (engine.ts's
      // computeComponent), not the taper branch, where periodDepreciation wouldn't
      // depend on daysInFy at all and this test's whole premise (a DAYS_FY change
      // produces a real delta) wouldn't hold.
      await insertAsset({ farId: "DAYSFY-CHANGE", dateAcquired: "2024-01-01", c1OpeningCost: 10000, usefulLifeC1Years: 5 });
      const after = await authedInject(app, { method: "GET", url: "/api/settings/days-in-fy/preview?daysInFy=366" });
      expect(after.statusCode).toBe(200);
      const afterBody = after.json();

      const expectedOld = (10000 / 5) * (365 / 365);
      const expectedNew = (10000 / 5) * (365 / 366);
      expect(afterBody.totalAssets - beforeBody.totalAssets).toBe(1);
      expect(afterBody.assetsChanged - beforeBody.assetsChanged).toBe(1);
      expect(afterBody.currentTotalPeriodDep - beforeBody.currentTotalPeriodDep).toBeCloseTo(expectedOld, 2);
      expect(afterBody.projectedTotalPeriodDep - beforeBody.projectedTotalPeriodDep).toBeCloseTo(expectedNew, 2);
      expect(afterBody.delta - beforeBody.delta).toBeCloseTo(expectedNew - expectedOld, 2);
    });

    it("preview rejects a non-admin", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/settings/days-in-fy/preview?daysInFy=366",
        headers: { cookie: nonAdminCookie }
      });
      expect(res.statusCode).toBe(403);
    });

    it("audit log rejects a non-admin", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/settings/audit-log",
        headers: { cookie: nonAdminCookie }
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
