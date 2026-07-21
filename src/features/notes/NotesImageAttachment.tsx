import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { AppNavigationContext } from "../../AppNavigationContext";
import type { NoteAttachment, NoteId } from "../../domain/notes";
import { NotesImageIngestOverlay } from "./NotesImageIngestOverlay";
import { NotesImageLightbox } from "./NotesImageLightbox";
import { NotesImageMenu } from "./NotesImageMenu";
import {
  useNotesImageByteLease,
  useNotesImageResidencyLease
} from "./NotesImageResidencyContext";
import { useNotesActions } from "./NotesWorkspaceContext";

const preferredMinimumWidth = 160;
const keyboardResizeStep = 16;
const offscreenReleaseDelayMs = 240;
const supportedMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

export interface NotesImageAttachmentMetadata {
  readonly id: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
  readonly displayWidth: number;
}

export type NotesImageByteLoader = () => Promise<Uint8Array>;

export interface NotesImageAttachmentProps {
  readonly attachment: NotesImageAttachmentMetadata;
  readonly bytes?: Uint8Array;
  readonly loadBytes?: NotesImageByteLoader;
  readonly presentationLabel?: string;
  readonly actionFailureController?: NotesImageActionFailureController;
  readonly renderActionFailureStatus?: boolean;
  readonly onDisplayWidthCommit: (displayWidth: number) => void;
  readonly onRemove?: () => void;
  readonly deleteLabel?: string;
  readonly showRemove?: boolean;
  readonly onViewOriginal?: () => void | Promise<void>;
  readonly onDownload?: () => void | Promise<void>;
  readonly onOpenSettings?: () => void;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
  readonly embedded?: boolean;
}

export interface NotesImageNodeContentProps {
  readonly nodeId: NoteId;
  readonly attachment: NoteAttachment | undefined;
  readonly originalName?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly contentRef?: Ref<HTMLDivElement>;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onEscape?: () => boolean;
  readonly onFrameInlineSizeChange?: (inlineSize: number) => void;
  readonly onRemoveImage?: () => void;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
}

interface WidthLimits {
  readonly minimum: number;
  readonly maximum: number;
}

interface InteractionIdentity {
  readonly attachmentId: string;
  readonly bytes: Uint8Array | undefined;
  readonly loadBytes: NotesImageByteLoader | undefined;
  readonly mimeType: string;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
  readonly commit: (displayWidth: number) => void;
  readonly startingPersistedWidth: number;
}

interface PointerResize extends InteractionIdentity {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
  readonly element: HTMLDivElement;
  proposedWidth: number;
}

interface KeyboardResize extends InteractionIdentity {
  readonly startWidth: number;
  proposedWidth: number;
}

type ImageSourceState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly objectUrl: string }
  | { readonly status: "error" };

export type NotesImageAction = () => void | Promise<void>;

export interface NotesImageActionFailure {
  readonly message: string;
  readonly retry: () => void;
}

export interface NotesImageActionFailureController {
  readonly failure: NotesImageActionFailure | null;
  readonly bindViewOriginal: (
    action: NotesImageAction | undefined
  ) => (() => void) | undefined;
  readonly bindDownload: (
    action: NotesImageAction | undefined
  ) => (() => void) | undefined;
}

interface NotesImageActionControllerIdentity {
  readonly identity: string;
  readonly viewOriginalAction: unknown;
  readonly downloadAction: unknown;
}

const viewOriginalFailureMessage = "Could not open the original image.";
const downloadFailureMessage = "Could not download the image.";

const groupStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  minWidth: 0
};

const frameBaseStyle: CSSProperties = {
  position: "relative",
  maxWidth: "100%",
  overflow: "hidden",
  borderRadius: 6,
  background: "var(--bg-hover)",
  boxShadow: "inset 0 0 0 1px var(--border)"
};

const invalidFrameStyle: CSSProperties = {
  ...frameBaseStyle,
  width: "100%",
  minHeight: 96
};

const imageStyle: CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  objectFit: "contain"
};

