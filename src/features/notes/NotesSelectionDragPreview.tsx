export function NotesSelectionDragPreview({
  labels,
  total
}: {
  labels: readonly string[];
  total: number;
}) {
  return (
    <div
      className="notes-selection-drag-preview"
      data-testid="notes-selection-drag-preview"
      aria-hidden="true"
    >
      <div className="notes-selection-drag-preview-stack">
        <div className="notes-selection-drag-preview-row">
          {labels[0] || "Untitled"}
        </div>
      </div>
      <span className="notes-selection-drag-preview-count">{total}</span>
    </div>
  );
}
