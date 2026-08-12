import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, RotateCcw, RotateCw, X } from "lucide-react";

/** Below this much pointer travel a release still counts as a backdrop click. */
const CLICK_SLOP = 4;
/** The breathing room the fitted image keeps against the window's edges. */
const GUTTER = 24;
const ZOOM_STEP = 0.1;
const MAX_SCALE = 2;
/** However narrow the window gets, the image stays visible. */
const MIN_SCALE = 0.05;

interface PaneSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The largest scale that keeps the whole image inside the pane, never above
 * full size -- blowing a small image up past its own pixels only blurs it. An
 * unmeasured pane (jsdom, the frame before layout) imposes no fit at all. The
 * result can fall below `MIN_SCALE`, which is how the caller learns that even
 * the fitted image will not be contained.
 */
function containScaleFor(pane: PaneSize, width: number, height: number): number {
  if (pane.width <= 0 || pane.height <= 0) return 1;
  return Math.min(
    1,
    (pane.width - GUTTER * 2) / width,
    (pane.height - GUTTER * 2) / height
  );
}

/** The pane the fit is measured against, kept in step with its own size. */
function usePaneSize(ref: RefObject<HTMLElement | null>): PaneSize {
  const [size, setSize] = useState<PaneSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSize((current) =>
      current.width === element.clientWidth &&
      current.height === element.clientHeight
        ? current
        : { width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export function ImageLightbox({
  originalName,
  sourceUrl,
  pixelWidth,
  pixelHeight,
  returnFocusRef,
  onClose
}: {
  readonly originalName: string;
  readonly sourceUrl: string;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly startLeft: number;
    readonly startTop: number;
  } | null>(null);
  const movedRef = useRef(0);
  // Pointer capture retargets the click that follows a drag to the capturing
  // container, so the click cannot see whether the press landed on the image.
  // The press target decides instead.
  const pressedBackdropRef = useRef(false);
  const [panning, setPanning] = useState(false);
  const [quarterTurns, setQuarterTurns] = useState(0);
  // `null` is "whatever fits" -- the one scale that has to follow the pane
  // through a resize or a turn instead of being recomputed by hand.
  const [requestedScale, setRequestedScale] = useState<number | null>(null);
  const pane = usePaneSize(scrollRef);

  const sideways = quarterTurns % 2 === 1;
  const shownWidth = sideways ? pixelHeight : pixelWidth;
  const shownHeight = sideways ? pixelWidth : pixelHeight;
  const containScale = containScaleFor(pane, shownWidth, shownHeight);
  const fitScale = Math.max(MIN_SCALE, containScale);
  const scale = Math.min(
    MAX_SCALE,
    Math.max(fitScale, requestedScale ?? fitScale)
  );
  // The floor leaves an enormous image larger than the pane, and then there is
  // something to pan after all -- fitting is not the same as being contained.
  const contained = scale <= fitScale && containScale >= MIN_SCALE;
  const followingFit = requestedScale === null;

  /**
   * Stepping down lands back ON the fit rather than beside it. The ladder is in
   * whole percents and the fit rarely is, so the test is what the bar shows: a
   * step that reads as the fitted percentage IS the fit, and goes back to
   * following the pane instead of freezing a hundredth above it.
   */
  const zoomBy = (delta: number) => {
    const next = Math.round((scale + delta) * 100) / 100;
    const readsAsFit = Math.round(next * 100) <= Math.round(fitScale * 100);
    setRequestedScale(readsAsFit ? null : next);
  };
  const turnBy = (quarters: number) =>
    setQuarterTurns((current) => (current + quarters + 4) % 4);

  const liveFocusables = useCallback((): readonly HTMLElement[] => {
    const dialog = dialogRef.current;
    return dialog
      ? [...dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [tabindex='0']"
      )]
      : [];
  }, []);

  useEffect(() => {
    const returnFocusTarget = returnFocusRef?.current;
    closeRef.current?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      // The controls, the scroll area and the close button all sit in the
      // dialog, so the trap walks whatever is live rather than two fixed ends.
      const live = liveFocusables();
      if (live.length === 0) return;
      event.preventDefault();
      const step = event.shiftKey ? -1 : 1;
      // A control that disabled itself under the last press drops focus to the
      // document; the image is the neutral place to pick the walk back up.
      const at = live.indexOf(document.activeElement as HTMLElement);
      if (at < 0) {
        scrollRef.current?.focus();
        return;
      }
      live[(at + step + live.length) % live.length]?.focus();
    };
    document.addEventListener("keydown", keyDown);
    return () => {
      document.removeEventListener("keydown", keyDown);
      returnFocusTarget?.focus();
    };
  }, [liveFocusables, onClose, returnFocusRef]);

  const endPan = (pointerId: number) => {
    if (panRef.current?.pointerId !== pointerId) return;
    panRef.current = null;
    setPanning(false);
  };
  return createPortal(
    <>
      <div className="notes-image-lightbox-backdrop" aria-hidden="true" />
      <div
        ref={dialogRef}
        className="notes-image-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label={originalName}
      >
        <div className="notes-image-lightbox-bar">
          <span className="notes-image-lightbox-name">{originalName}</span>
          <span className="notes-image-lightbox-dims">
            {pixelWidth} × {pixelHeight} · {Math.round(scale * 100)}%
          </span>
          <span className="notes-image-lightbox-controls">
            <button
              type="button"
              className="notes-image-lightbox-control"
              aria-label="Rotate left"
              onClick={() => turnBy(-1)}
            >
              <RotateCcw size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="notes-image-lightbox-control"
              aria-label="Rotate right"
              onClick={() => turnBy(1)}
            >
              <RotateCw size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="notes-image-lightbox-control"
              aria-label="Zoom out"
              disabled={contained}
              onClick={() => zoomBy(-ZOOM_STEP)}
            >
              <Minus size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="notes-image-lightbox-control"
              aria-label="Zoom in"
              disabled={scale >= MAX_SCALE}
              onClick={() => zoomBy(ZOOM_STEP)}
            >
              <Plus size={16} aria-hidden="true" />
            </button>
            {/* Names the scale it switches to, so its label is its own action.
                Off only when the fit and full size are the same scale AND the
                view is already there -- a zoomed small image still has a way
                back. */}
            <button
              type="button"
              className="notes-image-lightbox-control notes-image-lightbox-fit"
              title={followingFit ? "View at full size" : "Fit to window"}
              disabled={fitScale >= 1 && scale <= 1}
              onClick={() => setRequestedScale(followingFit ? 1 : null)}
            >
              {followingFit ? "100%" : "Fit"}
            </button>
          </span>
        </div>
        <div
          ref={scrollRef}
          className="notes-image-lightbox-scroll"
          role="group"
          aria-label={`Scrollable view of ${originalName}`}
          tabIndex={0}
          data-fits={contained ? "true" : undefined}
          data-panning={panning ? "true" : undefined}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            // The press stops image-drag selection, and with it the focus the
            // browser would have given the area, so arrow scrolling takes it
            // back explicitly.
            event.preventDefault();
            event.currentTarget.focus();
            movedRef.current = 0;
            pressedBackdropRef.current = event.target === event.currentTarget;
            // Nothing to drag while the whole image is on screen.
            if (contained) return;
            panRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              startLeft: event.currentTarget.scrollLeft,
              startTop: event.currentTarget.scrollTop
            };
            setPanning(true);
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const pan = panRef.current;
            if (!pan || pan.pointerId !== event.pointerId) return;
            const dx = event.clientX - pan.startX;
            const dy = event.clientY - pan.startY;
            movedRef.current = Math.max(movedRef.current, Math.hypot(dx, dy));
            event.currentTarget.scrollLeft = pan.startLeft - dx;
            event.currentTarget.scrollTop = pan.startTop - dy;
          }}
          onPointerUp={(event) => endPan(event.pointerId)}
          onPointerCancel={(event) => endPan(event.pointerId)}
          onClick={() => {
            if (pressedBackdropRef.current && movedRef.current < CLICK_SLOP) {
              onClose();
            }
          }}
        >
          {/* The stage is the box the turned image occupies, so the scroller
              measures the rotation rather than the file's own shape. */}
          <div
            className="notes-image-lightbox-stage"
            style={{
              width: Math.round(shownWidth * scale),
              height: Math.round(shownHeight * scale)
            }}
          >
            <img
              className="notes-image-lightbox-image"
              src={sourceUrl}
              alt={originalName}
              width={pixelWidth}
              height={pixelHeight}
              draggable={false}
              style={{
                width: Math.round(pixelWidth * scale),
                height: Math.round(pixelHeight * scale),
                transform:
                  `translate(-50%, -50%) rotate(${quarterTurns * 90}deg)`
              }}
            />
          </div>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="icon-button notes-image-lightbox-close"
          aria-label="Close full-screen image"
          onClick={onClose}
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>
    </>,
    document.body
  );
}
