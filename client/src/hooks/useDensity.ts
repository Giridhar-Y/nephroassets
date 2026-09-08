import { useEffect, useState } from "react";
import { useAuth } from "../lib/AuthContext.js";
import { DENSITY_KEY_PREFIX } from "../lib/durablePreferenceKeys.js";

export type Density = "comfortable" | "compact";

// Per-user scoped, same reasoning and pattern as useColumnPrefs.ts's Saved Views: a
// personal display preference the user would expect to keep across logins, not
// per-session state — persistedUiState.ts's logout sweep recognizes and skips
// DENSITY_KEY_PREFIX (imported from durablePreferenceKeys.ts, not from this file
// directly, to avoid a circular import — this file imports useAuth() from
// AuthContext.tsx, which itself imports clearPersistedUiState from persistedUiState.ts;
// see durablePreferenceKeys.ts's own comment). Reads useAuth() internally (rather than
// taking userId as a param) so every existing call site (RegisterPage,
// LocationSummaryPage, DisposalPage, CapitalizationPage, AdditionsPage, AssetGrid's own
// fallback) keeps working unchanged — all of them already render only inside
// AuthProvider (App.tsx).
const LEGACY_UNSCOPED_KEY = "nephroassets.density";

function densityKey(userId: number): string {
  return `${DENSITY_KEY_PREFIX}${userId}`;
}

// One-time migration from the pre-per-user-scoping shared key into this user's own
// scoped key, so nobody who already had a density preference set loses it on their next
// load after this fix ships — same convention useColumnPrefs.ts's migration follows.
function loadDensity(userId: number | null): Density {
  if (userId === null) return "comfortable";
  try {
    const scoped = localStorage.getItem(densityKey(userId));
    if (scoped) return scoped === "compact" ? "compact" : "comfortable";
    const legacy = localStorage.getItem(LEGACY_UNSCOPED_KEY);
    if (legacy) {
      localStorage.removeItem(LEGACY_UNSCOPED_KEY);
      const value: Density = legacy === "compact" ? "compact" : "comfortable";
      localStorage.setItem(densityKey(userId), value);
      return value;
    }
    return "comfortable";
  } catch {
    return "comfortable";
  }
}

// One shared preference (single localStorage key per user) rather than per-page state,
// since every page showing an AssetGrid table means the same thing by "compact" — used
// both as AssetGrid's own internal fallback (pages that don't expose their own toggle)
// and lifted up by RegisterPage so its toggle button can live in the toolbar next to
// Expand instead of floating separately over the table.
export function useDensity() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [density, setDensity] = useState<Density>(() => loadDensity(userId));

  useEffect(() => {
    if (userId === null) return;
    try {
      localStorage.setItem(densityKey(userId), density);
    } catch {
      // Private-browsing/storage-disabled — density just won't persist across reloads.
    }
  }, [density, userId]);

  return [density, setDensity] as const;
}
