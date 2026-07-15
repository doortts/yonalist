import type { NoteAttachment } from "../../domain/notes";

const supportedExtensions = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const supportedMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);
const maxSafeFilenameUtf8Bytes = 255;
const windowsReservedDeviceStemPattern =
  /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i;

type NotesImageMimeType = NoteAttachment["mimeType"];

interface ImageSaveSpec {
  readonly canonicalExtension: string;
  readonly filterName: string;
  readonly extensions: readonly string[];
}

const imageSaveSpecs: Record<NotesImageMimeType, ImageSaveSpec> = {
  "image/png": {
    canonicalExtension: "png",
    filterName: "PNG image",
    extensions: ["png"]
  },
  "image/jpeg": {
    canonicalExtension: "jpg",
    filterName: "JPEG image",
    extensions: ["jpg", "jpeg"]
  },
  "image/webp": {
    canonicalExtension: "webp",
    filterName: "WebP image",
    extensions: ["webp"]
  },
  "image/gif": {
    canonicalExtension: "gif",
    filterName: "GIF image",
    extensions: ["gif"]
  }
};

export interface NotesAttachmentUiBoundary {
  openImageFiles(): Promise<readonly string[] | null>;
  saveImageFile(
    originalName: string,
    mimeType: NotesImageMimeType
  ): Promise<string | null>;
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
  const name = path.split(/[\\/]/).pop() ?? "";
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return false;
  }
  const extension = name.slice(dotIndex + 1).toLowerCase();
  return extension.length > 0 && supportedExtensions.has(extension);
}

function nativeDragPositionUsesCssCoordinates(): boolean {
  const { platform, userAgent } = window.navigator;
  return platform.startsWith("Mac") || userAgent.includes("Macintosh");
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let byteLength = 0;
  let truncated = "";
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (byteLength + characterBytes > maxBytes) break;
    truncated += character;
    byteLength += characterBytes;
  }
  return truncated;
}

function prefixWindowsReservedDeviceStem(value: string): string {
  const comparisonStem = value.split(".", 1)[0].replace(/[. ]+$/g, "");
  return windowsReservedDeviceStemPattern.test(comparisonStem)
    ? `_${value}`
    : value;
}

function normalizeFinalImageStem(
  value: string,
  maxBytes: number,
  fallback: string
): string {
  const normalizeOnce = (candidate: string): string => {
    let normalized = truncateUtf8(candidate, maxBytes).replace(/[. ]+$/g, "");
    if (normalized.length === 0 || normalized === "." || normalized === "..") {
      normalized = fallback;
    }
    return prefixWindowsReservedDeviceStem(normalized);
  };

  return normalizeOnce(normalizeOnce(value));
}

function safeImageFilename(
  originalName: string,
  mimeType: NotesImageMimeType
): string {
  const spec = imageSaveSpecs[mimeType];
  const fallbackStem = "image";
  let basename = originalName.split(/[\\/]/).pop()?.trim() ?? "";
  basename = basename
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*]+/g, "_")
    .replace(/[. ]+$/g, "")
    .replace(/^\.+/g, "");

  if (basename.length === 0 || basename === "." || basename === "..") {
    basename = fallbackStem;
  }
  basename = prefixWindowsReservedDeviceStem(basename);

  const dotIndex = basename.lastIndexOf(".");
  const originalExtension =
    dotIndex > 0 ? basename.slice(dotIndex + 1) : "";
  const preservesOriginalExtension = spec.extensions.includes(
    originalExtension.toLowerCase()
  );
  const extension = preservesOriginalExtension
    ? originalExtension
    : spec.canonicalExtension;
  let stem = dotIndex > 0 ? basename.slice(0, dotIndex) : basename;
  stem = stem.replace(/[. ]+$/g, "");
  if (stem.length === 0 || stem === "." || stem === "..") {
    stem = fallbackStem;
  }

  const suffix = `.${extension}`;
  const suffixBytes = new TextEncoder().encode(suffix).byteLength;
  stem = normalizeFinalImageStem(
    stem,
    maxSafeFilenameUtf8Bytes - suffixBytes,
    fallbackStem
  );
  return `${stem}${suffix}`;
}

function saveFilterForImageMimeType(mimeType: NotesImageMimeType) {
  const spec = imageSaveSpecs[mimeType];
  return { name: spec.filterName, extensions: [...spec.extensions] };
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

  async saveImageFile(
    originalName: string,
    mimeType: NotesImageMimeType
  ): Promise<string | null> {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const filename = safeImageFilename(originalName, mimeType);
    const selected = await save({
      defaultPath: filename,
      filters: [saveFilterForImageMimeType(mimeType)]
    });
    return typeof selected === "string" ? selected : null;
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
        // Wry's macOS backend reports NSPoint coordinates, which already match
        // the webview's CSS coordinate space even though Tauri types them as
        // PhysicalPosition. Dividing them again misses the hovered note on Retina.
        if (nativeDragPositionUsesCssCoordinates()) {
          return { x: position.x, y: position.y };
        }
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
