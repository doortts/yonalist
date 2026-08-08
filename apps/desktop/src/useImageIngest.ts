import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEventHandler,
  type RefObject
} from "react";
import type { ImageCandidate } from "./imageApi";
import type { NotesStore } from "./notesStore";
import type { OutlineIndex } from "./outlineIndex";

export type NativeImageDropEvent =
  | {
      readonly type: "enter" | "drop";
      readonly paths: readonly string[];
      readonly position: { readonly x: number; readonly y: number };
    }
  | {
      readonly type: "over";
      readonly position: { readonly x: number; readonly y: number };
    }
  | { readonly type: "leave" };

export interface ImageIngestBoundary {
  readonly native: boolean;
  pickPaths(): Promise<readonly string[]>;
  listenNativeDrops(
    listener: (event: NativeImageDropEvent) => void
  ): Promise<() => void>;
}

interface UseImageIngestInput {
  readonly store: NotesStore;
  readonly outlineRootId: string;
  readonly index: OutlineIndex;
  readonly scopeRef: RefObject<HTMLElement | null>;
  readonly boundary?: ImageIngestBoundary;
  /**
   * Takes an image gesture away from the React rows. The Monaco surface owns
   * its own anchor and is the page's only writer while it is up, so the
   * payload goes to it rather than straight to the store.
   */
  readonly monacoIngest?: ((
    payload: MonacoBoundPayload,
    at?: MonacoBoundAnchor | null
  ) => void) | null;
}

/** Structurally the Monaco surface's payload, without importing its module. */
type MonacoBoundPayload =
  | { readonly paths: readonly string[] }
  | { readonly candidates: readonly ImageCandidate[] };

/** Structurally the Monaco surface's anchor, same reason. */
type MonacoBoundAnchor = { readonly nodeId: string };

export function useImageIngest({
  store,
  outlineRootId,
  index,
  scopeRef,
  boundary = defaultImageIngestBoundary,
  monacoIngest = null
}: UseImageIngestInput) {
  const latest = useRef({ store, outlineRootId, index, monacoIngest });
  latest.current = { store, outlineRootId, index, monacoIngest };
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The Monaco surface anchors the drop itself, so a row or header marker
   * would point at a target the gesture never writes to.
   */
  const markDropTarget = useCallback((targetId: string | null) => {
    setDropTargetId(latest.current.monacoIngest ? null : targetId);
  }, []);

  const importPaths = useCallback(async (
    targetId: string,
    paths: readonly string[]
  ) => {
    const current = latest.current;
    const { imageInsertionAnchor } = await import("./imageInsertion");
    const anchor = imageInsertionAnchor(
      targetId,
      current.outlineRootId,
      current.index
    );
    if (!anchor || paths.length === 0) return;
    setError(null);
    await current.store.images.importPathsAfter(
      anchor.parentId,
      anchor.beforeId,
      paths
    );
  }, []);

  const importFiles = useCallback(async (
    targetId: string,
    files: readonly File[]
  ) => {
    const current = latest.current;
    const [{ imageInsertionAnchor }, { imageCandidates }] = await Promise.all([
      import("./imageInsertion"),
      import("./imagePicker")
    ]);
    const anchor = imageInsertionAnchor(
      targetId,
      current.outlineRootId,
      current.index
    );
    const candidates = imageCandidates(files);
    if (!anchor || candidates.length === 0) return;
    setError(null);
    await current.store.images.importAfter(
      anchor.parentId,
      anchor.beforeId,
      candidates
    );
  }, []);

  /**
   * `at` is the Monaco surface's anchor: a row menu names its own node, while
   * the page header names none and lands where a paste would.
   */
  const openPicker = useCallback(async (
    targetId: string,
    at?: MonacoBoundAnchor | null
  ) => {
    try {
      const monaco = latest.current.monacoIngest;
      if (boundary.native) {
        const paths = await boundary.pickPaths();
        if (paths.length === 0) return;
        if (monaco) monaco({ paths }, at);
        else await importPaths(targetId, paths);
        return;
      }
      const { pickImageFiles, imageCandidates } = await import("./imagePicker");
      const files = await pickImageFiles(true);
      if (!monaco) {
        await importFiles(targetId, files);
        return;
      }
      const candidates = imageCandidates(files);
      if (candidates.length > 0) monaco({ candidates }, at);
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }, [boundary, importFiles, importPaths]);

  useEffect(() => {
    if (!boundary.native) return;
    let active = true;
    let unlisten: (() => void) | null = null;
    void boundary.listenNativeDrops((event) => {
      if (!active) return;
      if (event.type === "leave") {
        setDropTargetId(null);
        return;
      }
      const targetId = targetAtPosition(
        scopeRef.current,
        event.position,
        latest.current.outlineRootId
      );
      if (event.type !== "drop") {
        markDropTarget(targetId);
        return;
      }
      setDropTargetId(null);
      if (!targetId) return;
      const monaco = latest.current.monacoIngest;
      if (monaco) {
        monaco({ paths: event.paths });
        return;
      }
      void importPaths(targetId, event.paths)
        .catch((cause) => setError(messageFrom(cause)))
        .finally(() => setDropTargetId(null));
    }).then((dispose) => {
      if (active) unlisten = dispose;
      else dispose();
    }).catch((cause) => {
      if (active) setError(messageFrom(cause));
    });
    return () => {
      active = false;
      unlisten?.();
      setDropTargetId(null);
    };
  }, [boundary, importPaths, markDropTarget, scopeRef]);

  const onDragOver = useCallback<DragEventHandler<HTMLElement>>((event) => {
    if (!hasSupportedImage([...event.dataTransfer.files])) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    markDropTarget(targetFromElement(
      event.target,
      event.currentTarget,
      latest.current.outlineRootId
    ));
  }, [markDropTarget]);
  const onDragLeave = useCallback<DragEventHandler<HTMLElement>>((event) => {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return;
    }
    setDropTargetId(null);
  }, []);
  const onDrop = useCallback<DragEventHandler<HTMLElement>>((event) => {
    const files = [...event.dataTransfer.files];
    if (!hasSupportedImage(files)) return;
    event.preventDefault();
    const targetId = targetFromElement(
      event.target,
      event.currentTarget,
      latest.current.outlineRootId
    );
    setDropTargetId(null);
    if (!targetId) return;
    void importFiles(targetId, files)
      .catch((cause) => setError(messageFrom(cause)))
      .finally(() => setDropTargetId(null));
  }, [importFiles]);

  return {
    dropTargetId,
    error,
    openPicker,
    sectionProps: { onDragOver, onDragLeave, onDrop }
  };
}

