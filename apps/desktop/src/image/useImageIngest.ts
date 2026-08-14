import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEventHandler,
  type RefObject
} from "react";
import type { NotesStore } from "../notesStore";
import type { OutlineIndex } from "../outline/outlineIndex";

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
}

export function useImageIngest({
  store,
  outlineRootId,
  index,
  scopeRef,
  boundary = defaultImageIngestBoundary
}: UseImageIngestInput) {
  const latest = useRef({ store, outlineRootId, index });
  latest.current = { store, outlineRootId, index };
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const openPicker = useCallback(async (targetId: string) => {
    try {
      if (boundary.native) {
        const paths = await boundary.pickPaths();
        await importPaths(targetId, paths);
      } else {
        const { pickImageFiles } = await import("./imagePicker");
        const files = await pickImageFiles(true);
        await importFiles(targetId, files);
      }
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
        setDropTargetId(targetId);
        return;
      }
      setDropTargetId(null);
      if (!targetId) return;
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
  }, [boundary, importPaths, scopeRef]);

  const onDragOver = useCallback<DragEventHandler<HTMLElement>>((event) => {
    if (!carriesDraggedImage(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropTargetId(targetFromElement(
      event.target,
      event.currentTarget,
      latest.current.outlineRootId
    ));
  }, []);
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
  // Every element under the pointer, not just the topmost: the window's drag
  // strips sit above the outline's first rows, and a hit test that stopped at
  // the top one would call a drop there a drop on nothing.
  const stack = typeof document.elementsFromPoint === "function"
    ? document.elementsFromPoint(position.x, position.y)
    : typeof document.elementFromPoint === "function"
      ? [document.elementFromPoint(position.x, position.y)]
      : [];
  const pointed = stack.find((element) =>
    element instanceof Element && scope.contains(element));
  if (!pointed) return null;
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

function isSupportedImageType(type: string): boolean {
  return /^image\/(?:png|jpeg|gif|webp)$/u.test(type);
}

function hasSupportedImage(files: readonly File[]): boolean {
  return files.some((file) => isSupportedImageType(file.type));
}

/**
 * Whether a drag still in flight is carrying a file. A browser holds the files
 * back until the drop -- `dataTransfer.files` is empty for every `dragover` --
 * so reading it there refuses the drag the drop was meant for, and the drop
 * never arrives. The item list is what a drag in flight does expose: a kind for
 * every item, and, where the browser allows it, a type to match against.
 */
function carriesDraggedImage(transfer: DataTransfer): boolean {
  const files = [...transfer.items ?? []].filter((item) => item.kind === "file");
  if (files.length === 0) {
    return [...transfer.types ?? []].includes("Files");
  }
  // Safari hides the type until the drop, so an item that will not say what it
  // is has to be let through and turned away by the drop instead.
  return files.some((item) => item.type === "" || isSupportedImageType(item.type));
}
