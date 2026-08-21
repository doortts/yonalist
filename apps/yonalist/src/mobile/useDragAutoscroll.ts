import { useEffect, type RefObject } from "react";
import { autoscrollStep } from "./dragAutoscroll";

/** What the outline's drag puts on the body while a row is in the air. */
const DRAGGING = "is-outline-dragging";

/**
 * Moves the list under a dragged row when the finger reaches its edge.
 *
 * A phone shows a dozen rows, so a row's new home is usually off screen, and a
 * finger cannot both hold the row and scroll to where it belongs. The drag hook
 * itself is the desktop's and is left alone: this watches the class that hook
 * already puts on the body, so nothing shared has to learn about phones.
 *
 * The frame keeps running while the finger is still, since holding at the edge
 * is exactly how someone asks to keep going.
 */
export function useDragAutoscroll(scroller: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let frame = 0;
    let step = 0;

    const run = () => {
      frame = 0;
      const box = scroller.current;
      if (!box || step === 0) return;
      box.scrollTop += step;
      frame = requestAnimationFrame(run);
    };

    const follow = (event: PointerEvent) => {
      const box = scroller.current;
      if (!box || !document.body.classList.contains(DRAGGING)) {
        step = 0;
        return;
      }
      step = autoscrollStep(event.clientY, box.getBoundingClientRect());
      if (step !== 0 && frame === 0) frame = requestAnimationFrame(run);
    };

    const stop = () => {
      step = 0;
    };

    window.addEventListener("pointermove", follow, true);
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", follow, true);
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
    };
  }, [scroller]);
}
