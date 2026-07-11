const supportedExtensions = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const supportedMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

export interface NotesAttachmentUiBoundary {
  openImageFile(): Promise<string | null>;
  pathForDroppedFile(file: File): string | null;
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
  async openImageFile(): Promise<string | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "webp", "gif"]
        }
      ]
    });
    return typeof selected === "string" ? selected : null;
  },

  pathForDroppedFile(file: File): string | null {
    const path = (file as File & { path?: unknown }).path;
    return typeof path === "string" && path.length > 0 ? path : null;
  }
};
