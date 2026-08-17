import { describe, expect, it } from "vitest";
import { computeComponent } from "./engine.js";
import type { FySettings } from "./types.js";
import { getTestPool } from "../db/testClient.js";

// Proves the SQL port of the calc engine (far_calc_component in schema.sql, used by the
// aggregate reports for database-level SUM/GROUP BY) produces the same numbers as the
// TypeScript engine used by the register. Runs the same fixtures through both.

const FY: FySettings = { asAt: "2025-09-30", fyStart: "2025-04-01", fyEnd: "2026-03-31", daysInFy: 365 };

interface Fixture {
  name: string;
  input: Parameters<typeof computeComponent>[0];
  fy: FySettings;
}

const fixtures: Fixture[] = [
  {
    name: "normal opening depreciation",
    input: {
      openingCost: 100000,
      additions: 0,
      dateOfAddition: null,
      usefulLifeYears: 10,
      dateOfDisposal: null,
      deletionsCost: 0,
      saleValue: 0,
      accDepOpening: 0
    },
    fy: FY
  },
  {
    name: "addition mid-year, no disposal",
    input: {
      openingCost: 20000,
      additions: 50000,
      dateOfAddition: "2025-05-01",
      usefulLifeYears: 5,
      dateOfDisposal: null,
      deletionsCost: 0,
      saleValue: 0,
      accDepOpening: 5000
    },
    fy: { ...FY, asAt: "2025-12-31" }
  },
  {
    name: "fully depreciated (cap binds)",
    input: {
      openingCost: 100000,
      additions: 0,
      dateOfAddition: null,
      usefulLifeYears: 5,
      dateOfDisposal: null,
      deletionsCost: 0,
      saleValue: 0,
      accDepOpening: 100000
    },
    fy: FY
  },
  {
    name: "over-depreciated bad data (cap floors at zero, closing capped at gross block)",
    input: {
      openingCost: 100000,
      additions: 0,
      dateOfAddition: null,
      usefulLifeYears: 10,
      dateOfDisposal: null,
      deletionsCost: 0,
      saleValue: 0,
      accDepOpening: 130000
    },
    fy: FY
  },
  {
    name: "partial disposal mid-year with opening acc dep",
    input: {
      openingCost: 100000,
      additions: 0,
      dateOfAddition: null,
      usefulLifeYears: 10,
      dateOfDisposal: "2025-09-30",
      deletionsCost: 40000,
      saleValue: 25000,
      accDepOpening: 20000
    },
    fy: { ...FY, asAt: "2025-12-31" }
  },
  {
    name: "added and fully disposed within the same period",
    input: {
      openingCost: 0,
      additions: 50000,
      dateOfAddition: "2025-05-01",
      usefulLifeYears: 5,
      dateOfDisposal: "2025-08-31",
      deletionsCost: 50000,
      saleValue: 45000,
      accDepOpening: 0
    },
    fy: { ...FY, asAt: "2025-12-31" }
  },
  {
    name: "disposal dated after AS_AT is not yet effective",
    input: {
      openingCost: 80000,
      additions: 0,
      dateOfAddition: null,
      usefulLifeYears: 10,
      dateOfDisposal: "2026-02-01",
      deletionsCost: 80000,
      saleValue: 5000,
      accDepOpening: 0
    },
    fy: { ...FY, asAt: "2025-12-31" }
  },
  {
    name: "zero useful life never divides by zero",
    input: {
      openingCost: 50000,
      additions: 0,
      dateOfAddition: null,
      usefulLifeYears: 0,
      dateOfDisposal: null,
      deletionsCost: 0,
      saleValue: 0,
      accDepOpening: 0
    },
    fy: FY
  }
];

it.each(fixtures)("SQL matches TypeScript engine: $name", async ({ input, fy }) => {
  const ts = computeComponent(input, fy);

  const pool = getTestPool();
  const { rows } = await pool.query(
    `SELECT (far_calc_component($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)).*`,
    [
      input.openingCost,
      input.additions,
      input.dateOfAddition,
      input.usefulLifeYears,
      input.dateOfDisposal,
      input.deletionsCost,
      input.saleValue,
      input.accDepOpening,
      fy.asAt,
      fy.fyStart,
      fy.daysInFy
    ]
  );
  const sql = rows[0];

  expect(sql.effective_end_date).toBe(ts.effectiveEndDate);
  expect(sql.disposal_effective).toBe(ts.disposalEffective);
  expect(Number(sql.days_held_opening)).toBe(ts.daysHeldOpening);
  expect(Number(sql.days_held_addition)).toBe(ts.daysHeldAddition);
  expect(Number(sql.dep_on_opening)).toBeCloseTo(ts.depOnOpening, 6);
  expect(Number(sql.dep_on_additions)).toBeCloseTo(ts.depOnAdditions, 6);
  expect(Number(sql.period_depreciation)).toBeCloseTo(ts.periodDepreciation, 6);
  expect(Number(sql.gross_block)).toBeCloseTo(ts.grossBlock, 6);
  expect(Number(sql.disposed_ratio)).toBeCloseTo(ts.disposedRatio, 6);
  expect(Number(sql.dep_on_disposed_portion)).toBeCloseTo(ts.depOnDisposedPortion, 6);
  expect(Number(sql.acc_dep_on_disposed)).toBeCloseTo(ts.accDepOnDisposed, 6);
  expect(Number(sql.closing_acc_dep)).toBeCloseTo(ts.closingAccDep, 6);
  expect(Number(sql.nbv)).toBeCloseTo(ts.nbv, 6);
  if (ts.wdvAtDisposal === null) {
    expect(sql.wdv_at_disposal).toBeNull();
  } else {
    expect(Number(sql.wdv_at_disposal)).toBeCloseTo(ts.wdvAtDisposal, 6);
  }
  if (ts.profitLossOnDisposal === null) {
    expect(sql.profit_loss_on_disposal).toBeNull();
  } else {
    expect(Number(sql.profit_loss_on_disposal)).toBeCloseTo(ts.profitLossOnDisposal, 6);
  }
});
