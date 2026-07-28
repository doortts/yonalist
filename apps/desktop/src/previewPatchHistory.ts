import type { NoteView } from "../../../packages/contracts/generated/NoteView";

export interface PreviewNodeDelta {
  readonly upserts: readonly NoteView[];
  readonly removedIds: readonly string[];
  readonly receiptDeletedIds: readonly string[];
}

export interface PreviewHistoryEntry {
  readonly forward: PreviewNodeDelta;
  readonly inverse: PreviewNodeDelta;
}

function sameNode(left: NoteView, right: NoteView): boolean {
  return left.id === right.id &&
    left.parentId === right.parentId &&
    left.sortKey === right.sortKey &&
    left.kind === right.kind &&
    left.text === right.text &&
    left.note === right.note &&
    left.marker === right.marker &&
    left.collapsed === right.collapsed &&
    left.completed === right.completed &&
    left.starred === right.starred &&
    left.deleted === right.deleted;
}

function deltaBetween(
  previous: readonly NoteView[],
  next: readonly NoteView[]
): PreviewNodeDelta {
  const previousById = new Map(previous.map((node) => [node.id, node]));
  const nextIds = new Set(next.map((node) => node.id));
  const upserts = next
    .filter((node) => {
      const prior = previousById.get(node.id);
      return !prior || !sameNode(prior, node);
    })
    .map((node) => ({ ...node }));
  const removedIds = previous
    .filter((node) => !nextIds.has(node.id))
    .map((node) => node.id);
  const receiptDeletedIds = [
    ...removedIds,
    ...upserts
      .filter((node) => node.deleted && !previousById.get(node.id)?.deleted)
      .map((node) => node.id)
  ];

  return { upserts, removedIds, receiptDeletedIds };
}

export function createPreviewHistoryEntry(
  previous: readonly NoteView[],
  next: readonly NoteView[]
): PreviewHistoryEntry {
  return {
    forward: deltaBetween(previous, next),
    inverse: deltaBetween(next, previous)
  };
}

export function applyPreviewDelta(
  current: readonly NoteView[],
  delta: PreviewNodeDelta
): NoteView[] {
  const removedIds = new Set(delta.removedIds);
  const upsertsById = new Map(delta.upserts.map((node) => [node.id, node]));
  const existingIds = new Set(current.map((node) => node.id));
  const next = current
    .filter((node) => !removedIds.has(node.id))
    .map((node) => {
      const replacement = upsertsById.get(node.id);
      return replacement ? { ...replacement } : node;
    });

  for (const node of delta.upserts) {
    if (!existingIds.has(node.id) && !removedIds.has(node.id)) {
      next.push({ ...node });
    }
  }
  return next;
}
