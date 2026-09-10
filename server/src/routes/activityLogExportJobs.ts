import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type pg from "pg";
import { getPool } from "../db/pool.js";
import { requirePermission } from "../auth/middleware.js";
import { fetchCenterScope } from "../auth/centerScope.js";
import { csvLine } from "./assetsExport.js";
import {
  activityLogExportQuerySchema,
  buildActivityLogConditions,
  buildActivityLogFilterSummaryText,
  buildChangedFields,
  buildOtherDetailsText,
  CATEGORY_LABELS,
  COMBINED_SELECT_SQL,
  decodeCursor,
  encodeCursor,
  formatIstTimestamp,
  humanizeAction,
  shapeRow,
  type Cursor,
  type RawRow
} from "./activityLog.js";
import { PART_SIZE_BYTES, PROCESS_TIME_BUDGET_MS, SIGNED_URL_EXPIRY_SECONDS, fireSelfNudge } from "./assetsExportJobs.js";
import { isObjectStorageConfigured, s3ObjectStorage, type ObjectStorage, type UploadPart } from "../storage/objectStorage.js";

type ExportQuery = z.infer<typeof activityLogExportQuerySchema>;

// Same tuning as the synchronous export's own EXPORT_BATCH_SIZE (activityLog.ts) — the
// query shape (a 3-table UNION joined to users/assets) is identical, so the value that's
// already proven out there is the sane starting point here too.
const JOB_BATCH_SIZE = 2000;

const SOURCE_LABELS: Record<RawRow["src"], string> = {
  activity: "Activity Log",
  delete: "Delete Log",
  masters: "Masters Log"
};

/** activity-log-DD-MM-YYYY_HH-mm.csv, IST — same convention as assetsExportJobs.ts's own
 *  buildDownloadFilename (filesystem-safe hyphens, not colons). Duplicated rather than
 *  shared: the two differ only in their leading label, and exporting a
 *  label-parametrized version for exactly two callers isn't worth the indirection. */
function buildDownloadFilename(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata"
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `activity-log-${part("day")}-${part("month")}-${part("year")}_${part("hour")}-${part("minute")}.csv`;
}

interface JobRow {
  id: string;
  user_id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  job_type: "REGISTER" | "ACTIVITY_LOG";
  filters: ExportQuery;
  object_key: string;
  upload_id: string | null;
  upload_parts: UploadPart[];
  pending_buffer: string;
  bytes_uploaded: string;
  resume_cursor: string | null;
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
    totalRows: job.total_rows,
    processedRows: job.processed_rows,
    fileUrl: job.file_url,
    errorMessage: job.error_message,
    createdAt: job.created_at,
    completedAt: job.completed_at
  };
}

/** Advances one Activity Log export job by up to `timeBudgetMs` — same resumable-
 *  multipart-upload shape as assetsExportJobs.ts's advanceExportJob (fixed-size R2 parts,
 *  progress persisted after every batch so a killed invocation only re-fetches cheap
 *  already-accounted-for work, never loses or duplicates a row), just built fresh against
 *  this feed's own 3-table UNION query and flat 7-column CSV shape instead of Register's
 *  calc-engine rows — kept as its own copy rather than sharing that function's body for
 *  the same reason buildJobFilterSql's own comment gives for not sharing filter-SQL
 *  construction: the two orchestrate genuinely different row-fetch/shape logic around the
 *  same underlying R2 primitives (PART_SIZE_BYTES, ObjectStorage), which stay shared. */
