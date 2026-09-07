import { useState } from "react";
import { useNotifications } from "../lib/NotificationsContext.js";
import { formatRelativeTime } from "../lib/format.js";
import { BellIcon } from "../lib/icons.js";

// Wired to the two genuinely async-and-detachable operations found in this app today:
// Register Export (assetsExport.ts streams a large CSV — up to ~18s for a big filtered
// view, see useExport.ts) and Bulk Upload (client-driven chunked commit loop,
// api/client.ts's commitBulkUploadChunked). Both already keep running to completion via
// a plain fetch/async-function chain even if the page that started them unmounts (no
// AbortController tied to component lifecycle) — today the ONLY sign either one
// finished is a toast, which is easy to miss if you've already navigated away. This
// bell doesn't add a new background-job system; it just gives those two existing,
// already-detached operations a persistent record instead of a transient one.
//
// Nothing else in the app currently runs detached from its own request/response cycle
// — no depreciation run, no job queue, no websocket/SSE. If a real background job
// system gets added later, it plugs into the same addNotification() call these two use.
export function NotificationsBell() {
  const { notifications, unreadCount, markAllRead, clear } = useNotifications();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : "Notifications"}
        title="Notifications"
        className="relative grid h-9 w-9 shrink-0 place-items-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) markAllRead();
        }}
      >
        <BellIcon fontSize={18} />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold leading-none text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-gray-200 bg-white p-2 text-left normal-case shadow-lg">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Notifications</span>
              {notifications.length > 0 && (
                <button type="button" className="text-[11px] font-medium text-accent hover:underline" onClick={clear}>
                  Clear all
                </button>
              )}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="px-2 py-4 text-center text-xs text-gray-400">Nothing yet — exports and bulk uploads will show up here.</p>
              ) : (
                notifications.map((n) => (
                  <div key={n.id} className="flex items-start gap-2 rounded-md px-2 py-2 hover:bg-gray-50">
                    <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${n.type === "error" ? "bg-accent" : "bg-brand-teal"}`} />
                    <div className="min-w-0">
                      <p className="text-xs text-ink">{n.message}</p>
                      <p className="mt-0.5 text-[10px] text-gray-400">{formatRelativeTime(n.createdAt)}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
