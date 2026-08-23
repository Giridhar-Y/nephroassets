import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.js";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Avoid a flash of the login page while the initial /api/auth/me check is still in
  // flight — someone with a valid session shouldn't see it at all.
  if (loading) return null;

  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  // Server-side, every other route already 403s a mustChangePassword session (see
  // auth/middleware.ts) — this mirrors that on the client so the app doesn't render a
  // page that's just going to fail its first data fetch.
  if (user.mustChangePassword) {
    return <Navigate to="/change-password" replace />;
  }
  return <>{children}</>;
}