const fallbackStyle: CSSProperties = {
  display: "grid",
  width: "100%",
  height: "100%",
  placeItems: "center",
  padding: 12,
  color: "var(--text-3)",
  fontSize: 12,
  textAlign: "center"
};

const resizeHandleStyle: CSSProperties = {
  position: "absolute",
  zIndex: 2,
  top: 0,
  right: 0,
  width: 16,
  height: "100%",
  outlineOffset: -3,
  cursor: "ew-resize",
  touchAction: "none"
};

const resizeHandleLineStyle: CSSProperties = {
  position: "absolute",
  top: "20%",
  right: 4,
  width: 2,
  height: "60%",
  borderRadius: 1,
  background: "var(--border-strong)",
  pointerEvents: "none"
};

function widthLimits(
  intrinsicWidth: number,
  contentWidth: number | null
): WidthLimits {
  const availableWidth = contentWidth ?? intrinsicWidth;
  const maximum = Math.max(
    0,
    Math.floor(Math.min(intrinsicWidth, availableWidth))
  );

  return {
    minimum: Math.min(preferredMinimumWidth, maximum),
    maximum
  };
}

function clampWidth(width: number, limits: WidthLimits): number {
  const finiteWidth = Number.isFinite(width) ? width : limits.maximum;
  return Math.round(
    Math.min(limits.maximum, Math.max(limits.minimum, finiteWidth))
  );
}

export function isValidNotesImageAttachmentMetadata(
  attachment: NotesImageAttachmentMetadata
): boolean {
  return (
    supportedMimeTypes.has(attachment.mimeType) &&
    Number.isFinite(attachment.intrinsicWidth) &&
    attachment.intrinsicWidth > 0 &&
    Number.isFinite(attachment.intrinsicHeight) &&
    attachment.intrinsicHeight > 0
  );
}

function interactionMatches(
  interaction: InteractionIdentity,
  attachment: NotesImageAttachmentMetadata,
  bytes: Uint8Array | undefined,
  loadBytes: NotesImageByteLoader | undefined,
  commit: (displayWidth: number) => void
): boolean {
  return (
    interaction.attachmentId === attachment.id &&
    interaction.bytes === bytes &&
    interaction.loadBytes === loadBytes &&
    interaction.mimeType === attachment.mimeType &&
    interaction.intrinsicWidth === attachment.intrinsicWidth &&
    interaction.intrinsicHeight === attachment.intrinsicHeight &&
    interaction.commit === commit &&
    interaction.startingPersistedWidth === attachment.displayWidth
  );
}

function releaseCapturedPointer(resize: PointerResize) {
  try {
    const hasCapture =
      typeof resize.element.hasPointerCapture !== "function" ||
      resize.element.hasPointerCapture(resize.pointerId);
    if (hasCapture) resize.element.releasePointerCapture(resize.pointerId);
  } catch {
    // Pointer capture may already have been released by the browser.
  }
}

function placeholderSizeStyle(
  attachment: Pick<
    NotesImageAttachmentMetadata,
    "displayWidth" | "intrinsicWidth" | "intrinsicHeight"
  >
): CSSProperties {
  return {
    width: attachment.displayWidth,
    maxWidth: "100%",
    minHeight: 0,
    aspectRatio: `${attachment.intrinsicWidth} / ${attachment.intrinsicHeight}`
  };
}