export async function advanceActivityLogExportJob(
  db: pg.Pool,
  jobId: string,
  storage: ObjectStorage,
  timeBudgetMs: number,
  log: { error: (obj: unknown, msg: string) => void } = console
): Promise<void> {
  const { rows } = await db.query<JobRow>(`SELECT * FROM export_jobs WHERE id = $1`, [jobId]);
  const job = rows[0];
  if (!job || job.status === "COMPLETED" || job.status === "FAILED") return;
  if (job.job_type !== "ACTIVITY_LOG") {
    log.error({ jobId, jobType: job.job_type }, "advanceActivityLogExportJob called on a non-ACTIVITY_LOG job");
    return;
  }
  const objectKey = job.object_key;

  let uploadId = job.upload_id;
  const start = performance.now();
  try {
    if (job.status === "PENDING") {
      await db.query(`UPDATE export_jobs SET status = 'PROCESSING' WHERE id = $1`, [jobId]);
    }

    const q = job.filters;
    // req.user isn't available to a background hop — centerScope is refetched fresh here
    // instead, same pattern as assetsExportJobs.ts's own advanceExportJob re-deriving it
    // via fetchCenterScope rather than trusting anything captured at POST time.
    const centerScope = await fetchCenterScope(db, Number(job.user_id));
    const { conditions, params } = buildActivityLogConditions(q, { centerScope });
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    let pendingBuffer: Buffer = job.pending_buffer ? Buffer.from(job.pending_buffer, "base64") : Buffer.alloc(0);
    const uploadParts: UploadPart[] = [...job.upload_parts];
    let nextPartNumber = uploadParts.length + 1;
    let bytesUploaded = Number(job.bytes_uploaded);
    let cursor: Cursor | null = job.resume_cursor ? decodeCursor(job.resume_cursor) : null;
    let processedRows = job.processed_rows;

    function appendText(text: string): void {
      pendingBuffer = Buffer.concat([pendingBuffer, Buffer.from(text, "utf-8")]);
    }

    if (!uploadId) {
      uploadId = await storage.createMultipartUpload(objectKey, "text/csv");
      // UTF-8 BOM — see assetsExport.ts's identical write for why. Written exactly once
      // (only the hop that creates the upload reaches this branch), as the very first
      // bytes of the file.
      appendText(String.fromCharCode(0xfeff));
      appendText(csvLine([`Filters applied: ${buildActivityLogFilterSummaryText(q)}`]) + "\r\n");
      appendText(csvLine(["Timestamp", "Category", "Action", "FAR ID", "Actor", "Details (Summary)", "Source"]) + "\r\n");
      await db.query(`UPDATE export_jobs SET upload_id = $1, pending_buffer = $2 WHERE id = $3`, [
        uploadId,
        pendingBuffer.toString("base64"),
        jobId
      ]);
    }

    async function flushFullParts(): Promise<void> {
      while (pendingBuffer.length >= PART_SIZE_BYTES) {
        const partBody = pendingBuffer.subarray(0, PART_SIZE_BYTES);
        pendingBuffer = Buffer.from(pendingBuffer.subarray(PART_SIZE_BYTES));
        const etag = await storage.uploadPart(objectKey, uploadId!, nextPartNumber, partBody);
        uploadParts.push({ partNumber: nextPartNumber, etag });
        nextPartNumber++;
        bytesUploaded += partBody.length;
      }
    }

    let exhausted = false;
    for (;;) {
      if (performance.now() - start >= timeBudgetMs) break;

      const batchConditions = [...conditions];
      const batchParams = [...params];
      if (cursor) {
        batchParams.push(cursor.createdAt, cursor.src, cursor.id);
        batchConditions.push(
          `(c.created_at, c.src, c.id) > ($${batchParams.length - 2}::timestamptz, $${batchParams.length - 1}, $${batchParams.length})`
        );
      }
      const batchWhereClause = batchConditions.length > 0 ? `WHERE ${batchConditions.join(" AND ")}` : "";
      batchParams.push(JOB_BATCH_SIZE);

      const { rows: batchRows } = await db.query<RawRow>(
        `${COMBINED_SELECT_SQL}
         ${batchWhereClause}
         ORDER BY c.created_at ASC, c.src ASC, c.id ASC
         LIMIT $${batchParams.length}`,
        batchParams
      );

      if (batchRows.length === 0) {
        exhausted = true;
        break;
      }

      const lines: string[] = new Array(batchRows.length);
      for (let i = 0; i < batchRows.length; i++) {
        const item = shapeRow(batchRows[i]!);
        const changedFields = buildChangedFields(item.details);
        const changedText = changedFields.map((f) => `${f.label}: ${f.oldValue} → ${f.newValue}`).join("; ");
        const otherDetails = buildOtherDetailsText(item.details);
        const detailsSummary = [changedText, otherDetails].filter(Boolean).join("; ") || "-";
        lines[i] = csvLine([
          formatIstTimestamp(item.createdAt),
          CATEGORY_LABELS[item.category],
          (item.details?.type as string | undefined) ?? humanizeAction(item.action),
          item.farId ?? "",
          item.actorUsername ?? "Unknown user",
          detailsSummary,
          SOURCE_LABELS[item.source]
        ]);
      }
      appendText(lines.join("\r\n") + "\r\n");
      processedRows += batchRows.length;
      const last = batchRows[batchRows.length - 1]!;
      cursor = { createdAt: last.created_at, src: last.src, id: Number(last.id) };

      await flushFullParts();
      await db.query(
        `UPDATE export_jobs
         SET upload_id = $1, upload_parts = $2, pending_buffer = $3, bytes_uploaded = $4,
             resume_cursor = $5, processed_rows = $6
         WHERE id = $7`,
        [uploadId, JSON.stringify(uploadParts), pendingBuffer.toString("base64"), bytesUploaded, encodeCursor(cursor), processedRows, jobId]
      );

      if (batchRows.length < JOB_BATCH_SIZE) {
        exhausted = true;
        break;
      }
    }

    if (!exhausted) return;

    if (pendingBuffer.length > 0) {
      const etag = await storage.uploadPart(objectKey, uploadId!, nextPartNumber, pendingBuffer);
      uploadParts.push({ partNumber: nextPartNumber, etag });
      bytesUploaded += pendingBuffer.length;
      pendingBuffer = Buffer.alloc(0);
    }
    if (uploadParts.length === 0) {
      await storage.abortMultipartUpload(objectKey, uploadId!);
      await db.query(`UPDATE export_jobs SET status = 'FAILED', error_message = $1 WHERE id = $2`, [
        "Export produced no data.",
        jobId
      ]);
      return;
    }
    await storage.completeMultipartUpload(objectKey, uploadId!, uploadParts);
    const fileUrl = await storage.getSignedDownloadUrl(objectKey, SIGNED_URL_EXPIRY_SECONDS, buildDownloadFilename());
    await db.query(
      `UPDATE export_jobs
       SET status = 'COMPLETED', file_url = $1, file_size_bytes = $2, total_rows = $3, processed_rows = $3,
           completed_at = now(), pending_buffer = ''
       WHERE id = $4`,
      [fileUrl, bytesUploaded, processedRows, jobId]
    );
  } catch (err) {
    log.error({ err, jobId }, "Background Activity Log export job failed");
    if (uploadId) {
      await storage.abortMultipartUpload(objectKey, uploadId).catch(() => {});
    }
    await db
      .query(`UPDATE export_jobs SET status = 'FAILED', error_message = $1 WHERE id = $2`, [
        err instanceof Error ? err.message : "Export failed.",
        jobId
      ])
      .catch(() => {});
  }
}

