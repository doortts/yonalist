const supportedExtensions = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const supportedMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

export interface NotesAttachmentUiBoundary {
  /** Temporary compatibility seam removed in Task 6 after all callers switch. */
  openImageFile(): Promise<string | null>;
  /** Temporary browser-test seam removed with the old DOM drop path in Task 7. */
  pathForDroppedFile(file: File): string | null;
  openImageFiles(): Promise<readonly string[] | null>;
  subscribeToImageDrop?(
    listener: (event: NotesNativeImageDropEvent) => void
  ): Promise<() => void>;
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
  async openImageFile(): Promise<string | null> {
    const selected = await this.openImageFiles();
    return selected?.[0] ?? null;
  },

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

  async subscribeToImageDrop(listener): Promise<() => void> {
    const [{ getCurrentWebview }, { getCurrentWindow }] = await Promise.all([
      import("@tauri-apps/api/webview"),
      import("@tauri-apps/api/window")
    ]);
    return getCurrentWebview().onDragDropEvent(async ({ payload }) => {
      if (payload.type === "leave") {
        listener({ type: "leave" });
        return;
      }

      const currentScaleFactor = await getCurrentWindow().scaleFactor();
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
    });
  },

  pathForDroppedFile(file: File): string | null {
    const path = (file as File & { path?: unknown }).path;
    return typeof path === "string" && path.length > 0 ? path : null;
  }
};
