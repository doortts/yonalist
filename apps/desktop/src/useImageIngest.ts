import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEventHandler,
  type RefObject
} from "react";
import type { NotesStore } from "./notesStore";
import type { OutlineIndex } from "./outlineIndex";
import type { ImageIngestBoundary } from "./imageIngestTypes";

export type {
  ImageIngestBoundary,
  NativeImageDropEvent
} from "./imageIngestTypes";

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
  boundary
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
    const runtime = await import("./imageIngestRuntime");
    setError(null);
    await runtime.importImagePaths(current, targetId, paths);
  }, []);

  const importFiles = useCallback(async (
    targetId: string,
    files: readonly File[]
  ) => {
    const current = latest.current;
    const runtime = await import("./imageIngestRuntime");
    setError(null);
    await runtime.importImageFiles(current, targetId, files);
  }, []);

  const openPicker = useCallback(async (targetId: string) => {
    try {
      const runtime = await import("./imageIngestRuntime");
      const activeBoundary = boundary ?? runtime.defaultImageIngestBoundary;
      if (activeBoundary.native) {
        const paths = await activeBoundary.pickPaths();
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
    if (!(boundary?.native ?? "__TAURI_INTERNALS__" in window)) return;
    let active = true;
    let unlisten: (() => void) | null = null;
    void import("./imageIngestRuntime").then(async (runtime) => {
      const activeBoundary = boundary ?? runtime.defaultImageIngestBoundary;
      if (!active || !activeBoundary.native) return;
      const dispose = await activeBoundary.listenNativeDrops((event) => {
        if (!active) return;
        if (event.type === "leave") {
          setDropTargetId(null);
          return;
        }
        const targetId = runtime.targetAtPosition(
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
      });
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
    if (!hasSupportedImage([...event.dataTransfer.files])) return;
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

function hasSupportedImage(files: readonly File[]): boolean {
  return files.some((file) =>
    /^image\/(?:png|jpeg|gif|webp)$/u.test(file.type));
}
