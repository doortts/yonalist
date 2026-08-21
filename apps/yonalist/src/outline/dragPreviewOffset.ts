/**
 * Where the floating copy of a dragged row sits, relative to what is dragging
 * it.
 *
 * A pointer is an arrow a few pixels wide, so the ghost goes down and to the
 * right of it and hides nothing. A finger is not: it covers the row it holds
 * and a good deal around it, so the ghost is lifted above the touch, where it
 * can still be read.
 */
export function dragPreviewOffset(
  pointerType: string | undefined
): { readonly x: number; readonly y: number } {
  return pointerType === "touch" ? { x: 16, y: -52 } : { x: 12, y: 12 };
}
