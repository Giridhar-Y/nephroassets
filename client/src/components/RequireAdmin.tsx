import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.js";

/** Layered inside RequireAuth (which already handles "not signed in" and "must change
 *  password") — this only needs to handle "signed in, but not an admin". Mirrors the
 *  server's requireAdmin preHandler (auth/middleware.ts); this is the client-side half
 *  of the same check, not a substitute for it. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== "admin") {
    return <Navigate to="/register" replace />;
  }
  return <>{children}</>;
}
