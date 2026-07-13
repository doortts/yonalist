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

type NotesNativeUnlisten = () => void | Promise<void>;

interface NotesNativeDragPosition {
  readonly x: number;
  readonly y: number;
}

interface NotesNativeDragPathsPayload {
  readonly paths: string[];
  readonly position: NotesNativeDragPosition;
}

interface NotesNativeDragOverPayload {
  readonly position: NotesNativeDragPosition;
}

async function settleUnlisteners(
  unlisteners: readonly (() => void | Promise<void>)[]
): Promise<void> {
  await Promise.allSettled(
    unlisteners.map((unlisten) => Promise.resolve().then(unlisten))
  );
}

function createBestEffortCleanup(
  unlisteners: readonly NotesNativeUnlisten[]
): () => Promise<void> {
  const pendingUnlisteners = [...unlisteners];
  let cleanup: Promise<void> | undefined;
  return () => {
    cleanup ??= settleUnlisteners(pendingUnlisteners);
    return cleanup;
  };
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
    const [
      { PhysicalPosition },
      { TauriEvent },
      { getCurrentWebview },
      { getCurrentWindow }
    ] = await Promise.all([
      import("@tauri-apps/api/dpi"),
      import("@tauri-apps/api/event"),
      import("@tauri-apps/api/webview"),
      import("@tauri-apps/api/window")
    ]);
    const currentWindow = getCurrentWindow();
    let currentScaleFactor: number | undefined;
    let scaleRevision = 0;
    const unlistenScale = await currentWindow.onScaleChanged(({ payload }) => {
      scaleRevision += 1;
      currentScaleFactor = payload.scaleFactor;
    });
    const unlisteners: NotesNativeUnlisten[] = [unlistenScale];
    let setupPhase: "registering" | "ready" | "closed" = "registering";
    const publishDropEvent = (event: NotesNativeImageDropEvent) => {
      if (setupPhase === "ready") listener(event);
    };
    try {
      const baselineRevision = scaleRevision;
      const baselineScaleFactor = await currentWindow.scaleFactor();
      if (scaleRevision === baselineRevision) {
        currentScaleFactor = baselineScaleFactor;
      }

      const toLogicalPoint = (position: NotesNativeDragPosition) => {
        const { x, y } = new PhysicalPosition(position).toLogical(
          currentScaleFactor!
        );
        return { x, y };
      };
      const currentWebview = getCurrentWebview();
      unlisteners.push(
        await currentWebview.listen(TauriEvent.DRAG_LEAVE, () => {
          publishDropEvent({ type: "leave" });
        })
      );
      unlisteners.push(
        await currentWebview.listen<NotesNativeDragPathsPayload>(
          TauriEvent.DRAG_DROP,
          ({ payload }) => {
            publishDropEvent({
              type: "drop",
              paths: payload.paths,
              position: toLogicalPoint(payload.position)
            });
          }
        )
      );
      unlisteners.push(
        await currentWebview.listen<NotesNativeDragOverPayload>(
          TauriEvent.DRAG_OVER,
          ({ payload }) => {
            publishDropEvent({
              type: "over",
              position: toLogicalPoint(payload.position)
            });
          }
        )
      );
      unlisteners.push(
        await currentWebview.listen<NotesNativeDragPathsPayload>(
          TauriEvent.DRAG_ENTER,
          ({ payload }) => {
            publishDropEvent({
              type: "enter",
              paths: payload.paths,
              position: toLogicalPoint(payload.position)
            });
          }
        )
      );

      setupPhase = "ready";
      const cleanup = createBestEffortCleanup(unlisteners);
      return () => {
        setupPhase = "closed";
        return cleanup();
      };
    } catch (cause) {
      setupPhase = "closed";
      await settleUnlisteners(unlisteners);
      throw cause;
    }
  }
};
