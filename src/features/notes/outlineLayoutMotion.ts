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
}

export interface OutlineMotionOptions {
  readonly durationMs: number;
  readonly reducedMotion: boolean;
  // Per-axis ceiling (typically the outline root's client size) above which a
  // moved row's delta is treated as stale — from a render-free reflow such as
  // a row growing or an image loading — and teleported instead of animated.
  // A non-positive limit disables clamping on that axis.
  readonly clampLimit?: { readonly x: number; readonly y: number };
}

const OUTLINE_MOTION_EASING = "cubic-bezier(0.2, 0, 0, 1)";
// Entering rows decelerate into place; kept distinct from the move curve.
const OUTLINE_MOTION_ENTER_EASING = "cubic-bezier(0, 0, 0.2, 1)";
// linear() spring approximation (mass 1, stiffness 170, damping 26; ~1.3%
// overshoot) — a settle the move curve can't express. Used only where the
// runtime supports linear() easing; the tail wants the longer duration below.
const OUTLINE_MOTION_SPRING_EASING =
  "linear(0, 0.3407, 0.7371, 0.9823, 1.0868, 1.1046, 1.0796, 1.0417, 1.0093, 0.9888, 0.9793, 0.9772, 0.9791, 0.9825, 0.9858, 0.9885, 0.9905, 0.9928, 0.9959, 1)";
const OUTLINE_MOTION_SPRING_DURATION_MS = 220;
const OUTLINE_MOTION_STAGGER_STEP_MS = 8;
const OUTLINE_MOTION_STAGGER_MAX_MS = 80;

let linearEasingSupport: boolean | null = null;
function supportsLinearEasing(): boolean {
  if (linearEasingSupport === null) {
    try {
      linearEasingSupport =
        typeof CSS !== "undefined" &&
        typeof CSS.supports === "function" &&
        CSS.supports("animation-timing-function", "linear(0, 1)");
    } catch {
      linearEasingSupport = false;
    }
  }
  return linearEasingSupport;
}

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
  before: ReadonlyMap<string, OutlineMotionRect>
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
      entering: previous === undefined
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

function isSceneChange(targets: readonly OutlineMotionTarget[]): boolean {
  if (targets.length < SCENE_CHANGE_MIN_ROWS) return false;
  const entering = targets.reduce(
    (count, target) => (target.entering ? count + 1 : count),
    0
  );
  return entering / targets.length >= SCENE_CHANGE_ENTER_RATIO;
}

export function animateOutlineMotion(
  targets: readonly OutlineMotionTarget[],
  options: OutlineMotionOptions
): Animation[] {
  if (options.reducedMotion) return [];
  if (isSceneChange(targets)) return [];

  const spring = supportsLinearEasing();
  const moveEasing = spring ? OUTLINE_MOTION_SPRING_EASING : OUTLINE_MOTION_EASING;
  const moveDurationMs = spring
    ? OUTLINE_MOTION_SPRING_DURATION_MS
    : options.durationMs;

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
      duration: target.entering ? options.durationMs : moveDurationMs,
      easing: target.entering ? OUTLINE_MOTION_ENTER_EASING : moveEasing
    };
    if (staggered) {
      keyframeOptions.delay = Math.min(order * OUTLINE_MOTION_STAGGER_STEP_MS, OUTLINE_MOTION_STAGGER_MAX_MS);
      // Hold each row on its start keyframe through the delay; otherwise it
      // flashes at its final state (entering: opacity 1; moving: final spot)
      // before the delay elapses.
      keyframeOptions.fill = "backwards";
    }
    animations.push(
      target.element.animate(
        target.entering
          ? [
              { transform: "translate3d(0, -4px, 0)", opacity: 0 },
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
      )
    );
  });
  return animations;
}
