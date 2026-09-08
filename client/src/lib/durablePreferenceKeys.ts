// Key prefixes for durable, per-user localStorage preferences (a saved view, row
// density, sidebar-collapsed state) — deliberately its own leaf module with NO other
// imports. persistedUiState.ts's logout sweep needs these to know what to exempt; the
// feature files that own each preference (useColumnPrefs.ts, useDensity.ts, Layout.tsx)
// need them to build their own scoped keys — but those feature files import useAuth()
// from AuthContext.tsx, and AuthContext.tsx itself imports clearPersistedUiState from
// persistedUiState.ts. Having persistedUiState.ts import the prefix constants directly
// from the feature files would close that into a circular import (persistedUiState.ts ->
// a feature file -> AuthContext.tsx -> persistedUiState.ts), which surfaced as a real
// "Cannot access '...KEY_PREFIX' before initialization" crash on load — this module
// exists specifically so both sides can share the constant without completing that cycle.
export const SAVED_VIEWS_KEY_PREFIX = "nephroassets.register.views.";
export const DENSITY_KEY_PREFIX = "nephroassets.density.";
export const SIDEBAR_COLLAPSED_KEY_PREFIX = "nephroassets.sidebarCollapsed.";

// Not user-scoped like the three above — a bare key, not a prefix. Whether THIS BROWSER
// has already been shown the "Add to Home Screen" hint (IosInstallHint.tsx) is a property
// of the device/browser, not of whoever happens to be signed in, so there's no userId to
// scope it by. Still belongs in the sweep's exemption list for the same underlying
// reason as the per-user ones: it's a durable choice ("don't show me this again"), not
// per-session state, so wiping it every logout just makes the hint reappear needlessly
// for the same device on its next sign-in.
export const IOS_INSTALL_HINT_DISMISSED_KEY = "nephroassets.iosInstallHintDismissed";
