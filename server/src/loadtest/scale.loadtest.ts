import Fastify, { type FastifyInstance } from "fastify";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { generateAssets, generateTransfers, CENTERS } from "./generateAssets.js";
import { bulkInsertAssets, bulkInsertTransfers } from "./bulkInsert.js";
import { getPool } from "../db/pool.js";
import { computeComponent, computeAsset } from "../calc/engine.js";
import { maxIsoDate } from "../calc/dates.js";
import { splitDepreciationByLocation } from "../reports/transferDepreciationSplit.js";
import reportsRoutes from "../routes/reports.js";
import assetsRoutes from "../routes/assets.js";
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
    await app.register(reportsRoutes);
    await app.register(assetsRoutes);
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
});
