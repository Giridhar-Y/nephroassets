# Fixed Asset Register (FAR) — Developer Requirements

## Purpose
A tool that maintains a Fixed Asset Register and computes straight-line depreciation as of any user-chosen cut-off date within a financial year, for two independent cost components per asset (C1 and C2).

## Data Model
One row per asset.

**Identification:** FAR ID, Sub Classification, Asset Description, Serial No, Qty, Status, Date Acquired, Location, Revised Location, Last Date of Transaction

**Useful Life:** Useful Life C1 (Yrs), Useful Life C2 (Yrs)

**Cost:** C1 Opening Cost (as at FY start), C2 Opening Cost, Additions C1, Additions C2, Date of Addition

**Disposal:** Date of Disposal, Deletions C1 (Cost), Deletions C2 (Cost), Sale Value/Proceeds

**Opening Depreciation:** Acc Dep C1 Opening, Acc Dep C2 Opening

## Settings (single control panel)
- **AS_AT** — user-entered date, any day within the financial year
- **FY_ST, FY_EN** — financial year start/end dates
- **DAYS_FY** — days in the financial year (365, or 366 in a leap year)

All outputs recalculate instantly when AS_AT changes.

## Calculation Logic
Apply identically and independently to C1 and C2.

1. **Effective End Date** = Disposal Date, if Disposal Date is on or before AS_AT; otherwise AS_AT.
2. **Days Held (opening balance)** = Effective End Date minus FY Start, plus one.
   **Days Held (additions)** = Effective End Date minus Date of Addition, plus one.
3. **Depreciation on Opening** = Opening Cost divided by Useful Life, multiplied by (Days Held divided by Days in FY).
4. **Depreciation on Additions** = Addition Cost divided by Useful Life, multiplied by (Days Held from Addition divided by Days in FY).
5. **Period Depreciation (final)** = the smaller of: (Dep on Opening + Dep on Additions), or (Gross Block minus Opening Acc Dep, floored at zero).
   → This cap means a fully depreciated asset always shows zero further depreciation, and Net Book Value can never go negative.
6. **Gross Block as at AS_AT** = Opening Cost + Additions − Disposed Cost (subtract Disposed Cost only if Disposal Date is on or before AS_AT).
7. **Disposed Ratio** = Disposed Cost divided by (Opening Cost + Additions).
8. **Accumulated Depreciation on Disposed Portion** = the smaller of: (Disposed Ratio × Opening Acc Dep + Depreciation on the disposed portion up to Disposal Date), or Disposed Cost.
9. **Closing Accumulated Depreciation** = Opening Acc Dep + Period Depreciation − Acc Dep on Disposed, capped at Closing Gross Block.
10. **Net Book Value (NBV)** = Gross Block − Closing Accumulated Depreciation.
11. **Written-Down Value (WDV) at Disposal** = Disposed Cost − Acc Dep on Disposed Portion.
    **Profit/(Loss) on Disposal** = Sale Value − WDV at Disposal.
12. **Effective Location** = the location from the most recent matching Transfers record (matched on Asset ID + transaction date); if no transfer record matches, use the original Location.

## Reports / Outputs
- **Full Asset Register** — all fields above, computed as at AS_AT.
- **Location Summary** — user picks a location; tool lists assets whose Effective Location matches, with count and total C1 Gross Block.
- **Audit Reconciliation** — by Sub Classification, for C1 and C2 separately: Opening + Additions − Deletions = Closing (cost), and Opening Acc Dep + Period Depreciation − Acc Dep Removed = Closing Acc Dep. Show a pass/fail check column for each.
- **Depreciation Posting Summary** — total Period Depreciation (C1 + C2, all assets) for the selected AS_AT — the journal entry amount (Dr Depreciation Expense / Cr Accumulated Depreciation).

## Edge Cases to Handle
- Asset added and disposed within the same period.
- Asset with zero remaining useful life / fully depreciated (must show zero, not negative, depreciation).
- Disposal date entered but after AS_AT (disposal not yet effective — ignore it for this AS_AT).
- Asset with no additions, or no disposal (fields blank/zero).

## Explicitly Out of Scope
- Any depreciation method other than straight-line (SLM).
- Multi-currency, revaluation, or impairment accounting.
- More than two cost components per asset.
- Automated financial-year rollover (rollover is a manual step: carry Closing NBV and Closing Acc Dep into next year's Opening fields).
- User roles/permissions, approval workflows, or audit trails beyond the reconciliation check above.
- Integrations with ERP/GL systems beyond producing the journal entry summary figure.
