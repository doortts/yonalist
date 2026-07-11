import type {
  MoveNoteNodeInput,
  NoteId,
  NoteNode
} from "../../domain/notes";

export interface NotesMoveDestination {
  id: NoteId | null;
  label: string;
  depth: number;
}

function compareMoveNodes(left: NoteNode, right: NoteNode): number {
  return left.sortKey - right.sortKey || left.id.localeCompare(right.id);
}

export function isActiveMoveNode(
  node: NoteNode | undefined
): node is NoteNode {
  return Boolean(
    node &&
      node.deletedAt === null &&
      node.archivedAt === null &&
      node.archiveRootId === null
  );
}

function insideSubtree(
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  candidateId: NoteId,
  rootId: NoteId
): boolean {
  let current: NoteNode | undefined = nodesById[candidateId];
  const visited = new Set<NoteId>();
  while (current && !visited.has(current.id)) {
    if (current.id === rootId) {
      return true;
    }
    visited.add(current.id);
    current = current.parentId ? nodesById[current.parentId] : undefined;
  }
  return false;
}

export function buildNotesMoveDestinations(
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  movingNodeId: NoteId
): NotesMoveDestination[] {
  const childrenByParent = new Map<NoteId | null, NoteNode[]>();
  for (const node of Object.values(nodesById)) {
    if (
      !isActiveMoveNode(node) ||
      insideSubtree(nodesById, node.id, movingNodeId)
    ) {
      continue;
    }
    const parent =
      node.parentId === null ? undefined : nodesById[node.parentId];
    if (node.parentId !== null && !isActiveMoveNode(parent)) {
      continue;
    }
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort(compareMoveNodes);
  }

  const destinations: NotesMoveDestination[] = [
    { id: null, label: "Top level", depth: 0 }
  ];
  const visited = new Set<NoteId>();
  const appendChildren = (parentId: NoteId | null, depth: number) => {
    for (const node of childrenByParent.get(parentId) ?? []) {
      if (visited.has(node.id)) {
        continue;
      }
      visited.add(node.id);
      destinations.push({
        id: node.id,
        label: node.title.trim() || "Untitled node",
        depth
      });
      appendChildren(node.id, depth + 1);
    }
  };
  appendChildren(null, 0);
  return destinations;
}

export function buildNotesMoveNodeInput(
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  movingNodeId: NoteId,
  destinationId: NoteId | null
): MoveNoteNodeInput | null {
  const moving = nodesById[movingNodeId];
  if (
    !isActiveMoveNode(moving) ||
    (destinationId !== null &&
      (!isActiveMoveNode(nodesById[destinationId]) ||
        insideSubtree(nodesById, destinationId, movingNodeId)))
  ) {
    return null;
  }
  const siblings = Object.values(nodesById)
    .filter(
      (node) => isActiveMoveNode(node) && node.parentId === destinationId
    )
    .sort(compareMoveNodes);
  if (
    moving.parentId === destinationId &&
    siblings[siblings.length - 1]?.id === movingNodeId
  ) {
    return null;
  }
  const remainingSiblings = siblings.filter((node) => node.id !== movingNodeId);
  return {
    id: movingNodeId,
    parentId: destinationId,
    afterId: remainingSiblings[remainingSiblings.length - 1]?.id ?? null
  };
}
