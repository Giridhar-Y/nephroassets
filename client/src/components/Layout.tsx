import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useState, type ComponentType } from "react";
import { useSettings } from "../lib/SettingsContext.js";
import { useAuth } from "../lib/AuthContext.js";
import {
  RegisterIcon,
  LocationIcon,
  ReconciliationIcon,
  DepreciationIcon,
  SettingsIcon,
  SignOutIcon,
  CalendarIcon
} from "../lib/icons.js";
import type { FluentIconsProps } from "@fluentui/react-icons";

const NAV_ITEMS: Array<{ to: string; label: string; icon: ComponentType<FluentIconsProps> }> = [
  { to: "/register", label: "Register", icon: RegisterIcon },
  { to: "/location-summary", label: "Location Summary", icon: LocationIcon },
  { to: "/audit-reconciliation", label: "Audit Reconciliation", icon: ReconciliationIcon },
  { to: "/depreciation-posting", label: "Depreciation", icon: DepreciationIcon },
  { to: "/settings", label: "Settings", icon: SettingsIcon }
];

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
  const { logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-gray-200 bg-white">
        <div className="px-5 py-5">
          <span className="text-lg font-bold tracking-tight text-ink">NephroAssets</span>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? "bg-accent-light text-accent-hover" : "text-gray-600 hover:bg-gray-50"
                }`
              }
            >
              <item.icon fontSize={18} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-gray-100 px-3 py-3">
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700"
            onClick={() => {
              logout();
              navigate("/login", { replace: true });
            }}
          >
            <SignOutIcon fontSize={18} />
            Sign Out
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-end border-b border-gray-200 bg-white px-6 py-3">
          <AsAtControl />
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
