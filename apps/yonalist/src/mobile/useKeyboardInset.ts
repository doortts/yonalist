import { useEffect, useState } from "react";

/**
 * A keyboard is only a keyboard once it has taken a real bite. Below this, the
 * difference is a browser toolbar sliding, a rounded device pixel, or the
 * viewport settling after a rotation — none of which the rows should move for.
 */
const KEYBOARD_FLOOR = 80;

/**
 * How many pixels the soft keyboard covers.
 *
 * iOS does not shrink the layout viewport when the keyboard opens: the page
 * keeps its full height and the keyboard is drawn over the bottom of it, so a
 * row being edited near the foot of the screen ends up underneath and the
 * caret is somewhere the writer cannot see. The visual viewport is the one
 * that does shrink, and the difference between the two is the bite.
 *
 * `scroll` is listened to alongside `resize` because iOS also offsets the
 * visual viewport when it scrolls a focused field into view, and that arrives
 * as a scroll rather than a resize.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const measure = () => {
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      setInset(covered > KEYBOARD_FLOOR ? Math.round(covered) : 0);
    };
    measure();
    viewport.addEventListener("resize", measure);
    viewport.addEventListener("scroll", measure);
    return () => {
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
    };
  }, []);

  return inset;
}
