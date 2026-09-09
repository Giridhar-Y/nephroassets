import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type pg from "pg";
import { getPool } from "../db/pool.js";
import { requirePermission } from "../auth/middleware.js";
import { centerScopeSql, fetchCenterScope } from "../auth/centerScope.js";
import { SESSION_COOKIE_NAME } from "../auth/session.js";
import { mapAssetRow, mapTransferRow, mapSettingsRow } from "../db/mappers.js";
import type { AssetRow, TransferRow, SettingsRow } from "../db/mappers.js";
import { computeAsset } from "../calc/engine.js";
import { buildCalcCteExtras, buildConditionSql, buildFilterSummaryText, TOTAL_WDV_AND_PROFIT_LOSS_SQL } from "./assetColumnFilters.js";
import { buildExceptionPredicate, EXCEPTION_LABELS } from "./exceptionPredicates.js";
import { loadActiveMasterMaps, lookupCanonical } from "./bulkParse.js";
import { C2_EXPORT_KEYS, EXPORT_COLUMNS, csvLine, ddmmyyyy, exportQuerySchema, resolveLabel, type LabelContext } from "./assetsExport.js";
import { isObjectStorageConfigured, s3ObjectStorage, type ObjectStorage, type UploadPart } from "../storage/objectStorage.js";

type ExportQuery = z.infer<typeof exportQuerySchema>;

// Same batch size as the synchronous export's own EXPORT_BATCH_SIZE (assetsExport.ts) —
// kept as a separate constant rather than importing that one, since the two routes are
// free to tune independently now that neither shares the other's request lifetime.
const JOB_BATCH_SIZE = 20_000;

// The exact size of every non-final multipart part. S3 itself only requires each part
// (but the last) to be >=5MB and tolerates different sizes across parts; Cloudflare R2 is
// stricter and requires every non-trailing part to be EXACTLY the same length (confirmed
// live — R2 rejected CompleteMultipartUpload with "All non-trailing parts must have the
// same length" when this was a >= threshold instead of a fixed size). 8MB clears S3's own
// 5MB floor with margin and keeps memory use per part modest.
const PART_SIZE_BYTES = 8 * 1024 * 1024;

// How long one processing hop (one GET .../jobs/:id call, or the internal self-nudge
// below) is allowed to run before it must persist progress and return — safely under
// Vercel's 60s function ceiling (vercel.json's maxDuration), leaving headroom for the
// request/response overhead and the final multipart-completion call.
const PROCESS_TIME_BUDGET_MS = 45_000;

const SIGNED_URL_EXPIRY_SECONDS = 24 * 60 * 60;

/** far-register-DD-MM-YYYY_HH-mm.csv, in IST — same date convention (DD-MM-YYYY) and
 *  timezone (Asia/Kolkata) as the synchronous export's own exportedAtText
 *  (assetsExport.ts), just filesystem-safe (hyphens, not the colons a clock time normally
 *  uses — Windows rejects those in a filename). Computed once, at job completion, and
 *  stored as the presigned URL's response-content-disposition override — the object's own
 *  key stays a plain UUID path, this is only what the browser sees as the saved filename. */
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
  return `far-register-${part("day")}-${part("month")}-${part("year")}_${part("hour")}-${part("minute")}.csv`;
}

