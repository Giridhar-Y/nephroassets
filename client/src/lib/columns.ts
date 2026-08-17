import type { AssetListItem } from "./types.js";
import { formatCurrency, formatDate } from "./format.js";
import { FIELD_INFO } from "./fieldInfo.js";

export interface ColumnDef {
  id: string;
  label: string;
  tooltip?: string;
  width: number;
  sortKey?: string;
  render: (item: AssetListItem) => string;
  align?: "left" | "right";
}

export const ALL_COLUMNS: ColumnDef[] = [
  { id: "farId", label: "FAR ID", width: 130, sortKey: "farId", render: (i) => i.asset.farId },
  {
    id: "assetDescription",
    label: "Asset Description",
    width: 220,
    render: (i) => i.asset.assetDescription
  },
  {
    id: "subClassification",
    label: "Sub Classification",
    width: 170,
    sortKey: "subClassification",
    render: (i) => i.asset.subClassification
  },
  { id: "status", label: "Status", width: 110, sortKey: "status", render: (i) => i.asset.status },
  {
    id: "effectiveLocation",
    label: FIELD_INFO.effectiveLocation.label,
    tooltip: FIELD_INFO.effectiveLocation.tooltip,
    width: 140,
    render: (i) => i.result.effectiveLocation
  },
  {
    id: "dateAcquired",
    label: "Date Acquired",
    width: 130,
    sortKey: "dateAcquired",
    render: (i) => formatDate(i.asset.dateAcquired)
  },
  {
    id: "c1GrossBlock",
    label: `C1 ${FIELD_INFO.grossBlock.label}`,
    tooltip: FIELD_INFO.grossBlock.tooltip,
    width: 140,
    align: "right",
    render: (i) => formatCurrency(i.result.c1.grossBlock)
  },
  {
    id: "c1AccDep",
    label: `C1 ${FIELD_INFO.accumulatedDepreciation.label}`,
    tooltip: FIELD_INFO.accumulatedDepreciation.tooltip,
    width: 150,
    align: "right",
    render: (i) => formatCurrency(i.result.c1.closingAccDep)
  },
  {
    id: "c1PeriodDep",
    label: `C1 ${FIELD_INFO.periodDepreciation.label}`,
    tooltip: FIELD_INFO.periodDepreciation.tooltip,
    width: 150,
    align: "right",
    render: (i) => formatCurrency(i.result.c1.periodDepreciation)
  },
  {
    id: "c1Nbv",
    label: `C1 ${FIELD_INFO.nbv.label}`,
    tooltip: FIELD_INFO.nbv.tooltip,
    width: 140,
    align: "right",
    render: (i) => formatCurrency(i.result.c1.nbv)
  },
  {
    id: "c2GrossBlock",
    label: `C2 ${FIELD_INFO.grossBlock.label}`,
    tooltip: FIELD_INFO.grossBlock.tooltip,
    width: 140,
    align: "right",
    render: (i) => formatCurrency(i.result.c2.grossBlock)
  },
  {
    id: "c2AccDep",
    label: `C2 ${FIELD_INFO.accumulatedDepreciation.label}`,
    tooltip: FIELD_INFO.accumulatedDepreciation.tooltip,
    width: 150,
    align: "right",
    render: (i) => formatCurrency(i.result.c2.closingAccDep)
  },
  {
    id: "c2Nbv",
    label: `C2 ${FIELD_INFO.nbv.label}`,
    tooltip: FIELD_INFO.nbv.tooltip,
    width: 140,
    align: "right",
    render: (i) => formatCurrency(i.result.c2.nbv)
  },
  {
    id: "profitLoss",
    label: FIELD_INFO.profitLoss.label,
    tooltip: FIELD_INFO.profitLoss.tooltip,
    width: 150,
    align: "right",
    render: (i) =>
      i.result.c1.profitLossOnDisposal === null
        ? "—"
        : formatCurrency(i.result.c1.profitLossOnDisposal + (i.result.c2.profitLossOnDisposal ?? 0))
  }
];

export const DEFAULT_VISIBLE_COLUMNS = [
  "farId",
  "assetDescription",
  "subClassification",
  "status",
  "effectiveLocation",
  "dateAcquired",
  "c1GrossBlock",
  "c1AccDep",
  "c1Nbv",
  "c2GrossBlock",
  "c2Nbv"
];