export function useNotesImageActionFailureController(
  identity: string,
  viewOriginalAction: unknown = undefined,
  downloadAction: unknown = undefined
): NotesImageActionFailureController {
  const [failure, setFailure] = useState<NotesImageActionFailure | null>(null);
  const identityRef = useRef<NotesImageActionControllerIdentity>({
    identity,
    viewOriginalAction,
    downloadAction
  });
  const actionGenerationRef = useRef(0);
  if (
    identityRef.current.identity !== identity ||
    identityRef.current.viewOriginalAction !== viewOriginalAction ||
    identityRef.current.downloadAction !== downloadAction
  ) {
    identityRef.current = {
      identity,
      viewOriginalAction,
      downloadAction
    };
    actionGenerationRef.current += 1;
  }

  useEffect(() => {
    setFailure(null);
  }, [downloadAction, identity, viewOriginalAction]);

  const bind = useCallback(
    (
      action: NotesImageAction | undefined,
      failureMessage: string
    ): (() => void) | undefined => {
      if (!action) return undefined;
      const actionIdentity = identityRef.current;
      const run = () => {
        if (identityRef.current !== actionIdentity) return;
        const actionGeneration = actionGenerationRef.current + 1;
        actionGenerationRef.current = actionGeneration;
        setFailure(null);
        const reportFailure = () => {
          if (
            identityRef.current === actionIdentity &&
            actionGenerationRef.current === actionGeneration
          ) {
            setFailure({ message: failureMessage, retry: run });
          }
        };
        try {
          void Promise.resolve(action()).catch(reportFailure);
        } catch {
          reportFailure();
        }
      };
      return run;
    },
    []
  );
  const bindViewOriginal = useCallback(
    (action: NotesImageAction | undefined) =>
      bind(action, viewOriginalFailureMessage),
    [bind]
  );
  const bindDownload = useCallback(
    (action: NotesImageAction | undefined) =>
      bind(action, downloadFailureMessage),
    [bind]
  );

  return useMemo(
    () => ({ failure, bindViewOriginal, bindDownload }),
    [bindDownload, bindViewOriginal, failure]
  );
}

export function NotesImageActionFailureStatus({
  failure,
  maxWidth
}: {
  readonly failure: NotesImageActionFailure | null;
  readonly maxWidth?: number;
}) {
  if (!failure) return null;
  return (
    <div
      className="notes-attachment-error notes-image-action-error"
      role="alert"
      aria-label="Image action failed"
      style={{ maxWidth }}
    >
      <span>{failure.message}</span>
      <button type="button" className="text-button" onClick={failure.retry}>
        Retry
      </button>
    </div>
  );
}