function targetAtPosition(
  scope: HTMLElement | null,
  position: { readonly x: number; readonly y: number },
  outlineRootId: string
): string | null {
  if (!scope) return null;
  const pointed = typeof document.elementFromPoint === "function"
    ? document.elementFromPoint(position.x, position.y)
    : null;
  if (!pointed || !scope.contains(pointed)) return null;
  return targetFromElement(pointed, scope, outlineRootId);
}

function targetFromElement(
  target: EventTarget | null,
  scope: HTMLElement,
  outlineRootId: string
): string {
  if (!(target instanceof Element) || !scope.contains(target)) {
    return outlineRootId;
  }
  return target.closest<HTMLElement>("[data-outline-id]")?.dataset.outlineId ??
    target.closest<HTMLElement>("[data-outline-header-id]")
      ?.dataset.outlineHeaderId ??
    outlineRootId;
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The image could not be imported.";
}

const defaultImageIngestBoundary: ImageIngestBoundary = {
  native: "__TAURI_INTERNALS__" in window,
  pickPaths: async () => {
    const { pickImagePaths } = await import("./imagePicker");
    return pickImagePaths(true);
  },
  async listenNativeDrops(listener) {
    if (!("__TAURI_INTERNALS__" in window)) return () => undefined;
    const [{ getCurrentWebview }, { getCurrentWindow }] = await Promise.all([
      import("@tauri-apps/api/webview"),
      import("@tauri-apps/api/window")
    ]);
    const scaleFactor = await getCurrentWindow().scaleFactor();
    return getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") {
        listener({ type: "leave" });
        return;
      }
      const position = payload.position.toLogical(scaleFactor);
      listener(payload.type === "over"
        ? { type: "over", position }
        : {
            type: payload.type,
            paths: payload.paths,
            position
          });
    });
  }
};

function hasSupportedImage(files: readonly File[]): boolean {
  return files.some((file) =>
    /^image\/(?:png|jpeg|gif|webp)$/u.test(file.type));
}
