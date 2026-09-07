import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { ApiError, changePassword, updateProfile } from "../api/client.js";
import { useAuth } from "../lib/AuthContext.js";
import { formatDateTime } from "../lib/format.js";
import { ErrorIcon, InfoIcon, KeyIcon, MailIcon, PersonIcon } from "../lib/icons.js";
import { LogoSymbol, Wordmark } from "../components/Logo.js";
import { PasswordInput } from "../components/PasswordInput.js";
import { InitialsAvatar } from "../components/ui/InitialsAvatar.js";
import { RoleBadge } from "../components/ui/RoleBadge.js";
import { useToast } from "../components/Toast.js";

const LABEL_CLASS = "text-[11px] font-bold uppercase tracking-wide text-gray-500";
const TEXT_INPUT_CLASS =
  "rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
// Every card on this page (identity summary, Profile, Password) shares this same
// treatment — the standard card look used throughout the app.
const CARD_CLASS = "rounded-lg border border-gray-200 bg-white p-6 shadow-sm";
// The one primary-action button shape this page uses (Save Profile, Change Password).
// Disabled gets a genuinely neutral grey, not a faded/washed-out red (bg-accent at
// disabled:opacity-50) — the earlier version of Save Profile used that opacity-50
// treatment, which reads as an odd pale-pink rather than clearly "nothing to save yet",
// easy to mistake for a rendering bug. Grey is unambiguous either way.
const PRIMARY_BUTTON_CLASS =
  "w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:bg-gray-200 disabled:text-gray-400 disabled:hover:bg-gray-200 disabled:cursor-not-allowed";

/** Avatar, name, email, role, and the two account-age/last-seen facts — the same
 *  transparency instinct as everywhere else in this app: a user can see at a glance who
 *  the system thinks they are and when they last got in (also a cheap security cue if a
 *  login time looks wrong). Pure display, no form here. */
function IdentityCard() {
  const { user } = useAuth();
  return (
    <div className={CARD_CLASS}>
      <div className="flex items-center gap-4">
        <InitialsAvatar name={user!.displayName} size="md" />
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-ink">{user!.displayName}</p>
          <p className="flex items-center gap-1.5 truncate text-sm text-gray-500">
            <MailIcon fontSize={13} />
            {user!.email}
          </p>
        </div>
        <div className="ml-auto">
          <RoleBadge role={user!.role} />
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-gray-100 pt-4 text-xs">
        <div>
          <p className="font-semibold text-gray-400">Member since</p>
          <p className="mt-0.5 text-ink">{formatDateTime(user!.createdAt)}</p>
        </div>
        <div>
          <p className="font-semibold text-gray-400">Last login</p>
          <p className="mt-0.5 text-ink">{user!.lastLoginAt ? formatDateTime(user!.lastLoginAt) : "Never"}</p>
        </div>
      </div>
    </div>
  );
}

/** Self-service display-name editor — see server/src/routes/auth.ts's PATCH
 *  /api/auth/profile. Hidden entirely while mustChangePassword is true: that route
 *  isn't in the must-change-password allowlist (see auth/middleware.ts), so showing it
 *  here would just dead-end in a 403 before the password itself is sorted out. */
function ProfileCard() {
  const { user, refreshUser } = useAuth();
  const { showToast } = useToast();
  const [displayName, setDisplayName] = useState(user!.displayName);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isDirty = displayName.trim() !== user!.displayName;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!displayName.trim()) {
      setError("Display name can't be blank.");
      return;
    }
    setSubmitting(true);
    try {
      await updateProfile(displayName.trim());
      await refreshUser();
      showToast("Profile updated.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update your profile. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={CARD_CLASS}>
      <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
        <PersonIcon fontSize={16} />
        Profile
      </p>
      <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
        <div className="flex flex-col gap-1">
          <label htmlFor="profile-display-name" className={LABEL_CLASS}>
            Display Name
          </label>
          <input
            id="profile-display-name"
            className={TEXT_INPUT_CLASS}
            maxLength={80}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <p className="text-xs text-gray-400">Shown in your greeting and anywhere else the app addresses you by name.</p>
        </div>

        {error && (
          <p className="flex items-center gap-1.5 text-sm text-red-600">
            <ErrorIcon fontSize={15} />
            {error}
          </p>
        )}

        <button type="submit" disabled={submitting || !isDirty} className={PRIMARY_BUTTON_CLASS}>
          {submitting ? "Saving…" : "Save Profile"}
        </button>
      </form>
    </div>
  );
}

function PasswordCard({ onChanged }: { onChanged: () => void }) {
  const { user, refreshUser } = useAuth();
  const { showToast } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      await refreshUser();
      showToast("Password changed.");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change your password. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={CARD_CLASS}>
      <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
        <KeyIcon fontSize={16} />
        Password
      </p>

      {user!.mustChangePassword && (
        <p className="mt-3 flex items-start gap-1.5 rounded-md bg-accent-light px-3 py-2 text-xs text-accent-hover">
          <InfoIcon fontSize={14} className="mt-0.5 shrink-0" />
          <span>You're signing in with a temporary password. Set a new one to continue.</span>
        </p>
      )}

      <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
        <div className="flex flex-col gap-1">
          <label htmlFor="change-pw-current" className={LABEL_CLASS}>
            Current Password
          </label>
          <PasswordInput
            id="change-pw-current"
            autoFocus
            autoComplete="current-password"
            value={currentPassword}
            onChange={setCurrentPassword}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="change-pw-new" className={LABEL_CLASS}>
            New Password
          </label>
          <PasswordInput id="change-pw-new" autoComplete="new-password" value={newPassword} onChange={setNewPassword} />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="change-pw-confirm" className={LABEL_CLASS}>
            Confirm New Password
          </label>
          <PasswordInput id="change-pw-confirm" autoComplete="new-password" value={confirmPassword} onChange={setConfirmPassword} />
        </div>

        {error && (
          <p className="flex items-center gap-1.5 text-sm text-red-600">
            <ErrorIcon fontSize={15} />
            {error}
          </p>
        )}

        <button type="submit" disabled={submitting} className={PRIMARY_BUTTON_CLASS}>
          {submitting ? "Changing…" : "Change Password"}
        </button>
      </form>
    </div>
  );
}

export function AccountPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  // Can't reuse RequireAuth here — RequireAuth redirects a mustChangePassword session TO
  // this page, so wrapping this page in RequireAuth too would loop. Any signed-in user
  // (not just mustChangePassword ones) can reach this page voluntarily — via the header's
  // UserMenu avatar or the greeting, both in Layout.tsx. Standalone (not nested inside
  // Layout/the sidebar) specifically so a mustChangePassword session — which can't reach
  // Layout at all, see RequireAuth's own redirect — can still land here.
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="h-full overflow-auto bg-[#FAFAFA]">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Link to="/register" className="flex items-center gap-2">
          <LogoSymbol size={24} />
          <Wordmark className="font-heading text-lg font-bold tracking-tight" />
        </Link>
        <p className="mt-1 text-sm text-gray-500">Your Account</p>

        <div className="mt-6 space-y-4">
          <IdentityCard />
          {!user.mustChangePassword && <ProfileCard />}
          {/* Only a forced (mustChangePassword) session navigates away on success — this
              page also covers Profile now, so a voluntary password change from here
              should land back on the same page (with the just-unlocked Profile card now
              visible), not whisk the user off to Register. */}
          <PasswordCard onChanged={() => user.mustChangePassword && navigate("/register", { replace: true })} />
        </div>
      </div>
    </div>
  );
}
