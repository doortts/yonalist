import type {
  NoteAttachment,
  NoteAttachmentsByNodeId,
  NoteId,
  NoteNode
} from "../../domain/notes";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";

const NOTE_NODE_FIELDS = [
  "id",
  "nodeKind",
  "markerKind",
  "parentId",
  "sortKey",
  "title",
  "note",
  "imageOffsetUtf16",
  "markdownImageWidth",
  "layoutMode",
  "isCollapsed",
  "isStarred",
  "completedAt",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "archivedAt",
  "archiveRootId"
] as const satisfies readonly (keyof NoteNode)[];
const NOTE_ATTACHMENT_FIELDS = [
  "id",
  "nodeId",
  "sortKey",
  "relativePath",
  "contentHash",
  "originalName",
  "mimeType",
  "byteSize",
  "intrinsicWidth",
  "intrinsicHeight",
  "displayWidth",
  "createdAt",
  "updatedAt"
] as const satisfies readonly (keyof NoteAttachment)[];
const ALL_NODE_FIELDS_LISTED: Exclude<
  keyof NoteNode,
  (typeof NOTE_NODE_FIELDS)[number]
> extends never
  ? true
  : never = true;
const ALL_ATTACHMENT_FIELDS_LISTED: Exclude<
  keyof NoteAttachment,
  (typeof NOTE_ATTACHMENT_FIELDS)[number]
> extends never
  ? true
  : never = true;
void ALL_NODE_FIELDS_LISTED;
void ALL_ATTACHMENT_FIELDS_LISTED;

function equalIds(
  previous: readonly NoteId[],
  next: readonly NoteId[]
): boolean {
  return (
    previous.length === next.length &&
    previous.every((id, index) => id === next[index])
  );
}

function equalNoteNode(previous: NoteNode, next: NoteNode): boolean {
  return (
    previous.id === next.id &&
    previous.nodeKind === next.nodeKind &&
    previous.markerKind === next.markerKind &&
    previous.parentId === next.parentId &&
    previous.sortKey === next.sortKey &&
    previous.title === next.title &&
    previous.note === next.note &&
    previous.imageOffsetUtf16 === next.imageOffsetUtf16 &&
    previous.markdownImageWidth === next.markdownImageWidth &&
    previous.layoutMode === next.layoutMode &&
    previous.isCollapsed === next.isCollapsed &&
    previous.isStarred === next.isStarred &&
    previous.completedAt === next.completedAt &&
    previous.createdAt === next.createdAt &&
    previous.updatedAt === next.updatedAt &&
    previous.deletedAt === next.deletedAt &&
    previous.archivedAt === next.archivedAt &&
    previous.archiveRootId === next.archiveRootId
  );
}

function equalAttachment(
  previous: NoteAttachment,
  next: NoteAttachment
): boolean {
  return (
    previous.id === next.id &&
    previous.nodeId === next.nodeId &&
    previous.sortKey === next.sortKey &&
    previous.relativePath === next.relativePath &&
    previous.contentHash === next.contentHash &&
    previous.originalName === next.originalName &&
    previous.mimeType === next.mimeType &&
    previous.byteSize === next.byteSize &&
    previous.intrinsicWidth === next.intrinsicWidth &&
    previous.intrinsicHeight === next.intrinsicHeight &&
    previous.displayWidth === next.displayWidth &&
    previous.createdAt === next.createdAt &&
    previous.updatedAt === next.updatedAt
  );
}

function retainNodes(
  previous: Record<NoteId, NoteNode>,
  next: Record<NoteId, NoteNode>
): Record<NoteId, NoteNode> {
  const previousIds = Object.keys(previous);
  const nextIds = Object.keys(next);
  let canReuseRecord = previousIds.length === nextIds.length;
  const retained = Object.create(null) as Record<NoteId, NoteNode>;

  for (const id of nextIds) {
    const previousNode = previous[id];
    const nextNode = next[id];
    const retainedNode =
      previousNode && equalNoteNode(previousNode, nextNode)
        ? previousNode
        : nextNode;
    retained[id] = retainedNode;
    canReuseRecord &&= retainedNode === previousNode;
  }

  return canReuseRecord ? previous : retained;
}

