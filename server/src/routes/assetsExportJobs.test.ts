import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsExportJobsRoutes, { advanceExportJob, setObjectStorageForTests } from "./assetsExportJobs.js";
import { exportQuerySchema } from "./assetsExport.js";
import { getPool } from "../db/pool.js";
import { authGateHook } from "../auth/middleware.js";
import { authedInject, authHeaderFor, createTestUser } from "../testHelpers/authTestUtils.js";
import { s3ObjectStorage, type ObjectStorage, type UploadPart } from "../storage/objectStorage.js";

const AS_AT = "2026-08-17";
const FY_START = "2026-04-01";
const FY_END = "2027-03-31";
const DAYS_IN_FY = 365;

async function insertAsset(farId: string, overrides: Record<string, unknown> = {}) {
  const db = await getPool();
  const row = {
    far_id: farId,
    sub_classification: "Test-Sub",
    asset_description: `Export job test ${farId}`,
    status: "Active",
    date_acquired: "2020-01-01",
    location: "Center-ExportJob",
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

/** One multi-row INSERT of `count` assets, each with a description padded to ~5KB — real
 *  exports never have descriptions this long, this is purely to reach multiple 8MB
 *  multipart parts (PART_SIZE_BYTES) with a few thousand rows instead of the ~1-200k a
 *  realistic row width would need, which would make this test far too slow for the
 *  routine `npm test` suite (see vitest.scale.config.ts's own comment on why THAT scale of
 *  test is kept separate). */
async function insertManyPaddedAssets(count: number, farIdPrefix: string): Promise<void> {
  const db = await getPool();
  const paddedDescription = "X".repeat(5000);
  const columns = [
    "far_id",
    "sub_classification",
    "asset_description",
    "status",
    "date_acquired",
    "location",
    "useful_life_c1_years",
    "useful_life_c2_years",
    "c1_opening_cost",
    "c2_opening_cost"
  ];
  const params: unknown[] = [];
  const rowPlaceholders: string[] = [];
  for (let i = 0; i < count; i++) {
    const values = [
      `${farIdPrefix}-${String(i).padStart(6, "0")}`,
      "Test-Sub",
      paddedDescription,
      "Active",
      "2020-01-01",
      "Center-ExportJob",
      5,
      5,
      10000,
      0
    ];
    rowPlaceholders.push(`(${values.map((_, colIdx) => `$${i * columns.length + colIdx + 1}`).join(",")})`);
    params.push(...values);
  }
  await db.query(`INSERT INTO assets (${columns.join(",")}) VALUES ${rowPlaceholders.join(",")}`, params);
}

/** An in-memory stand-in for S3 — tracks each multipart upload's parts (keyed by part
 *  number, order-independent since S3 itself doesn't require parts uploaded in order,
 *  only completed in order) so a test can read back exactly what would have reached the
 *  bucket, with no real one involved. */
class FakeObjectStorage implements ObjectStorage {
  private uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  completed = new Map<string, string>(); // object key -> concatenated final body (decoded)
  aborted = new Set<string>(); // uploadId

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
    // Same real-world constraint R2 enforces (assetsExportJobs.ts's PART_SIZE_BYTES
    // comment) — every part but the last must be the exact same length. Asserted here so
    // any regression in the fixed-size-flush logic fails a test instead of only surfacing
    // against the real bucket in production.
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

const DEFAULT_FILTERS = exportQuerySchema.parse({});

interface JobRowForTest {
  id: string;
  status: string;
  total_rows: number | null;
  processed_rows: number;
  file_url: string | null;
  error_message: string | null;
  object_key: string;
}

async function insertJobRow(id: string, userId: number, overrides: Partial<Record<string, unknown>> = {}) {
  const db = await getPool();
  const filters = { ...DEFAULT_FILTERS, ...((overrides.filters as object) ?? {}) };
  await db.query(
    `INSERT INTO export_jobs (id, user_id, status, filters, as_at, object_key)
     VALUES ($1, $2, 'PENDING', $3, $4, $5)`,
    [id, userId, JSON.stringify(filters), AS_AT, (overrides.object_key as string) ?? `exports/${userId}/${id}.csv`]
  );
}

async function fetchJobRow(id: string): Promise<JobRowForTest> {
  const db = await getPool();
  const { rows } = await db.query<JobRowForTest>(`SELECT * FROM export_jobs WHERE id = $1`, [id]);
  return rows[0]!;
}

describe("Background Register export: advanceExportJob", () => {
  let userId: number;

  beforeAll(async () => {
    const db = await getPool();
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET as_at = $1, fy_start = $2, fy_end = $3, days_in_fy = $4`,
      [AS_AT, FY_START, FY_END, DAYS_IN_FY]
    );
    const user = await createTestUser({ username: "export-job-owner" });
    userId = user.id;
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    await db.query(`DELETE FROM export_jobs`);
  });

  it("completes a small export in one hop and uploads the expected CSV", async () => {
    await insertAsset("JOBTEST-001");
    await insertAsset("JOBTEST-002");
    await insertAsset("JOBTEST-003");
    const storage = new FakeObjectStorage();
    await insertJobRow("job-basic", userId, { filters: { search: "JOBTEST" } });

    await advanceExportJob(await getPool(), "job-basic", storage, 60_000);

    const job = await fetchJobRow("job-basic");
    expect(job.status).toBe("COMPLETED");
    expect(job.total_rows).toBe(3);
    expect(job.processed_rows).toBe(3);
    expect(job.file_url).toContain("signed=1");

    const body = storage.completed.get(job.object_key)!;
    // UTF-8 BOM as the literal first character — without it, Excel mis-guesses the
    // file's encoding and mangles any non-ASCII character into mojibake (a real
    // production bug this was the fix for).
    expect(body.charCodeAt(0)).toBe(0xfeff);
    const lines = body.split("\r\n").filter((l) => l.length > 0);
    expect(lines[0]).toContain("Filters applied:");
    expect(lines[1]).toContain("Asset Identification"); // group-band row
    expect(lines[2]).toContain("FAR ID");
    const farIdsInBody = lines.slice(3).map((l) => l.split(",")[0]);
    expect(farIdsInBody).toEqual(["JOBTEST-001", "JOBTEST-002", "JOBTEST-003"]);
  });

  it("excludes an asset disposed before FY Start, but keeps one disposed on/after it", async () => {
    await insertAsset("JOBDISP-PRIOR-FY", { status: "Disposed", date_of_disposal: "2025-12-15" });
    await insertAsset("JOBDISP-ON-FY-START", { status: "Disposed", date_of_disposal: FY_START });
    await insertAsset("JOBDISP-THIS-FY", { status: "Disposed", date_of_disposal: "2026-06-01" });
    const storage = new FakeObjectStorage();
    await insertJobRow("job-disposal-fy", userId, { filters: { search: "JOBDISP" } });

    await advanceExportJob(await getPool(), "job-disposal-fy", storage, 60_000);

    const job = await fetchJobRow("job-disposal-fy");
    const body = storage.completed.get(job.object_key)!;
    const farIdsInBody = body
      .split("\r\n")
      .filter((l) => l.length > 0)
      .slice(3)
      .map((l) => l.split(",")[0]);
    expect(farIdsInBody).not.toContain("JOBDISP-PRIOR-FY");
    expect(farIdsInBody).toContain("JOBDISP-ON-FY-START");
    expect(farIdsInBody).toContain("JOBDISP-THIS-FY");
  });

  // Regression test for a real production failure: Cloudflare R2 rejected
  // CompleteMultipartUpload with "All non-trailing parts must have the same length" the
  // first time this feature ran against a real bucket — R2 enforces that constraint,
  // unlike S3 (which only requires >=5MB per part, size can vary). ~4,200 padded-
  // description rows push this comfortably past two full PART_SIZE_BYTES (8MB) flushes
  // plus a smaller final part, so FakeObjectStorage's own same-length assertion (see its
  // completeMultipartUpload) actually gets exercised, not just trivially satisfied by a
  // single-part export.
  it("produces multiple same-length parts for a large export, not just one", async () => {
    const ROW_COUNT = 4200;
    await insertManyPaddedAssets(ROW_COUNT, "JOBBIG");
    const storage = new FakeObjectStorage();
    await insertJobRow("job-big", userId, { filters: { search: "JOBBIG" } });

    await advanceExportJob(await getPool(), "job-big", storage, 60_000);

    const job = await fetchJobRow("job-big");
    expect(job.status).toBe("COMPLETED");
    expect(job.processed_rows).toBe(ROW_COUNT);

    const body = storage.completed.get(job.object_key)!;
    const lines = body.split("\r\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(ROW_COUNT + 3); // + filter-summary row + group-band row + header row
  }, 30_000);

  it("resumes across multiple hops without losing or duplicating rows", async () => {
    for (const suffix of ["A", "B", "C", "D", "E"]) await insertAsset(`JOBRESUME-${suffix}`);
    const storage = new FakeObjectStorage();
    await insertJobRow("job-resume", userId, { filters: { search: "JOBRESUME" } });

    // A near-zero budget: the header rows get created and persisted, but the very first
    // batch never gets a chance to run — proves the upload isn't lost/orphaned by a hop
    // that stalls before completing anything (see advanceExportJob's own comment on why
    // upload_id/pending_buffer are persisted immediately, not deferred to first flush).
    await advanceExportJob(await getPool(), "job-resume", storage, 0);
    let job = await fetchJobRow("job-resume");
    expect(job.status).not.toBe("COMPLETED");
    expect(job.processed_rows).toBe(0);

    // A second, ample-budget hop resumes from exactly that state and finishes.
    await advanceExportJob(await getPool(), "job-resume", storage, 60_000);
    job = await fetchJobRow("job-resume");
    expect(job.status).toBe("COMPLETED");
    expect(job.processed_rows).toBe(5);

    const body = storage.completed.get(job.object_key)!;
    const farIdsInBody = body
      .split("\r\n")
      .filter((l) => l.length > 0)
      .slice(3)
      .map((l) => l.split(",")[0]);
    expect(farIdsInBody).toEqual(["JOBRESUME-A", "JOBRESUME-B", "JOBRESUME-C", "JOBRESUME-D", "JOBRESUME-E"]);
    // Only one multipart upload was ever created for this job — the near-zero-budget hop
    // above didn't orphan one and silently start a second.
    expect(storage.aborted.size).toBe(0);
  });

  it("marks the job FAILED (and aborts the multipart upload) when settings are missing", async () => {
    const db = await getPool();
    await db.query(`DELETE FROM settings`);
    const storage = new FakeObjectStorage();
    await insertJobRow("job-no-settings", userId);

    await advanceExportJob(db, "job-no-settings", storage, 60_000);

    const job = await fetchJobRow("job-no-settings");
    expect(job.status).toBe("FAILED");
    expect(job.error_message).toBeTruthy();

    // Restore for any later test in this file relying on settings existing.
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, $4)`,
      [AS_AT, FY_START, FY_END, DAYS_IN_FY]
    );
  });
});

describe("Background Register export: HTTP routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(assetsExportJobsRoutes);
    await app.ready();

    const db = await getPool();
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET as_at = $1, fy_start = $2, fy_end = $3, days_in_fy = $4`,
      [AS_AT, FY_START, FY_END, DAYS_IN_FY]
    );
  });

  afterAll(async () => {
    // Module-level, not per-instance — reset so a later test file importing the real
    // route (permissionEnforcement.test.ts) doesn't inherit this file's fake.
    setObjectStorageForTests(s3ObjectStorage);
    await app.close();
    // The last test in this describe leaves its own job row behind (beforeEach only
    // clears BEFORE each test, not after the final one) — clean it up here so it doesn't
    // outlive this file and block a later file's own `DELETE FROM users` on this file's
    // test users via export_jobs' FK (a real collision found running this file next to
    // roles.test.ts).
    const db = await getPool();
    await db.query(`DELETE FROM export_jobs`);
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM export_jobs`);
  });

  it("POST rejects with 503 when object storage isn't configured (test env has no S3 credentials)", async () => {
    const res = await authedInject(app, { method: "POST", url: "/api/assets/export/jobs" });
    expect(res.statusCode).toBe(503);
  });

  it("GET a job belonging to a different user 404s instead of leaking its state", async () => {
    const owner = await createTestUser({ username: "export-job-http-owner" });
    await insertJobRow("job-not-mine", owner.id);

    const res = await authedInject(app, { method: "GET", url: "/api/assets/export/jobs/job-not-mine" });
    expect(res.statusCode).toBe(404);
  });

  it("GET advances a PENDING job using whatever storage backend is active, then reports its status", async () => {
    await insertAsset("JOBHTTP-001");
    const owner = await createTestUser({ username: "export-job-http-owner-2" });
    await insertJobRow("job-http", owner.id, { filters: { search: "JOBHTTP" } });
    const storage = new FakeObjectStorage();
    setObjectStorageForTests(storage);

    // Authenticated AS the job's owner (not the shared admin authedInject normally uses)
    // — this is the one request in this suite that must actually reach req.user.id ===
    // job.user_id for the ownership check to let it proceed at all.
    const res = await app.inject({
      method: "GET",
      url: "/api/assets/export/jobs/job-http",
      headers: { cookie: authHeaderFor(owner.id, owner.username) }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("COMPLETED");
    expect(body.processedRows).toBe(1);
    expect(body.fileUrl).toContain("signed=1");
  });
});
