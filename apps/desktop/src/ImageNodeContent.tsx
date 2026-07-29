import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ClipboardEventHandler,
  type CSSProperties,
  type KeyboardEventHandler
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  ImageResidency,
  type ResidentImageIdentity
} from "./imageResidency";
import type { NotesStore } from "./notesStore";

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
    width: image.displayWidth,
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
      <div className="notes-image-attachment-frame" style={frameStyle}>
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
      </div>
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
