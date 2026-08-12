import type { ImageCandidate } from "./imageApi";

const supportedMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
]);

export function clipboardImageCandidates(
  clipboardData: Pick<DataTransfer, "items"> | {
    readonly items?: DataTransferItemList;
  }
): readonly ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const items = clipboardData.items;
  if (!items) return candidates;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    const declaredMimeType = file.type || item.type;
    if (!supportedMimeTypes.has(declaredMimeType)) continue;
    candidates.push({
      originalName: file.name || `clipboard-image-${index}.${extension(
        declaredMimeType
      )}`,
      declaredMimeType,
      blob: file
    });
  }
  return candidates;
}

/**
 * The image itself on the system clipboard, with its filename as the text
 * fallback so a plain-text target still gets an outline line back, and the row's
 * own rich payload in `html` so pasting it back here restores the node rather
 * than importing the bytes again.
 *
 * Nothing is awaited before `write`: WebKit refuses a clipboard write once the
 * gesture that asked for it is over, so the bytes -- still being read off disk
 * -- go in as the item's own promises and the write leaves inside the gesture.
 */
export async function writeImageClipboard(
  bytes: Uint8Array | Promise<Uint8Array>,
  mimeType: string,
  originalName: string,
  html?: string
): Promise<void> {
  const clipboard = navigator.clipboard;
  if (
    !clipboard ||
    typeof clipboard.write !== "function" ||
    typeof ClipboardItem !== "function"
  ) {
    throw new Error("Clipboard image write is unavailable.");
  }
  const source = Promise.resolve(bytes).then((ready) =>
    new Blob([ready.slice().buffer], { type: mimeType }));
  await clipboard.write([new ClipboardItem({
    "image/png": mimeType === "image/png" ? source : source.then(pngFrom),
    "text/plain": Promise.resolve(
      new Blob([`- ${originalName}`], { type: "text/plain" })
    ),
    ...html ? {
      "text/html": Promise.resolve(new Blob([html], { type: "text/html" }))
    } : {}
  })]);
}

/** WebKit's `ClipboardItem` takes `image/png` and nothing else. */
async function pngFrom(source: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("This image format cannot be copied.");
  }
  const bitmap = await createImageBitmap(source);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This image format cannot be copied.");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"));
  if (!png) throw new Error("This image format cannot be copied.");
  return png;
}

function extension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  return mimeType.slice("image/".length);
}
