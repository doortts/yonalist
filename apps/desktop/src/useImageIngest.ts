import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEventHandler,
  type RefObject
} from "react";
import type { ImageCandidate } from "./imageApi";
import { imageInsertionAnchor } from "./imageInsertion";
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
}

const supportedMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
]);

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

  const importPaths = useCallback((
    targetId: string,
    paths: readonly string[]
  ) => {
    const current = latest.current;
    const anchor = imageInsertionAnchor(
      targetId,
      current.outlineRootId,
      current.index
    );
    if (!anchor || paths.length === 0) return Promise.resolve();
    setError(null);
    return current.store.images.importPathsAfter(
      anchor.parentId,
      anchor.beforeId,
      paths
    ).then(() => undefined);
  }, []);

  const importFiles = useCallback((
    targetId: string,
    files: readonly File[]
  ) => {
    const current = latest.current;
    const anchor = imageInsertionAnchor(
      targetId,
      current.outlineRootId,
      current.index
    );
    const candidates = imageCandidates(files);
    if (!anchor || candidates.length === 0) return Promise.resolve();
    setError(null);
    return current.store.images.importAfter(
      anchor.parentId,
      anchor.beforeId,
      candidates
    ).then(() => undefined);
  }, []);

  const openPicker = useCallback(async (targetId: string) => {
    try {
      if (boundary.native) {
        const paths = await boundary.pickPaths();
        await importPaths(targetId, paths);
      } else {
        const files = await pickBrowserFiles();
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
    if (imageCandidates([...event.dataTransfer.files]).length === 0) return;
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
    if (imageCandidates(files).length === 0) return;
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

function imageCandidates(files: readonly File[]): readonly ImageCandidate[] {
  return files
    .filter((file) => supportedMimeTypes.has(file.type))
    .map((file) => ({
      originalName: file.name,
      declaredMimeType: file.type,
      blob: file
    }));
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

function pickBrowserFiles(): Promise<readonly File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", handleWindowFocus);
      const files = input.files ? [...input.files] : [];
      input.remove();
      resolve(files);
    };
    const handleWindowFocus = () => window.setTimeout(finish, 0);
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.multiple = true;
    input.hidden = true;
    input.addEventListener("change", finish, { once: true });
    window.addEventListener("focus", handleWindowFocus, { once: true });
    document.body.append(input);
    input.click();
  });
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The image could not be imported.";
}

const defaultImageIngestBoundary: ImageIngestBoundary = {
  native: "__TAURI_INTERNALS__" in window,
  async pickPaths() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{
        name: "Images",
        extensions: ["png", "jpg", "jpeg", "gif", "webp"]
      }]
    });
    if (!selected) return [];
    return Array.isArray(selected) ? selected : [selected];
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
