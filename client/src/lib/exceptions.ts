// The Finance FAR Dashboard's 5 exception categories — mirrors
// server/src/routes/exceptionPredicates.ts's ExceptionKey exactly (no shared package
// boundary between client and server in this app, same convention as every other
// parallel-definition pair here, e.g. assetsExport.ts's GROUP_INFO). Used by
// DashboardPage (tiles) and RegisterPage (the "Dashboard: ..." drill-through chip).
export const EXCEPTION_KEYS = [
  "negativeNbv",
  "fullyDepreciatedActive",
  "pastUsefulLifeActive",
  "bigDisposalSwings",
  "missingData"
] as const;
export type ExceptionKey = (typeof EXCEPTION_KEYS)[number];

export const EXCEPTION_LABELS: Record<ExceptionKey, string> = {
  negativeNbv: "Negative NBV",
  fullyDepreciatedActive: "Fully Depreciated, Still Active",
  pastUsefulLifeActive: "Past Useful Life, Still Active",
  bigDisposalSwings: "Big Disposal Swings (> ₹1L)",
  missingData: "Missing Data"
};

// Reuses Badge's existing tone vocabulary rather than inventing new severity colors.
export const EXCEPTION_TONES: Record<ExceptionKey, "danger" | "warning" | "info" | "neutral"> = {
  negativeNbv: "danger",
  fullyDepreciatedActive: "warning",
  pastUsefulLifeActive: "warning",
  bigDisposalSwings: "info",
  missingData: "neutral"
};

export function isExceptionKey(value: string): value is ExceptionKey {
  return (EXCEPTION_KEYS as readonly string[]).includes(value);
}
