import { SAVED_VIEWS_KEY_PREFIX } from "./useColumnPrefs.js";

// Every client-only UI preference this app persists (filters, column layout, sidebar
// collapsed state, and anything added later) is namespaced under this prefix by
// convention. Clearing by prefix means a screen that persists its own UI state later
// participates automatically just by following the convention — logout doesn't need to
// be taught about it by name.
const NAMESPACE_PREFIX = "nephroassets.";

// The one deliberate exception to "clear everything under the namespace on logout":
// Register's Saved Views (useColumnPrefs.ts) are a durable, per-user preference — a name
// the user typed and explicitly chose to save — not ephemeral per-session UI state like
// the live filters or sidebar-collapsed flag this sweep exists to reset for the next
// person on a shared/kiosk browser. Its key is already scoped by user id (see
// SAVED_VIEWS_KEY_PREFIX's own comment), so a different person logging into the same
// browser never sees it — sweeping it too would only cost the SAME user their own saved
// views on every one of their own logouts, which is what was happening before this
// exception existed.

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
 *  SAVED_VIEWS_KEY_PREFIX — see this file's own comment on that exception above. */
export function clearPersistedUiState(): void {
  for (const storage of [localStorage, sessionStorage]) {
    for (const key of Object.keys(storage)) {
      if (key.startsWith(NAMESPACE_PREFIX) && !key.startsWith(SAVED_VIEWS_KEY_PREFIX)) storage.removeItem(key);
    }
  }
  window.dispatchEvent(new Event(PERSISTED_UI_STATE_CLEARED_EVENT));
}
