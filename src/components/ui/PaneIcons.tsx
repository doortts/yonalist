import type { SVGProps } from "react";

interface PaneIconProps extends SVGProps<SVGSVGElement> {
  /** Square edge length in pixels. Defaults to 16 to match the lucide icons. */
  size?: number;
}

/**
 * Sidebar pane toggle glyph modeled on the Codex desktop icon: a rounded
 * square outline with a short vertical divider set in from the left, spanning
 * only the middle third of the height. lucide's PanelLeft draws a full-height
 * divider (`M9 3v18`), which reads more like a split view than a sidebar, so
 * this custom mark trims the divider to `M9 9v6`.
 *
 * Stroke-based and inherits `currentColor`, so it themes with the ghost
 * `.pane-toggle` button exactly like the neighboring lucide icons.
 */
export function SidebarPaneIcon({ size = 16, ...props }: PaneIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 9v6" />
    </svg>
  );
}
