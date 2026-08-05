import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEventHandler,
  type CSSProperties,
  type KeyboardEventHandler,
  type PointerEventHandler
} from "react";
import {
  Download, ExternalLink, Maximize2, MoreVertical, RefreshCw, Trash2
} from "lucide-react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  ImageResidency,
  type ResidentImageIdentity
} from "./imageResidency";
import type { NotesStore } from "./notesStore";
import {
  clampImageWidth,
  imageKeyboardResizeWidth
} from "./imageResize";
import { RowMenuItem } from "./outlineSupport";
import { ImageLightbox } from "./ImageLightbox";
import {
  downloadImage,
  replaceImageFromPicker,
  viewImageOriginal
} from "./imageActions";

const workspaceResidencies = new WeakMap<NotesStore, ImageResidency>();
const unavailableLease = {
  status: "error",
  message: "Image unavailable"
} as const;

export function imageResidencyForStore(store: NotesStore): ImageResidency {
  const existing = workspaceResidencies.get(store);
  if (existing) return existing;
  const residency = new ImageResidency((nodeId) => store.images.read(nodeId));
  workspaceResidencies.set(store, residency);
  return residency;
}

export function ImageNodeContent({
  node,
  store,
  residency: suppliedResidency,
  onKeyDown,
  onPaste
}: {
  readonly node: NoteView;
  readonly store?: NotesStore;
  readonly residency?: ImageResidency;
  readonly onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  readonly onPaste?: ClipboardEventHandler<HTMLDivElement>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const pointerResize = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startWidth: number;
    proposedWidth: number;
  } | null>(null);
  const keyboardResizeStart = useRef<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewWidth, setPreviewWidth] = useState(
    node.image?.displayWidth ?? 320
  );
  const residency = useMemo(() => {
    if (suppliedResidency) return suppliedResidency;
    if (store) return imageResidencyForStore(store);
    throw new Error("ImageNodeContent requires an image residency.");
  }, [store, suppliedResidency]);
  const image = node.image;
  const identity = useMemo<ResidentImageIdentity | null>(() => image ? ({
    nodeId: node.id,
    contentHash: image.contentHash,
    mimeType: image.mimeType
  }) : null, [image, node.id]);
  const subscribe = useCallback(
    (listener: () => void) =>
      identity ? residency.subscribe(identity, listener) : () => undefined,
    [identity, residency]
  );
  const getSnapshot = useCallback(
    () => identity
      ? residency.getSnapshot(identity)
      : unavailableLease,
    [identity, residency]
  );
  const lease = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    setPreviewWidth(node.image?.displayWidth ?? 320);
    pointerResize.current = null;
    keyboardResizeStart.current = null;
    setLightboxOpen(false);
  }, [node.image?.contentHash, node.image?.displayWidth]);

  useEffect(() => {
    if (!identity) return;
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") {
      return residency.activate(identity);
    }
    let release: (() => void) | null = null;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) =>
        entry.target === root && entry.isIntersecting);
      if (visible && !release) release = residency.activate(identity);
      if (!visible && release) {
        release();
        release = null;
      }
    }, { rootMargin: "160px 0px" });
    observer.observe(root);
    return () => {
      observer.disconnect();
      release?.();
    };
  }, [identity, residency]);

  const originalName = image?.originalName.trim() || "Image";
  const frameStyle: CSSProperties = image ? {
    position: "relative",
    width: previewWidth,
    maxWidth: "100%",
    aspectRatio: `${image.pixelWidth} / ${image.pixelHeight}`,
    overflow: "hidden",
    borderRadius: 6,
    background: "var(--bg-hover)",
    boxShadow: "inset 0 0 0 1px var(--border)"
  } : {
    position: "relative",
    width: "100%",
    minHeight: 96
  };
  const maximumWidth = () => Math.max(
    120,
    Math.floor(rootRef.current?.clientWidth || image?.pixelWidth || 320)
  );
  const commitWidth = (width: number) => {
    if (!store || !image || width === image.displayWidth) return;
    void store.images.resize(node.id, width).catch(() => {
      setPreviewWidth(image.displayWidth);
    });
  };
  const runAction = (action: () => Promise<void>) => {
    setMenuOpen(false);
    setActionError(null);
    void action().catch((cause: unknown) => {
      setActionError(
        cause instanceof Error ? cause.message : "The image action failed."
      );
    });
  };
  const finishPointerResize: PointerEventHandler<HTMLDivElement> = (event) => {
    const resize = pointerResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    pointerResize.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    commitWidth(resize.proposedWidth);
  };
  return (
    <div
      ref={rootRef}
      className="notes-image-node-content"
      role="group"
      aria-label={`Image: ${originalName}`}
      tabIndex={0}
      data-node-id={node.id}
      data-outline-field="image"
      style={{ width: "100%", minWidth: 0 }}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    >
      <div
        className="notes-image-attachment-frame"
        style={frameStyle}
        onDoubleClick={() => {
          if (lease.status === "ready") setLightboxOpen(true);
        }}
      >
        {lease.status === "ready" ? (
          <img
            src={lease.url}
            alt={originalName}
            width={image?.pixelWidth}
            height={image?.pixelHeight}
            draggable={false}
            style={{
              display: "block",
              width: "100%",
              height: "100%",
              objectFit: "contain"
            }}
          />
        ) : lease.status === "error" || !image ? (
          <div
            role="alert"
            aria-label={`Image unavailable: ${originalName}`}
            style={fallbackStyle}
          >
            Image unavailable
          </div>
        ) : (
          <div role="status" aria-label={`Loading image ${originalName}`} style={fallbackStyle}>
            Loading image
          </div>
        )}
        {store && image && (
          <div
            role="separator"
            aria-label={`Resize ${originalName}`}
            aria-orientation="vertical"
            aria-valuemin={120}
            aria-valuemax={maximumWidth()}
            aria-valuenow={previewWidth}
            tabIndex={0}
            style={resizeHandleStyle}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              pointerResize.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startWidth: previewWidth,
                proposedWidth: previewWidth
              };
              event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onPointerMove={(event) => {
              const resize = pointerResize.current;
              if (!resize || resize.pointerId !== event.pointerId) return;
              event.preventDefault();
              resize.proposedWidth = clampImageWidth(
                resize.startWidth + event.clientX - resize.startX,
                maximumWidth()
              );
              setPreviewWidth(resize.proposedWidth);
            }}
            onPointerUp={finishPointerResize}
            onPointerCancel={(event) => {
              const resize = pointerResize.current;
              if (!resize || resize.pointerId !== event.pointerId) return;
              pointerResize.current = null;
              setPreviewWidth(image.displayWidth);
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                return;
              }
              const key = event.key;
              event.preventDefault();
              event.stopPropagation();
              keyboardResizeStart.current ??= previewWidth;
              setPreviewWidth((width) => imageKeyboardResizeWidth(
                width,
                key,
                event.shiftKey,
                maximumWidth()
              ));
            }}
            onKeyUp={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                return;
              }
              const start = keyboardResizeStart.current;
              keyboardResizeStart.current = null;
              if (start !== null && start !== previewWidth) {
                commitWidth(previewWidth);
              }
            }}
            onBlur={() => {
              const start = keyboardResizeStart.current;
              keyboardResizeStart.current = null;
              if (start !== null && start !== previewWidth) {
                commitWidth(previewWidth);
              }
            }}
          >
            <span aria-hidden="true" style={resizeHandleLineStyle} />
          </div>
        )}
        {store && (
          <>
            <button
              ref={menuTriggerRef}
              type="button"
              className="notes-image-menu-trigger"
              aria-label={`Image actions for ${originalName}`}
              data-popup-open={menuOpen ? "true" : undefined}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreVertical size={18} aria-hidden="true" />
            </button>
            {menuOpen && (
              <div
                className="notes-bullet-menu notes-image-menu"
                role="menu"
                style={{
                  position: "absolute",
                  zIndex: 5,
                  top: 44,
                  right: 24,
                  "--available-height": "420px"
                } as CSSProperties}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setMenuOpen(false);
                    menuTriggerRef.current?.focus();
                    return;
                  }
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
                    return;
                  }
                  event.preventDefault();
                  const items = [...event.currentTarget.querySelectorAll<
                    HTMLButtonElement
                  >("[role=menuitem]")];
                  const current = items.indexOf(
                    document.activeElement as HTMLButtonElement
                  );
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  items[(current + delta + items.length) % items.length]
                    ?.focus();
                }}
              >
                <RowMenuItem
                  icon={<Maximize2 size={16} aria-hidden="true" />}
                  label="Show full-screen"
                  onClick={() => {
                    setMenuOpen(false);
                    if (lease.status === "ready") setLightboxOpen(true);
                  }}
                />
                <RowMenuItem
                  icon={<RefreshCw size={16} aria-hidden="true" />}
                  label="Replace image"
                  onClick={() => runAction(() =>
                    replaceImageFromPicker(store, node.id)
                  )}
                />
                <RowMenuItem
                  icon={<ExternalLink size={16} aria-hidden="true" />}
                  label="View original"
                  onClick={() => runAction(() =>
                    viewImageOriginal(
                      store,
                      node.id,
                      image?.mimeType ?? "application/octet-stream"
                    )
                  )}
                />
                <RowMenuItem
                  icon={<Download size={16} aria-hidden="true" />}
                  label="Download"
                  onClick={() => runAction(() =>
                    downloadImage(
                      store,
                      node.id,
                      originalName,
                      image?.mimeType ?? "application/octet-stream"
                    )
                  )}
                />
                <RowMenuItem
                  danger
                  icon={<Trash2 size={16} aria-hidden="true" />}
                  label="Move to Trash"
                  onClick={() => {
                    setMenuOpen(false);
                    void store.deleteSubtree(node.id);
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>
      {actionError && (
        <div className="notes-attachment-error" role="alert">
          {actionError}
        </div>
      )}
      {lightboxOpen && lease.status === "ready" && image && (
        <ImageLightbox
          originalName={originalName}
          sourceUrl={lease.url}
          pixelWidth={image.pixelWidth}
          pixelHeight={image.pixelHeight}
          returnFocusRef={menuTriggerRef}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </div>
  );
}

const fallbackStyle: CSSProperties = {
  display: "grid",
  width: "100%",
  height: "100%",
  minHeight: 96,
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
