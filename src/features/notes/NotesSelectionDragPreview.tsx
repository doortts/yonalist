export function NotesSelectionDragPreview({
  labels,
  total,
  thumbnailSrc
}: {
  labels: readonly string[];
  total: number;
  thumbnailSrc?: string;
}) {
  const multiple = total > 1;

  return (
    <div
      className="notes-selection-drag-preview"
      data-testid="notes-selection-drag-preview"
      data-multiple={multiple ? "true" : undefined}
      data-thumbnail={thumbnailSrc ? "true" : undefined}
      aria-hidden="true"
    >
      <div className="notes-selection-drag-preview-stack">
        <div
          className="notes-selection-drag-preview-row"
          data-thumbnail={thumbnailSrc ? "true" : undefined}
        >
          {thumbnailSrc ? (
            <img
              className="notes-selection-drag-preview-thumbnail"
              data-testid="notes-selection-drag-thumbnail"
              src={thumbnailSrc}
              alt=""
              draggable={false}
            />
          ) : (
            labels[0] || "Untitled"
          )}
        </div>
      </div>
      {multiple && (
        <span className="notes-selection-drag-preview-count">{total}</span>
      )}
    </div>
  );
}