// Same test-swap convention as assetsExportJobs.ts's own setObjectStorageForTests — kept
// as an independent module-local variable rather than a shared one, matching this file's
// broader "own copy of the R2 plumbing, own tests" choice above.
let activeStorage: ObjectStorage = s3ObjectStorage;
export function setObjectStorageForTests(storage: ObjectStorage): void {
  activeStorage = storage;
}

export default async function activityLogExportJobsRoutes(app: FastifyInstance) {
  app.post("/api/audit-log/activity/export/jobs", { preHandler: requirePermission("activityLog", "export") }, async (req, reply) => {
    if (!isObjectStorageConfigured()) {
      reply.code(503);
      return {
        error: "Background export storage isn't configured — set EXPORT_S3_BUCKET, EXPORT_S3_ACCESS_KEY_ID, and EXPORT_S3_SECRET_ACCESS_KEY (and EXPORT_S3_ENDPOINT for R2)."
      };
    }
    const parsed = activityLogExportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query parameters.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    const jobId = randomUUID();
    const objectKey = `exports/${req.user!.id}/activity-${jobId}.csv`;
    // as_at is meaningless for an Activity Log job (it's a Register-only concept — the
    // "figures as of" cutoff) but the shared export_jobs.as_at column is NOT NULL;
    // today's date is a harmless placeholder, never read by advanceActivityLogExportJob.
    const placeholderAsAt = new Date().toISOString().slice(0, 10);
    await db.query(
      `INSERT INTO export_jobs (id, user_id, status, job_type, filters, as_at, object_key)
       VALUES ($1, $2, 'PENDING', 'ACTIVITY_LOG', $3, $4, $5)`,
      [jobId, req.user!.id, JSON.stringify(parsed.data), placeholderAsAt, objectKey]
    );

    fireSelfNudge(req, `/api/audit-log/activity/export/jobs/${jobId}`);

    reply.code(202);
    return { jobId };
  });

  app.get("/api/audit-log/activity/export/jobs/:id", { preHandler: requirePermission("activityLog", "export") }, async (req, reply) => {
    const paramsParsed = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return { error: "Invalid request." };
    }
    const db = await getPool();
    const { rows } = await db.query<JobRow>(`SELECT * FROM export_jobs WHERE id = $1`, [paramsParsed.data.id]);
    const job = rows[0];
    if (!job || Number(job.user_id) !== req.user!.id || job.job_type !== "ACTIVITY_LOG") {
      reply.code(404);
      return { error: "No export job found with that id." };
    }

    if (job.status === "PENDING" || job.status === "PROCESSING") {
      await advanceActivityLogExportJob(db, job.id, activeStorage, PROCESS_TIME_BUDGET_MS, req.log);
      const { rows: refreshed } = await db.query<JobRow>(`SELECT * FROM export_jobs WHERE id = $1`, [job.id]);
      const current = refreshed[0]!;
      if (current.status === "PROCESSING") fireSelfNudge(req, `/api/audit-log/activity/export/jobs/${job.id}`);
      return jobToJson(current);
    }
    return jobToJson(job);
  });
}
