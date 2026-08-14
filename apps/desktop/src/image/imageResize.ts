export const MIN_IMAGE_DISPLAY_WIDTH = 120;

export function clampImageWidth(width: number, contentWidth: number): number {
  const maximum = Math.max(MIN_IMAGE_DISPLAY_WIDTH, Math.floor(contentWidth));
  const finiteWidth = Number.isFinite(width) ? width : maximum;
  return Math.round(Math.min(maximum, Math.max(
    MIN_IMAGE_DISPLAY_WIDTH,
    finiteWidth
  )));
}

export function imageKeyboardResizeWidth(
  width: number,
  key: "ArrowLeft" | "ArrowRight",
  shiftKey: boolean,
  contentWidth: number
): number {
  const step = shiftKey ? 50 : 10;
  return clampImageWidth(
    width + (key === "ArrowLeft" ? -step : step),
    contentWidth
  );
}
