import type { NoteId } from "../../domain/notes";
import {
  readPlainText,
  restorePlainTextSelection,
} from "./plainTextContenteditable";
import { outlineTitleEditor } from "./outlineDom";

export type OutlineCaretEdge =
  | "start"
  | "end"
  | { readonly start: number; readonly end: number };

function outlineNoteEditor(
  paneRoot: HTMLElement,
  nodeId: NoteId,
): HTMLTextAreaElement | null {
  const row = Array.from(
    paneRoot.querySelectorAll<HTMLElement>("[data-outline-id]"),
  ).find((candidate) => candidate.dataset.outlineId === nodeId);
  return (
    row?.querySelector<HTMLTextAreaElement>("textarea.notes-node-note") ?? null
  );
}

export function focusOutlineEditorDom(
  paneRoot: HTMLElement,
  nodeId: NoteId,
  field: "title" | "note",
  edge: OutlineCaretEdge | null,
): boolean {
  const editor =
    field === "title"
      ? outlineTitleEditor(paneRoot, nodeId)
      : outlineNoteEditor(paneRoot, nodeId);
  if (!editor) return false;

  const value =
    editor instanceof HTMLTextAreaElement ? editor.value : readPlainText(editor);
  const length = value.length;
  if (edge === null) {
    editor.focus();
    return document.activeElement === editor;
  }
  const clamp = (offset: number): number =>
    Math.max(0, Math.min(length, offset));
  const start =
    edge === "start" ? 0 : edge === "end" ? length : clamp(edge.start);
  const end =
    edge === "start" ? 0 : edge === "end" ? length : clamp(edge.end);
  if (editor instanceof HTMLTextAreaElement) {
    editor.focus();
    if (document.activeElement !== editor) return false;
    editor.setSelectionRange(Math.min(start, end), Math.max(start, end));
  } else {
    restorePlainTextSelection(editor, {
      anchorUtf16: Math.min(start, end),
      focusUtf16: Math.max(start, end),
    });
    editor.setAttribute("data-notes-restore-title-selection", "true");
    editor.focus();
    editor.removeAttribute("data-notes-restore-title-selection");
    if (document.activeElement !== editor) return false;
    restorePlainTextSelection(editor, {
      anchorUtf16: Math.min(start, end),
      focusUtf16: Math.max(start, end),
    });
  }
  return true;
}
