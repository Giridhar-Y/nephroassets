import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { createContext, useContext, useEffect, useRef, useState, type ComponentType, type Dispatch, type SetStateAction } from "react";
import { useSettings } from "../lib/SettingsContext.js";
import { useAuth } from "../lib/AuthContext.js";
import { hasPermission, type Module } from "../lib/permissions.js";
import { formatCompactIndianCount, formatDate } from "../lib/format.js";
import { useToast } from "./Toast.js";
import { NotificationsBell } from "./NotificationsBell.js";
import { LogoSymbol, Wordmark } from "./Logo.js";
import { InstallAppButton } from "./InstallAppButton.js";
import { IosInstallHint } from "./IosInstallHint.js";
import { OfflineBanner } from "./OfflineBanner.js";
import {
  DashboardIcon,
  RegisterIcon,
  SettingsIcon,
  SignOutIcon,
  CalendarIcon,
  HistoryIcon,
  AddCircleIcon,
  AdditionIcon,
  DeleteIcon,
  ReportsIcon,
  UploadIcon,
  LifecycleIcon,
  PanelCollapseIcon,
  PanelExpandIcon,
  BookDatabaseIcon,
  AdminIcon,
  AuditLogIcon
} from "../lib/icons.js";
import type { FluentIconsProps } from "@fluentui/react-icons";

const SIDEBAR_COLLAPSED_KEY = "nephroassets.sidebarCollapsed";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<FluentIconsProps>;
  module: Module;
  action?: string;
  /** Bulk Upload only — see RequirePermission's own comment on why it has no single
   *  umbrella permission. */
  anyOf?: string[];
}

// Each item's module/action is the client-side mirror of exactly what its route
// requires (see App.tsx's RequirePermission usage) — nav visibility and route
// reachability always agree because they read the same permission set.
const NAV_ITEMS: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: DashboardIcon, module: "reports", action: "view" },
  { to: "/register", label: "Register", icon: RegisterIcon, module: "register", action: "view" },
  { to: "/assets", label: "Asset History", icon: LifecycleIcon, module: "assetHistory", action: "view" },
  { to: "/transfers", label: "Transfers", icon: HistoryIcon, module: "transfers", action: "view" },
  { to: "/capitalization", label: "Capitalization", icon: AddCircleIcon, module: "capitalization", action: "view" },
  { to: "/additions", label: "Additions", icon: AdditionIcon, module: "additions", action: "view" },
  { to: "/disposals", label: "Disposals", icon: DeleteIcon, module: "disposals", action: "view" },
  {
    to: "/bulk-upload",
    label: "Bulk Upload",
    icon: UploadIcon,
    module: "bulkUpload",
    anyOf: ["capitalization", "transfers", "disposals", "merge"]
  },
  { to: "/reports", label: "Reports", icon: ReportsIcon, module: "reports", action: "view" },
  { to: "/activity-log", label: "Activity Log", icon: AuditLogIcon, module: "activityLog", action: "view" },
  { to: "/masters", label: "Masters", icon: BookDatabaseIcon, module: "masters", action: "view" },
  { to: "/settings", label: "Settings", icon: SettingsIcon, module: "settings", action: "view" }
];

const ADMIN_NAV_ITEM: NavItem = { to: "/admin", label: "Admin", icon: AdminIcon, module: "admin", action: "view" };

// Register publishes its own live "how many assets match the current view" count up
// into the global header (next to Figures As Of) via this context — the header itself
// has no idea what page it's on, and Register's count depends on state (filters, AS_AT)
// that only RegisterPage has, so a context is the plumbing that lets one page's number
// show up in a shared layout without those other pages knowing anything about Register.
// null = nothing published (every page but Register), so the badge renders nothing.
const RegisterAssetCountContext = createContext<Dispatch<SetStateAction<number | null>>>(() => {});

/** Register's total (see useAssetList's own `total` — already the exact count for the
 *  current filters/AS_AT, no extra query) — call with that value on every render; it's
 *  cleared automatically on unmount so navigating away from Register doesn't leave a
 *  stale count showing on some other page. */
export function useSetRegisterAssetCount(count: number | null): void {
  const setCount = useContext(RegisterAssetCountContext);
  useEffect(() => {
    setCount(count);
    return () => setCount(null);
  }, [count, setCount]);
}

const LAST_GREETED_DATE_KEY = "nephroassets.lastGreetedDate";

/** Pure decision logic, pulled out of useGreeting below purely so it's directly
 *  unit-testable without mounting a component or mocking Date/localStorage — see
 *  Layout.greeting.test.ts. `isReturnVisit` is whether today's date already matches
 *  LAST_GREETED_DATE_KEY; `hour` is 0-23 local time. */
export function formatGreeting(displayName: string, hour: number, isReturnVisit: boolean): string {
  if (isReturnVisit) return `Welcome back, ${displayName}`;
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return `Good ${timeOfDay}, ${displayName}`;
}

/** "Good morning, X" the first time the app loads today; "Welcome back, X" on any later
 *  load the same day (a reload, or leaving and coming back) so it doesn't read as a
 *  static label. Computed once per mount (the ref guard), not recomputed if
 *  `displayName` itself changes later in the same session (e.g. right after saving a
 *  new one on the Profile page) — the greeting is a "how's your day going" moment, not
 *  a live-bound label that should flicker back to the time-of-day phrasing mid-session.
 *  localStorage, not sessionStorage: swept on logout same as everything else under the
 *  nephroassets.* prefix (persistedUiState.ts), so a same-day re-login starts fresh with
 *  the fuller greeting rather than "welcome back" for what's genuinely a new sign-in. */
