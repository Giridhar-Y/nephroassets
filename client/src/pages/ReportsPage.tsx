import { Link } from "react-router-dom";
import { DepreciationIcon, LocationIcon, ReconciliationIcon, ReportsIcon } from "../lib/icons.js";
import type { ComponentType } from "react";
import type { FluentIconsProps } from "@fluentui/react-icons";

const REPORTS: Array<{ to: string; label: string; description: string; icon: ComponentType<FluentIconsProps> }> = [
  {
    to: "/location-summary",
    label: "Location Summary",
    description: "Asset count and total Gross Block for any one center.",
    icon: LocationIcon
  },
  {
    to: "/audit-reconciliation",
    label: "Audit Reconciliation",
    description: "Cost and depreciation checks by Sub Classification, so mismatches surface early.",
    icon: ReconciliationIcon
  },
  {
    to: "/depreciation-posting",
    label: "Depreciation Posting",
    description: "The period's total depreciation journal amount, with a per-Sub-Classification breakdown.",
    icon: DepreciationIcon
  }
];

export function ReportsPage() {
  return (
    <div className="flex h-full flex-col overflow-auto bg-white px-6 py-6">
      <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
        <ReportsIcon fontSize={20} />
        Reports
      </h1>
      <p className="mt-1 max-w-xl text-sm text-gray-500">Choose a report to view.</p>

      <div className="mt-6 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
        {REPORTS.map((report) => (
          <Link
            key={report.to}
            to={report.to}
            className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition-colors hover:border-accent hover:bg-accent-light"
          >
            <report.icon fontSize={22} className="text-accent" />
            <h2 className="mt-3 text-sm font-semibold text-ink">{report.label}</h2>
            <p className="mt-1 text-xs text-gray-500">{report.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
