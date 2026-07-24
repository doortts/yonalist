export interface OutlineMotionRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface OutlineFlipDelta {
  readonly x: number;
  readonly y: number;
}

export interface OutlineMotionTarget {
  readonly element: HTMLElement;
  readonly before: OutlineMotionRect;
  readonly after: OutlineMotionRect;
  readonly entering: boolean;
  // Motion id of the row's outline parent, if any (used to unfold an entering
  // row from its parent's position rather than a generic short fade).
  readonly parentId?: string;
}

export interface OutlineMotionOptions {
  readonly durationMs: number;
  readonly reducedMotion: boolean;
  // Per-axis ceiling (typically the outline root's client size) above which a
  // moved row's delta is treated as stale — from a render-free reflow such as
  // a row growing or an image loading — and teleported instead of animated.
  // A non-positive limit disables clamping on that axis.
  readonly clampLimit?: { readonly x: number; readonly y: number };
  // Motion ids of the rows that are the subject of the change (see
  // identifyMovedRowIds); each is lifted above the flow while it animates.
  readonly liftIds?: ReadonlySet<string>;
}

// Moves park like a car easing into a spot: fast approach, long gentle tail,
// never past the mark (easeOutExpo-ish; overshoot springs read as wobble here).
const OUTLINE_MOTION_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";
// Entering rows decelerate into place; kept distinct from the move curve.
const OUTLINE_MOTION_ENTER_EASING = "cubic-bezier(0, 0, 0.2, 1)";
// The parking tail needs room to read; entering rows keep the hook's duration.
const OUTLINE_MOTION_MOVE_DURATION_MS = 300;
const OUTLINE_MOTION_STAGGER_STEP_MS = 8;
const OUTLINE_MOTION_STAGGER_MAX_MS = 80;
const OUTLINE_MOTION_LIFT_CLASS = "notes-outline-item--motion-lift";
// The animation that currently owns each element's lift. A rapid re-move
// cancels the prior run (rejecting its finished, which fires cleanup on a
// microtask) after the new run has already reattached the lift; the token lets
// stale cleanup no-op instead of stripping the live lift.
const liftOwner = new WeakMap<HTMLElement, Animation>();

// When a structural change is dominated by entering rows (e.g. zooming into a
// node), animating every fade at once reads as a flicker. Past these
// thresholds the change is treated as a scene cut and rendered instantly.
export const SCENE_CHANGE_ENTER_RATIO = 0.5;
export const SCENE_CHANGE_MIN_ROWS = 8;

interface OutlineMotionOrigin {
  readonly left: number;
  readonly top: number;
}

// FLIP rects are stored relative to the outline root so a scroll (which shifts
// the root and every row by the same amount) cancels out and produces no
// phantom slide on the first structural change after scrolling.
function motionOrigin(root: ParentNode): OutlineMotionOrigin {
  const rect =
    typeof (root as Element).getBoundingClientRect === "function"
      ? (root as Element).getBoundingClientRect()
      : null;
  return { left: rect?.left ?? 0, top: rect?.top ?? 0 };
}

function motionRect(
  element: HTMLElement,
  origin: OutlineMotionOrigin
): OutlineMotionRect {
  const outerRect = element.getBoundingClientRect();
  const anchorRect = element
    .querySelector<HTMLElement>(".notes-node-main")
    ?.getBoundingClientRect();
  return {
    left: (anchorRect?.left ?? outerRect.left) - origin.left,
    top: outerRect.top - origin.top,
    width: outerRect.width,
    height: outerRect.height
  };
}

export function captureOutlineMotionRects(
  root: ParentNode
): ReadonlyMap<string, OutlineMotionRect> {
  const origin = motionOrigin(root);
  const rects = new Map<string, OutlineMotionRect>();
  for (const element of root.querySelectorAll<HTMLElement>(
    ".notes-outline-item[data-outline-motion-id]"
  )) {
    const id = element.dataset.outlineMotionId;
    if (id) {
      rects.set(id, motionRect(element, origin));
    }
  }
  return rects;
}

export function collectOutlineMotionTargets(
  root: ParentNode,
  before: ReadonlyMap<string, OutlineMotionRect>,
  parentById?: ReadonlyMap<string, string>
): OutlineMotionTarget[] {
  const origin = motionOrigin(root);
  const targets: OutlineMotionTarget[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(
    ".notes-outline-item[data-outline-motion-id]"
  )) {
    const id = element.dataset.outlineMotionId;
    if (!id) continue;
    const after = motionRect(element, origin);
    const previous = before.get(id);
    targets.push({
      element,
      before: previous ?? after,
      after,
      entering: previous === undefined,
      parentId: parentById?.get(id)
    });
  }
  return targets;
}

export function calculateOutlineFlipDelta(
  before: OutlineMotionRect,
  after: OutlineMotionRect
): OutlineFlipDelta {
  return {
    x: before.left - after.left,
    y: before.top - after.top
  };
}

function exceedsClampLimit(
  delta: OutlineFlipDelta,
  clampLimit: OutlineMotionOptions["clampLimit"]
): boolean {
  if (!clampLimit) return false;
  return (
    (clampLimit.x > 0 && Math.abs(delta.x) > clampLimit.x) ||
    (clampLimit.y > 0 && Math.abs(delta.y) > clampLimit.y)
  );
}

const ENTER_FALLBACK_OFFSET_PX = -4;
const ENTER_MAX_UNFOLD_PX = 160;

