import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import activityLogExportJobsRoutes, { advanceActivityLogExportJob, setObjectStorageForTests } from "./activityLogExportJobs.js";
import { getPool } from "../db/pool.js";
import { authGateHook } from "../auth/middleware.js";
import { authedInject, authHeaderFor, createTestUser } from "../testHelpers/authTestUtils.js";
import { s3ObjectStorage, type ObjectStorage, type UploadPart } from "../storage/objectStorage.js";

async function insertAsset(farId: string) {
  const db = await getPool();
  await db.query(
    `INSERT INTO assets (far_id, sub_classification, asset_description, status, date_acquired, location, useful_life_c1_years, useful_life_c2_years, c1_opening_cost, c2_opening_cost)
     VALUES ($1, 'Test-Sub', $2, 'Active', '2020-01-01', 'Center-ExportJob', 5, 5, 10000, 0)`,
    [farId, `Activity export job test ${farId}`]
  );
}

/** Direct insert into asset_activity_log, bypassing the real Capitalization route (same
 *  choice assetsExportJobs.test.ts makes for assets themselves) — `createdAt` is
 *  explicit, not `now()`, so a test can control the (created_at, src, id) ordering these
 *  jobs page through deterministically instead of racing real clock resolution. */
async function insertActivityLogRow(farId: string, createdAt: string, details: Record<string, unknown> | null = null) {
  const db = await getPool();
  await db.query(
    `INSERT INTO asset_activity_log (action, far_id, details, created_at) VALUES ('capitalization_create', $1, $2, $3)`,
    [farId, details ? JSON.stringify(details) : null, createdAt]
  );
}

// Same in-memory S3 stand-in as assetsExportJobs.test.ts's own FakeObjectStorage —
// duplicated rather than imported (test files in this codebase are self-contained, same
// convention as the production files this mirrors).
class FakeObjectStorage implements ObjectStorage {
  private uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  completed = new Map<string, string>();
  aborted = new Set<string>();

  async createMultipartUpload(key: string): Promise<string> {
    const uploadId = `upload-${this.uploads.size + 1}`;
    this.uploads.set(uploadId, { key, parts: new Map() });
    return uploadId;
  }

  async uploadPart(_key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error(`uploadPart: unknown uploadId ${uploadId}`);
    upload.parts.set(partNumber, Buffer.from(body));
    return `etag-${uploadId}-${partNumber}`;
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: UploadPart[]): Promise<{ sizeBytes: number }> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error(`completeMultipartUpload: unknown uploadId ${uploadId}`);
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const nonTrailing = ordered.slice(0, -1).map((p) => upload.parts.get(p.partNumber)?.length ?? 0);
    if (nonTrailing.length > 1 && new Set(nonTrailing).size > 1) {
      throw new Error("All non-trailing parts must have the same length.");
    }
    const body = Buffer.concat(ordered.map((p) => upload.parts.get(p.partNumber) ?? Buffer.alloc(0))).toString("utf-8");
    this.completed.set(key, body);
    return { sizeBytes: Buffer.byteLength(body, "utf-8") };
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.aborted.add(uploadId);
  }

  async getSignedDownloadUrl(key: string): Promise<string> {
    return `https://fake-storage.test/${encodeURIComponent(key)}?signed=1`;
  }
}

interface JobRowForTest {
  id: string;
  status: string;
  total_rows: number | null;
  processed_rows: number;
  file_url: string | null;
  error_message: string | null;
  object_key: string;
}

async function insertJobRow(id: string, userId: number, filters: Record<string, unknown> = {}) {
  const db = await getPool();
  await db.query(
    `INSERT INTO export_jobs (id, user_id, status, job_type, filters, as_at, object_key)
     VALUES ($1, $2, 'PENDING', 'ACTIVITY_LOG', $3, $4, $5)`,
    [id, userId, JSON.stringify(filters), "2026-01-01", `exports/${userId}/activity-${id}.csv`]
  );
}

async function fetchJobRow(id: string): Promise<JobRowForTest> {
  const db = await getPool();
  const { rows } = await db.query<JobRowForTest>(`SELECT * FROM export_jobs WHERE id = $1`, [id]);
  return rows[0]!;
}

