import { useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { DEMO_PASSWORD, DEMO_USERNAME, useAuth } from "../lib/AuthContext.js";
import { ErrorIcon, InfoIcon, LockIcon } from "../lib/icons.js";

export function LoginPage() {
  const { isAuthenticated, login } = useAuth();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (isAuthenticated) {
    const from = (location.state as { from?: string } | null)?.from ?? "/register";
    return <Navigate to={from} replace />;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!login(username, password)) {
      setError("Incorrect username or password.");
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-[#FAFAFA]">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-sm">
        <div className="flex items-center gap-2">
          <LockIcon fontSize={22} className="text-ink" />
          <h1 className="text-lg font-bold tracking-tight text-ink">NephroAssets</h1>
        </div>
        <p className="mt-1 text-sm text-gray-500">Sign in to preview the register.</p>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1">
            <label htmlFor="login-username" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
              Username
            </label>
            <input
              id="login-username"
              type="text"
              autoFocus
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="login-password" className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
            className="w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
          >
            Sign In
          </button>
        </form>

        <p className="mt-6 flex items-start gap-1.5 rounded-md bg-accent-light px-3 py-2 text-xs text-accent-hover">
          <InfoIcon fontSize={14} className="mt-0.5 shrink-0" />
          <span>
            Demo credentials — username <strong>{DEMO_USERNAME}</strong>, password <strong>{DEMO_PASSWORD}</strong>
          </span>
        </p>
      </div>
    </div>
  );
}
