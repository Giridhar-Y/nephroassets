// Excel-like read-only rendering of engine.ts's actual per-component formula (steps 2-5
// of FAR_Developer_Requirements.md) — documentation only, not an editable field. Kept as a
// pure function of the one real input (DAYS_FY) so it's unit-testable and can't silently
// drift from what's shown vs. what's typed in the confirm dialog.
export function depreciationFormulaText(daysInFy: number): string {
  return [
    `DepOnOpening   = IF(UsefulLife=0, 0, (OpeningCost / UsefulLife) × (DaysHeldOpening / ${daysInFy}))`,
    `DepOnAdditions = IF(UsefulLife=0, 0, (AdditionsCost / UsefulLife) × (DaysHeldAddition / ${daysInFy}))`,
    `PeriodDepreciation = MIN(DepOnOpening + DepOnAdditions, MAX(GrossBlockAsAt − OpeningAccDep, 0))`
  ].join("\n");
}
