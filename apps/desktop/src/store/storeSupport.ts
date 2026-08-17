export function messageFrom(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause) {
    return String(cause.message);
  }
  return cause instanceof Error
    ? cause.message
    : "Notes could not complete the request.";
}

export function hasErrorCode(cause: unknown, code: string): boolean {
  return Boolean(
    cause &&
    typeof cause === "object" &&
    "code" in cause &&
    cause.code === code
  );
}

/**
 * Every id ends up in the vault as `<!-- yid: ... -->`, the node's identity
 * across devices, so it has to be a UUID. Both runtimes that reach this —
 * the Tauri webview and jsdom under vitest — have `randomUUID`; a runtime
 * that does not should stop here rather than mint an unexportable node.
 */
/**
 * Twelve base64url characters from nine random bytes.
 *
 * Nine is three groups of three, so base64 has no padding to strip and no
 * partial group to bias — every byte pattern reaches a distinct twelve
 * characters. `+` and `/` are swapped for `-` and `_` because one of them is a
 * path separator and this id names a folder.
 *
 * `getRandomValues` rather than `randomUUID`: a v4 uuid fixes six of its bits to
 * a version and a variant, so nine bytes taken from one would carry 66 bits of
 * entropy instead of 72. Reaching for `crypto` at all is deliberate — where it is
 * missing this throws, and a node with an id the vault cannot write must not
 * reach the outline.
 */
export function freshId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(9));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_");
}

export function confirmedText(
  state: NotesState,
  id: string
): string | undefined {
  return state.pages.find((page) => page.id === id)?.title ??
    state.nodes.find((node) => node.id === id)?.text ??
    (state.pageNode?.id === id ? state.pageNode.text : undefined);
}

export function confirmedNote(
  state: NotesState,
  id: string
): string | undefined {
  return state.nodes.find((node) => node.id === id)?.note ??
    (state.pageNode?.id === id ? state.pageNode.note : undefined);
}
import type { NotesState } from "../notesState";

/** The one page every outline hangs from: Home, and the parent of every page. */
export const ROOT_ID = "root";

export const DRAFT_DEBOUNCE_MS = 300;
/**
 * How long a typing run stays open between keystrokes. CodeMirror and
 * ProseMirror both open a new undo group after a 500ms pause; the 300ms draft
 * debounce sits inside every pause here, so the same felt gap needs the
 * headroom.
 */
export const TYPING_IDLE_MS = 750;
export const VIEWPORT_LIMIT = 80;

export function cancelTimer<Key>(
  timers: Map<Key, ReturnType<typeof setTimeout>>,
  key: Key
): void {
  const timer = timers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(key);
}
