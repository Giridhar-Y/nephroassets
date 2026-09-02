import { CollapseExpandIcon, DensityIcon, ExpandIcon } from "../../lib/icons.js";
import type { Density } from "../../hooks/useDensity.js";

// The density + full-screen toggle, grouped in one bordered pill, meant to sit in a
// page's own toolbar next to its other controls (Export, Columns, ...) — same layout
// Register originally introduced. Pass both as controlled state (density from
// useDensity(), expanded from a local useState) into both this component AND AssetGrid's
// own density/onDensityChange/expanded/onExpandedChange props; AssetGrid suppresses its
// default floating buttons once it sees those are controlled, so the two never render
// twice. Every AssetGrid-based page should use this rather than falling back to
// AssetGrid's own uncontrolled floating buttons, which sit as separate bordered squares
// directly on top of the grid's own header row with no toolbar space reserved for them —
// readable as a rendering glitch, not an intentional control.
export function GridViewControls({
  density,
  onDensityChange,
  expanded,
  onExpandedChange
}: {
  density: Density;
  onDensityChange: (density: Density) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-gray-300 p-0.5 text-gray-600">
      <button
        type="button"
        aria-label={density === "compact" ? "Switch to comfortable row height" : "Switch to compact row height"}
        title={density === "compact" ? "Comfortable rows" : "Compact rows"}
        onClick={() => onDensityChange(density === "compact" ? "comfortable" : "compact")}
        className={`flex items-center rounded px-1.5 py-1 hover:bg-gray-50 ${
          density === "compact" ? "bg-accent-light text-accent-hover" : ""
        }`}
      >
        <DensityIcon fontSize={14} />
      </button>
      <button
        type="button"
        aria-label={expanded ? "Exit full screen" : "Expand table to full screen"}
        title={expanded ? "Exit full screen (Esc)" : "Expand to full screen"}
        onClick={() => onExpandedChange(!expanded)}
        className="flex items-center rounded px-1.5 py-1 hover:bg-gray-50"
      >
        {expanded ? <CollapseExpandIcon fontSize={14} /> : <ExpandIcon fontSize={14} />}
      </button>
    </div>
  );
}
