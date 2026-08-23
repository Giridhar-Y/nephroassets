// Every client-only UI preference this app persists (filters, column layout, sidebar
// collapsed state, and anything added later) is namespaced under this prefix by
// convention. Clearing by prefix means a screen that persists its own UI state later
// participates automatically just by following the convention — logout doesn't need to
// be taught about it by name.
const NAMESPACE_PREFIX = "nephroassets.";

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
 *  this is client-only display state, scoped by convention, not by account. */
export function clearPersistedUiState(): void {
  for (const storage of [localStorage, sessionStorage]) {
    for (const key of Object.keys(storage)) {
      if (key.startsWith(NAMESPACE_PREFIX)) storage.removeItem(key);
    }
  }
  window.dispatchEvent(new Event(PERSISTED_UI_STATE_CLEARED_EVENT));
}
