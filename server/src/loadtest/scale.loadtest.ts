import Fastify, { type FastifyInstance } from "fastify";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { generateAssets, CENTERS } from "./generateAssets.js";
import { bulkInsertAssets } from "./bulkInsert.js";
import { getPool } from "../db/pool.js";
import { computeComponent } from "../calc/engine.js";
import reportsRoutes from "../routes/reports.js";
import assetsRoutes from "../routes/assets.js";
import { authedInject } from "../testHelpers/authTestUtils.js";

const ASSET_COUNT = Number(process.env.LOADTEST_COUNT ?? 250_000);
const AS_AT = "2026-08-17";
const FY_START = "2026-04-01";
const FY_END = "2027-03-31";
const DAYS_IN_FY = 365;

describe(`load test: ${ASSET_COUNT.toLocaleString()} assets`, () => {
  let app: FastifyInstance;
  const assets = generateAssets(ASSET_COUNT, 12345);

  beforeAll(async () => {
    const db = await getPool();
    console.log(`Bulk-inserting ${ASSET_COUNT.toLocaleString()} assets...`);
    const insertStart = performance.now();
    await bulkInsertAssets(db, assets, 1000);
    console.log(`  done in ${((performance.now() - insertStart) / 1000).toFixed(1)}s`);

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
});
