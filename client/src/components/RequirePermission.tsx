import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.js";
import { hasPermission, type Module } from "../lib/permissions.js";

/** Layered inside RequireAuth — client-side mirror of the server's requirePermission
 *  preHandler, not a substitute for it (the server enforces this regardless of what the
 *  client renders). Replaces the old role-based RequireEditor/RequireAdmin — every route
 *  guard in this app now reads the user's actual permission set.
 *
 *  `action` is the common case (one route, one permission). `anyOf` is for Bulk Upload
 *  specifically — it has four sub-actions (capitalization/transfers/disposals/merge) and
 *  no single umbrella one, so the route itself is reachable with any single one of them,
 *  same coarse one-unit gate the old EDITOR_ONLY_PATHS gave it (nothing inside the page
 *  had its own finer-grained check before, so none is added here either). */
export function RequirePermission({
  module,
  action,
  anyOf,
  children
}: {
  module: Module;
  action?: string;
  anyOf?: string[];
  children: ReactNode;
}) {
  const { user } = useAuth();
  const allowed = anyOf ? anyOf.some((a) => hasPermission(user, module, a)) : hasPermission(user, module, action!);
  if (!allowed) {
    return <Navigate to="/register" replace />;
  }
  return <>{children}</>;
}
