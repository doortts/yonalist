import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

const preferredMinimumWidth = 160;
const keyboardResizeStep = 16;

interface WidthLimits {
  readonly minimum: number;
  readonly maximum: number;
}

interface InteractionIdentity {
  readonly id: string;
  readonly sourceIdentity: unknown;
  readonly sourceUrl: string | null;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
  readonly commit: ((width: number) => void) | undefined;
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

export interface NotesResizableImageFrameProps {
  readonly id: string;
  readonly accessibleLabel: string;
  readonly sourceUrl: string | null;
  readonly sourceStatus: "loading" | "ready" | "error";
  readonly intrinsicWidth: number | null;
  readonly intrinsicHeight: number | null;
  readonly persistedWidth: number | null;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly embedded?: boolean;
  readonly sourceIdentity?: unknown;
  readonly onDisplayWidthCommit?: (width: number) => void;
  readonly onSourceLoad?: (image: HTMLImageElement) => void;
  readonly onSourceError?: () => void;
  readonly onDoubleClick?: () => void;
  readonly overlay?: ReactNode;
  readonly loadingContent?: ReactNode;
  readonly errorContent?: ReactNode;
  readonly renderAfter?: (renderedWidth: number) => ReactNode;
  readonly imageInteractive?: boolean;
}

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

const fallbackFrameStyle: CSSProperties = {
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

function releaseCapturedPointer(resize: PointerResize) {
  try {
    const hasCapture =
      typeof resize.element.hasPointerCapture !== "function" ||
      resize.element.hasPointerCapture(resize.pointerId);
    if (hasCapture) resize.element.releasePointerCapture(resize.pointerId);
  } catch {
    // The browser may already have released capture.
  }
}

function interactionMatches(
  interaction: InteractionIdentity,
  current: InteractionIdentity
): boolean {
  return (
    interaction.id === current.id &&
    interaction.sourceIdentity === current.sourceIdentity &&
    interaction.sourceUrl === current.sourceUrl &&
    interaction.intrinsicWidth === current.intrinsicWidth &&
    interaction.intrinsicHeight === current.intrinsicHeight &&
    interaction.commit === current.commit &&
    interaction.startingPersistedWidth === current.startingPersistedWidth
  );
}

export function NotesResizableImageFrame({
  id,
  accessibleLabel,
  sourceUrl,
  sourceStatus,
  intrinsicWidth,
  intrinsicHeight,
  persistedWidth,
  disabled = false,
  readOnly = false,
  embedded = false,
  sourceIdentity = sourceUrl,
  onDisplayWidthCommit,
  onSourceLoad,
  onSourceError,
  onDoubleClick,
  overlay,
  loadingContent = "Loading image",
  errorContent = "Image unavailable",
  renderAfter,
  imageInteractive = false
}: NotesResizableImageFrameProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const pointerResizeRef = useRef<PointerResize | null>(null);
  const keyboardResizeRef = useRef<KeyboardResize | null>(null);
  const contentWidthRef = useRef<number | null>(null);
  const cancelActiveInteractionRef = useRef<() => void>(() => undefined);
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const geometryValid =
    intrinsicWidth !== null &&
    intrinsicHeight !== null &&
    Number.isFinite(intrinsicWidth) &&
    Number.isFinite(intrinsicHeight) &&
    intrinsicWidth > 0 &&
    intrinsicHeight > 0;
  const persistedTarget = geometryValid
    ? (persistedWidth ?? intrinsicWidth)
    : 0;
  const [proposedWidth, setProposedWidth] = useState(persistedTarget);
  const limits = useMemo(
    () =>
      geometryValid
        ? widthLimits(intrinsicWidth, contentWidth)
        : null,
    [contentWidth, geometryValid, intrinsicWidth]
  );
  const renderedWidth = limits ? clampWidth(proposedWidth, limits) : 0;
  const renderedWidthRef = useRef(renderedWidth);
  renderedWidthRef.current = renderedWidth;
  const currentIdentity = (): InteractionIdentity => ({
    id,
    sourceIdentity,
    sourceUrl,
    intrinsicWidth: intrinsicWidth ?? 0,
    intrinsicHeight: intrinsicHeight ?? 0,
    commit: onDisplayWidthCommit,
    startingPersistedWidth: persistedTarget
  });

  cancelActiveInteractionRef.current = () => {
    const pointerResize = pointerResizeRef.current;
    const keyboardResize = keyboardResizeRef.current;
    if (!pointerResize && !keyboardResize) return;
    pointerResizeRef.current = null;
    keyboardResizeRef.current = null;
    setProposedWidth(
      pointerResize?.startingPersistedWidth ??
        keyboardResize?.startingPersistedWidth ??
        persistedTarget
    );
    if (pointerResize) releaseCapturedPointer(pointerResize);
  };

  useLayoutEffect(() => {
    setProposedWidth(persistedTarget);
    return () => {
      const pointerResize = pointerResizeRef.current;
      pointerResizeRef.current = null;
      keyboardResizeRef.current = null;
      if (pointerResize) releaseCapturedPointer(pointerResize);
    };
  }, [
    id,
    intrinsicHeight,
    intrinsicWidth,
    onDisplayWidthCommit,
    persistedTarget,
    sourceIdentity,
    sourceUrl
  ]);

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    const measure = (width: number) => {
      if (!Number.isFinite(width)) return;
      const nextWidth = Math.max(0, width);
      if (
        contentWidthRef.current !== null &&
        contentWidthRef.current !== nextWidth
      ) {
        cancelActiveInteractionRef.current();
      }
      contentWidthRef.current = nextWidth;
      setContentWidth(nextWidth);
    };
    measure(group.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;
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

  const updateProposedWidth = (width: number) => {
    if (!geometryValid) return 0;
    const nextWidth = clampWidth(width, widthLimits(intrinsicWidth, null));
    setProposedWidth(nextWidth);
    return nextWidth;
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      !limits ||
      limits.maximum === 0 ||
      !onDisplayWidthCommit
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    pointerResizeRef.current = {
      ...currentIdentity(),
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
      !interactionMatches(resize, currentIdentity())
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
      interactionMatches(resize, currentIdentity()) &&
      resize.proposedWidth !== resize.startWidth &&
      renderedWidthRef.current > 0 &&
      renderedWidthRef.current !== resize.startWidth
    ) {
      resize.commit?.(renderedWidthRef.current);
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
    if (!limits || limits.maximum === 0 || !onDisplayWidthCommit) return;
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
    if (!resize || !interactionMatches(resize, currentIdentity())) {
      resize = {
        ...currentIdentity(),
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
      interactionMatches(resize, currentIdentity()) &&
      resize.proposedWidth !== resize.startWidth &&
      renderedWidthRef.current > 0 &&
      renderedWidthRef.current !== resize.startWidth
    ) {
      resize.commit?.(renderedWidthRef.current);
    }
  };

  const neutralPresentation = accessibleLabel.trim() === "" ||
    accessibleLabel === "Image";
  const label = neutralPresentation ? "Image" : accessibleLabel;
  const groupLabel = neutralPresentation ? "Image" : `Image: ${label}`;
  const loadingLabel = neutralPresentation
    ? "Loading image"
    : `Loading image ${label}`;
  const unavailableLabel = neutralPresentation
    ? "Image unavailable"
    : `Image unavailable: ${label}`;
  const frameStyle: CSSProperties = geometryValid
    ? {
        ...frameBaseStyle,
        width: renderedWidth,
        aspectRatio: `${intrinsicWidth} / ${intrinsicHeight}`
      }
    : fallbackFrameStyle;
  const canResize =
    geometryValid &&
    !readOnly &&
    !disabled &&
    onDisplayWidthCommit !== undefined;

  return (
    <div
      ref={groupRef}
      role={embedded ? undefined : "group"}
      aria-label={embedded ? undefined : groupLabel}
      aria-busy={embedded ? undefined : sourceStatus === "loading"}
      aria-disabled={disabled || undefined}
      style={groupStyle}
    >
      <div className="notes-image-attachment-frame" style={frameStyle}>
        {sourceUrl && sourceStatus !== "error" && (
          <img
            src={sourceUrl}
            alt={label}
            width={intrinsicWidth ?? undefined}
            height={intrinsicHeight ?? undefined}
            draggable={false}
            data-image-atom-interactive={
              imageInteractive && !disabled ? "true" : undefined
            }
            style={{
              ...imageStyle,
              visibility: sourceStatus === "ready" ? "visible" : "hidden"
            }}
            onLoad={(event) => onSourceLoad?.(event.currentTarget)}
            onDoubleClick={disabled ? undefined : onDoubleClick}
            onError={onSourceError}
          />
        )}
        {sourceStatus === "loading" && (
          <div role="status" aria-label={loadingLabel} style={fallbackStyle}>
            {loadingContent}
          </div>
        )}
        {sourceStatus === "error" && (
          <div role="alert" aria-label={unavailableLabel} style={fallbackStyle}>
            {errorContent}
          </div>
        )}
        {overlay}
        {canResize && limits && (
          <div
            role="separator"
            aria-label={
              neutralPresentation ? "Resize image" : `Resize ${label}`
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
      {renderAfter?.(renderedWidth)}
    </div>
  );
}