function retainChildIdsByParent(
  previous: Record<string, NoteId[]>,
  next: Record<string, NoteId[]>
): Record<string, NoteId[]> {
  const previousParentIds = Object.keys(previous);
  const nextParentIds = Object.keys(next);
  let canReuseRecord = previousParentIds.length === nextParentIds.length;
  const retained = Object.create(null) as Record<string, NoteId[]>;

  for (const parentId of nextParentIds) {
    const previousIds = previous[parentId];
    const nextIds = next[parentId];
    const retainedIds =
      previousIds && equalIds(previousIds, nextIds) ? previousIds : nextIds;
    retained[parentId] = retainedIds;
    canReuseRecord &&= retainedIds === previousIds;
  }

  return canReuseRecord ? previous : retained;
}

function retainAttachmentList(
  previous: NoteAttachment[] | undefined,
  next: NoteAttachment[]
): NoteAttachment[] {
  if (!previous) {
    return next;
  }
  const previousById = new Map(
    previous.map((attachment) => [attachment.id, attachment])
  );
  const retained = next.map((attachment) => {
    const previousAttachment = previousById.get(attachment.id);
    return previousAttachment &&
      equalAttachment(previousAttachment, attachment)
      ? previousAttachment
      : attachment;
  });
  return previous.length === retained.length &&
    retained.every((attachment, index) => attachment === previous[index])
    ? previous
    : retained;
}

function retainAttachmentsByNodeId(
  previous: NoteAttachmentsByNodeId,
  next: NoteAttachmentsByNodeId
): NoteAttachmentsByNodeId {
  const previousNodeIds = Object.keys(previous);
  const nextNodeIds = Object.keys(next);
  let canReuseRecord = previousNodeIds.length === nextNodeIds.length;
  const retained = Object.create(null) as NoteAttachmentsByNodeId;

  for (const nodeId of nextNodeIds) {
    const previousAttachments = previous[nodeId];
    const retainedAttachments = retainAttachmentList(
      previousAttachments,
      next[nodeId]
    );
    retained[nodeId] = retainedAttachments;
    canReuseRecord &&= retainedAttachments === previousAttachments;
  }

  return canReuseRecord ? previous : retained;
}

export function retainNormalizedWorkspaceIdentity(
  previous: NormalizedNotesWorkspace,
  next: NormalizedNotesWorkspace
): NormalizedNotesWorkspace {
  const nodesById = retainNodes(previous.nodesById, next.nodesById);
  const childIdsByParent = retainChildIdsByParent(
    previous.childIdsByParent,
    next.childIdsByParent
  );
  const rootIds = equalIds(previous.rootIds, next.rootIds)
    ? previous.rootIds
    : next.rootIds;
  const attachmentsByNodeId = retainAttachmentsByNodeId(
    previous.attachmentsByNodeId,
    next.attachmentsByNodeId
  );

  if (
    nodesById === previous.nodesById &&
    childIdsByParent === previous.childIdsByParent &&
    rootIds === previous.rootIds &&
    attachmentsByNodeId === previous.attachmentsByNodeId &&
    next.selectedId === previous.selectedId &&
    next.zoomRootId === previous.zoomRootId &&
    next.editingNoteId === previous.editingNoteId &&
    next.pendingFocusId === previous.pendingFocusId &&
    next.pendingFocusField === previous.pendingFocusField &&
    next.status === previous.status &&
    next.error === previous.error
  ) {
    return previous;
  }

  return {
    ...next,
    nodesById,
    childIdsByParent,
    rootIds,
    attachmentsByNodeId
  };
}
