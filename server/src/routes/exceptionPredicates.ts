// The Finance FAR Dashboard's 5 exception categories — one SQL predicate per category,
// shared verbatim between reports.ts's dashboard-summary counts, assets.ts's
// GET /api/assets?exception= drill-through, and assetsExport.ts's matching export, so a
// dashboard tile's count and Register's row count for the same tile can never silently
// drift apart — one definition, several consumers, instead of the same condition
// hand-copied at each call site.
//
// Every predicate here is valid against the `calc` CTE all three routes build via
// buildCalcCteExtras + TOTAL_WDV_AND_PROFIT_LOSS_SQL (assetColumnFilters.ts) — the c1/c2
// composites, expiry_date_c1/c2, and profit_loss aliases it exposes.

export const EPSILON = 0.01; // one paisa — guards against currency-display rounding only

// ₹1L — a disposal P&L swing beyond this is exception-worthy. Named so the threshold has
// one place to tune, not a magic number buried in a WHERE clause.
export const BIG_DISPOSAL_SWING_THRESHOLD = 100_000;

export const EXCEPTION_KEYS = [
  "negativeNbv",
  "fullyDepreciatedActive",
  "pastUsefulLifeActive",
  "bigDisposalSwings",
  "missingData"
] as const;
export type ExceptionKey = (typeof EXCEPTION_KEYS)[number];

// Server-side label, used only by the Register export's filter-summary note (client has
// its own copy for on-screen labels/tones — no shared package boundary between client and
// server in this app, same as assetsExport.ts's GROUP_INFO).
export const EXCEPTION_LABELS: Record<ExceptionKey, string> = {
  negativeNbv: "Negative NBV",
  fullyDepreciatedActive: "Fully Depreciated, Still Active",
  pastUsefulLifeActive: "Past Useful Life, Still Active",
  bigDisposalSwings: "Big Disposal Swings (> ₹1L)",
  missingData: "Missing Data"
};

/** Pushes whatever bound params this predicate needs onto `params` (continuing from
 *  `params.length + 1`, same convention as buildCalcCteExtras) and returns the SQL
 *  boolean expression to AND into a WHERE clause evaluated against the `calc` CTE. */
export function buildExceptionPredicate(key: ExceptionKey, params: unknown[], fy: { fyStart: string; asAt: string }): string {
  switch (key) {
    case "negativeNbv":
      return `(c1).nbv + (c2).nbv < ${-EPSILON} AND status = 'Active'`;
    case "fullyDepreciatedActive":
      return `(c1).nbv + (c2).nbv BETWEEN 0 AND ${EPSILON} AND status = 'Active'`;
    case "pastUsefulLifeActive": {
      const asAtIdx = params.push(fy.asAt);
      return `GREATEST(expiry_date_c1, expiry_date_c2) < $${asAtIdx}::date AND status = 'Active'`;
    }
    case "bigDisposalSwings": {
      const fyStartIdx = params.push(fy.fyStart);
      const asAtIdx = params.push(fy.asAt);
      return `date_of_disposal BETWEEN $${fyStartIdx}::date AND $${asAtIdx}::date AND ABS(profit_loss) > ${BIG_DISPOSAL_SWING_THRESHOLD}`;
    }
    case "missingData":
      return `(serial_no IS NULL OR serial_no = '' OR sub_classification IS NULL OR sub_classification = '')`;
  }
}
