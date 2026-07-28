import type { NoteId } from "../../domain/notes";

export function outlineTitleEditor(
  root: ParentNode | null,
  nodeId: NoteId,
): HTMLTextAreaElement | HTMLDivElement | null {
  const row = Array.from(
    root?.querySelectorAll<HTMLElement>("[data-outline-id]") ?? [],
  ).find((candidate) => candidate.dataset.outlineId === nodeId);
  return (
    row?.querySelector<HTMLDivElement>("[data-notes-bullet-title]") ??
    row?.querySelector<HTMLTextAreaElement>("textarea.notes-node-title") ?? null
  );
}
