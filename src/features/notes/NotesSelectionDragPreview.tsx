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
        {labels.slice(0, 3).map((label, index) => (
          <div
            className="notes-selection-drag-preview-row"
            key={`${index}:${label}`}
          >
            {label || "Untitled"}
          </div>
        ))}
      </div>
      <span className="notes-selection-drag-preview-count">
        {total} selected
      </span>
    </div>
  );
}
