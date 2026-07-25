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

export function buildTodoProgressMap(
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  childIdsByParent: Readonly<Record<NoteId, readonly NoteId[]>>
): ReadonlyMap<NoteId, NotesTodoProgressValue> {
  const progress = new Map<NoteId, NotesTodoProgressValue>();
  for (const [parentId, childIds] of Object.entries(childIdsByParent)) {
    let completed = 0;
    let total = 0;
    for (const childId of childIds) {
      const child = nodesById[childId];
      if (child?.markerKind !== "todo") continue;
      total += 1;
      if (child.completedAt !== null) {
        completed += 1;
      }
    }
    if (total > 0) {
      progress.set(parentId, { completed, total });
    }
  }
  return progress;
}
