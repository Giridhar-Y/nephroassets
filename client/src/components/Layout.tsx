import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useEffect, useState, type ComponentType } from "react";
import { useSettings } from "../lib/SettingsContext.js";
import { useAuth } from "../lib/AuthContext.js";
import { Logo } from "./Logo.js";
import {
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

const NAV_ITEMS: Array<{ to: string; label: string; icon: ComponentType<FluentIconsProps> }> = [
  { to: "/register", label: "Register", icon: RegisterIcon },
  { to: "/assets", label: "Asset History", icon: LifecycleIcon },
  { to: "/transfers", label: "Transfers", icon: HistoryIcon },
  { to: "/capitalization", label: "Capitalization", icon: AddCircleIcon },
  { to: "/additions", label: "Additions", icon: AdditionIcon },
  { to: "/disposals", label: "Disposals", icon: DeleteIcon },
  { to: "/bulk-upload", label: "Bulk Upload", icon: UploadIcon },
  { to: "/reports", label: "Reports", icon: ReportsIcon },
  { to: "/masters", label: "Masters", icon: BookDatabaseIcon },
  { to: "/settings", label: "Settings", icon: SettingsIcon }
];

const ADMIN_NAV_ITEM = { to: "/admin", label: "Admin", icon: AdminIcon };
const DELETE_LOG_NAV_ITEM = { to: "/delete-log", label: "Delete Log", icon: AuditLogIcon };

// Editor-only screens — a viewer has no access to these at all (server-enforced by
// requireEditor on their API routes; this is just the client-side nav/UX mirror).
const EDITOR_ONLY_PATHS = new Set(["/transfers", "/capitalization", "/additions", "/disposals", "/bulk-upload"]);

function AsAtControl() {
  const { settings, setAsAt, loading, notConfigured, error } = useSettings();
  const [pending, setPending] = useState(false);

  if (loading) {
    return <div className="h-9 w-64 animate-pulse rounded-md bg-gray-100" />;
  }

  if (notConfigured || !settings) {
    return (
      <Link to="/settings" className="text-sm font-medium text-accent hover:underline">
        Set up your financial year →
      </Link>
    );
  }

  if (error) {
    return <span className="text-sm text-red-600">Couldn't load settings.</span>;
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="flex items-center gap-1.5 font-medium text-gray-600">
        <CalendarIcon fontSize={16} />
        Figures as of:
      </span>
      <input
        type="date"
        data-testid="asat-input"
        className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
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
          } finally {
            setPending(false);
          }
        }}
      />
      {pending && <span className="text-xs text-gray-400">Recalculating…</span>}
    </label>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
  const visibleItems =
    user?.role === "viewer" ? NAV_ITEMS.filter((item) => !EDITOR_ONLY_PATHS.has(item.to)) : NAV_ITEMS;
  const navItems = user?.role === "admin" ? [...visibleItems, DELETE_LOG_NAV_ITEM, ADMIN_NAV_ITEM] : visibleItems;

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  return (
    <div className="flex h-full">
      <aside
        className={`flex shrink-0 flex-col border-r border-gray-200 bg-white transition-[width] print:hidden ${
          collapsed ? "w-14" : "w-60"
        }`}
      >
        <div className={`flex items-center py-5 ${collapsed ? "justify-center px-2" : "justify-between px-5"}`}>
          {!collapsed && (
            <span className="flex items-center gap-2">
              <Logo size={24} />
              <span className="text-lg font-bold tracking-tight text-ink">NephroAssets</span>
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
              <item.icon fontSize={18} />
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
            <SignOutIcon fontSize={18} />
            {!collapsed && "Sign Out"}
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-end border-b border-gray-200 bg-white px-6 py-3 print:hidden">
          <AsAtControl />
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
