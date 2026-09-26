import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useNotifications } from "../lib/NotificationsContext.js";
import { formatRelativeTime } from "../lib/format.js";
import { BellIcon } from "../lib/icons.js";
import { clearServerNotifications, fetchServerNotifications, markServerNotificationsRead, type ServerNotification } from "../api/approvals.js";
import { TASKS_CHANGED_EVENT } from "../pages/TasksPage.js";

// Two sources, one list:
// - Server notifications (approvals: new task, returned for changes, applied, needs
//   attention) — stored per user on the server, so they follow you to any device.
// - Browser-local notices for this tab's detached jobs (Register export, bulk upload
//   finishing after you navigated away) — see NotificationsContext.
// Server ones are polled every minute and after any Tasks decision.

const KIND_DOT: Record<string, string> = {
  task: "bg-brand-blue",
  rejected: "bg-accent",
  applied: "bg-green-600",
  needs_attention: "bg-amber-500"
};

type Item =
  | { source: "server"; id: string; message: string; link: string | null; createdAt: number; kind: string }
  | { source: "local"; id: string; message: string; link?: string; linkLabel?: string; createdAt: number; kind: string };

export function NotificationsBell() {
  const { notifications, unreadCount: localUnread, markAllRead, clear } = useNotifications();
  const [server, setServer] = useState<ServerNotification[]>([]);
  const [serverUnread, setServerUnread] = useState(0);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    fetchServerNotifications()
      .then((r) => {
        setServer(r.items);
        setServerUnread(r.unread);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    window.addEventListener(TASKS_CHANGED_EVENT, refresh);
    return () => {
      clearInterval(t);
      window.removeEventListener(TASKS_CHANGED_EVENT, refresh);
    };
  }, [refresh]);

  const unreadCount = localUnread + serverUnread;
  const items: Item[] = [
    ...server.map((n) => ({ source: "server" as const, id: `s${n.id}`, message: n.message, link: n.link, createdAt: new Date(n.createdAt).getTime(), kind: n.kind })),
    ...notifications.map((n) => ({
      source: "local" as const,
      id: `l${n.id}`,
      message: n.message,
      link: n.link,
      linkLabel: n.linkLabel,
      createdAt: n.createdAt,
      kind: n.type === "error" ? "rejected" : "applied"
    }))
  ].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : "Notifications"}
        title="Notifications"
        className="relative grid h-9 w-9 shrink-0 place-items-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) {
            markAllRead();
            if (serverUnread > 0) markServerNotificationsRead().then(() => setServerUnread(0)).catch(() => {});
          }
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
          <div className="animate-panel-in absolute right-0 z-20 mt-2 w-96 rounded-lg border border-gray-200 bg-white p-2 text-left normal-case shadow-lg">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Notifications</span>
              {items.length > 0 && (
                <button
                  type="button"
                  className="text-[11px] font-medium text-accent hover:underline"
                  onClick={() => {
                    clear();
                    clearServerNotifications().then(refresh).catch(() => {});
                  }}
                >
                  Clear all
                </button>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {items.length === 0 ? (
                <p className="px-2 py-4 text-center text-xs text-gray-400">Nothing yet. Approvals, exports and bulk uploads show up here.</p>
              ) : (
                items.map((n) => (
                  <div key={n.id} className="flex items-start gap-2 rounded-md px-2 py-2 hover:bg-gray-50">
                    <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${KIND_DOT[n.kind] ?? "bg-brand-teal"}`} aria-hidden />
                    <div className="min-w-0">
                      <p className="text-xs text-ink">{n.message}</p>
                      {n.source === "server" && n.link && (
                        <Link to={n.link.replace(/^#/, "")} onClick={() => setOpen(false)} className="mt-0.5 inline-block text-xs font-semibold text-accent hover:underline">
                          Open
                        </Link>
                      )}
                      {n.source === "local" && n.link && (
                        <a href={n.link} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-block text-xs font-semibold text-accent hover:underline">
                          {n.linkLabel ?? "Download"}
                        </a>
                      )}
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
