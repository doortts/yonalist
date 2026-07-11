import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
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
  readonly uploadRetryAttemptId?: string;
  readonly className?: string;
  readonly readOnly?: boolean;
}

const maxResidentImages = 8;
const offscreenReleaseDelayMs = 240;

function DeferredNotesImage({
  attachment,
  active,
  onActivate,
  onDeactivate,
  onRequestRemove,
  readOnly
}: {
  readonly attachment: NoteAttachment;
  readonly active: boolean;
  readonly onActivate: (attachmentId: string) => void;
  readonly onDeactivate: (attachmentId: string) => void;
  readonly onRequestRemove?: () => void;
  readonly readOnly: boolean;
}) {
  const { actions } = useNotesWorkspaceContext();
  const slotRef = useRef<HTMLDivElement>(null);
  const manualFocusPendingRef = useRef(false);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot || typeof IntersectionObserver === "undefined") {
      return;
    }

    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelRelease = () => {
      if (releaseTimer !== null) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.find((candidate) => candidate.target === slot);
        if (!entry) return;
        if (entry.isIntersecting) {
          cancelRelease();
          onActivate(attachment.id);
          return;
        }
        cancelRelease();
        releaseTimer = setTimeout(
          () => onDeactivate(attachment.id),
          offscreenReleaseDelayMs
        );
      },
      { rootMargin: "160px 0px" }
    );
    observer.observe(slot);
    return () => {
      cancelRelease();
      observer.disconnect();
    };
  }, [attachment.id, onActivate, onDeactivate]);

  useLayoutEffect(() => {
    if (!active || !manualFocusPendingRef.current) return;
    manualFocusPendingRef.current = false;
    slotRef.current?.focus();
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

  return (
    <div
      ref={slotRef}
      className="notes-image-attachment-slot"
      role="group"
      aria-label={`Image: ${attachment.originalName}`}
      tabIndex={active ? -1 : undefined}
      style={{ maxWidth: attachment.intrinsicWidth }}
    >
      {active ? (
        <NotesImageAttachment
          attachment={attachment}
          embedded
          loadBytes={loadBytes}
          onDisplayWidthCommit={commitWidth}
          onRemove={onRequestRemove}
          readOnly={readOnly}
        />
      ) : (
        <div
          className="notes-image-attachment-placeholder"
          style={{
            aspectRatio: `${attachment.intrinsicWidth} / ${attachment.intrinsicHeight}`
          }}
        >
          <button
            type="button"
            className="text-button"
            aria-label={`Load image ${attachment.originalName}`}
            onClick={() => {
              manualFocusPendingRef.current = true;
              onActivate(attachment.id);
            }}
          >
            Load image
          </button>
        </div>
      )}
    </div>
  );
}

export function NotesAttachmentList({
  nodeId,
  attachments,
  uploadError,
  uploadRetryAttemptId,
  className,
  readOnly = false
}: NotesAttachmentListProps) {
  const { actions } = useNotesWorkspaceContext();
  const [pendingRemoval, setPendingRemoval] =
    useState<NoteAttachment | null>(null);
  const [residentAttachmentIds, setResidentAttachmentIds] = useState<
    readonly string[]
  >([]);
  const activateAttachment = useCallback((attachmentId: string) => {
    setResidentAttachmentIds((current) => {
      const next = current.filter((currentId) => currentId !== attachmentId);
      next.push(attachmentId);
      return next.slice(-maxResidentImages);
    });
  }, []);
  const deactivateAttachment = useCallback((attachmentId: string) => {
    setResidentAttachmentIds((current) =>
      current.includes(attachmentId)
        ? current.filter((currentId) => currentId !== attachmentId)
        : current
    );
  }, []);
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
              active={residentAttachmentIds.includes(attachment.id)}
              attachment={attachment}
              key={attachment.id}
              onActivate={activateAttachment}
              onDeactivate={deactivateAttachment}
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
          {!readOnly && uploadRetryAttemptId && actions.retryImageUpload && (
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
