import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import settingsRoutes from "./settings.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";

describe("Settings", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(settingsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM settings`);
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
});
