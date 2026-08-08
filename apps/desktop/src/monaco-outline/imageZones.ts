import type { ImageView } from "../../../../packages/contracts/generated/ImageView";

export interface ImageZoneSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Contract I3: an image row is as wide as the width the node stored, never
 * wider than the original pixels (small images are never blown up) and never
 * wider than the editor content area. The height follows the original ratio.
 */
export function imageZoneSize(
  image: ImageView,
  contentWidth: number
): ImageZoneSize {
  const intrinsic = Math.max(0, Math.floor(image.pixelWidth));
  const available = Math.floor(contentWidth) > 0
    ? Math.floor(contentWidth)
    : intrinsic;
  const stored = image.displayWidth > 0 ? image.displayWidth : intrinsic;
  const width = Math.max(0, Math.min(stored, intrinsic, available));
  const ratio = image.pixelHeight / image.pixelWidth;
  return {
    width,
    height: Number.isFinite(ratio) ? Math.round(width * ratio) : 0
  };
}
