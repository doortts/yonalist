import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { AppNavigationContext } from "../../AppNavigationContext";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import {
  MAX_NOTE_ATTACHMENTS_PER_NODE,
  type NoteAttachment,
  type NoteId
} from "../../domain/notes";
import {
  NotesImageActionFailureStatus,
  NotesImageAttachment,
  useNotesImageActionFailureController
} from "./NotesImageAttachment";
import { NotesImageMenu } from "./NotesImageMenu";
import { useNotesImageResidencyLease } from "./NotesImageResidencyContext";
import { NotesImageUploadStatus } from "./NotesImageUploadStatus";
import { useNotesActions } from "./NotesWorkspaceContext";

interface NotesAttachmentListProps {
  readonly nodeId: NoteId;
  readonly attachments: readonly NoteAttachment[];
  readonly uploadError?: string;
  readonly uploadRetryAttemptId?: string;
  readonly className?: string;
  readonly readOnly?: boolean;
}

const offscreenReleaseDelayMs = 240;

function DeferredNotesImage({
  attachment,
  onRequestRemove,
  readOnly
}: {
  readonly attachment: NoteAttachment;
  readonly onRequestRemove?: () => void;
  readonly readOnly: boolean;
}) {
  const appNavigation = useContext(AppNavigationContext);
  const { actions } = useNotesActions();
  const {
    active,
    activate: activateResidency,
    deactivate: deactivateResidency
  } = useNotesImageResidencyLease();
  const slotRef = useRef<HTMLDivElement>(null);
  const actionFailureController =
    useNotesImageActionFailureController(attachment.id);
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
          activateResidency();
          return;
        }
        cancelPendingRelease();
        releaseTimerRef.current = setTimeout(() => {
          releaseTimerRef.current = null;
          if (isCurrent()) deactivateResidency();
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
  }, [
    attachment.id,
    activateResidency,
    cancelPendingRelease,
    deactivateResidency
  ]);

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
  const viewOriginal = useCallback(() => {
    return actions.viewImageOriginal?.(attachment.id) ?? Promise.resolve();
  }, [actions, attachment.id]);
  const downloadImage = useCallback(() => {
    return actions.downloadImage?.(
      attachment.id,
      attachment.originalName,
      attachment.mimeType
    ) ?? Promise.resolve();
  }, [
    actions,
    attachment.id,
    attachment.mimeType,
    attachment.originalName
  ]);
  const openImageSettings = useCallback(
    () => appNavigation?.openSettings("notes", "images"),
    [appNavigation]
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
          actionFailureController={actionFailureController}
          renderActionFailureStatus={false}
          onDisplayWidthCommit={commitWidth}
          onRemove={onRequestRemove}
          onViewOriginal={actions.viewImageOriginal ? viewOriginal : undefined}
          onDownload={actions.downloadImage ? downloadImage : undefined}
          readOnly={readOnly}
        />
      ) : (
        <div
          className="notes-image-attachment-placeholder"
          style={{
            width: attachment.displayWidth,
            maxWidth: "100%",
            minHeight: 0,
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
              activateResidency();
            }}
          >
            Load image
          </button>
          <NotesImageMenu
            originalName={attachment.originalName}
            onViewOriginal={actionFailureController.bindViewOriginal(
              actions.viewImageOriginal ? viewOriginal : undefined
            )}
            onDownload={actionFailureController.bindDownload(
              actions.downloadImage ? downloadImage : undefined
            )}
            onDelete={readOnly ? undefined : onRequestRemove}
            onOpenSettings={appNavigation ? openImageSettings : undefined}
          />
        </div>
      )}
      <NotesImageActionFailureStatus
        failure={actionFailureController.failure}
        maxWidth={attachment.displayWidth}
      />
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
  const { actions } = useNotesActions();
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
      <NotesImageUploadStatus
        nodeId={nodeId}
        uploadError={uploadError}
        uploadRetryAttemptId={uploadRetryAttemptId}
        readOnly={readOnly}
      />
      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        title="Remove image?"
        description="Remove this image from the note?"
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
