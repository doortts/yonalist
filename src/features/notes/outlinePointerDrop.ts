import type { NoteId } from "../../domain/notes";

export interface OutlinePointerRowRect {
  readonly id: NoteId;
  readonly top: number;
  readonly bottom: number;
}

export interface OutlinePointerBoundary {
  readonly beforeId: NoteId | null;
  readonly overId: NoteId | null;
}

export function resolveOutlinePointerBoundary(
  pointerY: number,
  rows: readonly OutlinePointerRowRect[]
): OutlinePointerBoundary {
  const before = rows.find(
    (row) => pointerY < row.top + (row.bottom - row.top) / 2
  );
  if (before) {
    return { beforeId: before.id, overId: before.id };
  }
  return {
    beforeId: null,
    overId: rows.at(-1)?.id ?? null
  };
}
