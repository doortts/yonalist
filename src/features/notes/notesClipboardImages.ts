import type { PendingNoteAttachmentByteItem } from "../../domain/notes";

const CANONICAL_EXTENSION_BY_MIME = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"]
]);

/** Shared trust-boundary allowlist for atom and ordinary clipboard image paths. */
export function isSupportedClipboardImageMime(
  mimeType: string
): mimeType is "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  return CANONICAL_EXTENSION_BY_MIME.has(mimeType);
}

export function canonicalClipboardImageExtension(
  mimeType: string
): string | undefined {
  return CANONICAL_EXTENSION_BY_MIME.get(mimeType);
}

export type ClipboardImageDescriptor = PendingNoteAttachmentByteItem;

export type ClipboardImageExtraction =
  | { readonly kind: "none" }
  | {
      readonly kind: "images";
      readonly items: readonly ClipboardImageDescriptor[];
    }
  | { readonly kind: "error"; readonly message: string };

export function extractClipboardImages(
  items: DataTransferItemList
): ClipboardImageExtraction {
  const images: ClipboardImageDescriptor[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== "file" || !item.type.startsWith("image/")) {
      continue;
    }

    const file = item.getAsFile();
    if (file === null) {
      return {
        kind: "error",
        message: "An image could not be read from the clipboard."
      };
    }

    const ordinal = images.length + 1;
    const extension = CANONICAL_EXTENSION_BY_MIME.get(item.type);
    const fallbackName = `clipboard-image-${ordinal}`;
    images.push({
      blob: file,
      originalName:
        file.name.length > 0
          ? file.name
          : extension === undefined
            ? fallbackName
            : `${fallbackName}.${extension}`,
      mimeType: item.type
    });
  }

  return images.length === 0
    ? { kind: "none" }
    : { kind: "images", items: images };
}
