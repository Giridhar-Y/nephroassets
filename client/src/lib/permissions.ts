import type { AuthUser } from "../api/client.js";

// Client-side mirror of server/src/auth/permissions.ts's PERMISSION_REGISTRY — kept in
// sync by hand, same convention this app already uses for Role (duplicated here and in
// AdminPage.tsx's ROLE_LABELS) since this registry only changes on a developer's own
// deploy, never at runtime. The server is the actual enforcement; this copy only drives
// the Permissions panel's checkbox grid and nav/route visibility.
export const PERMISSION_REGISTRY = {
  register: ["view", "edit", "export"],
  assetHistory: ["view"],
  transfers: ["view", "create", "delete"],
  capitalization: ["view", "create", "delete"],
  additions: ["view", "create", "undo"],
  disposals: ["view", "create", "undo"],
  bulkUpload: ["capitalization", "transfers", "disposals", "merge"],
  reports: ["view", "export"],
  activityLog: ["view", "export"],
  masters: ["view", "edit"],
  settings: ["view", "edit"],
  admin: ["view", "create", "edit", "resetPassword", "managePermissions"]
} as const;

export type Module = keyof typeof PERMISSION_REGISTRY;

// Registry order, once — the Permissions matrix (per-user panel, Roles master) renders
// its module groups in this order; both call sites share this instead of each
// re-deriving Object.keys(PERMISSION_REGISTRY) themselves.
export const MODULES = Object.keys(PERMISSION_REGISTRY) as Module[];

export const MODULE_LABELS: Record<Module, string> = {
  register: "Register",
  assetHistory: "Asset History",
  transfers: "Transfers",
  capitalization: "Capitalization",
  additions: "Additions",
  disposals: "Disposals",
  bulkUpload: "Bulk Upload",
  reports: "Reports",
  activityLog: "Activity Log",
  masters: "Masters",
  settings: "Settings",
  admin: "Admin"
};

const ACTION_LABELS: Record<string, string> = {
  view: "View",
  create: "Create",
  edit: "Edit",
  delete: "Delete",
  export: "Export",
  undo: "Undo",
  resetPassword: "Reset Password",
  managePermissions: "Manage Permissions",
  // Bulk Upload's own actions are named after what they bulk-upload, not a verb.
  capitalization: "Capitalization",
  transfers: "Transfers",
  disposals: "Disposals",
  merge: "Merge"
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** The one function every nav-visibility/button-gating check in the app should use —
 *  reads the user's actual permission set (fetched once at login, see AuthContext),
 *  never `role`. `user` may be null (not signed in yet) for call-site convenience. */
export function hasPermission(user: AuthUser | null, module: Module, action: string): boolean {
  return !!user?.permissions.includes(`${module}:${action}`);
}
