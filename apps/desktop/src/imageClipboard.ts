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

function extension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  return mimeType.slice("image/".length);
}
