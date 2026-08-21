import type { CSSProperties } from "react";

export function OutlineDragPreview({
  labels,
  total,
  x,
  y
}: {
  readonly labels: readonly string[];
  readonly total: number;
  readonly x: number;
  readonly y: number;
}) {
  const multiple = total > 1;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        pointerEvents: "none",
        transform: `translate3d(${x + 12}px, ${y + 12}px, 0)`
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
