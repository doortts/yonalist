import {
  createNoteId,
  type ImportImageNodeByteItem,
  type ImportImageNodePathItem,
  type NoteId,
  type PendingImageNodeByteItem
} from "../../domain/notes";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";

export interface ImageNodeInsertionAnchor {
  readonly parentId: NoteId | null;
  readonly afterId: NoteId | null;
}

export interface ImageNodeIdPair {
  readonly nodeId: NoteId;
  readonly attachmentId: string;
}

export function imageNodeInsertionAnchor(
  state: Pick<NormalizedNotesWorkspace, "nodesById" | "zoomRootId">,
  targetId: NoteId
): ImageNodeInsertionAnchor | null {
  const target = state.nodesById[targetId];
  if (
    !target ||
    target.deletedAt !== null ||
    target.archivedAt !== null
  ) {
    return null;
  }

  if (state.zoomRootId === targetId) {
    return { parentId: target.id, afterId: null };
  }

  return { parentId: target.parentId, afterId: target.id };
}

export function sameImageNodeInsertionAnchor(
  left: ImageNodeInsertionAnchor,
  right: ImageNodeInsertionAnchor
): boolean {
  return left.parentId === right.parentId && left.afterId === right.afterId;
}

export function createImageNodeIdPairs(
  count: number,
  createId: () => NoteId = createNoteId
): ImageNodeIdPair[] {
  const pairs: ImageNodeIdPair[] = [];
  for (let index = 0; index < count; index += 1) {
    pairs.push({
      nodeId: createId(),
      attachmentId: createId()
    });
  }
  return pairs;
}

function assertMatchingPairCount(
  sourceCount: number,
  pairs: readonly ImageNodeIdPair[]
): void {
  if (sourceCount !== pairs.length) {
    throw new Error("Image node import IDs do not match the source count.");
  }
}

export function imageNodePathItems(
  paths: readonly string[],
  pairs: readonly ImageNodeIdPair[]
): ImportImageNodePathItem[] {
  assertMatchingPairCount(paths.length, pairs);
  return paths.map((sourcePath, index) => ({
    nodeId: pairs[index]!.nodeId,
    attachmentId: pairs[index]!.attachmentId,
    sourcePath
  }));
}

export function imageNodeByteItems(
  items: readonly PendingImageNodeByteItem[],
  pairs: readonly ImageNodeIdPair[]
): ImportImageNodeByteItem[] {
  assertMatchingPairCount(items.length, pairs);
  return items.map((item, index) => ({
    nodeId: pairs[index]!.nodeId,
    attachmentId: pairs[index]!.attachmentId,
    originalName: item.originalName,
    mimeType: item.mimeType,
    blob: item.blob
  }));
}
