const supportedExtensions = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const supportedMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

export interface NotesAttachmentUiBoundary {
  openImageFiles(): Promise<readonly string[] | null>;
  subscribeToImageDrop(
    listener: (event: NotesNativeImageDropEvent) => void
  ): Promise<() => void | Promise<void>>;
}

export interface NotesLogicalPoint {
  readonly x: number;
  readonly y: number;
}

export type NotesNativeImageDropEvent =
  | {
      readonly type: "enter" | "drop";
      readonly paths: readonly string[];
      readonly position: NotesLogicalPoint;
    }
  | { readonly type: "over"; readonly position: NotesLogicalPoint }
  | { readonly type: "leave" };

async function unlistenAll(
  unlisteners: readonly (() => void | Promise<void>)[]
): Promise<void> {
  const results = await Promise.allSettled(
    unlisteners.map((unlisten) => Promise.resolve().then(unlisten))
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure) throw failure.reason;
}

function hasSupportedImageExtension(path: string): boolean {
  const extension = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  return extension !== undefined && supportedExtensions.has(extension);
}

export function isSupportedImagePath(path: string): boolean {
  const absoluteLocalPath =
    path.startsWith("/") ||
    /^[a-z]:[\\/]/i.test(path) ||
    path.startsWith("\\\\");
  return absoluteLocalPath && hasSupportedImageExtension(path);
}

export function isSupportedImageFile(file: File): boolean {
  return (
    supportedMimeTypes.has(file.type) && hasSupportedImageExtension(file.name)
  );
}

export const nativeNotesAttachmentUi: NotesAttachmentUiBoundary = {
  async openImageFiles(): Promise<readonly string[] | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: false,
      multiple: true,
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "webp", "gif"]
        }
      ]
    });
    if (Array.isArray(selected)) {
      return selected;
    }
    return typeof selected === "string" ? [selected] : null;
  },

  async subscribeToImageDrop(
    listener
  ): Promise<() => void | Promise<void>> {
    if (
      typeof window === "undefined" ||
      !("__TAURI_INTERNALS__" in window)
    ) {
      return async () => {};
    }
    const [{ getCurrentWebview }, { getCurrentWindow }] = await Promise.all([
      import("@tauri-apps/api/webview"),
      import("@tauri-apps/api/window")
    ]);
    const currentWindow = getCurrentWindow();
    let currentScaleFactor = await currentWindow.scaleFactor();
    const unlistenScale = await currentWindow.onScaleChanged(({ payload }) => {
      currentScaleFactor = payload.scaleFactor;
    });
    try {
      const unlistenDrag = await getCurrentWebview().onDragDropEvent(
        ({ payload }) => {
          if (payload.type === "leave") {
            listener({ type: "leave" });
            return;
          }

          const { x, y } = payload.position.toLogical(currentScaleFactor);
          if (payload.type === "over") {
            listener({ type: "over", position: { x, y } });
            return;
          }
          listener({
            type: payload.type,
            paths: payload.paths,
            position: { x, y }
          });
        }
      );
      return () => unlistenAll([unlistenDrag, unlistenScale]);
    } catch (cause) {
      try {
        await unlistenScale();
      } catch {
        // Preserve the setup failure after making a best-effort cleanup.
      }
      throw cause;
    }
  }
};
