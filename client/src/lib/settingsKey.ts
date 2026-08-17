import type { FySettings } from "./types.js";

/** Stable dependency key covering every field of the FY settings, so effects that
 *  should refetch on ANY settings change (not just AS_AT) can depend on this instead
 *  of a single field. */
export function fySettingsKey(fy: FySettings | null): string {
  return fy ? `${fy.asAt}|${fy.fyStart}|${fy.fyEnd}|${fy.daysInFy}` : "";
}
