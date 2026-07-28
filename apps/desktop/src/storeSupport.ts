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
    state.nodes.find((node) => node.id === id)?.text;
}

export function confirmedNote(
  state: NotesState,
  id: string
): string | undefined {
  return state.nodes.find((node) => node.id === id)?.note;
}
import type { NotesState } from "./notesState";

export const DRAFT_DEBOUNCE_MS = 300;
export const VIEWPORT_LIMIT = 80;

export function cancelTimer<Key>(
  timers: Map<Key, ReturnType<typeof setTimeout>>,
  key: Key
): void {
  const timer = timers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(key);
}
