import { useEffect } from "react";
import { outlinePlatform } from "./outlineSupport";

/**
 * App-wide rule: holding the shortcut modifier -- Cmd on macOS, Ctrl
 * elsewhere -- shows every control's own key under it. One listener paints the
 * document, so a control only has to render a `ShortcutHint` and CSS decides
 * when it is on screen. No React state, so a held Cmd cannot re-render a
 * textarea out from under a caret or a drag.
 */
export function useShortcutHints(): void {
  useEffect(() => {
    const modifier = outlinePlatform() === "mac" ? "Meta" : "Control";
    const paint = (held: boolean) => {
      document.documentElement.toggleAttribute("data-modifier-held", held);
    };
    const down = (event: globalThis.KeyboardEvent) => {
      if (event.key === modifier) paint(true);
    };
    const up = (event: globalThis.KeyboardEvent) => {
      if (event.key === modifier) paint(false);
    };
    // Cmd+Tab and Cmd+` leave the window with the key still down, so the
    // keyup never arrives: the blur is the only signal the hints are stale.
    const clear = () => paint(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
      clear();
    };
  }, []);
}

/**
 * The key label for one control, hidden until the modifier is held. Takes both
 * platforms' labels the way the row menu's `binding` does, rather than building
 * a chord out of glyph parts.
 */
export function ShortcutHint({
  mac,
  other
}: {
  readonly mac: string;
  readonly other: string;
}) {
  return <span className="shortcut-hint" aria-hidden="true">
    {outlinePlatform() === "mac" ? mac : other}
  </span>;
}