function useGreeting(displayName: string | undefined): string | null {
  const [greeting, setGreeting] = useState<string | null>(null);
  const computed = useRef(false);

  useEffect(() => {
    if (!displayName || computed.current) return;
    computed.current = true;
    const today = new Date().toISOString().slice(0, 10);
    const isReturnVisit = localStorage.getItem(LAST_GREETED_DATE_KEY) === today;
    localStorage.setItem(LAST_GREETED_DATE_KEY, today);
    setGreeting(formatGreeting(displayName, new Date().getHours(), isReturnVisit));
  }, [displayName]);

  return greeting;
}

/** Links to the same Profile section Change Password already lives on (ChangePasswordPage.tsx)
 *  — the one discoverable place a signed-in user manages their own account, per that
 *  page's own comment on why the route stays named /change-password. */
function Greeting() {
  const { user } = useAuth();
  const greeting = useGreeting(user?.displayName);
  if (!greeting) return null;
  return (
    <Link to="/change-password" className="text-sm font-medium text-white hover:underline" title="Manage your profile">
      {greeting}
    </Link>
  );
}

function AsAtControl() {
  const { settings, setAsAt, loading, notConfigured, error } = useSettings();
  const { showToast } = useToast();
  const [pending, setPending] = useState(false);

  if (loading) {
    return <div className="h-9 w-64 animate-pulse rounded-md bg-white/10" />;
  }

  if (notConfigured || !settings) {
    return (
      <Link to="/settings" className="text-sm font-medium text-white underline decoration-white/40 underline-offset-2 hover:decoration-white">
        Set up your financial year →
      </Link>
    );
  }

  if (error) {
    return <span className="text-sm text-brand-rose">Couldn't load settings.</span>;
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="flex items-center gap-1.5 font-medium text-white/80">
        <CalendarIcon fontSize={16} />
        Figures as of:
      </span>
      <input
        type="date"
        data-testid="asat-input"
        className="rounded-md border border-white/20 bg-white/10 px-2 py-1.5 text-sm text-white [color-scheme:dark] focus:border-white/50 focus:outline-none focus:ring-1 focus:ring-white/50"
        value={settings.asAt}
        min={settings.fyStart}
        max={settings.fyEnd}
        disabled={pending}
        onChange={async (e) => {
          const value = e.target.value;
          if (!value) return;
          setPending(true);
          try {
            await setAsAt(value);
            // Recalculates every figure on every visible row — worth a toast, not just
            // the inline "Recalculating…" text below, since the table itself is
            // typically scrolled out of view from this control at the top of the page.
            showToast(`Figures recalculated as of ${formatDate(value)}.`);
          } catch {
            showToast("Couldn't change Figures As Of. Please try again.", "error");
          } finally {
            setPending(false);
          }
        }}
      />
      {pending && <span className="text-xs text-white/60">Recalculating…</span>}
    </label>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
  const [registerAssetCount, setRegisterAssetCount] = useState<number | null>(null);
  const isVisible = (item: NavItem) =>
    item.anyOf ? item.anyOf.some((a) => hasPermission(user, item.module, a)) : hasPermission(user, item.module, item.action!);
  const navItems = [...NAV_ITEMS, ADMIN_NAV_ITEM].filter(isVisible);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  return (
    <div className="flex h-full print:block print:h-auto">
      <aside
        className={`flex shrink-0 flex-col border-r border-gray-200 bg-white transition-[width] print:hidden ${
          collapsed ? "w-14" : "w-60"
        }`}
      >
        <div className={`flex items-center py-5 ${collapsed ? "justify-center px-2" : "justify-between px-5"}`}>
          {!collapsed && (
            <span className="flex items-center gap-2">
              <LogoSymbol size={26} />
              <Wordmark className="font-heading text-lg font-bold tracking-tight" />
            </span>
          )}
          <button
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed((c) => !c)}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-ink"
          >
            {collapsed ? <PanelExpandIcon fontSize={18} /> : <PanelCollapseIcon fontSize={18} />}
          </button>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  collapsed ? "justify-center px-0" : ""
                } ${isActive ? "bg-accent-light text-accent-hover" : "text-gray-600 hover:bg-gray-50"}`
              }
            >
              <item.icon fontSize={collapsed ? 20 : 18} />
              {!collapsed && item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-gray-100 px-3 py-3">
          <button
            type="button"
            title={collapsed ? "Sign Out" : undefined}
            className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700 ${
              collapsed ? "justify-center px-0" : ""
            }`}
            onClick={async () => {
              await logout();
              navigate("/login", { replace: true });
            }}
          >
            <SignOutIcon fontSize={collapsed ? 20 : 18} />
            {!collapsed && "Sign Out"}
          </button>
        </div>
      </aside>
      <RegisterAssetCountContext.Provider value={setRegisterAssetCount}>
        <div className="flex min-w-0 flex-1 flex-col print:block">
          <OfflineBanner />
          <header className="flex shrink-0 items-center justify-end gap-4 bg-ink px-6 py-3 print:hidden">
            {/* mr-auto on a wrapper (not InstallAppButton's own root, which is null most of
                the time) — pushes everything in it to the far left, while an empty
                wrapper still keeps everything else pinned right via justify-end otherwise. */}
            <div className="mr-auto flex items-center gap-4">
              <Greeting />
              <InstallAppButton />
            </div>
            {registerAssetCount !== null && (
              <span className="text-sm text-white/80">
                <span className="font-semibold text-white">{formatCompactIndianCount(registerAssetCount)}</span> assets loaded
              </span>
            )}
            <AsAtControl />
            <NotificationsBell />
          </header>
          <main className="min-h-0 flex-1 overflow-hidden print:h-auto print:overflow-visible">
            <Outlet />
          </main>
        </div>
      </RegisterAssetCountContext.Provider>
      <IosInstallHint />
    </div>
  );
}
