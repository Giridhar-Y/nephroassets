import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ApiError, changePassword } from "../api/client.js";
import { useAuth } from "../lib/AuthContext.js";
import { ErrorIcon, InfoIcon, KeyIcon } from "../lib/icons.js";
import { Logo } from "../components/Logo.js";
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
    <div className="flex h-full items-center justify-center bg-[#FAFAFA]">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-sm">
        <div className="flex items-center gap-2">
          <Logo size={26} />
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

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="change-pw-current"
              className="text-[11px] font-bold uppercase tracking-wide text-gray-500"
            >
              Current Password
            </label>
            <input
              id="change-pw-current"
              type="password"
              autoFocus
              autoComplete="current-password"
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="change-pw-new" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
              New Password
            </label>
            <input
              id="change-pw-new"
              type="password"
              autoComplete="new-password"
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="change-pw-confirm"
              className="text-[11px] font-bold uppercase tracking-wide text-gray-500"
            >
              Confirm New Password
            </label>
            <input
              id="change-pw-confirm"
              type="password"
              autoComplete="new-password"
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
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
  );
}
