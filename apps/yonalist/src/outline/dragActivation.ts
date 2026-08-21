/**
 * How far a pointer has to travel off the bullet before it is a drag and not a
 * press.
 *
 * A mouse sits still while it clicks, so a couple of pixels is already
 * deliberate movement. A finger does not: it rolls a little on the way down and
 * again on the way up, and at four pixels an ordinary tap would lift the row and
 * swallow the zoom that tapping the bullet is for.
 *
 * The touch figure stays well under what anyone would call a swipe, so a drag
 * still begins as soon as the finger means it.
 */
export function activationDistance(pointerType: string | undefined): number {
  return pointerType === "touch" ? 10 : 4;
}
