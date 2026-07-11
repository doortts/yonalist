import { Trash2 } from "lucide-react";
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
import { IconTooltip } from "../../components/ui/Tooltip";

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
}

interface WidthLimits {
  readonly minimum: number;
  readonly maximum: number;
}

interface PointerResize {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
  changed: boolean;
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

const removeButtonStyle: CSSProperties = {
  position: "absolute",
  zIndex: 3,
  top: 6,
  right: 18,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  padding: 0,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-card)",
  color: "var(--danger)",
  boxShadow: "var(--shadow-modal)",
  cursor: "pointer"
};

function widthLimits(
  intrinsicWidth: number,
  contentWidth: number | null
): WidthLimits {
  const availableWidth = contentWidth ?? intrinsicWidth;
  const maximum = Math.max(
    1,
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

export function NotesImageAttachment({
  attachment,
  bytes,
  loadBytes,
  onDisplayWidthCommit,
  onRemove
}: NotesImageAttachmentProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const pointerResizeRef = useRef<PointerResize | null>(null);
  const keyboardCommitPendingRef = useRef(false);
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const [targetWidth, setTargetWidth] = useState(attachment.displayWidth);
  const [source, setSource] = useState<ImageSourceState>({ status: "loading" });
  const limits = useMemo(
    () => widthLimits(attachment.intrinsicWidth, contentWidth),
    [attachment.intrinsicWidth, contentWidth]
  );
  const renderedWidth = clampWidth(targetWidth, limits);
  const renderedWidthRef = useRef(renderedWidth);
  renderedWidthRef.current = renderedWidth;

  useEffect(() => {
    setTargetWidth(attachment.displayWidth);
  }, [attachment.displayWidth, attachment.id]);

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    const measure = (width: number) => {
      if (Number.isFinite(width) && width > 0) {
        setContentWidth(width);
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
    let disposed = false;
    let objectUrl: string | null = null;
    setSource({ status: "loading" });

    const load = async () => {
      if (!isValidAttachmentMetadata(attachment)) {
        throw new Error("Invalid image metadata");
      }
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
  }, [attachment.id, attachment.mimeType, bytes, loadBytes]);

  const updateTargetWidth = (width: number) => {
    const nextWidth = clampWidth(width, limits);
    renderedWidthRef.current = nextWidth;
    setTargetWidth(nextWidth);
    return nextWidth;
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    pointerResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: renderedWidthRef.current,
      changed: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const resize = pointerResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    const nextWidth = updateTargetWidth(
      resize.startWidth + event.clientX - resize.startX
    );
    if (nextWidth !== resize.startWidth) resize.changed = true;
  };

  const finishPointerResize = (
    event: PointerEvent<HTMLDivElement>,
    releaseCapture: boolean
  ) => {
    const resize = pointerResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    pointerResizeRef.current = null;
    if (releaseCapture) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (resize.changed) onDisplayWidthCommit(renderedWidthRef.current);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
    const previousWidth = renderedWidthRef.current;
    const updatedWidth = updateTargetWidth(nextWidth);
    if (updatedWidth !== previousWidth) keyboardCommitPendingRef.current = true;
  };

  const finishKeyboardResize = () => {
    if (!keyboardCommitPendingRef.current) return;
    keyboardCommitPendingRef.current = false;
    onDisplayWidthCommit(renderedWidthRef.current);
  };

  const frameStyle: CSSProperties = {
    ...frameBaseStyle,
    width: renderedWidth,
    aspectRatio: `${attachment.intrinsicWidth} / ${attachment.intrinsicHeight}`
  };

  return (
    <div
      ref={groupRef}
      role="group"
      aria-label={`Image: ${attachment.originalName}`}
      aria-busy={source.status === "loading"}
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

        {onRemove ? (
          <IconTooltip label="Remove image" side="left">
            <button
              type="button"
              aria-label={`Remove ${attachment.originalName}`}
              title="Remove image"
              style={removeButtonStyle}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onRemove}
            >
              <Trash2 aria-hidden="true" size={15} />
            </button>
          </IconTooltip>
        ) : null}

        <div
          role="separator"
          aria-label={`Resize ${attachment.originalName}`}
          aria-orientation="vertical"
          aria-valuemin={limits.minimum}
          aria-valuemax={limits.maximum}
          aria-valuenow={renderedWidth}
          aria-valuetext={`${renderedWidth} pixels wide`}
          tabIndex={0}
          style={resizeHandleStyle}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(event) => finishPointerResize(event, true)}
          onPointerCancel={(event) => finishPointerResize(event, true)}
          onLostPointerCapture={(event) => finishPointerResize(event, false)}
          onKeyDown={handleKeyDown}
          onKeyUp={finishKeyboardResize}
          onBlur={finishKeyboardResize}
        >
          <span aria-hidden="true" style={resizeHandleLineStyle} />
        </div>
      </div>
    </div>
  );
}
