import type { AuthUser, Role } from "../api/client.js";

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
  activityLog: ["view"],
  masters: ["view", "edit"],
  settings: ["view", "edit"],
  admin: ["view", "create", "edit", "resetPassword", "managePermissions"]
} as const;

export type Module = keyof typeof PERMISSION_REGISTRY;

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

function grants<M extends Module>(module: M, ...actions: Array<(typeof PERMISSION_REGISTRY)[M][number]>) {
  return actions.map((action) => ({ module: module as string, action: action as string }));
}

// Mirrors server/src/auth/permissions.ts's ROLE_TEMPLATES exactly — used only for the
// Permissions panel's "Reset to [role] template" button, a local preview/bulk-apply, not
// a second source of truth for enforcement (the server computes and stores the real
// thing at user-creation time).
export const ROLE_TEMPLATES: Record<Role, Array<{ module: string; action: string }>> = {
  viewer: [
    ...grants("register", "view", "export"),
    ...grants("assetHistory", "view"),
    ...grants("reports", "view", "export"),
    ...grants("masters", "view"),
    ...grants("settings", "view")
  ],
  editor: [
    ...grants("register", "view", "edit", "export"),
    ...grants("assetHistory", "view"),
    ...grants("transfers", "view", "create"),
    ...grants("capitalization", "view", "create"),
    ...grants("additions", "view", "create"),
    ...grants("disposals", "view", "create"),
    ...grants("bulkUpload", "capitalization", "transfers", "disposals", "merge"),
    ...grants("reports", "view", "export"),
    ...grants("activityLog", "view"),
    ...grants("masters", "view", "edit"),
    ...grants("settings", "view")
  ],
  admin: [
    ...grants("register", "view", "edit", "export"),
    ...grants("assetHistory", "view"),
    ...grants("transfers", "view", "create", "delete"),
    ...grants("capitalization", "view", "create", "delete"),
    ...grants("additions", "view", "create", "undo"),
    ...grants("disposals", "view", "create", "undo"),
    ...grants("bulkUpload", "capitalization", "transfers", "disposals", "merge"),
    ...grants("reports", "view", "export"),
    ...grants("activityLog", "view"),
    ...grants("masters", "view", "edit"),
    ...grants("settings", "view", "edit"),
    ...grants("admin", "view", "create", "edit", "resetPassword", "managePermissions")
  ]
};

/** The one function every nav-visibility/button-gating check in the app should use —
 *  reads the user's actual permission set (fetched once at login, see AuthContext),
 *  never `role`. `user` may be null (not signed in yet) for call-site convenience. */
export function hasPermission(user: AuthUser | null, module: Module, action: string): boolean {
  return !!user?.permissions.includes(`${module}:${action}`);
}