interface JobRow {
  id: string;
  user_id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  filters: ExportQuery;
  as_at: string;
  object_key: string;
  upload_id: string | null;
  upload_parts: UploadPart[];
  pending_buffer: string;
  bytes_uploaded: string;
  last_far_id: string | null;
  total_rows: number | null;
  processed_rows: number;
  file_url: string | null;
  file_size_bytes: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string;
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

/** Same WHERE-clause construction as GET /api/assets/export (assetsExport.ts) — kept as
 *  its own copy rather than a shared function, since the two routes reuse the same
 *  underlying primitives (buildCalcCteExtras/buildConditionSql/centerScopeSql, all from
 *  assetColumnFilters.ts) but orchestrate them differently: one streams a single HTTP
 *  response, this one resumes across many stateless invocations. `centerScope` is fetched
 *  fresh by the caller (fetchCenterScope) rather than taken from a live `req.user`, since
 *  a background hop has no request of its own — see advanceExportJob. */
function buildJobFilterSql(q: ExportQuery, centerScope: Set<string> | null, asAt: string, fyStart: string) {
  const conditions: string[] = ["deleted_at IS NULL"];
  const params: unknown[] = [];
  const scopeSql = centerScopeSql({ centerScope }, "COALESCE(revised_location, location)", params);
  if (scopeSql) conditions.push(scopeSql);
  if (q.center) {
    params.push(q.center);
    conditions.push(`COALESCE(revised_location, location) = ANY($${params.length})`);
  }
  if (q.capLocation) {
    params.push(q.capLocation);
    conditions.push(`location = ANY($${params.length})`);
  }
  if (q.subClassification) {
    params.push(q.subClassification);
    conditions.push(`sub_classification = ANY($${params.length})`);
  }
  if (q.status) {
    params.push(q.status);
    conditions.push(`status = ANY($${params.length})`);
  }
  params.push(asAt);
  conditions.push(`date_acquired <= $${params.length}`);
  // Same reasoning as GET /api/assets / GET /api/assets/export: an asset disposed of
  // before the active FY began is prior-year history, not part of the current export.
  params.push(fyStart);
  conditions.push(`(date_of_disposal IS NULL OR date_of_disposal >= $${params.length})`);
  if (q.dateAcquiredFrom) {
    params.push(q.dateAcquiredFrom);
    conditions.push(`date_acquired >= $${params.length}`);
  }
  if (q.dateAcquiredTo) {
    params.push(q.dateAcquiredTo);
    conditions.push(`date_acquired <= $${params.length}`);
  }
  if (q.search) {
    params.push(`${q.search.toUpperCase()}%`);
    conditions.push(`far_id LIKE $${params.length}`);
  }
  if (q.descriptionSearch) {
    params.push(`%${q.descriptionSearch}%`);
    conditions.push(`asset_description ILIKE $${params.length}`);
  }
  if (q.globalSearch) {
    params.push(`${q.globalSearch.toUpperCase()}%`);
    const farIdParam = params.length;
    params.push(`%${q.globalSearch}%`);
    const descParam = params.length;
    params.push(`%${q.globalSearch}%`);
    const subClassParam = params.length;
    params.push(`%${q.globalSearch}%`);
    const statusParam = params.length;
    params.push(`%${q.globalSearch}%`);
    const locationParam = params.length;
    conditions.push(
      `(far_id LIKE $${farIdParam}
        OR asset_description ILIKE $${descParam}
        OR sub_classification ILIKE $${subClassParam}
        OR status ILIKE $${statusParam}
        OR COALESCE(revised_location, location) ILIKE $${locationParam})`
    );
  }
  return { whereClause: `WHERE ${conditions.join(" AND ")}`, conditions, params };
}

function buildComputedConditions(q: ExportQuery, params: unknown[], asAt: string, fy: { fyStart: string; fyEnd: string }) {
  const computedConditions: string[] = [];
  for (const cond of q.conditions) {
    const built = buildConditionSql(cond, params, fy);
    if ("error" in built) throw new Error(built.error);
    computedConditions.push(built.sql);
  }
  if (q.exception) {
    computedConditions.push(buildExceptionPredicate(q.exception, params, { fyStart: fy.fyStart, asAt }));
  }
  return { computedConditions, computedWhereClause: computedConditions.length > 0 ? `WHERE ${computedConditions.join(" AND ")}` : "" };
}

/** Advances one job by up to `timeBudgetMs` of real work — a batch of rows fetched,
 *  turned into CSV, buffered, and flushed as an S3 multipart part whenever the buffer
 *  clears MIN_PART_FLUSH_BYTES — then persists exactly how far it got (never losing an
 *  already-buffered-but-unflushed batch) and returns. Safe to call repeatedly and
 *  concurrently-ish for the same job: a job already PROCESSING/PENDING just picks up from
 *  its own persisted state; COMPLETED/FAILED is a no-op. This is the one and only place
 *  export_jobs actually moves forward — both the client's poll (GET .../jobs/:id) and the
 *  best-effort internal self-nudge call it. */
export async function advanceExportJob(
  db: pg.Pool,
  jobId: string,
  storage: ObjectStorage,
  timeBudgetMs: number,
  log: { error: (obj: unknown, msg: string) => void } = console
): Promise<void> {
  const { rows } = await db.query<JobRow>(`SELECT * FROM export_jobs WHERE id = $1`, [jobId]);
  const job = rows[0];
  if (!job || job.status === "COMPLETED" || job.status === "FAILED") return;
  const objectKey = job.object_key;

  // Hoisted above the try block so the catch below can always abort whichever multipart
  // upload is actually live, including one created by THIS call after the initial SELECT
  // above already read a stale (null) upload_id — referencing job.upload_id there instead
  // would miss exactly that case, the one that matters most (a failure partway through
  // this same call, after the upload was already created).
  let uploadId = job.upload_id;

  const start = performance.now();
  try {
    if (job.status === "PENDING") {
      await db.query(`UPDATE export_jobs SET status = 'PROCESSING' WHERE id = $1`, [jobId]);
    }

    const q = job.filters;
    const { rows: settingsRows } = await db.query<SettingsRow>(
      `SELECT as_at, fy_start, fy_end, days_in_fy FROM settings WHERE id = TRUE`
    );
    const fySettings = settingsRows[0];
    if (!fySettings) throw new Error("Financial year settings have not been configured.");
    const fy = mapSettingsRow(fySettings);
    fy.asAt = job.as_at;
    const ctx: LabelContext = { asAt: fy.asAt, fyStart: fy.fyStart };

    const centerScope = await fetchCenterScope(db, Number(job.user_id));
    const { whereClause, conditions, params } = buildJobFilterSql(q, centerScope, job.as_at, fy.fyStart);
    const { computedConditions, computedWhereClause } = buildComputedConditions(q, params, job.as_at, fy);

    let shouldHideC2 = false;
    if (q.subClassification && q.subClassification.length > 0) {
      const maps = await loadActiveMasterMaps(db);
      shouldHideC2 = q.subClassification.every((name) => {
        const canonical = lookupCanonical(maps.subClassifications, name);
        return canonical !== undefined && maps.subClassificationHasComponent2.get(canonical) === false;
      });
    }
    const exportColumns = shouldHideC2 ? EXPORT_COLUMNS.filter((c) => !C2_EXPORT_KEYS.has(c.key)) : EXPORT_COLUMNS;

    // Tracked as raw bytes (not a JS string) throughout — R2 requires every non-trailing
    // multipart part to be EXACTLY the same length (a real, stricter rule than S3's own
    // "just >=5MB, size can vary" — confirmed live: an earlier version of this function
    // flushed a variable-sized part whenever the buffer crossed a threshold, and R2 threw
    // "All non-trailing parts must have the same length" completing the upload). Working
    // in Buffers rather than strings also means a part boundary can safely fall in the
    // middle of a multi-byte UTF-8 character — the final downloaded file is just every
    // part's bytes concatenated in order, so the character reassembles correctly either
    // way; nothing here ever needs to decode a part on its own.
    let pendingBuffer: Buffer = job.pending_buffer ? Buffer.from(job.pending_buffer, "base64") : Buffer.alloc(0);
    const uploadParts: UploadPart[] = [...job.upload_parts];
    let nextPartNumber = uploadParts.length + 1;
    let bytesUploaded = Number(job.bytes_uploaded);
    let lastFarId = job.last_far_id;
    let processedRows = job.processed_rows;

    function appendText(text: string): void {
      pendingBuffer = Buffer.concat([pendingBuffer, Buffer.from(text, "utf-8")]);
    }

    if (!uploadId) {
      uploadId = await storage.createMultipartUpload(objectKey, "text/csv");
      // Row 1: filter-summary note, same convention as the synchronous export's own —
      // what this file represents, not just a raw column dump. Row 2: column names. No
      // totals/group-band rows here — a deliberate simplification for this new code path
      // (Register Summary already covers grouped totals for anyone who wants them); the
      // per-asset rows below are byte-identical in shape to the synchronous export's own.
      const filterSummaryText =
        buildFilterSummaryText(q, q.conditions) + (q.exception ? `; Dashboard Exception: ${EXCEPTION_LABELS[q.exception]}` : "");
      appendText(csvLine([`Filters applied: ${filterSummaryText}`]) + "\r\n");
      appendText(csvLine(exportColumns.map((c) => resolveLabel(c, ctx))) + "\r\n");
      // Persisted immediately, not deferred to the first flush below — if this hop's time
      // budget runs out before any batch even completes (a real possibility: the budget is
      // meant to protect a slow COLD hop too), the multipart upload this just created
      // would otherwise never be recorded, and the NEXT hop would orphan it by creating a
      // second one from scratch while losing these two header rows entirely.
      await db.query(`UPDATE export_jobs SET upload_id = $1, pending_buffer = $2 WHERE id = $3`, [
        uploadId,
        pendingBuffer.toString("base64"),
        jobId
      ]);
    }

    // Flushes exactly PART_SIZE_BYTES at a time off the front of pendingBuffer, looping in
    // case one batch pushed it past that more than once — every part this produces is
    // identical in length (the R2 requirement above); whatever's left under that size stays
    // pending for the next hop, or becomes the final (allowed to be any size) part at real
    // completion below.
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

      const batchParams = [...params];
      const batchConditions = [...conditions];
      if (lastFarId !== null) {
        batchParams.push(lastFarId);
        batchConditions.push(`far_id > $${batchParams.length}`);
      }
      const batchWhereClause = `WHERE ${batchConditions.join(" AND ")}`;

      let batchRows: AssetRow[];
      if (computedConditions.length === 0) {
        batchParams.push(JOB_BATCH_SIZE);
        ({ rows: batchRows } = await db.query<AssetRow>(
          `SELECT * FROM assets ${batchWhereClause} ORDER BY far_id LIMIT $${batchParams.length}`,
          batchParams
        ));
      } else {
        const batchCalcExtras = buildCalcCteExtras(batchParams, job.as_at, { fyStart: fy.fyStart, fyEnd: fy.fyEnd, daysInFy: fy.daysInFy });
        batchParams.push(JOB_BATCH_SIZE);
        ({ rows: batchRows } = await db.query<AssetRow>(
          `WITH calc_base AS (
             SELECT assets.*, ${batchCalcExtras}
             FROM assets ${batchWhereClause}
           ), calc AS (
             SELECT *, ${TOTAL_WDV_AND_PROFIT_LOSS_SQL}
             FROM calc_base
           )
           SELECT * FROM calc ${computedWhereClause} ORDER BY far_id LIMIT $${batchParams.length}`,
          batchParams
        ));
      }

      if (batchRows.length === 0) {
        exhausted = true;
        break;
      }

      const farIds = batchRows.map((r) => r.far_id);
      const { rows: transferRows } = await db.query<TransferRow>(
        `SELECT far_id, transaction_date, location FROM transfers
         WHERE far_id = ANY($1) AND transaction_date <= $2 AND deleted_at IS NULL
         ORDER BY far_id, transaction_date`,
        [farIds, job.as_at]
      );
      const transfersByFarId = new Map<string, TransferRow[]>();
      for (const t of transferRows) {
        const list = transfersByFarId.get(t.far_id);
        if (list) list.push(t);
        else transfersByFarId.set(t.far_id, [t]);
      }

      const lines: string[] = new Array(batchRows.length);
      for (let i = 0; i < batchRows.length; i++) {
        const row = batchRows[i]!;
        const asset = mapAssetRow(row);
        const relevantTransfers = (transfersByFarId.get(row.far_id) ?? []).map(mapTransferRow);
        const result = computeAsset(asset, fy, relevantTransfers);
        const values = exportColumns.map((c) => {
          const v = c.value(asset, result);
          return c.kind === "date" ? ddmmyyyy(v as string | null) : v;
        });
        lines[i] = csvLine(values);
      }
      appendText(lines.join("\r\n") + "\r\n");
      processedRows += batchRows.length;
      lastFarId = batchRows[batchRows.length - 1]!.far_id;

      await flushFullParts();
      // Persisted after every batch regardless of whether a part was actually flushed
      // this time — pending_buffer (base64) always reflects exactly what's already
      // accounted for in processed_rows/last_far_id, so a killed invocation never loses or
      // duplicates a row, only re-fetches (cheap) whatever this hop hadn't gotten to yet.
      await db.query(
        `UPDATE export_jobs
         SET upload_id = $1, upload_parts = $2, pending_buffer = $3, bytes_uploaded = $4,
             last_far_id = $5, processed_rows = $6
         WHERE id = $7`,
        [uploadId, JSON.stringify(uploadParts), pendingBuffer.toString("base64"), bytesUploaded, lastFarId, processedRows, jobId]
      );

      if (batchRows.length < JOB_BATCH_SIZE) {
        exhausted = true;
        break;
      }
    }

    if (!exhausted) return; // time budget hit, more rows remain — next hop resumes from here

    // The final part — unlike every part flushFullParts produced above, this one is
    // allowed to be any size (including smaller than PART_SIZE_BYTES), same as S3/R2 both
    // require: every part but the last must match; the last may not.
    if (pendingBuffer.length > 0) {
      const etag = await storage.uploadPart(objectKey, uploadId!, nextPartNumber, pendingBuffer);
      uploadParts.push({ partNumber: nextPartNumber, etag });
      bytesUploaded += pendingBuffer.length;
      pendingBuffer = Buffer.alloc(0);
    }
    if (uploadParts.length === 0) {
      // An empty result set (filters matched nothing) — still a valid, if header-only,
      // CSV. S3/R2 require at least one part to complete a multipart upload, so the header
      // rows written above (and flushed just now) cover this; if somehow still empty
      // (shouldn't happen — the header rows are always >0 bytes), abort cleanly rather
      // than calling CompleteMultipartUpload with zero parts.
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
    log.error({ err, jobId }, "Background export job failed");
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

/** Best-effort — fires a GET at this same job's status endpoint, forwarding the
 *  triggering request's own session cookie (so it's authenticated as the same user who
 *  owns the job, with zero changes to the global auth gate), and does NOT wait for it.
 *  Vercel serverless has no guaranteed way to keep running after a response is sent, so
 *  this may simply never complete — that's fine, not a correctness risk: the job's actual
 *  progress is only ever advanced by (and persisted inside) advanceExportJob, and the
 *  client's own next poll tick reaches the exact same endpoint and picks up from whatever
 *  was last persisted regardless of whether this nudge landed. */
function fireSelfNudge(req: FastifyRequest, jobId: string): void {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return;
  const origin = `${req.protocol}://${req.headers.host}`;
  fetch(`${origin}/api/assets/export/jobs/${jobId}`, { headers: { cookie: cookieHeader } }).catch(() => {});
}

// The real S3-backed implementation is the default everywhere except tests, which swap
// it for an in-memory fake (assetsExportJobs.test.ts) so the GET route's "advance, then
// respond" behavior can be exercised end-to-end without a real bucket. Not exposed
// outside this module's own tests.
let activeStorage: ObjectStorage = s3ObjectStorage;
export function setObjectStorageForTests(storage: ObjectStorage): void {
  activeStorage = storage;
}

export default async function assetsExportJobsRoutes(app: FastifyInstance) {
  app.post("/api/assets/export/jobs", { preHandler: requirePermission("register", "export") }, async (req, reply) => {
    if (!isObjectStorageConfigured()) {
      reply.code(503);
      return {
        error: "Background export storage isn't configured — set EXPORT_S3_BUCKET, EXPORT_S3_ACCESS_KEY_ID, and EXPORT_S3_SECRET_ACCESS_KEY (and EXPORT_S3_ENDPOINT for R2)."
      };
    }
    const parsed = exportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query parameters.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    const { rows: settingsRows } = await db.query<SettingsRow>(`SELECT as_at FROM settings WHERE id = TRUE`);
    const fySettings = settingsRows[0];
    if (!fySettings) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }
    const asAt = parsed.data.asAt ?? fySettings.as_at;
    const jobId = randomUUID();
    const objectKey = `exports/${req.user!.id}/${jobId}.csv`;
    await db.query(
      `INSERT INTO export_jobs (id, user_id, status, filters, as_at, object_key)
       VALUES ($1, $2, 'PENDING', $3, $4, $5)`,
      [jobId, req.user!.id, JSON.stringify(parsed.data), asAt, objectKey]
    );

    fireSelfNudge(req, jobId);

    reply.code(202);
    return { jobId };
  });

  app.get("/api/assets/export/jobs/:id", { preHandler: requirePermission("register", "export") }, async (req, reply) => {
    const paramsParsed = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return { error: "Invalid request." };
    }
    const db = await getPool();
    const { rows } = await db.query<JobRow>(`SELECT * FROM export_jobs WHERE id = $1`, [paramsParsed.data.id]);
    const job = rows[0];
    if (!job || Number(job.user_id) !== req.user!.id) {
      reply.code(404);
      return { error: "No export job found with that id." };
    }

    if (job.status === "PENDING" || job.status === "PROCESSING") {
      await advanceExportJob(db, job.id, activeStorage, PROCESS_TIME_BUDGET_MS, req.log);
      const { rows: refreshed } = await db.query<JobRow>(`SELECT * FROM export_jobs WHERE id = $1`, [job.id]);
      const current = refreshed[0]!;
      if (current.status === "PROCESSING") fireSelfNudge(req, job.id);
      return jobToJson(current);
    }
    return jobToJson(job);
  });
}
