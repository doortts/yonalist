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
  identifyMovedRowIds,
  type OutlineMotionRect
} from "./outlineLayoutMotion";
import type { KeyboardInsertionDisposition } from "./notesKeyboardInsertion";
import type { NotesProjectionPublication } from "./notesWorkspaceTypes";
import {
  createOutlineIdleBaselineScheduler,
  type OutlineIdleBaselineScheduler
} from "./outlineIdleBaseline";

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
  readonly publication: NotesProjectionPublication | null;
  readonly insertionDisposition: KeyboardInsertionDisposition;
  readonly onInsertionMotionConsumed: (intentToken: number) => void;
  readonly onSettledFirstPaint: (generation: number) => void;
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

// Nearest preceding row whose depth is exactly one less is a row's parent.
function computeParentIds(
  rows: readonly OutlineLayoutMotionRow[]
): Map<string, string> {
  const parentById = new Map<string, string>();
  const ancestors: OutlineLayoutMotionRow[] = [];
  for (const row of rows) {
    while (
      ancestors.length > 0 &&
      ancestors[ancestors.length - 1]!.depth >= row.depth
    ) {
      ancestors.pop();
    }
    const parent = ancestors[ancestors.length - 1];
    if (parent && parent.depth === row.depth - 1) {
      parentById.set(row.id, parent.id);
    }
    ancestors.push(row);
  }
  return parentById;
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

function acceptedInsertionMotionToken(
  publication: NotesProjectionPublication | null,
  disposition: KeyboardInsertionDisposition
): number | null {
  const authoritative = publication?.keyboardInsertionDisposition;
  if (
    !publication ||
    publication.owner.kind !== "keyboard-insertion" ||
    (authoritative?.kind !== "exact" && authoritative?.kind !== "mixed") ||
    (disposition.kind !== "exact" && disposition.kind !== "mixed")
  ) {
    return null;
  }
  const token = authoritative.settlement.intentToken;
  return publication.owner.intentToken === token &&
    authoritative.pending.intent.token === token &&
    disposition.pending.intent.token === token &&
    disposition.settlement.intentToken === token &&
    authoritative.settlement.acceptedProjectionGeneration ===
      publication.projectionGeneration &&
    authoritative.settlement.acceptedLayoutGeneration ===
      publication.layoutGeneration
    ? token
    : null;
}

function mismatchedInsertionMotionToken(
  publication: NotesProjectionPublication | null,
  disposition: KeyboardInsertionDisposition
): number | null {
  const authoritative = publication?.keyboardInsertionDisposition;
  if (
    !publication ||
    publication.owner.kind !== "keyboard-insertion" ||
    authoritative?.kind !== "mismatch" ||
    disposition.kind !== "mismatch"
  ) {
    return null;
  }
  const token = authoritative.settlement.intentToken;
  return publication.owner.intentToken === token &&
    authoritative.pending.intent.token === token &&
    disposition.pending.intent.token === token &&
    disposition.settlement.intentToken === token
    ? token
    : null;
}

export function useOutlineLayoutMotion({
  rootRef,
  rows,
  activeDrag,
  initialLoading,
  isComposing,
  publication,
  insertionDisposition,
  onInsertionMotionConsumed,
  onSettledFirstPaint
}: UseOutlineLayoutMotionOptions): OutlineIdleBaselineScheduler {
  const reducedMotion = usePrefersReducedMotion();
  const priorRectsRef = useRef<ReadonlyMap<string, OutlineMotionRect>>(
    new Map()
  );
  const priorSignatureRef = useRef<string | null>(null);
  const priorRowCountRef = useRef(0);
  const initializedRef = useRef(false);
  const hasMotionBaselineRef = useRef(false);
  const consumedInsertionIntentTokenRef = useRef<number | null>(null);
  const terminalInsertionIntentTokenRef = useRef<number | null>(null);
  const resizeInProgressRef = useRef(false);
  const animationsRef = useRef<readonly Animation[]>([]);
  const latestProjectionGenerationRef = useRef(
    publication?.projectionGeneration ?? 0
  );
  latestProjectionGenerationRef.current =
    publication?.projectionGeneration ?? latestProjectionGenerationRef.current;
  const latestLayoutGenerationRef = useRef(
    publication?.layoutGeneration ?? 0
  );
  latestLayoutGenerationRef.current =
    publication?.layoutGeneration ?? latestLayoutGenerationRef.current;
  const settledPaintFramesRef = useRef<{
    first: number | null;
    second: number | null;
  }>({ first: null, second: null });
  const settledPaintCallbackRef = useRef(onSettledFirstPaint);
  settledPaintCallbackRef.current = onSettledFirstPaint;
  const cancelSettledPaintFramesRef = useRef<() => void>(() => undefined);
  const baselineSchedulerRef =
    useRef<OutlineIdleBaselineScheduler | null>(null);
  const signature = projectionSignature(rows);
  // Latest rows for the layout effect's parent-id lookup without widening its
  // dependencies to the (per-render fresh) rows array.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const createBaselineScheduler = useCallback(
    () =>
      createOutlineIdleBaselineScheduler({
        quietMs: 150,
        idleTimeoutMs: 500,
        requestIdle: (callback, timeoutMs) => {
          if (typeof window.requestIdleCallback === "function") {
            return window.requestIdleCallback(callback, {
              timeout: timeoutMs
            });
          }
          callback({
            didTimeout: true,
            timeRemaining: () => 0
          });
          return null;
        },
        cancelIdle: (handle) => {
          if (
            handle !== null &&
            typeof window.cancelIdleCallback === "function"
          ) {
            window.cancelIdleCallback(handle as number);
          }
        },
        captureLatest: (generation) => {
          if (latestLayoutGenerationRef.current !== generation) return;
          const root = rootRef.current;
          if (!root || priorRowCountRef.current > MAX_VISIBLE_ROWS) return;
          priorRectsRef.current = captureOutlineMotionRects(root);
          hasMotionBaselineRef.current = true;
        }
      }),
    [rootRef]
  );
  const ensureBaselineScheduler = useCallback(() => {
    baselineSchedulerRef.current ??= createBaselineScheduler();
    return baselineSchedulerRef.current;
  }, [createBaselineScheduler]);
  const baselineSchedulerFacadeRef =
    useRef<OutlineIdleBaselineScheduler | null>(null);
  if (baselineSchedulerFacadeRef.current === null) {
    baselineSchedulerFacadeRef.current = {
      suspendForPendingInsertion(generation) {
        cancelSettledPaintFramesRef.current();
        ensureBaselineScheduler().suspendForPendingInsertion(generation);
      },
      afterSettledFirstPaint(generation) {
        ensureBaselineScheduler().afterSettledFirstPaint(generation);
      },
      noteActivity(generation) {
        ensureBaselineScheduler().noteActivity(generation);
      },
      completeFromSynchronousCapture(generation) {
        cancelSettledPaintFramesRef.current();
        ensureBaselineScheduler().completeFromSynchronousCapture(generation);
      },
      dispose() {
        cancelSettledPaintFramesRef.current();
        baselineSchedulerRef.current?.dispose();
        baselineSchedulerRef.current = null;
      },
      pendingCount() {
        return baselineSchedulerRef.current?.pendingCount() ?? 0;
      }
    };
  }
  const baselineScheduler = baselineSchedulerFacadeRef.current;
  const cancelSettledPaintFrames = useCallback(() => {
    const frames = settledPaintFramesRef.current;
    if (frames.first !== null) {
      window.cancelAnimationFrame(frames.first);
    }
    if (frames.second !== null) {
      window.cancelAnimationFrame(frames.second);
    }
    settledPaintFramesRef.current = { first: null, second: null };
  }, []);
  cancelSettledPaintFramesRef.current = cancelSettledPaintFrames;
  const scheduleSettledFirstPaint = useCallback(
    (projectionGeneration: number, layoutGeneration: number) => {
      cancelSettledPaintFrames();
      const frames = settledPaintFramesRef.current;
      frames.first = window.requestAnimationFrame(() => {
        frames.first = null;
        if (
          latestProjectionGenerationRef.current !== projectionGeneration ||
          latestLayoutGenerationRef.current !== layoutGeneration
        ) {
          return;
        }
        frames.second = window.requestAnimationFrame(() => {
          frames.second = null;
          if (
            latestProjectionGenerationRef.current !== projectionGeneration ||
            latestLayoutGenerationRef.current !== layoutGeneration
          ) {
            return;
          }
          baselineScheduler.afterSettledFirstPaint(layoutGeneration);
          settledPaintCallbackRef.current(layoutGeneration);
        });
      });
    },
    [baselineScheduler, cancelSettledPaintFrames]
  );
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

  useLayoutEffect(() => {
    ensureBaselineScheduler();
    return () => {
      cancelActiveAnimations();
      baselineScheduler.dispose();
    };
  }, [
    baselineScheduler,
    cancelActiveAnimations,
    ensureBaselineScheduler
  ]);

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
        baselineScheduler.completeFromSynchronousCapture(
          latestLayoutGenerationRef.current
        );
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
  }, [baselineScheduler, cancelActiveAnimations, rootRef]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const priorSignature = priorSignatureRef.current;
    const structuralChange =
      priorSignature !== null && priorSignature !== signature;
    const insertionMotionToken = acceptedInsertionMotionToken(
      publication,
      insertionDisposition
    );
    if (insertionMotionToken !== null) {
      if (consumedInsertionIntentTokenRef.current !== insertionMotionToken) {
        cancelActiveAnimations();
        consumedInsertionIntentTokenRef.current = insertionMotionToken;
        onInsertionMotionConsumed(insertionMotionToken);
        scheduleSettledFirstPaint(
          publication!.projectionGeneration,
          publication!.layoutGeneration
        );
        priorRectsRef.current = new Map();
        hasMotionBaselineRef.current = false;
      }
      initializedRef.current = true;
      priorSignatureRef.current = signature;
      priorRowCountRef.current = rows.length;
      return;
    }
    if (
      settledPaintFramesRef.current.first !== null ||
      settledPaintFramesRef.current.second !== null
    ) {
      cancelSettledPaintFrames();
    }
    const mismatchToken = mismatchedInsertionMotionToken(
      publication,
      insertionDisposition
    );
    if (
      mismatchToken !== null &&
      terminalInsertionIntentTokenRef.current !== mismatchToken
    ) {
      terminalInsertionIntentTokenRef.current = mismatchToken;
      scheduleSettledFirstPaint(
        publication!.projectionGeneration,
        publication!.layoutGeneration
      );
    }
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

    if (!structuralChange) {
      if (skip) {
        cancelActiveAnimations();
      }
      priorSignatureRef.current = signature;
      priorRowCountRef.current = rows.length;
      return;
    }

    if (skip || !hasMotionBaselineRef.current) {
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
        baselineScheduler.completeFromSynchronousCapture(
          latestLayoutGenerationRef.current
        );
      }
      return;
    }

    cancelActiveAnimations();
    const beforeIds = [...priorRectsRef.current.keys()];
    const targets = collectOutlineMotionTargets(
      root,
      priorRectsRef.current,
      computeParentIds(rowsRef.current)
    );
    const movedIds = identifyMovedRowIds(
      beforeIds,
      targets.map((target) => target.element.dataset.outlineMotionId!)
    );
    const durationMs = rows.length === priorRowCountRef.current ? 140 : 180;
    priorSignatureRef.current = signature;
    priorRowCountRef.current = rows.length;
    priorRectsRef.current = new Map(
      targets.map((target) => [
        target.element.dataset.outlineMotionId!,
        target.after
      ])
    );
    baselineScheduler.completeFromSynchronousCapture(
      latestLayoutGenerationRef.current
    );
    retainAnimations(animateOutlineMotion(targets, {
      durationMs,
      reducedMotion: false,
      skipLoneEntering: false,
      // Clamp against the viewport, not the root: an outline's <ol> reports its
      // full content height, so a root-sized limit never fires on long lists.
      // A move beyond one screen also just reads better as a teleport.
      clampLimit: { x: window.innerWidth, y: window.innerHeight },
      liftIds: movedIds
    }));
  }, [
    activeDrag,
    initialLoading,
    isComposing,
    reducedMotion,
    cancelActiveAnimations,
    cancelSettledPaintFrames,
    baselineScheduler,
    retainAnimations,
    rootRef,
    insertionDisposition,
    onInsertionMotionConsumed,
    publication,
    rows.length,
    scheduleSettledFirstPaint,
    signature
  ]);
  return baselineScheduler;
}
