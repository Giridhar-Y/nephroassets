import { describe, expect, it } from "vitest";
import { splitDepreciationByLocation } from "./transferDepreciationSplit.js";
import type { TransferRecord } from "../calc/types.js";

function sum(segments: { depreciation: number }[]): number {
  return segments.reduce((s, seg) => s + seg.depreciation, 0);
}

// Summing many already-rounded 2-decimal floats with plain `+` can itself pick up a
// sub-paisa binary floating-point residue (e.g. 123456.78999999998 instead of
// 123456.79) — a JS float-representation artifact, not a real reconciliation gap. The
// exact-to-the-paisa check the correctness requirement actually cares about belongs in
// integer-paisa space, where that artifact can't occur.
function sumPaise(values: number[]): number {
  return values.reduce((s, v) => s + Math.round(v * 100), 0);
}

describe("splitDepreciationByLocation", () => {
  it("returns a single full-period segment when the asset never moved", () => {
    const segments = splitDepreciationByLocation("Center-A", [], "2026-04-01", "2026-09-30", 700, 300);
    expect(segments).toEqual([
      {
        location: "Center-A",
        fromDate: "2026-04-01",
        toDate: "2026-09-30",
        daysHeld: 183,
        c1Depreciation: 700,
        c2Depreciation: 300,
        depreciation: 1000
      }
    ]);
  });

  it("splits into two segments around a single mid-period transfer, proportional to days held, per component", () => {
    const transfers: TransferRecord[] = [{ farId: "A1", transactionDate: "2026-07-01", location: "Center-B" }];
    const segments = splitDepreciationByLocation("Center-A", transfers, "2026-04-01", "2026-09-30", 700, 300);

    expect(segments).toHaveLength(2);
    expect(segments[0]!.location).toBe("Center-A");
    expect(segments[0]!.fromDate).toBe("2026-04-01");
    expect(segments[0]!.toDate).toBe("2026-06-30");
    expect(segments[1]!.location).toBe("Center-B");
    expect(segments[1]!.fromDate).toBe("2026-07-01");
    expect(segments[1]!.toDate).toBe("2026-09-30");
    // Reconciliation: exact, not approximate — per component and combined.
    expect(sumPaise(segments.map((s) => s.c1Depreciation))).toBe(70000);
    expect(sumPaise(segments.map((s) => s.c2Depreciation))).toBe(30000);
    expect(sum(segments)).toBe(1000);
  });

  it("ignores a transfer on or before periodStart for segmenting, but uses it as the starting location", () => {
    const transfers: TransferRecord[] = [{ farId: "A1", transactionDate: "2026-04-01", location: "Center-B" }];
    const segments = splitDepreciationByLocation("Center-A", transfers, "2026-04-01", "2026-06-30", 200, 100);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.location).toBe("Center-B");
    expect(sum(segments)).toBe(300);
  });

  it("collapses same-day transfers to only the final location that day, with zero-day segments dropped", () => {
    const transfers: TransferRecord[] = [
      { farId: "A1", transactionDate: "2026-05-01", location: "Center-B" },
      { farId: "A1", transactionDate: "2026-05-01", location: "Center-C" }
    ];
    const segments = splitDepreciationByLocation("Center-A", transfers, "2026-04-01", "2026-06-30", 600, 300);
    expect(segments.map((s) => s.location)).toEqual(["Center-A", "Center-C"]);
    expect(sum(segments)).toBe(900);
  });

  it("returns no segments when the period is empty (periodStart after periodEnd)", () => {
    const segments = splitDepreciationByLocation("Center-A", [], "2026-06-30", "2026-04-01", 400, 100);
    expect(segments).toEqual([]);
  });

  it("handles zero total depreciation cleanly (every segment zero, still reconciles)", () => {
    const transfers: TransferRecord[] = [{ farId: "A1", transactionDate: "2026-07-01", location: "Center-B" }];
    const segments = splitDepreciationByLocation("Center-A", transfers, "2026-04-01", "2026-09-30", 0, 0);
    expect(segments.every((s) => s.c1Depreciation === 0 && s.c2Depreciation === 0)).toBe(true);
    expect(sum(segments)).toBe(0);
  });

  it("reconciles C1 and C2 independently when only one component has a nonzero total", () => {
    const transfers: TransferRecord[] = [{ farId: "A1", transactionDate: "2026-07-01", location: "Center-B" }];
    const segments = splitDepreciationByLocation("Center-A", transfers, "2026-04-01", "2026-09-30", 500, 0);
    expect(sumPaise(segments.map((s) => s.c1Depreciation))).toBe(50000);
    expect(segments.every((s) => s.c2Depreciation === 0)).toBe(true);
  });

  // The scenario the report's own spec calls out by name: an asset with many location
  // changes across the period (10+, per the requirement) — every segment's share is
  // computed with full float precision from an amount that doesn't divide evenly across
  // uneven day-count segments, which is exactly where naive per-segment rounding would
  // normally cause the sum to drift a paisa or two off the true total. Both components
  // use deliberately different, awkward totals so a bug that only reconciles the
  // combined figure (e.g. splitting c1+c2 as one lump sum) can't hide behind it.
  it("reconciles exactly per component for an asset with many transfers, even when neither amount divides evenly", () => {
    const locations = Array.from({ length: 14 }, (_, i) => `Center-${i + 1}`);
    const transfers: TransferRecord[] = locations.slice(1).map((location, i) => ({
      farId: "A1",
      // Irregular day gaps (3, 7, 1, 11, ...) so segment lengths are uneven on purpose.
      transactionDate: `2026-04-${String(2 + ((i * 7 + 3) % 27)).padStart(2, "0")}`,
      location
    }));
    const c1Total = 123456.79;
    const c2Total = 54321.11;

    const segments = splitDepreciationByLocation(locations[0]!, transfers, "2026-04-01", "2026-04-30", c1Total, c2Total);

    expect(segments.length).toBeGreaterThan(1);
    expect(sumPaise(segments.map((s) => s.c1Depreciation))).toBe(Math.round(c1Total * 100));
    expect(sumPaise(segments.map((s) => s.c2Depreciation))).toBe(Math.round(c2Total * 100));
    // The combined figure per segment is exactly the sum of that segment's own two
    // already-rounded component amounts (Register's convention — see the type doc).
    for (const s of segments) {
      expect(s.depreciation).toBe(Math.round((s.c1Depreciation + s.c2Depreciation) * 100) / 100);
    }
  });

  it("reconciles exactly across a much larger many-segment case (20 real-world-shaped transfers), per component", () => {
    const transferCount = 20;
    const transfers: TransferRecord[] = Array.from({ length: transferCount }, (_, i) => ({
      farId: "A1",
      transactionDate: `2026-${String(4 + Math.floor(i / 3)).padStart(2, "0")}-${String(1 + ((i * 5) % 27)).padStart(2, "0")}`,
      location: `Center-${(i % 6) + 1}`
    }));
    const c1Total = 987654.33;
    const c2Total = 12345.67;
    const segments = splitDepreciationByLocation("Center-0", transfers, "2026-04-01", "2027-03-31", c1Total, c2Total);
    expect(sumPaise(segments.map((s) => s.c1Depreciation))).toBe(Math.round(c1Total * 100));
    expect(sumPaise(segments.map((s) => s.c2Depreciation))).toBe(Math.round(c2Total * 100));
  });
});
