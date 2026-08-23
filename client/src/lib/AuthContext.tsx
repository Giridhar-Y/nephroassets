import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  ApiError,
  fetchCurrentUser,
  login as apiLogin,
  logout as apiLogout,
  type AuthUser
} from "../api/client.js";

interface AuthContextValue {
  user: AuthUser | null;
  /** True only while the initial "am I signed in" check is in flight — lets
   *  RequireAuth avoid a flash of the login page for someone with a valid session. */
  loading: boolean;
  login: (username: string, password: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => Promise<void>;
  /** Re-reads /api/auth/me — used after changing a temporary password, so the
   *  session's mustChangePassword flag (read fresh from the DB by the server on every
   *  request) is reflected in the client's own state without a full page reload. */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    setUser(await fetchCurrentUser());
  }, []);

  useEffect(() => {
    refreshUser().finally(() => setLoading(false));
  }, [refreshUser]);

  // Fired by api/client.ts whenever any request comes back 401/UNAUTHENTICATED after the
  // initial check above already found a session — the session died mid-use (expired, or
  // an admin disabled the account). Clearing `user` here is what sends RequireAuth to
  // /login, instead of leaving the sidebar rendered as if still signed in while every
  // data fetch quietly fails underneath it.
  useEffect(() => {
    const onUnauthenticated = () => setUser(null);
    window.addEventListener("auth:unauthenticated", onUnauthenticated);
    return () => window.removeEventListener("auth:unauthenticated", onUnauthenticated);
  }, []);

  const login = async (username: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const { user } = await apiLogin(username, password);
      setUser(user);
      return { ok: true };
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Sign in failed. Please try again.";
      return { ok: false, error: message };
    }
  };

  const logout = async () => {
    // Best-effort: clear local state regardless of whether the request itself succeeds
    // — a network hiccup shouldn't leave the UI stuck showing a "signed in" state for
    // someone who just asked to sign out.
    try {
      await apiLogout();
    } catch {
      // ignored
    } finally {
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