export function NotesImageAttachment({
  attachment,
  bytes,
  loadBytes,
  presentationLabel,
  actionFailureController,
  renderActionFailureStatus = true,
  onDisplayWidthCommit,
  onRemove,
  deleteLabel,
  showRemove = true,
  onViewOriginal,
  onDownload,
  onOpenSettings,
  readOnly = false,
  disabled = false,
  embedded = false
}: NotesImageAttachmentProps) {
  const byteLease = useNotesImageByteLease();
  const appNavigation = useContext(AppNavigationContext);
  const openImageSettings = useCallback(
    () => appNavigation?.openSettings("notes", "images"),
    [appNavigation]
  );
  const resolvedOpenSettings =
    onOpenSettings ?? (appNavigation ? openImageSettings : undefined);
  const localActionFailureController = useNotesImageActionFailureController(
    attachment.id,
    onViewOriginal,
    onDownload
  );
  const actionController =
    actionFailureController ?? localActionFailureController;
  const accessibleLabel =
    presentationLabel?.trim() || attachment.originalName.trim() || "Image";
  const neutralPresentation = accessibleLabel === "Image";
  const groupLabel = neutralPresentation
    ? "Image"
    : `Image: ${accessibleLabel}`;
  const loadingLabel = neutralPresentation
    ? "Loading image"
    : `Loading image ${accessibleLabel}`;
  const unavailableLabel = neutralPresentation
    ? "Image unavailable"
    : `Image unavailable: ${accessibleLabel}`;
  const metadataValid = isValidNotesImageAttachmentMetadata(attachment);
  const groupRef = useRef<HTMLDivElement>(null);
  const pointerResizeRef = useRef<PointerResize | null>(null);
  const keyboardResizeRef = useRef<KeyboardResize | null>(null);
  const contentWidthRef = useRef<number | null>(null);
  const cancelActiveInteractionRef = useRef<() => void>(() => undefined);
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const [proposedWidth, setProposedWidth] = useState(attachment.displayWidth);
  const [source, setSource] = useState<ImageSourceState>({ status: "loading" });
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const limits = useMemo(
    () =>
      metadataValid
        ? widthLimits(attachment.intrinsicWidth, contentWidth)
        : null,
    [attachment.intrinsicWidth, contentWidth, metadataValid]
  );
  const renderedWidth = limits ? clampWidth(proposedWidth, limits) : 0;
  const renderedWidthRef = useRef(renderedWidth);
  renderedWidthRef.current = renderedWidth;
  const leaseLoadBytes = useCallback(() => {
    if (bytes) return Promise.resolve(bytes);
    if (loadBytes) return loadBytes();
    return Promise.reject(new Error("Image bytes are unavailable"));
  }, [bytes, loadBytes]);
  cancelActiveInteractionRef.current = () => {
    const pointerResize = pointerResizeRef.current;
    const keyboardResize = keyboardResizeRef.current;
    if (!pointerResize && !keyboardResize) return;

    pointerResizeRef.current = null;
    keyboardResizeRef.current = null;
    setProposedWidth(
      pointerResize?.startingPersistedWidth ??
        keyboardResize?.startingPersistedWidth ??
        attachment.displayWidth
    );
    if (pointerResize) releaseCapturedPointer(pointerResize);
  };

  useLayoutEffect(() => {
    setProposedWidth(attachment.displayWidth);
    return () => {
      const pointerResize = pointerResizeRef.current;
      pointerResizeRef.current = null;
      keyboardResizeRef.current = null;
      if (pointerResize) releaseCapturedPointer(pointerResize);
    };
  }, [
    attachment.displayWidth,
    attachment.id,
    attachment.intrinsicHeight,
    attachment.intrinsicWidth,
    attachment.mimeType,
    bytes,
    loadBytes,
    onDisplayWidthCommit
  ]);

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    const measure = (width: number) => {
      if (Number.isFinite(width)) {
        const nextWidth = Math.max(0, width);
        if (
          contentWidthRef.current !== null &&
          contentWidthRef.current !== nextWidth
        ) {
          cancelActiveInteractionRef.current();
        }
        contentWidthRef.current = nextWidth;
        setContentWidth(nextWidth);
      }
    };
    measure(group.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === group);
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(group);

    return () => {
      observer.unobserve(group);
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    if (!metadataValid) return;

    let disposed = false;
    let objectUrl: string | null = null;
    setLightboxOpen(false);
    setSource({ status: "loading" });

    const load = async () => {
      const loadedBytes = await byteLease.prewarm(attachment.id, leaseLoadBytes);
      if (disposed) return;
      if (!loadedBytes || loadedBytes.byteLength === 0) {
        throw new Error("Image bytes are unavailable");
      }

      const ownedBytes = loadedBytes.slice().buffer;
      objectUrl = URL.createObjectURL(
        new Blob([ownedBytes], { type: attachment.mimeType })
      );
      if (disposed) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        return;
      }
      setSource({ status: "ready", objectUrl });
    };

    void load().catch(() => {
      if (!disposed) setSource({ status: "error" });
    });

    return () => {
      disposed = true;
      byteLease.release(attachment.id);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    attachment.id,
    attachment.intrinsicHeight,
    attachment.intrinsicWidth,
    attachment.mimeType,
    byteLease,
    leaseLoadBytes,
    metadataValid
  ]);

  const updateProposedWidth = (width: number) => {
    const nextWidth = clampWidth(
      width,
      widthLimits(attachment.intrinsicWidth, null)
    );
    setProposedWidth(nextWidth);
    return nextWidth;
  };

  const interactionIdentity = (): InteractionIdentity => ({
    attachmentId: attachment.id,
    bytes,
    loadBytes,
    mimeType: attachment.mimeType,
    intrinsicWidth: attachment.intrinsicWidth,
    intrinsicHeight: attachment.intrinsicHeight,
    commit: onDisplayWidthCommit,
    startingPersistedWidth: attachment.displayWidth
  });

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !limits || limits.maximum === 0) return;
    event.preventDefault();
    event.stopPropagation();
    pointerResizeRef.current = {
      ...interactionIdentity(),
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: renderedWidthRef.current,
      element: event.currentTarget,
      proposedWidth: renderedWidthRef.current
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const resize = pointerResizeRef.current;
    if (
      !resize ||
      resize.pointerId !== event.pointerId ||
      !interactionMatches(
        resize,
        attachment,
        bytes,
        loadBytes,
        onDisplayWidthCommit
      )
    ) {
      return;
    }
    event.preventDefault();
    resize.proposedWidth = updateProposedWidth(
      resize.startWidth + event.clientX - resize.startX
    );
  };

  const finishPointerResize = (
    event: PointerEvent<HTMLDivElement>,
    releaseCapture: boolean
  ) => {
    const resize = pointerResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    pointerResizeRef.current = null;
    if (releaseCapture) releaseCapturedPointer(resize);
    if (
      interactionMatches(
        resize,
        attachment,
        bytes,
        loadBytes,
        onDisplayWidthCommit
      ) &&
      resize.proposedWidth !== resize.startWidth &&
      renderedWidthRef.current > 0 &&
      renderedWidthRef.current !== resize.startWidth
    ) {
      resize.commit(renderedWidthRef.current);
    }
  };

  const cancelPointerResize = (event: PointerEvent<HTMLDivElement>) => {
    const resize = pointerResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    pointerResizeRef.current = null;
    releaseCapturedPointer(resize);
    setProposedWidth(resize.startingPersistedWidth);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!limits || limits.maximum === 0) return;
    let nextWidth: number | null = null;
    const step = event.shiftKey ? keyboardResizeStep * 2 : keyboardResizeStep;

    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        nextWidth = renderedWidthRef.current - step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        nextWidth = renderedWidthRef.current + step;
        break;
      case "Home":
        nextWidth = limits.minimum;
        break;
      case "End":
        nextWidth = limits.maximum;
        break;
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    let resize = keyboardResizeRef.current;
    if (
      !resize ||
      !interactionMatches(
        resize,
        attachment,
        bytes,
        loadBytes,
        onDisplayWidthCommit
      )
    ) {
      resize = {
        ...interactionIdentity(),
        startWidth: renderedWidthRef.current,
        proposedWidth: renderedWidthRef.current
      };
      keyboardResizeRef.current = resize;
    }
    const proposedNextWidth =
      event.key === "Home" || event.key === "End"
        ? nextWidth
        : resize.proposedWidth +
          (event.key === "ArrowLeft" || event.key === "ArrowDown" ? -step : step);
    resize.proposedWidth = updateProposedWidth(proposedNextWidth);
  };

  const finishKeyboardResize = () => {
    const resize = keyboardResizeRef.current;
    if (!resize) return;
    keyboardResizeRef.current = null;
    if (
      interactionMatches(
        resize,
        attachment,
        bytes,
        loadBytes,
        onDisplayWidthCommit
      ) &&
      resize.proposedWidth !== resize.startWidth &&
      renderedWidthRef.current > 0 &&
      renderedWidthRef.current !== resize.startWidth
    ) {
      resize.commit(renderedWidthRef.current);
    }
  };

  const imageMenu = (
    <NotesImageMenu
      originalName={accessibleLabel}
      disabled={disabled}
      onShowFullScreen={
        source.status === "ready" && !disabled
          ? () => setLightboxOpen(true)
          : undefined
      }
      onViewOriginal={actionController.bindViewOriginal(onViewOriginal)}
      onDownload={actionController.bindDownload(onDownload)}
      onDelete={readOnly ? undefined : onRemove}
      deleteLabel={deleteLabel}
      showRemove={showRemove}
      onOpenSettings={resolvedOpenSettings}
    />
  );

  if (!metadataValid || !limits) {
    return (
      <div
        ref={groupRef}
        role={embedded ? undefined : "group"}
        aria-label={embedded ? undefined : groupLabel}
        aria-busy={embedded ? undefined : "false"}
        aria-disabled={disabled || undefined}
        style={groupStyle}
      >
        <div className="notes-image-attachment-frame" style={invalidFrameStyle}>
          <div role="alert" aria-label={unavailableLabel} style={fallbackStyle}>
            Image unavailable
          </div>
          {imageMenu}
        </div>
        {renderActionFailureStatus && (
          <NotesImageActionFailureStatus failure={actionController.failure} />
        )}
      </div>
    );
  }

  const frameStyle: CSSProperties = {
    ...frameBaseStyle,
    width: renderedWidth,
    aspectRatio: `${attachment.intrinsicWidth} / ${attachment.intrinsicHeight}`
  };

  return (
    <div
      ref={groupRef}
      role={embedded ? undefined : "group"}
      aria-label={embedded ? undefined : groupLabel}
      aria-busy={embedded ? undefined : source.status === "loading"}
      aria-disabled={disabled || undefined}
      style={groupStyle}
    >
      <div className="notes-image-attachment-frame" style={frameStyle}>
        {source.status === "ready" ? (
          <img
            src={source.objectUrl}
            alt={accessibleLabel}
            width={attachment.intrinsicWidth}
            height={attachment.intrinsicHeight}
            draggable={false}
            data-image-atom-interactive={disabled ? undefined : "true"}
            style={imageStyle}
            onDoubleClick={disabled ? undefined : () => setLightboxOpen(true)}
            onError={() => setSource({ status: "error" })}
          />
        ) : source.status === "loading" ? (
          <div role="status" aria-label={loadingLabel} style={fallbackStyle}>
            Loading image
          </div>
        ) : (
          <div role="alert" aria-label={unavailableLabel} style={fallbackStyle}>
            Image unavailable
          </div>
        )}

        {imageMenu}

        {!readOnly && !disabled && (
          <div
            role="separator"
            aria-label={
              neutralPresentation ? "Resize image" : `Resize ${accessibleLabel}`
            }
            aria-orientation="vertical"
            aria-valuemin={limits.minimum}
            aria-valuemax={limits.maximum}
            aria-valuenow={renderedWidth}
            aria-valuetext={`${renderedWidth} pixels wide`}
            aria-disabled={limits.maximum === 0}
            tabIndex={limits.maximum === 0 ? -1 : 0}
            style={resizeHandleStyle}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(event) => finishPointerResize(event, true)}
            onPointerCancel={cancelPointerResize}
            onLostPointerCapture={(event) => finishPointerResize(event, false)}
            onKeyDown={handleKeyDown}
            onKeyUp={finishKeyboardResize}
            onBlur={finishKeyboardResize}
          >
            <span aria-hidden="true" style={resizeHandleLineStyle} />
          </div>
        )}
      </div>
      {source.status === "ready" && (
        <NotesImageLightbox
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
          originalName={accessibleLabel}
          sourceUrl={source.objectUrl}
          intrinsicWidth={attachment.intrinsicWidth}
          intrinsicHeight={attachment.intrinsicHeight}
        />
      )}
      {renderActionFailureStatus && (
        <NotesImageActionFailureStatus
          failure={actionController.failure}
          maxWidth={renderedWidth}
        />
      )}
    </div>
  );
}