// Where an entering row's fade starts, in y — only ever called for a multi-row
// reveal (an expand). Unfold from the parent's row when the parent is on screen
// and not itself entering; otherwise a short fade.
function enteringStartY(
  target: OutlineMotionTarget,
  afterTopById: ReadonlyMap<string, { top: number; entering: boolean }>
): number {
  const parent = target.parentId
    ? afterTopById.get(target.parentId)
    : undefined;
  if (!parent || parent.entering) return ENTER_FALLBACK_OFFSET_PX;
  const offset = parent.top - target.after.top;
  return Math.max(-ENTER_MAX_UNFOLD_PX, Math.min(0, offset));
}

function isSceneChange(targets: readonly OutlineMotionTarget[]): boolean {
  if (targets.length < SCENE_CHANGE_MIN_ROWS) return false;
  const entering = targets.reduce(
    (count, target) => (target.entering ? count + 1 : count),
    0
  );
  return entering / targets.length >= SCENE_CHANGE_ENTER_RATIO;
}

// Rows present both before and after the change but not on the longest common
// subsequence of the two orders — i.e. the ones that actually broke formation.
// Ids unique per row, so no duplicate handling. O(n*m), n,m <= MAX_VISIBLE_ROWS.
export function identifyMovedRowIds(
  beforeIds: readonly string[],
  afterIds: readonly string[]
): ReadonlySet<string> {
  const n = beforeIds.length;
  const m = afterIds.length;
  const lengths: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lengths[i]![j] =
        beforeIds[i] === afterIds[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const onLcs = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (beforeIds[i] === afterIds[j]) {
      onLcs.add(beforeIds[i]!);
      i += 1;
      j += 1;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  const afterSet = new Set(afterIds);
  const moved = new Set<string>();
  for (const id of beforeIds) {
    if (afterSet.has(id) && !onLcs.has(id)) moved.add(id);
  }
  return moved;
}

export function animateOutlineMotion(
  targets: readonly OutlineMotionTarget[],
  options: OutlineMotionOptions
): Animation[] {
  if (options.reducedMotion) return [];
  if (isSceneChange(targets)) return [];

  const afterTopById = new Map<string, { top: number; entering: boolean }>();
  let enteringCount = 0;
  for (const target of targets) {
    if (target.entering) enteringCount += 1;
    const id = target.element.dataset.outlineMotionId;
    if (id) {
      afterTopById.set(id, { top: target.after.top, entering: target.entering });
    }
  }

  const candidates: { target: OutlineMotionTarget; delta: OutlineFlipDelta }[] =
    [];
  for (const target of targets) {
    const delta = calculateOutlineFlipDelta(target.before, target.after);
    if (
      typeof target.element.animate !== "function" ||
      (!target.entering && delta.x === 0 && delta.y === 0)
    ) {
      continue;
    }
    // A lone entering row is a new bullet about to receive the caret. Let it
    // appear instantly instead of fading/translating in, so focus lands on a
    // stable, fully-painted row with no hitch. Rows below still slide.
    if (target.entering && enteringCount < 2) {
      continue;
    }
    if (!target.entering && exceedsClampLimit(delta, options.clampLimit)) {
      continue;
    }
    candidates.push({ target, delta });
  }
  // Cascade top-to-bottom so a burst of rows reads as a wave rather than a
  // single snap. Not worth it for one or two rows.
  candidates.sort((a, b) => a.target.after.top - b.target.after.top);
  const staggered = candidates.length > 2;

  const animations: Animation[] = [];
  candidates.forEach(({ target, delta }, order) => {
    const keyframeOptions: KeyframeAnimationOptions = {
      duration: target.entering
        ? options.durationMs
        : OUTLINE_MOTION_MOVE_DURATION_MS,
      easing: target.entering ? OUTLINE_MOTION_ENTER_EASING : OUTLINE_MOTION_EASING
    };
    if (staggered) {
      keyframeOptions.delay = Math.min(order * OUTLINE_MOTION_STAGGER_STEP_MS, OUTLINE_MOTION_STAGGER_MAX_MS);
      // Hold each row on its start keyframe through the delay; otherwise it
      // flashes at its final state (entering: opacity 1; moving: final spot)
      // before the delay elapses.
      keyframeOptions.fill = "backwards";
    }
    const id = target.element.dataset.outlineMotionId;
    const lift =
      !target.entering && id !== undefined && options.liftIds?.has(id) === true;
    const element = target.element;
    if (lift) {
      element.classList.add(OUTLINE_MOTION_LIFT_CLASS);
    }
    const animation = element.animate(
      target.entering
        ? [
            {
              transform: `translate3d(0, ${enteringStartY(target, afterTopById)}px, 0)`,
              opacity: 0
            },
            { transform: "translate3d(0, 0, 0)", opacity: 1 }
          ]
        : [
            {
              transform: `translate3d(${delta.x}px, ${delta.y}px, 0)`,
              opacity: 1
            },
            { transform: "translate3d(0, 0, 0)", opacity: 1 }
          ],
      keyframeOptions
    );
    if (lift) {
      liftOwner.set(element, animation);
      // Drop the lift when the row lands, or when the run is cancelled (WAAPI
      // rejects finished on cancel) — but only if this run still owns it, so a
      // superseding re-move keeps its own lift.
      const clearLift = () => {
        if (liftOwner.get(element) === animation) {
          liftOwner.delete(element);
          element.classList.remove(OUTLINE_MOTION_LIFT_CLASS);
        }
      };
      void animation.finished.then(clearLift, clearLift);
    }
    animations.push(animation);
  });
  return animations;
}
