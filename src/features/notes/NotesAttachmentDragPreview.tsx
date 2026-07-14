import { FileImage } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { NotesLogicalPoint } from "./notesAttachmentController";

interface NotesAttachmentDragPreviewProps {
  readonly paths: readonly string[];
  readonly position: NotesLogicalPoint;
  readonly portalContainer?: Element;
}

const pointerOffsetPx = 14;
const viewportInsetPx = 8;

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function clampToViewport(value: number, extent: number, viewport: number) {
  const maximum = Math.max(viewportInsetPx, viewport - extent - viewportInsetPx);
  return Math.min(Math.max(value, viewportInsetPx), maximum);
}

export function NotesAttachmentDragPreview({
  paths,
  position,
  portalContainer
}: NotesAttachmentDragPreviewProps) {
  const previewRef = useRef<HTMLDivElement>(null);
  const previewExtentRef = useRef({ width: 0, height: 0 });
  const firstPath = paths[0];
  const fileName = firstPath ? fileNameFromPath(firstPath) : "";
  const additionalCount = Math.max(0, paths.length - 1);
  const desiredLeft = position.x + pointerOffsetPx;
  const desiredTop = position.y + pointerOffsetPx;
  const desiredPositionRef = useRef({ left: desiredLeft, top: desiredTop });
  desiredPositionRef.current = { left: desiredLeft, top: desiredTop };

  useLayoutEffect(() => {
    const measureAndPosition = () => {
      const preview = previewRef.current;
      if (!preview) return;

      const bounds = preview.getBoundingClientRect();
      previewExtentRef.current = {
        width: bounds.width,
        height: bounds.height
      };
      const desired = desiredPositionRef.current;
      preview.style.left = `${clampToViewport(
        desired.left,
        previewExtentRef.current.width,
        window.innerWidth
      )}px`;
      preview.style.top = `${clampToViewport(
        desired.top,
        previewExtentRef.current.height,
        window.innerHeight
      )}px`;
    };

    measureAndPosition();
    window.addEventListener("resize", measureAndPosition);
    return () => window.removeEventListener("resize", measureAndPosition);
  }, [fileName, additionalCount]);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;

    preview.style.left = `${clampToViewport(
      desiredLeft,
      previewExtentRef.current.width,
      window.innerWidth
    )}px`;
    preview.style.top = `${clampToViewport(
      desiredTop,
      previewExtentRef.current.height,
      window.innerHeight
    )}px`;
  }, [desiredLeft, desiredTop]);

  if (!firstPath) return null;

  return createPortal(
    <div
      ref={previewRef}
      className="notes-attachment-drag-preview"
      data-testid="notes-attachment-drag-preview"
      aria-hidden="true"
      style={{ left: desiredLeft, top: desiredTop }}
    >
      <FileImage size={14} aria-hidden="true" />
      <span className="notes-attachment-drag-preview-name">{fileName}</span>
      {additionalCount > 0 && (
        <span className="notes-attachment-drag-preview-count">
          +{additionalCount}
        </span>
      )}
    </div>,
    portalContainer ?? document.body
  );
}
