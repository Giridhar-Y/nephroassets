import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.js";
import { hasPermission } from "../lib/permissions.js";
import { InitialsAvatar } from "./ui/InitialsAvatar.js";
import { RoleBadge } from "./ui/RoleBadge.js";
import { AdminIcon, PersonIcon, SettingsIcon, SignOutIcon } from "../lib/icons.js";

const NAV_LINK_CLASS =
  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100";

/** The persistent entry point back to /account — before this, the only way to reach it
 *  was the forced-first-login redirect (RequireAuth.tsx/LoginPage.tsx), so a user past
 *  that first login had no way back to edit their display name or password at all. Same
 *  dropdown pattern as NotificationsBell.tsx (fixed-inset click-outside overlay).
 *
 *  This is now the ONLY place Sign Out lives (the sidebar's own button was removed,
 *  Layout.tsx) — a single authoritative account menu rather than two. Deliberately its
 *  own slate/sky/emerald palette rather than the app's usual ink/accent/gray tokens —
 *  this panel is a self-contained "account card", not part of the page chrome it sits
 *  above, and reads as more clearly a distinct enterprise-SaaS-style overlay for it. */
export function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (!user) return null;

  function close() {
    setOpen(false);
  }

  async function handleSignOut() {
    close();
    await logout();
    navigate("/login", { replace: true });
  }

  const centerScopeText =
    user.centerAccess === null
      ? "All Centers (Unrestricted)"
      : `${user.centerAccess.length} Center${user.centerAccess.length === 1 ? "" : "s"} Assigned`;

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`Account menu for ${user.displayName}`}
        title={user.displayName}
        className="rounded-full ring-white/40 hover:ring-2"
        onClick={() => setOpen((o) => !o)}
      >
        <InitialsAvatar name={user.displayName} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div
            className="absolute right-0 z-50 mt-2 w-72 origin-top-right rounded-2xl border border-slate-200/90 bg-white p-3 text-left text-slate-800 normal-case shadow-xl [animation:chip-in_120ms_ease-out]"
          >
            <div className="mb-2 flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/75 p-2.5">
              <InitialsAvatar name={user.displayName} size="md" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold leading-tight text-slate-900">{user.displayName}</p>
                <p className="max-w-[170px] truncate text-xs text-slate-500" title={user.email}>
                  {user.email}
                </p>
                <div className="mt-1">
                  <RoleBadge role={user.role} />
                </div>
              </div>
            </div>

            <div className="space-y-1.5 px-1 py-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Organization</span>
                <span className="font-medium text-slate-700">NephroPlus Health Services</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Center Scope</span>
                <span className="font-medium text-slate-700">{centerScopeText}</span>
              </div>
              <div className="flex items-center gap-1.5 rounded-md bg-emerald-50/60 px-2 py-1 text-[11px] font-medium text-emerald-600">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                Active Session • 30m Auto-Lock
              </div>
            </div>

            <div className="my-1.5 border-t border-slate-100" />

            <Link to="/account" className={NAV_LINK_CLASS} onClick={close}>
              <PersonIcon fontSize={16} />
              Account
            </Link>
            <Link to="/settings" className={NAV_LINK_CLASS} onClick={close}>
              <SettingsIcon fontSize={16} />
              Settings
            </Link>
            {hasPermission(user, "admin", "view") && (
              <Link to="/admin" className={NAV_LINK_CLASS} onClick={close}>
                <AdminIcon fontSize={16} />
                User Management
              </Link>
            )}

            <div className="my-1.5 border-t border-slate-100" />

            <button
              type="button"
              onClick={handleSignOut}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-rose-600 transition-colors hover:bg-rose-50"
            >
              <SignOutIcon fontSize={16} />
              Sign Out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
