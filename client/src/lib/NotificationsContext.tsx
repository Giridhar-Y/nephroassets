import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { PERSISTED_UI_STATE_CLEARED_EVENT } from "./persistedUiState.js";

const STORAGE_KEY = "nephroassets.notifications";
// A bounded log, not a full history — this is "what happened recently that you might
// have missed", not an audit trail (Activity Log already covers that server-side,
// permanently, per-asset). Oldest entries just fall off once this many accumulate.
const MAX_NOTIFICATIONS = 50;

export interface AppNotification {
  id: string;
  message: string;
  type: "success" | "error";
  createdAt: number;
  read: boolean;
  /** A clickable follow-up action (e.g. a signed download URL for a completed background
   *  export) — optional, and rendered as a small link by NotificationsBell.tsx below the
   *  message. Most notifications have none. */
  link?: string;
  linkLabel?: string;
}

function load(): AppNotification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AppNotification[]) : [];
  } catch {
    return [];
  }
}

interface NotificationsContextValue {
  notifications: AppNotification[];
  unreadCount: number;
  /** Records a notification for an operation that genuinely runs detached from the page
   *  that started it — see NotificationsBell.tsx's own comment for which operations
   *  qualify and why. Not a generic toast replacement: most user actions already get
   *  immediate on-screen feedback and don't belong here too. */
  addNotification: (message: string, type?: "success" | "error", opts?: { link?: string; linkLabel?: string }) => void;
  markAllRead: () => void;
  clear: () => void;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

// Mounted at the app root (App.tsx, alongside ToastProvider) so it's available to any
// page and survives navigation — an export or bulk upload started on one page and
// finishing after the user has already moved to another still needs somewhere to land.
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>(load);

  // No notifications stores no key at all, rather than an empty `[]` — otherwise the
  // logout sweep below (persistedUiState.ts) removing this key would be immediately
  // undone by this same effect re-running for the very state change (setNotifications([]))
  // the sweep's own PERSISTED_UI_STATE_CLEARED_EVENT listener causes, leaving a
  // harmless-but-misleading key behind right after a clear that's supposed to remove it —
  // same reasoning FiltersContext.tsx's identical empty-check already follows.
  useEffect(() => {
    if (notifications.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
  }, [notifications]);

  // Same logout-sweep participation as FiltersContext — persistedUiState.ts clears the
  // localStorage key by prefix, but this component's own in-memory state needs telling
  // separately since (like FiltersContext) it's mounted above the route switch and
  // doesn't unmount on logout.
  useEffect(() => {
    const onCleared = () => setNotifications([]);
    window.addEventListener(PERSISTED_UI_STATE_CLEARED_EVENT, onCleared);
    return () => window.removeEventListener(PERSISTED_UI_STATE_CLEARED_EVENT, onCleared);
  }, []);

  const addNotification: NotificationsContextValue["addNotification"] = (message, type = "success", opts) => {
    setNotifications((prev) =>
      [
        { id: crypto.randomUUID(), message, type, createdAt: Date.now(), read: false, link: opts?.link, linkLabel: opts?.linkLabel },
        ...prev
      ].slice(0, MAX_NOTIFICATIONS)
    );
  };

  const markAllRead = () => setNotifications((prev) => (prev.some((n) => !n.read) ? prev.map((n) => ({ ...n, read: true })) : prev));
  const clear = () => setNotifications([]);
  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationsContext.Provider value={{ notifications, unreadCount, addNotification, markAllRead, clear }}>
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used within NotificationsProvider");
  return ctx;
}