export function NotesImageNodeContent({
  nodeId,
  attachment,
  originalName,
  className,
  style,
  contentRef,
  onKeyDown,
  onEscape,
  onFrameInlineSizeChange,
  onRemoveImage,
  readOnly = false,
  disabled = false
}: NotesImageNodeContentProps) {
  const appNavigation = useContext(AppNavigationContext);
  const { actions } = useNotesActions();
  const {
    active,
    activate: activateResidency,
    deactivate: deactivateResidency
  } = useNotesImageResidencyLease();
  const slotRef = useRef<HTMLDivElement | null>(null);
  const manualFocusPendingRef = useRef(false);
  const menuCloseObserverRef = useRef<MutationObserver | null>(null);
  const menuRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observerGenerationRef = useRef(0);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attachmentId = attachment?.id;
  const canRemove = !readOnly && !disabled && Boolean(onRemoveImage);
  const actionController = useNotesImageActionFailureController(
    `${nodeId}:${attachmentId ?? "missing"}:${disabled ? "disabled" : "enabled"}`,
    actions.viewImageOriginal,
    actions.downloadImage
  );
  const classes = ["notes-image-node-content", className]
    .filter(Boolean)
    .join(" ");
  const accessibleOriginalName =
    attachment?.originalName.trim() || originalName?.trim() || "";
  const imageNodeLabel = accessibleOriginalName
    ? `Image: ${accessibleOriginalName}`
    : "Image";
  const loadImageLabel = attachment?.originalName.trim()
    ? `Load image ${attachment.originalName.trim()}`
    : "Load image";
  const setSlotRef = useCallback(
    (element: HTMLDivElement | null) => {
      slotRef.current = element;
      if (typeof contentRef === "function") {
        contentRef(element);
      } else if (contentRef) {
        (contentRef as { current: HTMLDivElement | null }).current = element;
      }
    },
    [contentRef]
  );
  const cancelPendingRelease = useCallback(() => {
    if (releaseTimerRef.current !== null) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
  }, []);
  const openImageSettings = useCallback(
    () => appNavigation?.openSettings("notes", "images"),
    [appNavigation]
  );
  useEffect(
    () => () => {
      menuCloseObserverRef.current?.disconnect();
      if (menuRestoreTimerRef.current !== null) {
        clearTimeout(menuRestoreTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    const slot = slotRef.current;
    if (!attachmentId || !slot || typeof IntersectionObserver === "undefined") {
      deactivateResidency();
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
    attachmentId,
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

  useLayoutEffect(() => {
    if (!onFrameInlineSizeChange) return;
    const visual = slotRef.current?.querySelector<HTMLElement>(
      ".notes-image-attachment-frame, .notes-image-attachment-placeholder"
    );
    if (!visual) return;

    let lastInlineSize: number | null = null;
    const publish = (inlineSize: number) => {
      if (
        !Number.isFinite(inlineSize) ||
        inlineSize < 0 ||
        inlineSize === lastInlineSize
      ) {
        return;
      }
      lastInlineSize = inlineSize;
      onFrameInlineSizeChange(inlineSize);
    };
    publish(visual.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === visual);
      if (entry) {
        publish(
          entry.borderBoxSize?.[0]?.inlineSize ??
            visual.getBoundingClientRect().width
        );
      }
    });
    observer.observe(visual, { box: "border-box" });
    return () => {
      observer.unobserve(visual);
      observer.disconnect();
    };
  }, [
    active,
    attachment?.displayWidth,
    attachment?.id,
    attachment?.intrinsicHeight,
    attachment?.intrinsicWidth,
    onFrameInlineSizeChange
  ]);

  const loadBytes = useCallback(() => {
    if (!attachmentId || !actions.loadAttachmentBytes) {
      return Promise.reject(new Error("Image loading is unavailable."));
    }
    return actions.loadAttachmentBytes(attachmentId);
  }, [actions, attachmentId]);
  const commitWidth = useCallback(
    (displayWidth: number) => {
      if (attachmentId) void actions.resizeImage?.(attachmentId, displayWidth);
    },
    [actions, attachmentId]
  );
  const viewOriginal = useCallback(() => {
    return attachmentId && actions.viewImageOriginal
      ? actions.viewImageOriginal(attachmentId)
      : Promise.resolve();
  }, [actions, attachmentId]);
  const downloadImage = useCallback(() => {
    if (attachment && attachmentId) {
      return actions.downloadImage?.(
        attachmentId,
        attachment.originalName,
        attachment.mimeType
      ) ?? Promise.resolve();
    }
    return Promise.resolve();
  }, [actions, attachment, attachmentId]);

  const boundViewOriginal = actionController.bindViewOriginal(
    actions.viewImageOriginal ? viewOriginal : undefined
  );
  const boundDownload = actionController.bindDownload(
    actions.downloadImage ? downloadImage : undefined
  );

  const openImageActionsFromKeyboard = useCallback(() => {
    const slot = slotRef.current;
    const trigger = slotRef.current?.querySelector<HTMLButtonElement>(
      ".notes-image-menu-trigger"
    );
    if (!slot || !trigger || trigger.disabled) return;

    menuCloseObserverRef.current?.disconnect();
    if (menuRestoreTimerRef.current !== null) {
      clearTimeout(menuRestoreTimerRef.current);
      menuRestoreTimerRef.current = null;
    }

    if (typeof MutationObserver !== "undefined") {
      let observedOpen = trigger.hasAttribute("data-popup-open");
      const observer = new MutationObserver(() => {
        if (trigger.hasAttribute("data-popup-open")) {
          observedOpen = true;
          return;
        }
        if (!observedOpen) return;

        observer.disconnect();
        if (menuCloseObserverRef.current === observer) {
          menuCloseObserverRef.current = null;
        }
        menuRestoreTimerRef.current = setTimeout(() => {
          menuRestoreTimerRef.current = null;
          const focused = document.activeElement;
          if (focused === trigger || focused === document.body) {
            slot.focus({ preventScroll: true });
          }
        }, 0);
      });
      observer.observe(trigger, {
        attributes: true,
        attributeFilter: ["data-popup-open"]
      });
      menuCloseObserverRef.current = observer;
    }

    trigger.click();
  }, []);

  return (
    <>
      <div
        ref={setSlotRef}
        className={classes}
        role="group"
        aria-label={imageNodeLabel}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        style={{ width: "100%", minWidth: 0, ...style }}
        onKeyDownCapture={(event) => {
          if (
            disabled ||
            event.key !== "Escape" ||
            !(event.target instanceof Node) ||
            !event.currentTarget.contains(event.target)
          ) {
            return;
          }
          if (onEscape?.()) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "Escape" || event.key === "Tab") return;
          if (event.target !== event.currentTarget) return;
          const opensContextMenu =
            event.key === "ContextMenu" ||
            (event.key === "F10" &&
              event.shiftKey &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey);
          if (opensContextMenu) {
            event.preventDefault();
            event.stopPropagation();
            openImageActionsFromKeyboard();
            return;
          }
          if (
            (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
            event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey
          ) {
            event.preventDefault();
          }
          onKeyDown?.(event);
        }}
      >
        {!attachment ? (
          <div className="notes-image-attachment-frame" style={invalidFrameStyle}>
            <div role="alert" aria-label="Image unavailable" style={fallbackStyle}>
              Image unavailable
            </div>
            <NotesImageMenu
              originalName={accessibleOriginalName || "Image"}
              disabled={disabled}
              onDelete={canRemove ? onRemoveImage : undefined}
              deleteLabel={canRemove ? "Remove image" : undefined}
              showRemove={canRemove}
              onOpenSettings={appNavigation ? openImageSettings : undefined}
            />
          </div>
        ) : active ? (
          <NotesImageAttachment
            attachment={attachment}
            embedded
            loadBytes={loadBytes}
            actionFailureController={actionController}
            renderActionFailureStatus={false}
            onDisplayWidthCommit={commitWidth}
            onViewOriginal={actions.viewImageOriginal ? viewOriginal : undefined}
            onDownload={actions.downloadImage ? downloadImage : undefined}
            onRemove={canRemove ? onRemoveImage : undefined}
            deleteLabel={canRemove ? "Remove image" : undefined}
            showRemove={canRemove}
            readOnly={readOnly}
            disabled={disabled}
          />
        ) : (
          <div
            className="notes-image-attachment-placeholder"
            style={placeholderSizeStyle(attachment)}
          >
            <NotesImageIngestOverlay nodeId={nodeId} />
            <button
              type="button"
              className="text-button"
              aria-label={loadImageLabel}
              disabled={disabled}
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
              disabled={disabled}
              onViewOriginal={boundViewOriginal}
              onDownload={boundDownload}
              onDelete={canRemove ? onRemoveImage : undefined}
              deleteLabel={canRemove ? "Remove image" : undefined}
              showRemove={canRemove}
              onOpenSettings={appNavigation ? openImageSettings : undefined}
            />
          </div>
        )}
        <NotesImageActionFailureStatus
          failure={actionController.failure}
          maxWidth={attachment?.displayWidth}
        />
      </div>
    </>
  );
}
