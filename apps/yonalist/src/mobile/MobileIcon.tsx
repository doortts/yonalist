/**
 * The handful of Tabler glyphs the phone shell draws, as paths.
 *
 * `docs/design/icons.md` makes Tabler the first-choice set. The package that
 * ships it is not installed, and installing it here would write into the
 * node_modules this worktree shares with every other one, so the six glyphs
 * this shell needs are carried directly instead. They are the outline set's
 * own 24x24 paths, unaltered.
 *
 * ponytail: six glyphs by hand; add `@tabler/icons-react` once the shell needs
 * more than a screenful of them, or at the next clean install.
 */

/** Tabler Icons v3.46.0, outline. */
const glyphs = {
  "calendar-event":
    "M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12|M16 3l0 4|M8 3l0 4|M4 11l16 0|M8 15h2v2h-2l0 -2",
  notebook:
    "M6 4h11a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-11a1 1 0 0 1 -1 -1v-14a1 1 0 0 1 1 -1m3 0v18|M13 8l2 0|M13 12l2 0",
  "file-text":
    "M14 3v4a1 1 0 0 0 1 1h4|M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2|M9 9l1 0|M9 13l6 0|M9 17l6 0",
  search: "M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0|M21 21l-6 -6",
  "chevron-left": "M15 6l-6 6l6 6",
  "chevron-right": "M9 6l6 6l-6 6"
} as const;

export type MobileIconName = keyof typeof glyphs;

/**
 * Decorative by default: every place this is used already names itself in
 * text, and a second reading of the same word helps nobody.
 */
export function MobileIcon({
  name,
  size = 24
}: {
  readonly name: MobileIconName;
  readonly size?: number;
}) {
  return (
    <svg
      className="mobile-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyphs[name].split("|").map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
