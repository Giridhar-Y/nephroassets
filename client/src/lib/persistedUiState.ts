// Imported from this dedicated leaf module, not directly from useColumnPrefs.ts/
// useDensity.ts/Layout.tsx — those files import useAuth() from AuthContext.tsx, which
// itself imports clearPersistedUiState from this file, so importing their prefix
// constants directly here would close a circular import (see durablePreferenceKeys.ts's
// own comment for the full account, including the crash it caused before this fix).
import {
  DENSITY_KEY_PREFIX,
  IOS_INSTALL_HINT_DISMISSED_KEY,
  SAVED_VIEWS_KEY_PREFIX,
  SIDEBAR_COLLAPSED_KEY_PREFIX
} from "./durablePreferenceKeys.js";

// Every client-only UI preference this app persists (filters, column layout, sidebar
// collapsed state, and anything added later) is namespaced under this prefix by
// convention. Clearing by prefix means a screen that persists its own UI state later
// participates automatically just by following the convention — logout doesn't need to
// be taught about it by name.
const NAMESPACE_PREFIX = "nephroassets.";

// The deliberate exceptions to "clear everything under the namespace on logout": each of
// these is a durable choice the user (or, for IOS_INSTALL_HINT_DISMISSED_KEY, the device)
// made on purpose — a saved view, a display density, a sidebar state, "don't show me the
// install hint again" — not ephemeral per-session UI state like the live filters this
// sweep exists to reset for the next person on a shared/kiosk browser. The first three
// are scoped by user id (see each *_KEY_PREFIX constant's own comment), so a different
// person logging into the same browser never sees them; the install-hint one is scoped by
// device instead (there's nothing user-specific about it), so it's exempted as a bare key
// rather than a prefix. Sweeping any of these would only cost the SAME user/device its own
// preference on every logout, which is what was happening before these exceptions
// existed. Add a new durable preference's own exported constant to this list rather than
// special-casing clearPersistedUiState() itself.
const DURABLE_PREFIXES = [SAVED_VIEWS_KEY_PREFIX, DENSITY_KEY_PREFIX, SIDEBAR_COLLAPSED_KEY_PREFIX, IOS_INSTALL_HINT_DISMISSED_KEY];

/** Fired after clearPersistedUiState() runs. Only needed by a React context whose state
 *  was seeded from storage on mount and which doesn't unmount across logout/login (i.e.
 *  one mounted above the route switch, like FiltersContext) — it won't otherwise notice
 *  storage was cleared underneath it. Anything that lives inside RequireAuth's route
 *  tree unmounts on logout and reloads from (now-cleared) storage fresh on next mount,
 *  no subscription needed. */
export const PERSISTED_UI_STATE_CLEARED_EVENT = "nephroassets:persisted-ui-state-cleared";

/** Sweeps every nephroassets.*-namespaced key out of both localStorage and
 *  sessionStorage — called on every logout path (explicit Sign Out, forced logout on
 *  session expiry) so a shared/kiosk browser starts the next sign-in on a clean UI
 *  instead of the previous user's filters/columns/etc. Never touches server-side data —
 *  this is client-only display state, scoped by convention, not by account. Skips
 *  DURABLE_PREFIXES — see this file's own comment on that exception above. */
export function clearPersistedUiState(): void {
  for (const storage of [localStorage, sessionStorage]) {
    for (const key of Object.keys(storage)) {
      if (key.startsWith(NAMESPACE_PREFIX) && !DURABLE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        storage.removeItem(key);
      }
    }
  }
  window.dispatchEvent(new Event(PERSISTED_UI_STATE_CLEARED_EVENT));
}
