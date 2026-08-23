import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ApiError, changePassword } from "../api/client.js";
import { useAuth } from "../lib/AuthContext.js";
import { ErrorIcon, InfoIcon, KeyIcon } from "../lib/icons.js";
import { Logo } from "../components/Logo.js";
import { PasswordInput } from "../components/PasswordInput.js";
import { useToast } from "../components/Toast.js";

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
  // user (not just mustChangePassword ones) can reach this page voluntarily.
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
      navigate("/register", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change your password. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-[#FAFAFA]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(24,24,27,0.06),transparent_60%)]" />
      <div className="relative w-full max-w-sm rounded-xl bg-white p-10 shadow-sm">
        <div className="flex items-center gap-2">
          <Logo size={24} />
          <h1 className="text-lg font-bold tracking-tight text-ink">NephroAssets</h1>
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-gray-500">
          <KeyIcon fontSize={16} />
          Change your password
        </p>

        {user?.mustChangePassword && (
          <p className="mt-3 flex items-start gap-1.5 rounded-md bg-accent-light px-3 py-2 text-xs text-accent-hover">
            <InfoIcon fontSize={14} className="mt-0.5 shrink-0" />
            <span>You're signing in with a temporary password. Set a new one to continue.</span>
          </p>
        )}

        <div className="mt-6 border-t border-gray-100 pt-6">
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-1">
              <label
                htmlFor="change-pw-current"
                className="text-[11px] font-bold uppercase tracking-wide text-gray-500"
              >
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
              <label htmlFor="change-pw-new" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                New Password
              </label>
              <PasswordInput id="change-pw-new" autoComplete="new-password" value={newPassword} onChange={setNewPassword} />
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="change-pw-confirm"
                className="text-[11px] font-bold uppercase tracking-wide text-gray-500"
              >
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
