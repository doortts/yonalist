import type { NoteId, NoteNode } from "../../domain/notes";

export interface NotesTodoProgressValue {
  readonly completed: number;
  readonly total: number;
}

export function directTodoProgress(
  parentId: NoteId,
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  childIdsByParent: Readonly<Record<NoteId, readonly NoteId[]>>
): NotesTodoProgressValue | null {
  const todos = (childIdsByParent[parentId] ?? [])
    .map((id) => nodesById[id])
    .filter((node): node is NoteNode => node?.markerKind === "todo");
  if (todos.length === 0) return null;
  return {
    completed: todos.filter((node) => node.completedAt !== null).length,
    total: todos.length
  };
}
