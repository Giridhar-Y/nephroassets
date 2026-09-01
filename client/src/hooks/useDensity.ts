import { useEffect, useState } from "react";

export type Density = "comfortable" | "compact";

const DENSITY_KEY = "nephroassets.density";

// One shared preference (single localStorage key) rather than per-page state, since
// every page showing an AssetGrid table means the same thing by "compact" — used both as
// AssetGrid's own internal fallback (pages that don't expose their own toggle) and lifted
// up by RegisterPage so its toggle button can live in the toolbar next to Expand instead
// of floating separately over the table.
export function useDensity() {
  const [density, setDensity] = useState<Density>(() => {
    try {
      return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
    } catch {
      return "comfortable";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(DENSITY_KEY, density);
    } catch {
      // Private-browsing/storage-disabled — density just won't persist across reloads.
    }
  }, [density]);
  return [density, setDensity] as const;
}
