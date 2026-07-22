import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from "react";
import {
  animateOutlineMotion,
  captureOutlineMotionRects,
  collectOutlineMotionTargets,
  type OutlineMotionRect
} from "./outlineLayoutMotion";

const MAX_VISIBLE_ROWS = 120;

interface OutlineLayoutMotionRow {
  readonly id: string;
  readonly depth: number;
}

interface UseOutlineLayoutMotionOptions {
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly rows: readonly OutlineLayoutMotionRow[];
  readonly activeDrag: boolean;
  readonly initialLoading: boolean;
  readonly isComposing: boolean;
}

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = () => setReducedMotion(media.matches);
    handleChange();
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  return reducedMotion;
}

function projectionSignature(rows: readonly OutlineLayoutMotionRow[]): string {
  if (rows.length > MAX_VISIBLE_ROWS) {
    return `over-limit:${rows.length}`;
  }
  return rows.map((row) => `${row.id}\u0000${row.depth}`).join("\u0001");
}

function cancelAnimations(animations: readonly Animation[]): void {
  for (const animation of animations) {
    animation.cancel();
  }
}

export function useOutlineLayoutMotion({
  rootRef,
  rows,
  activeDrag,
  initialLoading,
  isComposing
}: UseOutlineLayoutMotionOptions): void {
  const reducedMotion = usePrefersReducedMotion();
  const priorRectsRef = useRef<ReadonlyMap<string, OutlineMotionRect>>(
    new Map()
  );
  const priorSignatureRef = useRef<string | null>(null);
  const priorRowCountRef = useRef(0);
  const initializedRef = useRef(false);
  const hasMotionBaselineRef = useRef(false);
  const resizeInProgressRef = useRef(false);
  const animationsRef = useRef<readonly Animation[]>([]);
  const signature = projectionSignature(rows);
  const cancelActiveAnimations = useCallback(() => {
    cancelAnimations(animationsRef.current);
    animationsRef.current = [];
  }, []);
  const retainAnimations = useCallback((animations: readonly Animation[]) => {
    animationsRef.current = animations;
    for (const animation of animations) {
      void animation.finished.then(
        () => {
          animationsRef.current = animationsRef.current.filter(
            (current) => current !== animation
          );
        },
        () => {
          animationsRef.current = animationsRef.current.filter(
            (current) => current !== animation
          );
        }
      );
    }
  }, []);

  useEffect(
    () => () => {
      cancelActiveAnimations();
    },
    [cancelActiveAnimations]
  );

  useEffect(() => {
    let frameId: number | null = null;
    const clearResizeState = () => {
      resizeInProgressRef.current = false;
      frameId = null;
      // A resize likely reflowed every row, so the pre-resize baseline is now
      // stale. Re-capture it against the settled layout to avoid a phantom
      // slide on the first structural change afterwards.
      const root = rootRef.current;
      if (root && priorRowCountRef.current <= MAX_VISIBLE_ROWS) {
        priorRectsRef.current = captureOutlineMotionRects(root);
        hasMotionBaselineRef.current = true;
      }
    };
    const handleResize = () => {
      resizeInProgressRef.current = true;
      cancelActiveAnimations();
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(clearResizeState);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [cancelActiveAnimations, rootRef]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const priorSignature = priorSignatureRef.current;
    const structuralChange =
      priorSignature !== null && priorSignature !== signature;
    const overRowLimit =
      rows.length > MAX_VISIBLE_ROWS || priorRowCountRef.current > MAX_VISIBLE_ROWS;
    const skip =
      initialLoading ||
      activeDrag ||
      isComposing ||
      reducedMotion ||
      resizeInProgressRef.current ||
      overRowLimit;

    if (!initializedRef.current) {
      priorSignatureRef.current = signature;
      priorRowCountRef.current = rows.length;
      if (!initialLoading && !overRowLimit) {
        priorRectsRef.current = captureOutlineMotionRects(root);
        initializedRef.current = true;
        hasMotionBaselineRef.current = true;
      } else {
        priorRectsRef.current = new Map();
        hasMotionBaselineRef.current = false;
      }
      return;
    }

    if (!structuralChange || skip || !hasMotionBaselineRef.current) {
      if (skip) {
        cancelActiveAnimations();
      }
      priorSignatureRef.current = signature;
      priorRowCountRef.current = rows.length;
      if (initialLoading || overRowLimit) {
        priorRectsRef.current = new Map();
        hasMotionBaselineRef.current = false;
      } else {
        priorRectsRef.current = captureOutlineMotionRects(root);
        hasMotionBaselineRef.current = true;
      }
      return;
    }

    cancelActiveAnimations();
    const targets = collectOutlineMotionTargets(root, priorRectsRef.current);
    const durationMs = rows.length === priorRowCountRef.current ? 140 : 180;
    priorSignatureRef.current = signature;
    priorRowCountRef.current = rows.length;
    priorRectsRef.current = new Map(
      targets.map((target) => [
        target.element.dataset.outlineMotionId!,
        target.after
      ])
    );
    retainAnimations(animateOutlineMotion(targets, {
      durationMs,
      reducedMotion: false,
      // Clamp against the viewport, not the root: an outline's <ol> reports its
      // full content height, so a root-sized limit never fires on long lists.
      // A move beyond one screen also just reads better as a teleport.
      clampLimit: { x: window.innerWidth, y: window.innerHeight }
    }));
  }, [
    activeDrag,
    initialLoading,
    isComposing,
    reducedMotion,
    cancelActiveAnimations,
    retainAnimations,
    rootRef,
    rows.length,
    signature
  ]);
}
