import type { NoteId } from "../../domain/notes";
import type { NotesLogicalPoint } from "./notesAttachmentController";

export function attachmentTargetFromPoint(
  root: HTMLElement,
  logicalPoint: NotesLogicalPoint
): NoteId | null {
  const hit = document.elementFromPoint(logicalPoint.x, logicalPoint.y);
  const target = hit?.closest<HTMLElement>(
    "[data-notes-attachment-target]"
  );
  if (!target || !root.contains(target)) return null;

  const noteId = target.dataset.notesAttachmentTarget;
  return noteId?.trim() ? noteId : null;
}

export function attachmentTargetFromPaste(
  root: HTMLElement,
  eventTarget: EventTarget | null,
  selectedId: NoteId | null
): NoteId | null {
  const element =
    eventTarget instanceof Element
      ? eventTarget
      : eventTarget instanceof Node
        ? eventTarget.parentElement
        : null;
  const target = element?.closest<HTMLElement>(
    "[data-notes-attachment-target]"
  );
  if (target && root.contains(target)) {
    const noteId = target.dataset.notesAttachmentTarget;
    if (noteId?.trim()) return noteId;
  }

  return selectedId?.trim() ? selectedId : null;
}
