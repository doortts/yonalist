import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { NotesImageLightbox } from "./NotesImageLightbox";
import { NotesImageMenu } from "./NotesImageMenu";

const preferredMinimumWidth = 160;
const keyboardResizeStep = 16;
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
  readonly onDisplayWidthCommit: (displayWidth: number) => void;
  readonly onRemove?: () => void;
  readonly onViewOriginal?: () => void;
  readonly onDownload?: () => void;
  readonly onOpenSettings?: () => void;
  readonly readOnly?: boolean;
  readonly embedded?: boolean;
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

function isValidAttachmentMetadata(
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

export function NotesImageAttachment({
  attachment,
  bytes,
  loadBytes,
  onDisplayWidthCommit,
  onRemove,
  onViewOriginal,
  onDownload,
  onOpenSettings,
  readOnly = false,
  embedded = false
}: NotesImageAttachmentProps) {
  const metadataValid = isValidAttachmentMetadata(attachment);
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

  useEffect(() => {
    if (!metadataValid) return;

    let disposed = false;
    let objectUrl: string | null = null;
    setLightboxOpen(false);
    setSource({ status: "loading" });

    const load = async () => {
      const loadedBytes = bytes ?? (await loadBytes?.());
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
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    attachment.id,
    attachment.intrinsicHeight,
    attachment.intrinsicWidth,
    attachment.mimeType,
    bytes,
    loadBytes,
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
      originalName={attachment.originalName}
      onShowFullScreen={
        source.status === "ready" ? () => setLightboxOpen(true) : undefined
      }
      onViewOriginal={onViewOriginal}
      onDownload={onDownload}
      onDelete={readOnly ? undefined : onRemove}
      onOpenSettings={onOpenSettings}
    />
  );

  if (!metadataValid || !limits) {
    return (
      <div
        ref={groupRef}
        role={embedded ? undefined : "group"}
        aria-label={embedded ? undefined : `Image: ${attachment.originalName}`}
        aria-busy={embedded ? undefined : "false"}
        style={groupStyle}
      >
        <div className="notes-image-attachment-frame" style={invalidFrameStyle}>
          <div role="alert" style={fallbackStyle}>
            Image unavailable
          </div>
          {imageMenu}
        </div>
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
      aria-label={embedded ? undefined : `Image: ${attachment.originalName}`}
      aria-busy={embedded ? undefined : source.status === "loading"}
      style={groupStyle}
    >
      <div className="notes-image-attachment-frame" style={frameStyle}>
        {source.status === "ready" ? (
          <img
            src={source.objectUrl}
            alt={attachment.originalName}
            width={attachment.intrinsicWidth}
            height={attachment.intrinsicHeight}
            draggable={false}
            style={imageStyle}
            onDoubleClick={() => setLightboxOpen(true)}
            onError={() => setSource({ status: "error" })}
          />
        ) : source.status === "loading" ? (
          <div role="status" style={fallbackStyle}>
            Loading image
          </div>
        ) : (
          <div role="alert" style={fallbackStyle}>
            Image unavailable
          </div>
        )}

        {imageMenu}

        {!readOnly && (
          <div
            role="separator"
            aria-label={`Resize ${attachment.originalName}`}
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
          originalName={attachment.originalName}
          sourceUrl={source.objectUrl}
          intrinsicWidth={attachment.intrinsicWidth}
          intrinsicHeight={attachment.intrinsicHeight}
        />
      )}
    </div>
  );
}
