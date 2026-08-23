import { useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.js";
import { ErrorIcon } from "../lib/icons.js";
import { Logo } from "../components/Logo.js";
import { PasswordInput } from "../components/PasswordInput.js";

export function LoginPage() {
  const { user, login } = useAuth();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) {
    if (user.mustChangePassword) return <Navigate to="/change-password" replace />;
    const from = (location.state as { from?: string } | null)?.from ?? "/register";
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await login(username, password);
    if (!result.ok) setError(result.error);
    setSubmitting(false);
  }

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-[#FAFAFA]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(24,24,27,0.06),transparent_60%)]" />
      <div className="relative w-full max-w-sm rounded-xl bg-white p-10 shadow-sm">
        <div className="flex items-center gap-2">
          <Logo size={24} />
          <h1 className="text-lg font-bold tracking-tight text-ink">NephroAssets</h1>
        </div>
        <p className="mt-1 text-sm text-gray-500">Sign in to your account.</p>

        <div className="mt-6 border-t border-gray-100 pt-6">
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-1">
              <label htmlFor="login-username" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                Username
              </label>
              <input
                id="login-username"
                type="text"
                autoFocus
                autoComplete="username"
                className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="login-password" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                Password
              </label>
              <PasswordInput id="login-password" autoComplete="current-password" value={password} onChange={setPassword} />
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
              {submitting ? "Signing in…" : "Sign In"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
