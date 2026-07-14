import { caseFold } from "unicode-case-folding";

/**
 * Canonical identity for a tag body.
 *
 * Normalize before folding so canonically equivalent input follows the same
 * mapping, then normalize again because a full fold can emit decomposed text.
 */
export function normalizeNoteTagIdentity(value: string): string {
  return caseFold(value.normalize("NFC")).normalize("NFC");
}
