import type { NoteId } from "../../domain/notes";

export type OutlineCaretEdge =
  | "start"
  | "end"
  | { readonly start: number; readonly end: number };

function outlineEditor(
  paneRoot: HTMLElement,
  nodeId: NoteId,
  field: "title" | "note",
): HTMLTextAreaElement | null {
  const row = Array.from(
    paneRoot.querySelectorAll<HTMLElement>("[data-outline-id]"),
  ).find((candidate) => candidate.dataset.outlineId === nodeId);
  const fieldSelector =
    field === "title" ? "textarea.notes-node-title" : "textarea.notes-node-note";
  return row?.querySelector<HTMLTextAreaElement>(fieldSelector) ?? null;
}

export function focusOutlineEditorDom(
  paneRoot: HTMLElement,
  nodeId: NoteId,
  field: "title" | "note",
  edge: OutlineCaretEdge | null,
): boolean {
  const textarea = outlineEditor(paneRoot, nodeId, field);
  if (!textarea) return false;

  textarea.focus();
  if (document.activeElement !== textarea) return false;
  if (edge === null) return true;

  const length = textarea.value.length;
  const clamp = (offset: number): number =>
    Math.max(0, Math.min(length, offset));
  const start =
    edge === "start" ? 0 : edge === "end" ? length : clamp(edge.start);
  const end =
    edge === "start" ? 0 : edge === "end" ? length : clamp(edge.end);
  textarea.setSelectionRange(Math.min(start, end), Math.max(start, end));
  return true;
}
