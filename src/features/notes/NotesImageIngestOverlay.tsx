import type { NoteId } from "../../domain/notes";
import { useNotesAssetIngestProgress } from "./useNotesAssetIngestProgress";

/**
 * C4: a minimal percent overlay shown on an image placeholder while its bytes
 * are being ingested. Hidden when idle (and for dedup hits, which resolve to
 * "done" immediately). Batches also show "file i/N" because the backend reports
 * per-file byte totals rather than a batch total.
 */
export function NotesImageIngestOverlay({ nodeId }: { readonly nodeId: NoteId }) {
  const overlay = useNotesAssetIngestProgress(nodeId);
  if (!overlay) {
    return null;
  }
  return (
    <div
      className="notes-image-ingest-overlay"
      role="status"
      aria-live="polite"
    >
      <span className="notes-image-ingest-overlay-percent">
        {overlay.percent}%
      </span>
      {overlay.fileCount > 1 && (
        <span className="notes-image-ingest-overlay-count">
          {`file ${overlay.fileIndex}/${overlay.fileCount}`}
        </span>
      )}
    </div>
  );
}
