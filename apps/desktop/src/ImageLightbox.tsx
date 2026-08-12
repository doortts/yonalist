import {
  useEffect,
  useRef,
  useState,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/** Below this much pointer travel a release still counts as a backdrop click. */
const CLICK_SLOP = 4;

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
  const closeRef = useRef<HTMLButtonElement>(null);
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
  useEffect(() => {
    const returnFocusTarget = returnFocusRef?.current;
    closeRef.current?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener("keydown", keyDown);
    return () => {
      document.removeEventListener("keydown", keyDown);
      returnFocusTarget?.focus();
    };
  }, [onClose, returnFocusRef]);
  const endPan = (pointerId: number) => {
    if (panRef.current?.pointerId !== pointerId) return;
    panRef.current = null;
    setPanning(false);
  };
  return createPortal(
    <>
      <div className="notes-image-lightbox-backdrop" aria-hidden="true" />
      <div
        className="notes-image-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label={originalName}
      >
        <div className="notes-image-lightbox-bar">
          <span className="notes-image-lightbox-name">{originalName}</span>
          <span className="notes-image-lightbox-dims">
            {pixelWidth} × {pixelHeight}
          </span>
        </div>
        <div
          className="notes-image-lightbox-scroll"
          data-panning={panning ? "true" : undefined}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            movedRef.current = 0;
            pressedBackdropRef.current = event.target === event.currentTarget;
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
          <img
            className="notes-image-lightbox-image"
            src={sourceUrl}
            alt={originalName}
            width={pixelWidth}
            height={pixelHeight}
            draggable={false}
          />
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
