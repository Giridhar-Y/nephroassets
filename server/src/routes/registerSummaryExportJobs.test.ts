import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import reportsRoutes from "./reports.js";
import registerSummaryExportJobsRoutes, { advanceRegisterSummaryJob } from "./registerSummaryExportJobs.js";
import { getPool } from "../db/pool.js";
import { authGateHook } from "../auth/middleware.js";
import { authedInject, createTestUser } from "../testHelpers/authTestUtils.js";
import { clearReportCacheForTests } from "../db/reportCache.js";
import type { ObjectStorage, UploadPart } from "../storage/objectStorage.js";

// Same in-memory S3 stand-in the other background-export suites use (self-contained per
// file, the convention here).
class FakeObjectStorage implements ObjectStorage {
  private uploads = new Map<string, { parts: Map<number, Buffer> }>();
  completed = new Map<string, string>();
  async createMultipartUpload(): Promise<string> {
    const uploadId = `upload-${this.uploads.size + 1}`;
    this.uploads.set(uploadId, { parts: new Map() });
    return uploadId;
  }
  async uploadPart(_key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string> {
    this.uploads.get(uploadId)!.parts.set(partNumber, Buffer.from(body));
    return `etag-${partNumber}`;
  }
  async completeMultipartUpload(key: string, uploadId: string, parts: UploadPart[]): Promise<{ sizeBytes: number }> {
    const upload = this.uploads.get(uploadId)!;
    const body = Buffer.concat(parts.map((p) => upload.parts.get(p.partNumber)!)).toString("utf-8");
    this.completed.set(key, body);
    return { sizeBytes: body.length };
  }
  async abortMultipartUpload(): Promise<void> {}
  async getSignedDownloadUrl(key: string): Promise<string> {
    return `https://fake-storage.test/${encodeURIComponent(key)}?signed=1`;
  }
}

const AS_AT = "2026-08-17";

async function insertAsset(farId: string, overrides: Record<string, unknown>) {
  const row = {
    far_id: farId,
    sub_classification: "Dialysis Machines",
    asset_description: `Summary job ${farId}`,
    status: "Active",
    date_acquired: "2025-01-01",
    location: "Center-A",
    useful_life_c1_years: 5,
    useful_life_c2_years: 0,
    c1_opening_cost: 1000,
    c2_opening_cost: 0,
    ...overrides
  };
  const cols = Object.keys(row);
  await (await getPool()).query(
    `INSERT INTO assets (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(row)
  );
}

async function insertJob(id: string, userId: number, filters: Record<string, unknown> = {}) {
  await (await getPool()).query(
    `INSERT INTO export_jobs (id, user_id, status, job_type, filters, as_at, object_key)
     VALUES ($1, $2, 'PENDING', 'REGISTER_SUMMARY', $3, $4, $5)`,
    [id, userId, JSON.stringify({ conditions: [], asAt: AS_AT, ...filters }), AS_AT, `exports/${userId}/rs-${id}.csv`]
  );
}

async function job(id: string) {
  const { rows } = await (await getPool()).query(`SELECT * FROM export_jobs WHERE id = $1`, [id]);
  return rows[0];
}

describe("Background Register Summary export", () => {
  let app: FastifyInstance;
  let userId: number;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(reportsRoutes);
    await app.register(registerSummaryExportJobsRoutes);
    await app.ready();
    userId = (await createTestUser({ username: "rs-export-job-owner" })).id;
    await (await getPool()).query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, '2026-04-01', '2027-03-31', 365)
       ON CONFLICT (id) DO UPDATE SET as_at = $1, fy_start = '2026-04-01', fy_end = '2027-03-31', days_in_fy = 365`,
      [AS_AT]
    );
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM export_jobs`);
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    clearReportCacheForTests();
    // Seven assets over three groups, with paise and a group whose assets fall in
    // different slices (Center-A appears at both ends of the FAR ID order).
    await insertAsset("RS-01", { c1_opening_cost: 1000.125 });
    await insertAsset("RS-02", { location: "Center-B", c1_opening_cost: 250.5 });
    await insertAsset("RS-03", { status: "Disposed", date_of_disposal: "2026-05-01", deletions_c1: 900, sale_value: 100.25 });
    await insertAsset("RS-04", { location: "Center-B", qty: 3 });
    await insertAsset("RS-05", { c1_opening_cost: 333.33 });
    await insertAsset("RS-06", { location: "Center-B", c1_opening_cost: 10.01 });
    await insertAsset("RS-07", { c1_opening_cost: 0.005 });
  });

  it("merging FAR ID slices gives exactly the same CSV as the direct export, rounded to the paisa", async () => {
    const storage = new FakeObjectStorage();
    await insertJob("rs-slices", userId);
    // Two assets per slice and no time budget: one slice per hop, four hops plus the finish.
    for (let hop = 0; hop < 10 && (await job("rs-slices")).status !== "COMPLETED"; hop++) {
      await advanceRegisterSummaryJob(await getPool(), "rs-slices", storage, 0, console, 2);
    }
    const done = await job("rs-slices");
    expect(done.status).toBe("COMPLETED");
    expect(done.processed_rows).toBe(7);
    expect(done.total_rows).toBe(7);
    expect(done.state).toBeNull();

    const fromJob = storage.completed.get(done.object_key)!;
    expect(fromJob.charCodeAt(0)).toBe(0xfeff);
    const direct = await authedInject(app, { method: "GET", url: `/api/reports/register-summary/export?asAt=${AS_AT}` });
    expect(fromJob.slice(1)).toBe(direct.rawPayload.toString("utf-8"));
    expect(fromJob).toContain("Amounts rounded to the paisa");
  });

  it("a hop that finds another hop holding the lease does nothing (no double-counted slice)", async () => {
    await insertJob("rs-lease", userId);
    await (await getPool()).query(
      `UPDATE export_jobs SET status = 'PROCESSING', state = jsonb_build_object('groups', '{}'::jsonb, 'lastFarId', null, 'leaseUntil', (now() + interval '1 minute')::text) WHERE id = 'rs-lease'`
    );
    await advanceRegisterSummaryJob(await getPool(), "rs-lease", new FakeObjectStorage(), 60_000);
    const after = await job("rs-lease");
    expect(after.processed_rows).toBe(0);
    expect(after.status).toBe("PROCESSING");
  });

  it("POST says background storage isn't configured (test env has none), so the page can fall back to the direct export", async () => {
    const res = await authedInject(app, { method: "POST", url: "/api/reports/register-summary/export/jobs" });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("STORAGE_NOT_CONFIGURED");
  });
});
