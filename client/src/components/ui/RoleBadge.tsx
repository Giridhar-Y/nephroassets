import type { Role } from "../../api/client.js";

// The three built-in roles keep their existing distinct colors; any custom role (Roles
// master, MastersPage.tsx) gets one consistent neutral badge — simpler than inventing a
// color per custom role, and still visually distinguishes "one of the original three"
// from "something someone defined". Extracted out of AdminPage.tsx once the Account
// page's identity card needed the exact same role display — both now read from here so
// the color/casing rules can't drift between the two places a role gets shown.
const BUILT_IN_ROLE_BADGE_CLASS: Record<string, string> = {
  viewer: "bg-gray-100 text-gray-600",
  editor: "bg-blue-100 text-blue-800",
  admin: "bg-ink text-white"
};
const CUSTOM_ROLE_BADGE_CLASS = "bg-purple-100 text-purple-800";

// Built-in role names are stored lowercase (matching every pre-existing user's `role`
// column, from before Roles became a Master) — capitalized only for display. A custom
// role keeps whatever casing its creator typed.
export function roleDisplayName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function RoleBadge({ role }: { role: Role }) {
  const cls = BUILT_IN_ROLE_BADGE_CLASS[role.toLowerCase()] ?? CUSTOM_ROLE_BADGE_CLASS;
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{roleDisplayName(role)}</span>;
}
