import {
  useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent
} from "react";

const MIN_SPLIT_PERCENT = 25;
const MAX_SPLIT_PERCENT = 75;
const KEYBOARD_STEP = 2;

function clampSplitPercent(value: number) {
  return Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, value));
}

export function useSplitResize(enabled: boolean) {
  const [primaryPercent, setPrimaryPercent] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    if (!enabled) setPrimaryPercent(50);
  }, [enabled]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragging.current) return;
      const bounds = containerRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width === 0) return;
      setPrimaryPercent(clampSplitPercent(
        ((event.clientX - bounds.left) / bounds.width) * 100
      ));
    };
    const stop = () => {
      dragging.current = false;
      document.body.classList.remove("is-resizing-pane");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      stop();
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragging.current = true;
    document.body.classList.add("is-resizing-pane");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = {
      ArrowLeft: primaryPercent - KEYBOARD_STEP,
      ArrowRight: primaryPercent + KEYBOARD_STEP,
      Home: MIN_SPLIT_PERCENT,
      End: MAX_SPLIT_PERCENT
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setPrimaryPercent(clampSplitPercent(next));
  };

  return {
    containerRef,
    onKeyDown,
    onPointerDown,
    primaryPercent
  };
}
