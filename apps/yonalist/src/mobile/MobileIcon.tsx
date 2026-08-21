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
  "chevron-right": "M9 6l6 6l-6 6",
  dots:
    "M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0|M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0|M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
  check: "M5 12l5 5l10 -10",
  "indent-increase": "M20 6l-11 0|M20 12l-7 0|M20 18l-11 0|M4 8l4 4l-4 4",
  "indent-decrease": "M20 6l-7 0|M20 12l-9 0|M20 18l-7 0|M8 8l-4 4l4 4",
  "square-check":
    "M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14|M9 12l2 2l4 -4",
  tag:
    "M6.5 7.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0|M3 6v5.172a2 2 0 0 0 .586 1.414l7.71 7.71a2.41 2.41 0 0 0 3.408 0l5.592 -5.592a2.41 2.41 0 0 0 0 -3.408l-7.71 -7.71a2 2 0 0 0 -1.414 -.586h-5.172a3 3 0 0 0 -3 3",
  "keyboard-hide":
    "M2 5a2 2 0 0 1 2 -2h16a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2l0 -8|M6 7l0 .01|M10 7l0 .01|M14 7l0 .01|M18 7l0 .01|M6 11l0 .01|M18 11l0 .01|M10 11l4 0|M10 21l2 -2l2 2"
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
