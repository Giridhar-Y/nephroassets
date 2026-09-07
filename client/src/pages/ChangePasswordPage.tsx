import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ApiError, changePassword, updateProfile } from "../api/client.js";
import { useAuth } from "../lib/AuthContext.js";
import { ErrorIcon, InfoIcon, KeyIcon, PersonIcon } from "../lib/icons.js";
import { LogoSymbol, Wordmark } from "../components/Logo.js";
import { PasswordInput } from "../components/PasswordInput.js";
import { useToast } from "../components/Toast.js";

const LABEL_CLASS = "text-[11px] font-bold uppercase tracking-wide text-gray-500";
const TEXT_INPUT_CLASS =
  "rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

/** Self-service display-name editor — see server/src/routes/auth.ts's PATCH
 *  /api/auth/profile. Hidden entirely while mustChangePassword is true: that route
 *  isn't in the must-change-password allowlist (see auth/middleware.ts), so showing it
 *  here would just dead-end in a 403 before the password itself is sorted out. */
function ProfileSection() {
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
    <div>
      <p className="flex items-center gap-1.5 text-sm text-gray-500">
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

        <button
          type="submit"
          disabled={submitting || !isDirty}
          className="w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save Profile"}
        </button>
      </form>
    </div>
  );
}

export function ChangePasswordPage() {
  const { user, loading, refreshUser } = useAuth();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Can't reuse RequireAuth here — RequireAuth redirects a mustChangePassword session
  // TO this page, so wrapping this page in RequireAuth too would loop. Any signed-in
  // user (not just mustChangePassword ones) can reach this page voluntarily — it's the
  // one place discoverable from the header greeting (Layout.tsx) for managing your own
  // account, Profile and Password both. The route itself is still named
  // /change-password (not renamed to something like /account) to avoid touching the
  // mustChangePassword redirect in RequireAuth.tsx/LoginPage.tsx that already points here.
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;

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
      // Only a forced (mustChangePassword) session navigates away — this page also
      // covers Profile now, so a voluntary password change from here should land back
      // on the same page (with the just-unlocked Profile section now visible), not
      // whisk the user off to Register.
      if (user!.mustChangePassword) navigate("/register", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change your password. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-[#FAFAFA]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(1,72,111,0.06),transparent_60%)]" />
      <div className="relative w-full max-w-sm rounded-xl bg-white p-10 shadow-sm">
        <div className="flex items-center gap-2">
          <LogoSymbol size={24} />
          <h1>
            <Wordmark className="font-heading text-lg font-bold tracking-tight" />
          </h1>
        </div>
        <p className="mt-1 text-sm text-gray-500">Your Account</p>

        {user.mustChangePassword && (
          <p className="mt-3 flex items-start gap-1.5 rounded-md bg-accent-light px-3 py-2 text-xs text-accent-hover">
            <InfoIcon fontSize={14} className="mt-0.5 shrink-0" />
            <span>You're signing in with a temporary password. Set a new one to continue.</span>
          </p>
        )}

        {!user.mustChangePassword && (
          <>
            <div className="mt-6 border-t border-gray-100 pt-6">
              <ProfileSection />
            </div>
            <div className="mt-6 border-t border-gray-100" />
          </>
        )}

        <div className={user.mustChangePassword ? "mt-6 border-t border-gray-100 pt-6" : "mt-6"}>
          <p className="flex items-center gap-1.5 text-sm text-gray-500">
            <KeyIcon fontSize={16} />
            Password
          </p>
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
              <PasswordInput
                id="change-pw-confirm"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={setConfirmPassword}
              />
            </div>

            {error && (
              <p className="flex items-center gap-1.5 text-sm text-red-600">
                <ErrorIcon fontSize={15} />
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {submitting ? "Changing…" : "Change Password"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
