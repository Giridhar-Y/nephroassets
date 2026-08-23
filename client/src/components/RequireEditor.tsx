import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.js";

/** Layered inside RequireAuth, mirrors RequireAdmin.tsx — client-side half of the
 *  server's requireEditor preHandler (auth/middleware.ts), not a substitute for it. Guards
 *  Capitalization/Transfers/Disposals/Bulk Upload, which a viewer has no access to. */
export function RequireEditor({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.role === "viewer") {
    return <Navigate to="/register" replace />;
  }
  return <>{children}</>;
}
