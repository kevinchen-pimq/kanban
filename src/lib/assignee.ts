/**
 * Assignee identity colours.
 *
 * The board shows the same person in several places (cards, the assignee
 * filter), and scanning a column for "whose cards are these" only works if a
 * person keeps one colour everywhere and between sessions.
 *
 * There are two ways a name gets its colour, in this order:
 *
 *  1. The `assigneeColors` map in the board's Convex config, which is where the
 *     team's actual people live. Those assignments are fixed by hand and never
 *     move, whatever else changes.
 *  2. Otherwise a colour derived from the name, so somebody who joins today
 *     still gets a stable, distinct-looking avatar before an operator adds them
 *     to the config. The same name always lands on the same palette entry, on
 *     every deployment — nothing here depends on load order.
 */

/**
 * Ten hand-picked colours, each of which clears the 4.5:1 contrast ratio
 * against the white initials drawn on top (checked with the WCAG formula).
 * Neighbouring entries differ in hue as well as lightness, so two assignees
 * landing on adjacent indices still read as different people.
 */
const AVATAR_COLORS = [
  "#7c2d12", // brown
  "#1e3a8a", // navy
  "#2563eb", // blue
  "#b91c1c", // red
  "#be185d", // pink
  "#6d28d9", // violet
  "#0f766e", // teal
  "#15803d", // green
  "#a16207", // amber
  "#4d7c0f", // olive
] as const;

/** Unassigned cards get a neutral slate instead of a person's colour. */
const UNASSIGNED_COLOR = "#475569";

/**
 * FNV-1a, 32-bit. Any stable string hash would do; this one is short, has no
 * dependencies and spreads short names like "bob" across the palette better
 * than summing char codes.
 */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Background colour for an assignee's avatar, as a hex string.
 *
 * `configured` is the board config's name → colour map, which wins when it
 * names this person; the key has to match the ticket's `assignee` string
 * exactly. Anyone it does not name falls back to the hashed palette entry.
 *
 * Returned as a value rather than a Tailwind class: both the configured colours
 * and the hashed ones are only known at runtime, and Tailwind cannot emit a
 * class it never sees in the source.
 */
export function assigneeColor(
  name: string | null | undefined,
  configured?: Record<string, string>,
): string {
  if (!name?.trim()) return UNASSIGNED_COLOR;

  const fixed = configured?.[name];
  if (fixed) return fixed;

  // Fallback: hashed on the trimmed, lowercased name, so "Alice" and "alice "
  // are one person even though the config would treat them as two keys.
  return AVATAR_COLORS[hash(name.trim().toLowerCase()) % AVATAR_COLORS.length];
}

/** Initials for the assignee avatar: "Kevin Chen" -> "KC", "alice" -> "AL". */
export function initials(name: string | null | undefined): string {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
