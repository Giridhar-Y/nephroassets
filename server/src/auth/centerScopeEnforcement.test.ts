import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "../routes/assets.js";
import adminUsersRoutes from "../routes/adminUsers.js";
import { getPool } from "../db/pool.js";
import { authGateHook } from "./middleware.js";
import { authedInject, authHeaderFor, createTestUser } from "../testHelpers/authTestUtils.js";

// End-to-end coverage of center-scoped access (centerScope.ts) across the routes not
// already covered by transfers.test.ts/bulkTransfers.test.ts's own "Center-scoped
// access" describe blocks — Register listing, Asset History, Capitalization, Edit,
// Additions, Disposal, and the Admin Permissions panel's center-access round trip.
// centerScope.test.ts covers the shared primitives in isolation; this file proves
// they're actually wired into the routes the approved model said they should be.
describe("Center-scoped access — cross-endpoint enforcement", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(assetsRoutes);
    await app.register(adminUsersRoutes);
    await app.ready();

    const db = await getPool();
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, '2026-08-17', '2026-04-01', '2027-03-31', 365)
       ON CONFLICT (id) DO UPDATE SET as_at = '2026-08-17', fy_start = '2026-04-01', fy_end = '2027-03-31', days_in_fy = 365`
    );
    // Capitalization validates status/subClassification against active Masters —
    // seeded once (unlike centers below, neither table is wiped per-test). ON CONFLICT
    // DO NOTHING since this suite shares one Postgres instance sequentially across
    // every test file (vitest.config.ts's fileParallelism:false) and another file may
    // have already seeded the same well-known "Active"/"Test-Sub" names.
    await db.query(
      `INSERT INTO statuses (name, active, system_managed) VALUES ('Active', TRUE, FALSE) ON CONFLICT (LOWER(name)) DO NOTHING`
    );
    await db.query(`INSERT INTO sub_classifications (name, active) VALUES ('Test-Sub', TRUE) ON CONFLICT (LOWER(name)) DO NOTHING`);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    await db.query(`DELETE FROM centers`);
    await db.query(`INSERT INTO centers (code) VALUES ('Center-A'), ('Center-B'), ('Center-C')`);
  });

  async function insertAsset(farId: string, location = "Center-A", overrides: Record<string, unknown> = {}) {
    const db = await getPool();
    const row = {
      far_id: farId,
      sub_classification: "Test-Sub",
      asset_description: `Center scope test ${farId}`,
      status: "Active",
      date_acquired: "2020-01-01",
      location,
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

  describe("Register listing (GET /api/assets)", () => {
    it("a scoped user only sees assets currently in their own center(s)", async () => {
      const user = await createTestUser({ username: "cse-register", role: "editor", centerAccess: ["Center-A"] });
      await insertAsset("CSE-REG-IN", "Center-A");
      await insertAsset("CSE-REG-OUT", "Center-B");

      const res = await authedInject(app, {
        method: "GET",
        url: "/api/assets",
        headers: { cookie: authHeaderFor(user.id, user.username) }
      });
      expect(res.statusCode).toBe(200);
      const farIds = new Set(res.json().items.map((i: { asset: { farId: string } }) => i.asset.farId));
      expect(farIds.has("CSE-REG-IN")).toBe(true);
      expect(farIds.has("CSE-REG-OUT")).toBe(false);
    });

    it("an unscoped user still sees every center's assets", async () => {
      await insertAsset("CSE-REG-UNSCOPED-A", "Center-A");
      await insertAsset("CSE-REG-UNSCOPED-B", "Center-B");
      const res = await authedInject(app, { method: "GET", url: "/api/assets" });
      const farIds = new Set(res.json().items.map((i: { asset: { farId: string } }) => i.asset.farId));
      expect(farIds.has("CSE-REG-UNSCOPED-A")).toBe(true);
      expect(farIds.has("CSE-REG-UNSCOPED-B")).toBe(true);
    });
  });

  describe("Asset History (GET /api/assets/:farId)", () => {
    it("404s an in-scope FAR ID's out-of-scope counterpart, but serves the in-scope one", async () => {
      const user = await createTestUser({ username: "cse-detail", role: "editor", centerAccess: ["Center-A"] });
      await insertAsset("CSE-DETAIL-IN", "Center-A");
      await insertAsset("CSE-DETAIL-OUT", "Center-B");
      const cookieHeader = authHeaderFor(user.id, user.username);

      const inScope = await authedInject(app, {
        method: "GET",
        url: "/api/assets/CSE-DETAIL-IN",
        headers: { cookie: cookieHeader }
      });
      expect(inScope.statusCode).toBe(200);

      const outOfScope = await authedInject(app, {
        method: "GET",
        url: "/api/assets/CSE-DETAIL-OUT",
        headers: { cookie: cookieHeader }
      });
      expect(outOfScope.statusCode).toBe(404);
    });
  });

  describe("Capitalization (POST /api/assets)", () => {
    it("403s capitalizing into a center the user doesn't manage, and names it", async () => {
      const user = await createTestUser({ username: "cse-capz", role: "editor", centerAccess: ["Center-A"] });
      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets",
        headers: { cookie: authHeaderFor(user.id, user.username) },
        payload: {
          farId: "CSE-CAPZ-1",
          subClassification: "Test-Sub",
          assetDescription: "Out of scope capitalization",
          status: "Active",
          dateAcquired: "2026-01-01",
          location: "Center-B",
          usefulLifeC1Years: 5,
          usefulLifeC2Years: 5,
          c1OpeningCost: 1000,
          c2OpeningCost: 0
        }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain("Center-B");
    });

    it("allows capitalizing into a center the user does manage", async () => {
      const user = await createTestUser({ username: "cse-capz-ok", role: "editor", centerAccess: ["Center-A"] });
      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets",
        headers: { cookie: authHeaderFor(user.id, user.username) },
        payload: {
          farId: "CSE-CAPZ-2",
          subClassification: "Test-Sub",
          assetDescription: "In scope capitalization",
          status: "Active",
          dateAcquired: "2026-01-01",
          location: "Center-A",
          usefulLifeC1Years: 5,
          usefulLifeC2Years: 5,
          c1OpeningCost: 1000,
          c2OpeningCost: 0
        }
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("Edit (PATCH /api/assets/:farId)", () => {
    it("404s editing an asset currently outside the user's scope", async () => {
      const user = await createTestUser({ username: "cse-edit", role: "editor", centerAccess: ["Center-A"] });
      await insertAsset("CSE-EDIT-1", "Center-B");
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/CSE-EDIT-1",
        headers: { cookie: authHeaderFor(user.id, user.username) },
        payload: {
          farId: "CSE-EDIT-1",
          subClassification: "Test-Sub",
          assetDescription: "Renamed",
          usefulLifeC1Years: 5,
          usefulLifeC2Years: 5,
          accDepC1Opening: 0,
          accDepC2Opening: 0,
          parentFarId: null
        }
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("Additions (PATCH /api/assets/:farId/addition)", () => {
    it("404s recording an addition on an asset currently outside the user's scope", async () => {
      const user = await createTestUser({ username: "cse-add", role: "editor", centerAccess: ["Center-A"] });
      await insertAsset("CSE-ADD-1", "Center-B");
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/CSE-ADD-1/addition",
        headers: { cookie: authHeaderFor(user.id, user.username) },
        payload: { additionsC1: 500, dateOfAddition: "2026-06-01" }
      });
      expect(res.statusCode).toBe(404);
    });

    it("allows recording an addition on an in-scope asset", async () => {
      const user = await createTestUser({ username: "cse-add-ok", role: "editor", centerAccess: ["Center-A"] });
      await insertAsset("CSE-ADD-2", "Center-A");
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/CSE-ADD-2/addition",
        headers: { cookie: authHeaderFor(user.id, user.username) },
        payload: { additionsC1: 500, dateOfAddition: "2026-06-01" }
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("Disposal (PATCH /api/assets/:farId/disposal)", () => {
    it("404s disposing an asset currently outside the user's scope", async () => {
      const user = await createTestUser({ username: "cse-disp", role: "editor", centerAccess: ["Center-A"] });
      await insertAsset("CSE-DISP-1", "Center-B");
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/CSE-DISP-1/disposal",
        headers: { cookie: authHeaderFor(user.id, user.username) },
        payload: { dateOfDisposal: "2026-06-01", saleValue: 0 }
      });
      expect(res.statusCode).toBe(404);
    });

    it("allows disposing an in-scope asset", async () => {
      const user = await createTestUser({ username: "cse-disp-ok", role: "editor", centerAccess: ["Center-A"] });
      await insertAsset("CSE-DISP-2", "Center-A");
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/CSE-DISP-2/disposal",
        headers: { cookie: authHeaderFor(user.id, user.username) },
        payload: { dateOfDisposal: "2026-06-01", saleValue: 0 }
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("Admin Permissions panel — center access round trip", () => {
    it("GET/PUT .../permissions reads and writes center access, and it's independent of module/action grants", async () => {
      const target = await createTestUser({ username: "cse-admin-target", role: "viewer" });
      const admin = await createTestUser({ username: "cse-admin-actor", role: "admin" });
      const adminCookie = authHeaderFor(admin.id, admin.username);

      const before = await authedInject(app, {
        method: "GET",
        url: `/api/admin/users/${target.id}/permissions`,
        headers: { cookie: adminCookie }
      });
      expect(before.statusCode).toBe(200);
      expect(before.json().centerAccess).toEqual([]);

      const put = await authedInject(app, {
        method: "PUT",
        url: `/api/admin/users/${target.id}/permissions`,
        headers: { cookie: adminCookie },
        payload: { grants: [{ module: "register", action: "view" }], centerAccess: ["Center-A", "Center-B"] }
      });
      expect(put.statusCode).toBe(200);
      expect(new Set(put.json().centerAccess)).toEqual(new Set(["Center-A", "Center-B"]));

      const db = await getPool();
      const { rows } = await db.query<{ code: string }>(
        `SELECT c.code FROM user_center_access uca JOIN centers c ON c.id = uca.center_id WHERE uca.user_id = $1 ORDER BY c.code`,
        [target.id]
      );
      expect(rows.map((r) => r.code)).toEqual(["Center-A", "Center-B"]);

      // Saving back to an empty array un-scopes the user again.
      const unscope = await authedInject(app, {
        method: "PUT",
        url: `/api/admin/users/${target.id}/permissions`,
        headers: { cookie: adminCookie },
        payload: { grants: [{ module: "register", action: "view" }], centerAccess: [] }
      });
      expect(unscope.statusCode).toBe(200);
      const { rows: afterUnscope } = await db.query(`SELECT * FROM user_center_access WHERE user_id = $1`, [target.id]);
      expect(afterUnscope).toHaveLength(0);
    });

    it("rejects an unrecognized center name", async () => {
      const target = await createTestUser({ username: "cse-admin-badcenter", role: "viewer" });
      const admin = await createTestUser({ username: "cse-admin-actor2", role: "admin" });
      const res = await authedInject(app, {
        method: "PUT",
        url: `/api/admin/users/${target.id}/permissions`,
        headers: { cookie: authHeaderFor(admin.id, admin.username) },
        payload: { grants: [], centerAccess: ["Not-A-Real-Center"] }
      });
      expect(res.statusCode).toBe(400);
    });

    it("a newly created user starts unscoped regardless of role", async () => {
      const admin = await createTestUser({ username: "cse-admin-actor3", role: "admin" });
      const create = await authedInject(app, {
        method: "POST",
        url: "/api/admin/users",
        headers: { cookie: authHeaderFor(admin.id, admin.username) },
        payload: { username: "cse-brand-new", email: "cse-brand-new@example.invalid", password: "temp-password-123", role: "editor" }
      });
      expect(create.statusCode).toBe(200);
      const db = await getPool();
      const { rows } = await db.query(`SELECT * FROM user_center_access WHERE user_id = $1`, [create.json().id]);
      expect(rows).toHaveLength(0);
    });
  });
});
