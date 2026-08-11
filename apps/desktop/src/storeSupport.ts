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

export function freshId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `note-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
import type { NotesState } from "./notesState";

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
