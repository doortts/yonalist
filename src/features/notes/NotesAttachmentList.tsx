import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import {
  MAX_NOTE_ATTACHMENTS_PER_NODE,
  type NoteAttachment,
  type NoteId
} from "../../domain/notes";
import { NotesImageAttachment } from "./NotesImageAttachment";
import { useNotesWorkspaceContext } from "./NotesWorkspaceContext";

interface NotesAttachmentListProps {
  readonly nodeId: NoteId;
  readonly attachments: readonly NoteAttachment[];
  readonly uploadError?: string;
  readonly className?: string;
  readonly readOnly?: boolean;
}

function DeferredNotesImage({
  attachment,
  onRequestRemove,
  readOnly
}: {
  readonly attachment: NoteAttachment;
  readonly onRequestRemove?: () => void;
  readonly readOnly: boolean;
}) {
  const { actions } = useNotesWorkspaceContext();
  const placeholderRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const placeholder = placeholderRef.current;
    if (active || !placeholder || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setActive(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(placeholder);
    return () => observer.disconnect();
  }, [active]);

  const loadBytes = useCallback(() => {
    if (!actions.loadAttachmentBytes) {
      return Promise.reject(new Error("Image loading is unavailable."));
    }
    return actions.loadAttachmentBytes(attachment.id);
  }, [actions, attachment.id]);
  const commitWidth = useCallback(
    (displayWidth: number) => {
      void actions.resizeImage?.(attachment.id, displayWidth);
    },
    [actions, attachment.id]
  );

  if (active) {
    return (
      <NotesImageAttachment
        attachment={attachment}
        loadBytes={loadBytes}
        onDisplayWidthCommit={commitWidth}
        onRemove={onRequestRemove}
        readOnly={readOnly}
      />
    );
  }

  return (
    <div
      ref={placeholderRef}
      className="notes-image-attachment-placeholder"
      role="group"
      aria-label={`Image: ${attachment.originalName}`}
      style={{
        maxWidth: attachment.intrinsicWidth,
        aspectRatio: `${attachment.intrinsicWidth} / ${attachment.intrinsicHeight}`
      }}
    >
      <button
        type="button"
        className="text-button"
        aria-label={`Load image ${attachment.originalName}`}
        onClick={() => setActive(true)}
      >
        Load image
      </button>
    </div>
  );
}

export function NotesAttachmentList({
  nodeId,
  attachments,
  uploadError,
  className,
  readOnly = false
}: NotesAttachmentListProps) {
  const { actions } = useNotesWorkspaceContext();
  const [pendingRemoval, setPendingRemoval] =
    useState<NoteAttachment | null>(null);
  const classes = ["notes-attachment-list", className]
    .filter(Boolean)
    .join(" ");
  const boundedAttachments = attachments.slice(
    0,
    MAX_NOTE_ATTACHMENTS_PER_NODE
  );

  if (attachments.length === 0 && !uploadError) {
    return null;
  }

  return (
    <>
      {boundedAttachments.length > 0 && (
        <div className={classes}>
          {boundedAttachments.map((attachment) => (
            <DeferredNotesImage
              attachment={attachment}
              key={attachment.id}
              readOnly={readOnly}
              onRequestRemove={
                readOnly ? undefined : () => setPendingRemoval(attachment)
              }
            />
          ))}
        </div>
      )}
      {uploadError && (
        <div
          className="notes-attachment-error"
          role="alert"
          aria-label="Image upload failed"
        >
          <span>{uploadError}</span>
          {!readOnly && actions.retryImageUpload && (
            <button
              type="button"
              className="text-button"
              onClick={() => void actions.retryImageUpload?.(nodeId)}
            >
              Retry image upload
            </button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        title="Remove image?"
        description={
          pendingRemoval
            ? `Remove ${pendingRemoval.originalName} from this note?`
            : "Remove this image from the note?"
        }
        confirmLabel="Remove image"
        cancelLabel="Cancel"
        danger
        onConfirm={() => {
          const attachmentId = pendingRemoval?.id;
          setPendingRemoval(null);
          if (attachmentId) void actions.removeImage?.(attachmentId);
        }}
      />
    </>
  );
}
