// Deep Blue circle, white initials — the one avatar treatment used everywhere a user
// needs a visual identity: the header's UserMenu trigger and the Account page's
// identity card both render this same component (see UserMenu.tsx and AccountPage.tsx)
// rather than each rolling their own, so the two can never drift in size/color/initials
// logic.

/** First letter of the first and last word ("Dev Test User" -> "DU"); the first two
 *  characters of a single-word name ("devtest" -> "DE", the common case for a user who
 *  has never set a display name — see resolveDisplayName's email-prefix fallback). */
function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

const SIZE_CLASSES = {
  sm: "h-9 w-9 text-xs",
  md: "h-12 w-12 text-base"
} as const;

export function InitialsAvatar({ name, size = "sm" }: { name: string; size?: keyof typeof SIZE_CLASSES }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full bg-brand-deepBlue font-bold text-white ${SIZE_CLASSES[size]}`}
      aria-hidden="true"
    >
      {getInitials(name)}
    </span>
  );
}
