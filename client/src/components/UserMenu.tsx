import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.js";
import { InitialsAvatar } from "./ui/InitialsAvatar.js";
import { RoleBadge } from "./ui/RoleBadge.js";

// The persistent entry point back to /account — before this, the only way to reach it
// was the forced-first-login redirect (RequireAuth.tsx/LoginPage.tsx), so a user past
// that first login had no way back to edit their display name or password at all. Same
// dropdown pattern as NotificationsBell.tsx (fixed-inset click-outside overlay).
export function UserMenu() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  if (!user) return null;

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
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-gray-200 bg-white p-2 text-left normal-case shadow-lg">
            <div className="flex items-center gap-3 px-2 py-2">
              <InitialsAvatar name={user.displayName} size="md" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{user.displayName}</p>
                <p className="truncate text-xs text-gray-500">{user.email}</p>
              </div>
            </div>
            <div className="px-2 pb-2">
              <RoleBadge role={user.role} />
            </div>
            <Link
              to="/account"
              className="block rounded-md border-t border-gray-100 px-2 py-2 text-sm font-medium text-ink hover:bg-gray-50"
              onClick={() => setOpen(false)}
            >
              Account
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
