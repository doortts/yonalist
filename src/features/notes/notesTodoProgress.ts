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

/**
 * Batched progress for every parent that has direct To-do children, built in a
 * single O(N) pass over `childIdsByParent`. The render loop calls this once (via
 * useMemo, invalidated only when `nodesById`/`childIdsByParent` change) and does
 * a Map lookup per row instead of re-running {@link directTodoProgress} — an
 * O(children) child scan — for every visible row on every pane re-render.
 * Parents without To-do children are omitted, so a missing key means null.
 */
export function buildTodoProgressMap(
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  childIdsByParent: Readonly<Record<NoteId, readonly NoteId[]>>
): ReadonlyMap<NoteId, NotesTodoProgressValue> {
  const progress = new Map<NoteId, NotesTodoProgressValue>();
  for (const parentId of Object.keys(childIdsByParent)) {
    const value = directTodoProgress(parentId, nodesById, childIdsByParent);
    if (value !== null) {
      progress.set(parentId, value);
    }
  }
  return progress;
}
