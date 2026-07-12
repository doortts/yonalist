import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { ImagePlus } from "lucide-react";
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
  readonly showDropPlaceholder?: boolean;
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
  const observerGenerationRef = useRef(0);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingRelease = useCallback(() => {
    if (releaseTimerRef.current !== null) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot || typeof IntersectionObserver === "undefined") {
      return;
    }

    const generation = observerGenerationRef.current + 1;
    observerGenerationRef.current = generation;
    let disposed = false;
    const isCurrent = () =>
      !disposed && observerGenerationRef.current === generation;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!isCurrent()) return;
        const entry = entries.find((candidate) => candidate.target === slot);
        if (!entry) return;
        if (entry.isIntersecting) {
          cancelPendingRelease();
          onActivate(attachment.id);
          return;
        }
        cancelPendingRelease();
        releaseTimerRef.current = setTimeout(() => {
          releaseTimerRef.current = null;
          if (isCurrent()) onDeactivate(attachment.id);
        }, offscreenReleaseDelayMs);
      },
      { rootMargin: "160px 0px" }
    );
    observer.observe(slot);
    return () => {
      disposed = true;
      if (observerGenerationRef.current === generation) {
        observerGenerationRef.current = generation + 1;
      }
      cancelPendingRelease();
      observer.disconnect();
    };
  }, [attachment.id, cancelPendingRelease, onActivate, onDeactivate]);

  useLayoutEffect(() => {
    if (!active) return;
    cancelPendingRelease();
    if (manualFocusPendingRef.current) {
      manualFocusPendingRef.current = false;
      slotRef.current?.focus();
    }
  }, [active, cancelPendingRelease]);

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
              cancelPendingRelease();
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
  readOnly = false,
  showDropPlaceholder = false
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

  useEffect(() => {
    const currentAttachmentIds = new Set(
      boundedAttachments.map((attachment) => attachment.id)
    );
    setResidentAttachmentIds((current) => {
      const next = current.filter((attachmentId) =>
        currentAttachmentIds.has(attachmentId)
      );
      return next.length === current.length ? current : next;
    });
    // boundedAttachments is a fresh slice of attachments each render; depend on
    // the source prop so this prune runs on real changes, not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments]);

  if (attachments.length === 0 && !uploadError && !showDropPlaceholder) {
    return null;
  }

  return (
    <>
      {(boundedAttachments.length > 0 || showDropPlaceholder) && (
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
          {showDropPlaceholder && (
            <div
              className="notes-image-drop-placeholder"
              data-testid="notes-image-drop-placeholder"
              aria-hidden="true"
            >
              <ImagePlus size={20} aria-hidden="true" />
            </div>
          )}
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
