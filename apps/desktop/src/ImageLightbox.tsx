import {
  useEffect,
  useRef,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

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
  return createPortal(
    <>
      <div className="notes-image-lightbox-backdrop" aria-hidden="true" />
      <div
        className="notes-image-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label={originalName}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <button
          ref={closeRef}
          type="button"
          className="icon-button notes-image-lightbox-close"
          aria-label="Close full-screen image"
          onClick={onClose}
        >
          <X size={20} aria-hidden="true" />
        </button>
        <img
          className="notes-image-lightbox-image"
          src={sourceUrl}
          alt={originalName}
          width={pixelWidth}
          height={pixelHeight}
          draggable={false}
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    </>,
    document.body
  );
}
