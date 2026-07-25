import type { NoteId } from "../../domain/notes";

export function outlineTitleTextarea(
  root: ParentNode | null,
  nodeId: NoteId,
): HTMLTextAreaElement | null {
  const row = Array.from(
    root?.querySelectorAll<HTMLElement>("[data-outline-id]") ?? [],
  ).find((candidate) => candidate.dataset.outlineId === nodeId);
  return (
    row?.querySelector<HTMLTextAreaElement>("textarea.notes-node-title") ?? null
  );
}
