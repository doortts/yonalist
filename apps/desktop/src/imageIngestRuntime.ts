import type {
  ImageIngestBoundary,
  NativeImageDropEvent
} from "./imageIngestTypes";
import type { NotesStore } from "./notesStore";
import type { OutlineIndex } from "./outlineIndex";

interface ImageImportContext {
  readonly store: NotesStore;
  readonly outlineRootId: string;
  readonly index: OutlineIndex;
}

export function targetAtPosition(
  scope: HTMLElement | null,
  position: { readonly x: number; readonly y: number },
  outlineRootId: string
): string | null {
  if (!scope) return null;
  const pointed = typeof document.elementFromPoint === "function"
    ? document.elementFromPoint(position.x, position.y)
    : null;
  if (!pointed || !scope.contains(pointed)) return null;
  return pointed.closest<HTMLElement>("[data-outline-id]")
    ?.dataset.outlineId ??
    pointed.closest<HTMLElement>("[data-outline-header-id]")
      ?.dataset.outlineHeaderId ??
    outlineRootId;
}

export async function importImagePaths(
  current: ImageImportContext,
  targetId: string,
  paths: readonly string[]
): Promise<void> {
  const { imageInsertionAnchor } = await import("./imageInsertion");
  const anchor = imageInsertionAnchor(
    targetId,
    current.outlineRootId,
    current.index
  );
  if (!anchor || paths.length === 0) return;
  await current.store.images.importPathsAfter(
    anchor.parentId,
    anchor.beforeId,
    paths
  );
}

export async function importImageFiles(
  current: ImageImportContext,
  targetId: string,
  files: readonly File[]
): Promise<void> {
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
  await current.store.images.importAfter(
    anchor.parentId,
    anchor.beforeId,
    candidates
  );
}

export const defaultImageIngestBoundary: ImageIngestBoundary = {
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
        : nativeDropEvent(payload.type, payload.paths, position));
    });
  }
};

function nativeDropEvent(
  type: "enter" | "drop",
  paths: readonly string[],
  position: { readonly x: number; readonly y: number }
): NativeImageDropEvent {
  return { type, paths, position };
}
