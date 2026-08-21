import type { CSSProperties } from "react";
import { dragPreviewOffset } from "./dragPreviewOffset";

export function OutlineDragPreview({
  labels,
  total,
  x,
  y,
  pointerType
}: {
  readonly labels: readonly string[];
  readonly total: number;
  readonly x: number;
  readonly y: number;
  readonly pointerType?: string;
}) {
  const multiple = total > 1;
  const offset = dragPreviewOffset(pointerType);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        pointerEvents: "none",
        transform: `translate3d(${x + offset.x}px, ${y + offset.y}px, 0)`
      } as CSSProperties}
    >
      <div
        className="notes-selection-drag-preview"
        data-testid="notes-selection-drag-preview"
        data-multiple={multiple ? "true" : undefined}
        aria-hidden="true"
      >
        <div className="notes-selection-drag-preview-stack">
          <div className="notes-selection-drag-preview-row">
            {labels[0] || "Untitled"}
          </div>
        </div>
        {multiple && (
          <span className="notes-selection-drag-preview-count">{total}</span>
        )}
      </div>
    </div>
  );
}
