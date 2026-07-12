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
    let setupPhase: "pending" | "flushing" | "active" | "closed" = "pending";
    const setupEvents: NotesNativeImageDropEvent[] = [];
    const publishDropEvent = (event: NotesNativeImageDropEvent) => {
      if (setupPhase === "active") {
        listener(event);
        return;
      }
      if (setupPhase === "pending" || setupPhase === "flushing") {
        setupEvents.push(event);
      }
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
      const dragRegistrations = await Promise.allSettled([
        Promise.resolve().then(() =>
          currentWebview.listen<NotesNativeDragPathsPayload>(
            TauriEvent.DRAG_ENTER,
            ({ payload }) => {
              publishDropEvent({
                type: "enter",
                paths: payload.paths,
                position: toLogicalPoint(payload.position)
              });
            }
          )
        ),
        Promise.resolve().then(() =>
          currentWebview.listen<NotesNativeDragOverPayload>(
            TauriEvent.DRAG_OVER,
            ({ payload }) => {
              publishDropEvent({
                type: "over",
                position: toLogicalPoint(payload.position)
              });
            }
          )
        ),
        Promise.resolve().then(() =>
          currentWebview.listen<NotesNativeDragPathsPayload>(
            TauriEvent.DRAG_DROP,
            ({ payload }) => {
              publishDropEvent({
                type: "drop",
                paths: payload.paths,
                position: toLogicalPoint(payload.position)
              });
            }
          )
        ),
        Promise.resolve().then(() =>
          currentWebview.listen(TauriEvent.DRAG_LEAVE, () => {
            publishDropEvent({ type: "leave" });
          })
        )
      ]);
      const registrationFailure = dragRegistrations.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      );
      for (const result of dragRegistrations) {
        if (result.status === "fulfilled") unlisteners.push(result.value);
      }
      if (registrationFailure) throw registrationFailure.reason;

      setupPhase = "flushing";
      for (let index = 0; index < setupEvents.length; index += 1) {
        listener(setupEvents[index]);
      }
      setupEvents.length = 0;
      setupPhase = "active";
      const cleanup = createBestEffortCleanup(unlisteners);
      return () => {
        setupPhase = "closed";
        setupEvents.length = 0;
        return cleanup();
      };
    } catch (cause) {
      setupPhase = "closed";
      setupEvents.length = 0;
      await settleUnlisteners(unlisteners);
      throw cause;
    }
  }
};
