/**
 * How far into the edge a finger has to be before the list starts moving. Wide
 * enough that the edge can be reached without leaving the screen, narrow enough
 * that the middle of a phone-sized list is still still.
 */
const EDGE = 56;
/** The most a single frame moves, so the rows stay readable while they pass. */
const MOST = 24;

/**
 * How far the list should move this frame while a row is being dragged, in
 * pixels: negative towards the top, positive towards the bottom, zero to stay.
 *
 * A phone shows a dozen rows at once, so a row's new home is usually somewhere
 * the finger cannot reach without the list coming to meet it. The nearer the
 * edge, the faster it comes; past the edge it keeps its fastest, because a
 * finger that has left the list has not changed its mind about where the row
 * should go.
 */
export function autoscrollStep(
  y: number,
  box: { readonly top: number; readonly bottom: number }
): number {
  const intoTop = box.top + EDGE - y;
  if (intoTop > 0) return -Math.min(MOST, Math.ceil((intoTop / EDGE) * MOST));
  const intoBottom = y - (box.bottom - EDGE);
  if (intoBottom > 0) return Math.min(MOST, Math.ceil((intoBottom / EDGE) * MOST));
  return 0;
}
