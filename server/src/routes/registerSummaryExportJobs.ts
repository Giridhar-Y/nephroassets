import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type pg from "pg";
import { getPool } from "../db/pool.js";
import { requirePermission } from "../auth/middleware.js";
import { fetchCenterScope } from "../auth/centerScope.js";
import {
  aggregateRegisterSummaryGroups,
  planRegisterSummary,
  registerSummaryColumns,
  registerSummaryCsvLines,
  registerSummaryQuerySchema,
  type RegisterSummaryGroup,
  type RegisterSummaryQuery
} from "./reports.js";
import { PROCESS_TIME_BUDGET_MS, SIGNED_URL_EXPIRY_SECONDS, fireSelfNudge } from "./assetsExportJobs.js";
import { isObjectStorageConfigured, s3ObjectStorage, type ObjectStorage } from "../storage/objectStorage.js";

// Register Summary as a background export: the unfiltered report is two full
// far_calc_component() scans (locked calc engine), which don't fit one 60s Vercel
// request. Same job pattern as the Register/Activity Log exports (export_jobs, advanced
// in time-limited hops by polls and self-nudges), but sliced by FAR ID range: each slice
// aggregates its assets into (Sub Classification x Status x Location) sums and merges
// them into the job's saved `state` (sums add across slices, and a group that spans
// slices just accumulates). When every asset is done, the groups are sorted, the Grand
// Total is their sum, and the CSV (small: grouped rows) is written in one piece.

/** Assets aggregated per slice: one aggregate over this many assets is a few seconds on
 *  Vercel, so a hop covers several within its time budget. */
const SLICE_ASSETS = 10_000;

interface JobState {
  groups: Record<string, RegisterSummaryGroup>;
  lastFarId: string | null;
  /** A hop holds this while it runs, so a poll and a self-nudge arriving together can't
   *  both merge the same slice (which would double-count its sums). */
  leaseUntil?: string | null;
}

const LEASE_SECONDS = 75; // longer than one hop (PROCESS_TIME_BUDGET_MS plus a slice)

