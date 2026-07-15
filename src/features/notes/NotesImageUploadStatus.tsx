import type { NoteId } from "../../domain/notes";
import { useNotesActions } from "./NotesWorkspaceContext";

interface NotesImageUploadStatusProps {
  readonly nodeId: NoteId;
  readonly uploadError?: string;
  readonly uploadRetryAttemptId?: string;
  readonly readOnly?: boolean;
}

export function NotesImageUploadStatus({
  nodeId,
  uploadError,
  uploadRetryAttemptId,
  readOnly = false
}: NotesImageUploadStatusProps) {
  const { actions } = useNotesActions();

  if (!uploadError) {
    return null;
  }

  const canRetryUpload =
    Boolean(uploadRetryAttemptId) || uploadError.startsWith("Image picker failed:");

  return (
    <div
      className="notes-attachment-error"
      role="alert"
      aria-label="Image upload failed"
    >
      <span>{uploadError}</span>
      {!readOnly && canRetryUpload && actions.retryImageUpload && (
        <button
          type="button"
          className="text-button"
          onClick={() =>
            void actions.retryImageUpload?.(nodeId, uploadRetryAttemptId)
          }
        >
          Retry image upload
        </button>
      )}
    </div>
  );
}
