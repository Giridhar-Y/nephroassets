import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { generateAssets, generateTransfers, CENTERS } from "./generateAssets.js";
import { bulkInsertAssets, bulkInsertTransfers } from "./bulkInsert.js";
import { getPool } from "../db/pool.js";
import { computeComponent, computeAsset } from "../calc/engine.js";
import { maxIsoDate } from "../calc/dates.js";
import { splitDepreciationByLocation } from "../reports/transferDepreciationSplit.js";
import reportsRoutes from "../routes/reports.js";
import assetsRoutes from "../routes/assets.js";
import assetsExportRoutes from "../routes/assetsExport.js";
import { authGateHook } from "../auth/middleware.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import type { TransferRecord } from "../calc/types.js";

const ASSET_COUNT = Number(process.env.LOADTEST_COUNT ?? 250_000);
const AS_AT = "2026-08-17";
const FY_START = "2026-04-01";
const FY_END = "2027-03-31";
const DAYS_IN_FY = 365;

describe(`load test: ${ASSET_COUNT.toLocaleString()} assets`, () => {
  let app: FastifyInstance;
  const assets = generateAssets(ASSET_COUNT, 12345);
  // Same seed relationship as assets itself — deterministic, so the "independent
  // oracle" comparisons below can regenerate the exact same transfers without ever
  // reading them back from the database.
  const transfers = generateTransfers(assets, 67890);

  beforeAll(async () => {
    const db = await getPool();
    console.log(`Bulk-inserting ${ASSET_COUNT.toLocaleString()} assets...`);
    const insertStart = performance.now();
    await bulkInsertAssets(db, assets, 1000);
    console.log(`  done in ${((performance.now() - insertStart) / 1000).toFixed(1)}s`);

    console.log(`Bulk-inserting ${transfers.length.toLocaleString()} transfers...`);
    const transferInsertStart = performance.now();
    await bulkInsertTransfers(db, transfers, 1000);
    console.log(`  done in ${((performance.now() - transferInsertStart) / 1000).toFixed(1)}s`);

    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET as_at = $1, fy_start = $2, fy_end = $3, days_in_fy = $4`,
      [AS_AT, FY_START, FY_END, DAYS_IN_FY]
    );

    app = Fastify();
    // Every route below is gated by requirePermission (auth/middleware.ts), which reads
    // req.user — populated by authGateHook, the global preHandler app.ts registers for
    // the real app. This loadtest's own minimal Fastify instance never registered it (a
    // real, pre-existing bug found investigating a reported Register-export corruption
    // issue): every request below has been silently 403ing since permission enforcement
    // was cut over (req.user stayed undefined, so `!req.user` short-circuited every
    // requirePermission check) — none of this suite's timing assertions were actually
    // exercising the routes they claim to. Fixed by mirroring assetsExport.test.ts's
    // already-correct minimal harness exactly.
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(reportsRoutes);
    await app.register(assetsRoutes);
    await app.register(assetsExportRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it(
    "Depreciation Posting total matches an independently computed total (TS engine, summed in JS — never reads the seeded rows back)",
    async () => {
      const fy = { asAt: AS_AT, fyStart: FY_START, fyEnd: FY_END, daysInFy: DAYS_IN_FY };
      let expectedTotal = 0;
      for (const asset of assets) {
        const c1 = computeComponent(
          {
            dateAcquired: asset.dateAcquired,
            openingCost: asset.c1OpeningCost,
            additions: asset.additionsC1,
            dateOfAddition: asset.dateOfAddition,
            usefulLifeYears: asset.usefulLifeC1Years,
            dateOfDisposal: asset.dateOfDisposal,
            deletionsCost: asset.deletionsC1,
            saleValue: asset.saleValue,
            accDepOpening: asset.accDepC1Opening
          },
          fy
        );
        const c2 = computeComponent(
          {
            dateAcquired: asset.dateAcquired,
            openingCost: asset.c2OpeningCost,
            additions: asset.additionsC2,
            dateOfAddition: asset.dateOfAddition,
            usefulLifeYears: asset.usefulLifeC2Years,
            dateOfDisposal: asset.dateOfDisposal,
            deletionsCost: asset.deletionsC2,
            saleValue: asset.saleValue,
            accDepOpening: asset.accDepC2Opening
          },
          fy
        );
        expectedTotal += c1.periodDepreciation + c2.periodDepreciation;
      }

      const start = performance.now();
      const res = await authedInject(app, { method: "GET", url: `/api/reports/depreciation-posting?asAt=${AS_AT}` });
      const elapsedMs = performance.now() - start;
      console.log(`Depreciation Posting Summary: ${elapsedMs.toFixed(0)}ms`);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalPeriodDepreciation).toBeCloseTo(expectedTotal, 2);
      expect(elapsedMs).toBeLessThan(5000);
    }
  );

  // Two AS_AT dates on purpose: AS_AT itself (~day 138 of the FY, after every
  // generated disposal — days 30-130 — is effective) and an earlier one (~day 61,
  // where some disposals are still legitimately in the future). Testing only the
  // former previously hid a real bug: unconditionally summing raw Deletions falsely
  // failed every asset with a not-yet-effective disposal, only caught by clicking
  // through the real app at an earlier AS_AT than any automated test used.
  it.each([
    ["all disposals already effective", AS_AT],
    ["some disposals not yet effective", "2026-06-01"]
  ])("Audit Reconciliation ties out at full scale (%s)", async (_label, asAt) => {
    const start = performance.now();
    const res = await authedInject(app, { method: "GET", url: `/api/reports/audit-reconciliation?asAt=${asAt}` });
    const elapsedMs = performance.now() - start;
    console.log(`Audit Reconciliation (${asAt}): ${elapsedMs.toFixed(0)}ms, ${res.json().items.length} rows`);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ costCheckPass: boolean; depCheckPass: boolean }> };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.costCheckPass).toBe(true);
      expect(item.depCheckPass).toBe(true);
    }
    expect(elapsedMs).toBeLessThan(5000);
  });

  it("Location Summary matches an independently computed total for one center", async () => {
    const center = CENTERS[7]!;
    const fy = { asAt: AS_AT, fyStart: FY_START, fyEnd: FY_END, daysInFy: DAYS_IN_FY };
    const atCenter = assets.filter((a) => a.location === center);
    let expectedTotalC1GrossBlock = 0;
    for (const asset of atCenter) {
      const c1 = computeComponent(
        {
          dateAcquired: asset.dateAcquired,
          openingCost: asset.c1OpeningCost,
          additions: asset.additionsC1,
          dateOfAddition: asset.dateOfAddition,
          usefulLifeYears: asset.usefulLifeC1Years,
          dateOfDisposal: asset.dateOfDisposal,
          deletionsCost: asset.deletionsC1,
          saleValue: asset.saleValue,
          accDepOpening: asset.accDepC1Opening
        },
        fy
      );
      expectedTotalC1GrossBlock += c1.grossBlock;
    }

    const start = performance.now();
    const res = await authedInject(app, {
      method: "GET",
      url: `/api/reports/location-summary?location=${center}&asAt=${AS_AT}`
    });
    const elapsedMs = performance.now() - start;
    console.log(`Location Summary (${center}): ${elapsedMs.toFixed(0)}ms, ${res.json().assetCount} assets`);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.assetCount).toBe(atCenter.length);
    expect(body.totalC1GrossBlock).toBeCloseTo(expectedTotalC1GrossBlock, 2);
    expect(elapsedMs).toBeLessThan(3000);
  });

  it("Register: first page and a center-filtered page both stay fast", async () => {
    const start1 = performance.now();
    const page1 = await authedInject(app, { method: "GET", url: `/api/assets?asAt=${AS_AT}&limit=150` });
    const elapsed1 = performance.now() - start1;
    console.log(`Register first page: ${elapsed1.toFixed(0)}ms`);
    expect(page1.statusCode).toBe(200);
    expect(page1.json().items.length).toBe(150);
    expect(elapsed1).toBeLessThan(2000);

    const center = CENTERS[42]!;
    const start2 = performance.now();
    const page2 = await authedInject(app, {
      method: "GET",
      url: `/api/assets?asAt=${AS_AT}&center=${center}&limit=150`
    });
    const elapsed2 = performance.now() - start2;
    console.log(`Register center-filtered page (${center}): ${elapsed2.toFixed(0)}ms`);
    expect(page2.statusCode).toBe(200);
    expect(elapsed2).toBeLessThan(2000);

    // Changing AS_AT must stay fast too — same page, different cut-off date.
    const start3 = performance.now();
    const page3 = await authedInject(app, { method: "GET", url: `/api/assets?asAt=2026-06-01&limit=150` });
    const elapsed3 = performance.now() - start3;
    console.log(`Register after AS_AT change: ${elapsed3.toFixed(0)}ms`);
    expect(page3.statusCode).toBe(200);
    expect(elapsed3).toBeLessThan(2000);
  });

  it("Asset Movement & Depreciation Schedule: movement schedule first page, unfiltered and filtered, both stay fast", async () => {
    const start1 = performance.now();
    const page1 = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/movement?asAt=${AS_AT}&limit=150`
    });
    const elapsed1 = performance.now() - start1;
    console.log(`Asset Movement & Depreciation Schedule first page: ${elapsed1.toFixed(0)}ms, ${page1.json().items.length} rows`);
    expect(page1.statusCode).toBe(200);
    // limit=150 bounds ASSETS scanned, not rows returned — a mover expands into more
    // than one row, so the row count can exceed 150.
    expect(page1.json().items.length).toBeGreaterThanOrEqual(150);
    expect(elapsed1).toBeLessThan(2000);

    const conditions = encodeURIComponent(JSON.stringify([{ columnId: "c1TotalDepreciation", op: "gt", value: 20000 }]));
    const start2 = performance.now();
    const page2 = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/movement?asAt=${AS_AT}&limit=150&conditions=${conditions}`
    });
    const elapsed2 = performance.now() - start2;
    console.log(`Asset Movement & Depreciation Schedule filtered page (C1 > 20,000): ${elapsed2.toFixed(0)}ms`);
    expect(page2.statusCode).toBe(200);
    expect(elapsed2).toBeLessThan(3000);
  });

  it(
    "Asset Movement & Depreciation Schedule: location totals grand total matches an independently computed total (TS engine + the same split function, summed in JS — never reads the seeded rows back), and stays within budget",
    async () => {
      const fy = { asAt: AS_AT, fyStart: FY_START, fyEnd: FY_END, daysInFy: DAYS_IN_FY };
      const transfersByFarId = new Map<string, TransferRecord[]>();
      for (const t of transfers) {
        const list = transfersByFarId.get(t.farId);
        if (list) list.push(t);
        else transfersByFarId.set(t.farId, [t]);
      }

      let expectedC1Paise = 0;
      let expectedC2Paise = 0;
      for (const asset of assets) {
        const assetTransfers = transfersByFarId.get(asset.farId) ?? [];
        const result = computeAsset(asset, fy, assetTransfers);
        const c1Total = Math.round(result.c1.periodDepreciation * 100) / 100;
        const c2Total = Math.round(result.c2.periodDepreciation * 100) / 100;
        const periodStart = maxIsoDate([fy.fyStart, asset.dateAcquired]);
        const segments = splitDepreciationByLocation(
          asset.location,
          assetTransfers,
          periodStart,
          result.c1.effectiveEndDate,
          c1Total,
          c2Total
        );
        for (const seg of segments) {
          expectedC1Paise += Math.round(seg.c1Depreciation * 100);
          expectedC2Paise += Math.round(seg.c2Depreciation * 100);
        }
      }

      const start = performance.now();
      const res = await authedInject(app, {
        method: "GET",
        url: `/api/reports/transfer-depreciation/location-wise?asAt=${AS_AT}`
      });
      const elapsedMs = performance.now() - start;
      console.log(
        `Asset Movement & Depreciation Schedule location totals (full ${ASSET_COUNT.toLocaleString()}-asset scan, ${transfers.length.toLocaleString()} transfers): ${elapsedMs.toFixed(0)}ms, ${res.json().locationWise.length} locations`
      );

      expect(res.statusCode).toBe(200);
      const locationWise: Array<{ c1TotalDepreciation: number; c2TotalDepreciation: number }> = res.json().locationWise;
      const actualC1Paise = locationWise.reduce((s, l) => s + Math.round(l.c1TotalDepreciation * 100), 0);
      const actualC2Paise = locationWise.reduce((s, l) => s + Math.round(l.c2TotalDepreciation * 100), 0);
      expect(actualC1Paise).toBe(expectedC1Paise);
      expect(actualC2Paise).toBe(expectedC2Paise);
      // Batched full-table scan over 250k assets + their transfers — generous budget
      // (this is the one genuinely O(table size) endpoint in the report), but must
      // still complete well within a request timeout, not run for minutes.
      expect(elapsedMs).toBeLessThan(60_000);
    }
  );

  // Regression coverage for a reported production bug: real users hit a corrupted
  // "far-register-....xlsx" download (Excel's "we found a problem with some content...
  // recover?" dialog) once the register held 217,000+ real assets. GET /api/assets/export
  // (assetsExport.ts) was never in this scale suite at all before that report — this is
  // its first real measurement at the app's documented ~250k-row ceiling.
  //
  // First run of this test (before this comment was written) measured 93,214ms for the
  // full export — 55% OVER this app's configured Vercel maxDuration (60s, vercel.json)
  // — confirmed on a LOWER BOUND (this embedded, same-process Postgres pays none of the
  // real network round-trip latency ~125 real batch-query-pairs to a real Supabase
  // instance would add). This is the smoking gun for the reported corruption: Vercel
  // kills the function outright at 60s — a process termination that skips every bit of
  // this app's own error handling (no catch block runs, nothing gets logged) — leaving
  // whatever bytes were already streamed as a truncated, invalid zip. The client sees a
  // response that started successfully (200, correct headers) and simply stops.
  //
  // That same first run ALSO crashed this test file's own worker process outright
  // ("Worker exited unexpectedly") when it tried to fully reload the resulting ~74MB
  // response with `ExcelJS.Workbook().xlsx.load()` for a structural-validity check —
  // out-of-memory, from materializing 250,000 rows × 40 columns' worth of cell objects
  // in one go. That's a DIFFERENT, test-side cost (this is a one-shot verification
  // convenience, not the production code path, which never holds more than one
  // EXPORT_BATCH_SIZE batch in memory at a time) — but it's still genuine evidence for
  // why a platform memory ceiling is a real second candidate failure mode alongside the
  // timeout, worth keeping in mind if maxDuration alone doesn't fully explain a future
  // report. Replaced with a lightweight structural check below that doesn't require
  // deserializing the whole workbook: a ZIP archive's End Of Central Directory record is
  // always the LAST thing written, so a killed-mid-stream file — which stops wherever
  // the process happened to be — is reliably missing it, while a completed file always
  // has it. Full deserialize-and-read validation (proving the file doesn't just have the
  // right shape at both ends, but is genuinely readable start to finish) is covered at a
  // safe, practical scale by assetsExport.test.ts's own 4,500-row multi-batch test
  // instead.
  // Update, after EXPORT_ROW_LIMIT was added: a full unfiltered 250k-row request is now
  // REJECTED up front (COUNT(*) > EXPORT_ROW_LIMIT, before reply.send(stream) — see
  // assetsExport.ts) rather than attempted and timed out. This is the safety net doing
  // its job at real full production scale — fast (a single aggregate query, no
  // streaming) and with a real JSON error the client can show, instead of the ~93-123s
  // timeout-into-corruption behavior this test originally caught (see git history for
  // that version if the pre-EXPORT_ROW_LIMIT numbers are ever needed again).
  it("Register Export: a full unfiltered request at full scale is rejected quickly by the row-count safety limit, not attempted and timed out", async () => {
    const start = performance.now();
    const res = await authedInject(app, { method: "GET", url: "/api/assets/export" });
    const elapsedMs = performance.now() - start;
    console.log(`Register Export, full ${ASSET_COUNT.toLocaleString()}-asset scan (over EXPORT_ROW_LIMIT): rejected in ${elapsedMs.toFixed(0)}ms`);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(`${ASSET_COUNT.toLocaleString()} rows`);
    // The rejection itself is just one aggregate query, not a batched scan — nowhere
    // near the 60s ceiling this exists to stay under in the first place.
    expect(elapsedMs).toBeLessThan(10_000);
  });

  // The other half of the same story: a request that's actually under EXPORT_ROW_LIMIT
  // must still complete normally, within budget, at real scale — the safety limit isn't
  // supposed to make every large-register export unusable, only the ones too big for a
  // single 60s request. Filtered to a deterministic subset of Centers computed from the
  // same in-memory `assets` fixture the other independent-oracle checks in this file
  // already use, rather than assumed from the average (500 assets/center × 500
  // centers) — this asserts what the real filtered count is, not what it's expected to
  // average out to.
  it("Register Export: a filtered request safely under EXPORT_ROW_LIMIT completes normally, within budget, with a complete ZIP archive", async () => {
    const selectedCenters = CENTERS.slice(0, 130);
    const expectedRowCount = assets.filter((a) => selectedCenters.includes(a.location)).length;
    // Sanity-checks the fixture itself, not the route — if this ever fails, the center
    // slice above needs adjusting, not EXPORT_ROW_LIMIT.
    expect(expectedRowCount).toBeGreaterThan(0);
    expect(expectedRowCount).toBeLessThan(70_000);

    const start = performance.now();
    const res = await authedInject(app, {
      method: "GET",
      url: `/api/assets/export?center=${selectedCenters.join(",")}`
    });
    const elapsedMs = performance.now() - start;
    console.log(
      `Register Export, filtered to ${selectedCenters.length} centers (${expectedRowCount.toLocaleString()} assets): ${elapsedMs.toFixed(0)}ms, ${res.rawPayload.length.toLocaleString()} bytes`
    );

    expect(res.statusCode).toBe(200);
    const buf = res.rawPayload;
    // ZIP local file header signature — every valid xlsx (a zip container) starts with
    // this; a response that never even got this far wouldn't be a zip at all.
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    // End Of Central Directory record signature ("PK\x05\x06") — the one thing a
    // truncated write can never have, since it's the LAST bytes a complete zip writer
    // emits. Searched within the last 1KB (the EOCD is fixed-size plus a short comment
    // field, always near the very end) rather than requiring it be the literal final 4
    // bytes, since ExcelJS may still trail a few bytes of stream-internal padding.
    const tail = buf.subarray(Math.max(0, buf.length - 1024));
    const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    let hasEocd = false;
    for (let i = 0; i <= tail.length - 4; i++) {
      if (tail.subarray(i, i + 4).equals(eocdSignature)) {
        hasEocd = true;
        break;
      }
    }
    expect(hasEocd).toBe(true);

    // Real 60s Vercel Hobby ceiling. A local, zero-network-latency time is a LOWER
    // BOUND on what production actually takes — passing here doesn't by itself prove
    // production is safe, only that the code's own compute cost at this row count isn't
    // the problem (see EXPORT_ROW_LIMIT's own comment in assetsExport.ts for the margin
    // reasoning against real network latency and run-to-run variance).
    expect(elapsedMs).toBeLessThan(60_000);
  });
});