interface JobRow {
  id: string;
  user_id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  job_type: string;
  filters: RegisterSummaryQuery;
  as_at: string;
  object_key: string;
  state: JobState | null;
  total_rows: number | null;
  processed_rows: number;
  file_url: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

function jobToJson(job: JobRow) {
  return {
    id: job.id,
    status: job.status,
    asAt: job.as_at,
    totalRows: job.total_rows,
    processedRows: job.processed_rows,
    fileUrl: job.file_url,
    errorMessage: job.error_message,
    createdAt: job.created_at,
    completedAt: job.completed_at
  };
}

const groupKey = (g: Pick<RegisterSummaryGroup, "subClassification" | "status" | "location">) =>
  JSON.stringify([g.subClassification, g.status, g.location]);

function mergeGroups(into: Record<string, RegisterSummaryGroup>, slice: RegisterSummaryGroup[]): void {
  for (const g of slice) {
    const k = groupKey(g);
    const existing = into[k];
    if (!existing) {
      into[k] = { ...g };
      continue;
    }
    for (const [field, value] of Object.entries(g)) {
      if (typeof value === "number") existing[field] = Number(existing[field] ?? 0) + value;
    }
  }
}

/** Advances one job by up to `timeBudgetMs`: at least one slice per hop, so it always
 *  makes progress. Progress (the merged sums and the resume position) is saved after
 *  every slice, so a killed hop only redoes the slice it was in. */
export async function advanceRegisterSummaryJob(
  db: pg.Pool,
  jobId: string,
  storage: ObjectStorage,
  timeBudgetMs: number,
  log: { error: (obj: unknown, msg: string) => void } = console,
  sliceAssets: number = SLICE_ASSETS
): Promise<void> {
  const { rows } = await db.query<JobRow>(`SELECT * FROM export_jobs WHERE id = $1`, [jobId]);
  const job = rows[0];
  if (!job || job.status === "COMPLETED" || job.status === "FAILED" || job.job_type !== "REGISTER_SUMMARY") return;
  const { rows: leased } = await db.query<{ state: Partial<JobState> }>(
    `UPDATE export_jobs
     SET state = COALESCE(state, '{}'::jsonb) || jsonb_build_object('leaseUntil', (now() + interval '${LEASE_SECONDS} seconds')::text)
     WHERE id = $1 AND status IN ('PENDING', 'PROCESSING')
       AND (state->>'leaseUntil' IS NULL OR (state->>'leaseUntil')::timestamptz < now())
     RETURNING state`,
    [jobId]
  );
  if (!leased[0]) return; // another hop is running this job right now
  const start = performance.now();
  const state: JobState = { groups: leased[0].state.groups ?? {}, lastFarId: leased[0].state.lastFarId ?? null, leaseUntil: leased[0].state.leaseUntil };
  let finished = false;
  try {
    const centerScope = await fetchCenterScope(db, Number(job.user_id));
    const planned = await planRegisterSummary(db, job.filters, { centerScope });
    if (!planned.ok) throw new Error(planned.error);
    const { plan } = planned;

    let processed = job.processed_rows;
    if (job.status === "PENDING") {
      const countParams = [...plan.params];
      const { rows: countRows } = await db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM assets ${plan.whereClause}`, countParams);
      await db.query(`UPDATE export_jobs SET status = 'PROCESSING', total_rows = $2, state = $3 WHERE id = $1`, [
        jobId,
        Number(countRows[0]!.n),
        JSON.stringify(state)
      ]);
    }

    let slices = 0;
    for (;;) {
      if (slices > 0 && performance.now() - start >= timeBudgetMs) break;
      slices += 1;
      // The next slice's upper bound: the SLICE_ASSETS-th matching FAR ID after the last.
      const boundParams = [...plan.params];
      let after = "";
      if (state.lastFarId !== null) {
        boundParams.push(state.lastFarId);
        after = ` AND far_id > $${boundParams.length}`;
      }
      const { rows: bound } = await db.query<{ upto: string | null; n: string }>(
        `SELECT MAX(far_id) AS upto, COUNT(*) AS n
         FROM (SELECT far_id FROM assets ${plan.whereClause}${after} ORDER BY far_id LIMIT ${sliceAssets}) slice`,
        boundParams
      );
      const upto = bound[0]?.upto ?? null;
      if (upto === null) {
        finished = true;
        break;
      }
      mergeGroups(state.groups, await aggregateRegisterSummaryGroups(db, plan, { afterFarId: state.lastFarId, upToFarId: upto }));
      state.lastFarId = upto;
      processed += Number(bound[0]!.n);
      await db.query(`UPDATE export_jobs SET state = $2, processed_rows = $3 WHERE id = $1`, [jobId, JSON.stringify(state), processed]);
    }
    if (!finished) return;

    const groups = Object.values(state.groups).sort((a, b) =>
      a.subClassification !== b.subClassification
        ? a.subClassification < b.subClassification ? -1 : 1
        : a.status !== b.status
          ? a.status < b.status ? -1 : 1
          : a.location < b.location ? -1 : a.location > b.location ? 1 : 0
    );
    const grandTotal: { assetCount: number; [key: string]: number } = { assetCount: 0 };
    for (const g of groups)
      for (const [field, value] of Object.entries(g)) if (typeof value === "number") grandTotal[field] = (grandTotal[field] ?? 0) + value;

    const csv =
      String.fromCharCode(0xfeff) +
      registerSummaryCsvLines({
        filterSummaryText: plan.filterSummaryText,
        columns: registerSummaryColumns(plan.asAt, plan.fyStart),
        groups,
        grandTotal
      }).join("\r\n") +
      "\r\n";
    const body = Buffer.from(csv, "utf-8");
    const uploadId = await storage.createMultipartUpload(job.object_key, "text/csv");
    try {
      const etag = await storage.uploadPart(job.object_key, uploadId, 1, body);
      await storage.completeMultipartUpload(job.object_key, uploadId, [{ partNumber: 1, etag }]);
    } catch (err) {
      await storage.abortMultipartUpload(job.object_key, uploadId).catch(() => {});
      throw err;
    }
    const fileUrl = await storage.getSignedDownloadUrl(job.object_key, SIGNED_URL_EXPIRY_SECONDS, `register-summary-${plan.asAt}.csv`);
    await db.query(
      `UPDATE export_jobs
       SET status = 'COMPLETED', file_url = $2, file_size_bytes = $3, processed_rows = $4, total_rows = $4, completed_at = now(), state = NULL
       WHERE id = $1`,
      [jobId, fileUrl, body.length, processed]
    );
  } catch (err) {
    finished = true;
    log.error({ err, jobId }, "Background Register Summary export job failed");
    await db
      .query(`UPDATE export_jobs SET status = 'FAILED', error_message = $2 WHERE id = $1`, [
        jobId,
        err instanceof Error ? err.message : "Export failed."
      ])
      .catch(() => {});
  } finally {
    // Hand the job to the next poll/nudge straight away rather than after the lease expires.
    if (!finished) {
      state.leaseUntil = null;
      await db.query(`UPDATE export_jobs SET state = $2 WHERE id = $1`, [jobId, JSON.stringify(state)]).catch(() => {});
    }
  }
}

let activeStorage: ObjectStorage = s3ObjectStorage;
export function setObjectStorageForTests(storage: ObjectStorage): void {
  activeStorage = storage;
}

export default async function registerSummaryExportJobsRoutes(app: FastifyInstance) {
  app.post("/api/reports/register-summary/export/jobs", { preHandler: requirePermission("reports", "export") }, async (req, reply) => {
    if (!isObjectStorageConfigured()) {
      reply.code(503);
      return {
        error: "Background export storage isn't configured — set EXPORT_S3_BUCKET, EXPORT_S3_ACCESS_KEY_ID, and EXPORT_S3_SECRET_ACCESS_KEY (and EXPORT_S3_ENDPOINT for R2).",
        code: "STORAGE_NOT_CONFIGURED"
      };
    }
    const parsed = registerSummaryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query parameters.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    // Validates the filters (and settings) now, so a bad request fails here, not later.
    const planned = await planRegisterSummary(db, parsed.data, req.user!);
    if (!planned.ok) {
      reply.code(planned.status);
      return { error: planned.error };
    }
    const jobId = randomUUID();
    await db.query(
      `INSERT INTO export_jobs (id, user_id, status, job_type, filters, as_at, object_key)
       VALUES ($1, $2, 'PENDING', 'REGISTER_SUMMARY', $3, $4, $5)`,
      [jobId, req.user!.id, JSON.stringify(parsed.data), planned.plan.asAt, `exports/${req.user!.id}/register-summary-${jobId}.csv`]
    );
    fireSelfNudge(req, `/api/reports/register-summary/export/jobs/${jobId}`);
    reply.code(202);
    return { jobId };
  });

  app.get("/api/reports/register-summary/export/jobs/:id", { preHandler: requirePermission("reports", "export") }, async (req, reply) => {
    const paramsParsed = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return { error: "Invalid request." };
    }
    const db = await getPool();
    const { rows } = await db.query<JobRow>(`SELECT * FROM export_jobs WHERE id = $1`, [paramsParsed.data.id]);
    const job = rows[0];
    if (!job || Number(job.user_id) !== req.user!.id || job.job_type !== "REGISTER_SUMMARY") {
      reply.code(404);
      return { error: "No export job found with that id." };
    }
    if (job.status === "PENDING" || job.status === "PROCESSING") {
      await advanceRegisterSummaryJob(db, job.id, activeStorage, PROCESS_TIME_BUDGET_MS, req.log);
      const { rows: refreshed } = await db.query<JobRow>(`SELECT * FROM export_jobs WHERE id = $1`, [job.id]);
      const current = refreshed[0]!;
      if (current.status === "PROCESSING") fireSelfNudge(req, `/api/reports/register-summary/export/jobs/${job.id}`);
      return jobToJson(current);
    }
    return jobToJson(job);
  });
}