describe("Background Activity Log export: advanceActivityLogExportJob", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await createTestUser({ username: "activity-export-job-owner" });
    userId = user.id;
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM asset_activity_log`);
    await db.query(`DELETE FROM export_jobs`);
    await db.query(`DELETE FROM assets`);
  });

  it("completes a small export in one hop and uploads the expected flat CSV", async () => {
    await insertAsset("ACTJOB-001");
    await insertAsset("ACTJOB-002");
    await insertActivityLogRow("ACTJOB-001", "2026-01-01T10:00:00Z");
    await insertActivityLogRow("ACTJOB-002", "2026-01-01T11:00:00Z", { previous: { status: "Active" }, status: "Disposed" });
    const storage = new FakeObjectStorage();
    await insertJobRow("act-job-basic", userId, {});

    await advanceActivityLogExportJob(await getPool(), "act-job-basic", storage, 60_000);

    const job = await fetchJobRow("act-job-basic");
    expect(job.status).toBe("COMPLETED");
    expect(job.processed_rows).toBe(2);
    expect(job.file_url).toContain("signed=1");

    const body = storage.completed.get(job.object_key)!;
    // UTF-8 BOM as the literal first character — see assetsExportJobs.test.ts's identical
    // assertion for why (the real "â€”" mojibake bug this fixes).
    expect(body.charCodeAt(0)).toBe(0xfeff);
    const lines = body.split("\r\n").filter((l) => l.length > 0);
    expect(lines[0]).toContain("Filters applied:");
    // The exact filter-summary text this bug was reported against — a plain ASCII
    // hyphen, not an em-dash (which would mojibake to "â€”" once Excel guesses the
    // wrong encoding for a BOM-less file — no longer possible either, per the BOM
    // assertion above).
    expect(lines[0]).toContain("Filters: None - showing all activity");
    expect(lines[1]).toBe("Timestamp,Category,Action,FAR ID,Actor,Details (Summary),Source");
    expect(lines.length).toBe(4); // filter row + header row + 2 data rows, oldest first
    expect(lines[2]).toContain("ACTJOB-001");
    expect(lines[2]).toContain("Activity Log");
    expect(lines[3]).toContain("ACTJOB-002");
    expect(lines[3]).toContain("Status"); // humanized `previous` key, in the Details (Summary) column
  });

  it("resumes across multiple hops without losing or duplicating rows, in created_at order", async () => {
    for (const [suffix, hour] of [["A", "10"], ["B", "11"], ["C", "12"], ["D", "13"], ["E", "14"]] as const) {
      await insertAsset(`ACTRESUME-${suffix}`);
      await insertActivityLogRow(`ACTRESUME-${suffix}`, `2026-01-01T${hour}:00:00Z`);
    }
    const storage = new FakeObjectStorage();
    await insertJobRow("act-job-resume", userId, {});

    // Near-zero budget: header rows persist, but no batch completes — proves the upload
    // isn't orphaned by a hop that stalls before its first flush (same guarantee
    // assetsExportJobs.test.ts's own resume test asserts for Register).
    await advanceActivityLogExportJob(await getPool(), "act-job-resume", storage, 0);
    let job = await fetchJobRow("act-job-resume");
    expect(job.status).not.toBe("COMPLETED");
    expect(job.processed_rows).toBe(0);

    await advanceActivityLogExportJob(await getPool(), "act-job-resume", storage, 60_000);
    job = await fetchJobRow("act-job-resume");
    expect(job.status).toBe("COMPLETED");
    expect(job.processed_rows).toBe(5);

    const body = storage.completed.get(job.object_key)!;
    const farIdsInBody = body
      .split("\r\n")
      .filter((l) => l.length > 0)
      .slice(2)
      .map((l) => l.split(",")[3]!.replace(/"/g, ""));
    expect(farIdsInBody).toEqual(["ACTRESUME-A", "ACTRESUME-B", "ACTRESUME-C", "ACTRESUME-D", "ACTRESUME-E"]);
    expect(storage.aborted.size).toBe(0);
  });
});

describe("Background Activity Log export: HTTP routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(activityLogExportJobsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    setObjectStorageForTests(s3ObjectStorage);
    await app.close();
    const db = await getPool();
    await db.query(`DELETE FROM export_jobs`);
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM export_jobs`);
  });

  it("POST rejects with 503 when object storage isn't configured (test env has no S3 credentials)", async () => {
    const res = await authedInject(app, { method: "POST", url: "/api/audit-log/activity/export/jobs" });
    expect(res.statusCode).toBe(503);
  });

  it("GET a job belonging to a different user 404s instead of leaking its state", async () => {
    const owner = await createTestUser({ username: "activity-export-job-http-owner" });
    await insertJobRow("act-job-not-mine", owner.id, {});

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export/jobs/act-job-not-mine" });
    expect(res.statusCode).toBe(404);
  });

  it("GET a REGISTER-typed job (wrong job_type on this route) 404s rather than crashing", async () => {
    const owner = await createTestUser({ username: "activity-export-job-http-wrongtype" });
    const db = await getPool();
    await db.query(
      `INSERT INTO export_jobs (id, user_id, status, job_type, filters, as_at, object_key)
       VALUES ('act-job-wrong-type', $1, 'PENDING', 'REGISTER', '{}', '2026-01-01', 'exports/x/y.csv')`,
      [owner.id]
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/audit-log/activity/export/jobs/act-job-wrong-type",
      headers: { cookie: authHeaderFor(owner.id, owner.username) }
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET advances a PENDING job using whatever storage backend is active, then reports its status", async () => {
    await insertAsset("ACTJOBHTTP-001");
    await insertActivityLogRow("ACTJOBHTTP-001", "2026-01-01T10:00:00Z");
    const owner = await createTestUser({ username: "activity-export-job-http-owner-2" });
    // farId-filtered — the "advanceActivityLogExportJob" describe block above may leave
    // its own rows behind in the shared test DB (same convention assetsExportJobs.test.ts's
    // HTTP describe relies on, via its own `search: "JOBHTTP"` filter), so this scopes to
    // exactly the one row this test cares about rather than picking up every leftover row.
    await insertJobRow("act-job-http", owner.id, { farId: "ACTJOBHTTP" });
    const storage = new FakeObjectStorage();
    setObjectStorageForTests(storage);

    const res = await app.inject({
      method: "GET",
      url: "/api/audit-log/activity/export/jobs/act-job-http",
      headers: { cookie: authHeaderFor(owner.id, owner.username) }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("COMPLETED");
    expect(body.processedRows).toBe(1);
    expect(body.fileUrl).toContain("signed=1");
  });
});
