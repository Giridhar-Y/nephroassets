import type { ReactNode } from "react";
import { ColumnFilterPopover, ConditionFilterPanel } from "../components/ColumnFilterPopover.js";
import { isConditionComplete, type ColumnCondition, type ColumnFilterType } from "./columnFilters.js";

/** Shared wiring for "every column gets a plain Excel-style custom-condition filter,
 *  no checklist mode" — the shape Additions/Disposal/Capitalization's log tabs and the
 *  Transfer Log all want. Register keeps its own hand-written version (four of its
 *  columns additionally get a checkbox "select values" mode via DualModeFilterPanel,
 *  which needs extra page-specific props this generic helper doesn't have) — extracted
 *  here once a *second* page needed the identical column-loop wiring, not preemptively.
 *
 *  `setConditions` should come from whatever local/context filter state the page already
 *  has (an array field on it, e.g. `filters.conditions ?? []`) — this only builds the
 *  per-column popovers and the single per-column commit function, it holds no state of
 *  its own. */
export function makeSetCondition(
  conditions: ColumnCondition[],
  setConditions: (next: ColumnCondition[]) => void
): (columnId: string, next: ColumnCondition | undefined) => void {
  return (columnId, next) => {
    const rest = conditions.filter((c) => c.columnId !== columnId);
    setConditions(isConditionComplete(next) ? [...rest, next] : rest);
  };
}

export function buildConditionHeaderFilters(
  columns: Array<{ id: string; label: string; type: ColumnFilterType }>,
  conditions: ColumnCondition[],
  setCondition: (columnId: string, next: ColumnCondition | undefined) => void
): Partial<Record<string, ReactNode>> {
  const headerFilters: Partial<Record<string, ReactNode>> = {};
  for (const col of columns) {
    const current = conditions.find((c) => c.columnId === col.id);
    headerFilters[col.id] = (
      <ColumnFilterPopover label={col.label} active={!!current}>
        {() => (
          <ConditionFilterPanel label={col.label} columnId={col.id} type={col.type} condition={current} onChange={(next) => setCondition(col.id, next)} />
        )}
      </ColumnFilterPopover>
    );
  }
  return headerFilters;
}
