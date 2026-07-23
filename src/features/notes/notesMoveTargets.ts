import type {
  MoveNoteNodeInput,
  NoteId,
  NoteNode
} from "../../domain/notes";
import { GITHUB_NOTIFICATIONS_ROOT_ID } from "../../services/githubNotificationsProvider";
import { noteNodePresentationLabel } from "./notesPresentation";

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

function insideAnySubtree(
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  candidateId: NoteId,
  rootIds: ReadonlySet<NoteId>
): boolean {
  let current: NoteNode | undefined = nodesById[candidateId];
  const visited = new Set<NoteId>();
  while (current && !visited.has(current.id)) {
    if (rootIds.has(current.id)) {
      return true;
    }
    visited.add(current.id);
    current = current.parentId ? nodesById[current.parentId] : undefined;
  }
  return false;
}

function movingRootIds(
  movingNodeIds: NoteId | readonly NoteId[]
): readonly NoteId[] {
  return typeof movingNodeIds === "string" ? [movingNodeIds] : movingNodeIds;
}

function isPluginOwnedMoveNode(node: NoteNode): boolean {
  return (
    node.id === GITHUB_NOTIFICATIONS_ROOT_ID ||
    node.pluginMeta !== undefined
  );
}

export function protectedNotesMoveRootIds(
  nodesById: Readonly<Record<NoteId, NoteNode>>,
): ReadonlySet<NoteId> {
  const protectedIds = new Set<NoteId>();
  for (const node of Object.values(nodesById)) {
    if (
      !isActiveMoveNode(node) ||
      node.id === GITHUB_NOTIFICATIONS_ROOT_ID ||
      (node.isReadonly !== true && !isPluginOwnedMoveNode(node))
    ) {
      continue;
    }
    let current: NoteNode | undefined = node;
    const visited = new Set<NoteId>();
    while (
      current &&
      current.id !== GITHUB_NOTIFICATIONS_ROOT_ID &&
      !visited.has(current.id)
    ) {
      if (protectedIds.has(current.id)) {
        break;
      }
      visited.add(current.id);
      protectedIds.add(current.id);
      current =
        current.parentId === null
          ? undefined
          : nodesById[current.parentId];
    }
  }
  return protectedIds;
}

function activeChildren(
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  parentId: NoteId | null
): NoteNode[] {
  return Object.values(nodesById)
    .filter((node) => isActiveMoveNode(node) && node.parentId === parentId)
    .sort(compareMoveNodes);
}

export function buildNotesMoveDestinations(
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  movingNodeIds: NoteId | readonly NoteId[]
): NotesMoveDestination[] {
  const movingRoots = movingRootIds(movingNodeIds);
  const protectedMoveIds = protectedNotesMoveRootIds(nodesById);
  if (
    movingRoots.length === 0 ||
    new Set(movingRoots).size !== movingRoots.length ||
    movingRoots.some((nodeId) => protectedMoveIds.has(nodeId))
  ) {
    return [];
  }
  const movingRootSet = new Set(movingRoots);
  const childrenByParent = new Map<NoteId | null, NoteNode[]>();
  for (const node of Object.values(nodesById)) {
    if (
      !isActiveMoveNode(node) ||
      insideAnySubtree(nodesById, node.id, movingRootSet)
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
      if (!isPluginOwnedMoveNode(node)) {
        destinations.push({
          id: node.id,
          label: noteNodePresentationLabel(node, node.title, "Untitled node"),
          depth
        });
      }
      appendChildren(node.id, depth + 1);
    }
  };
  appendChildren(null, 0);
  return destinations;
}

/**
 * Returns whether the destination picker can offer at least one legal target
 * that changes parent or stored sibling order. The selected roots and all of
 * their descendants are excluded through {@link buildNotesMoveDestinations};
 * moving an already-last contiguous block back to the same parent is a no-op.
 */
export function hasValidNotesMoveDestination(
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  movingNodeIds: NoteId | readonly NoteId[]
): boolean {
  const roots = [...movingRootIds(movingNodeIds)];
  const rootSet = new Set(roots);
  const protectedMoveIds = protectedNotesMoveRootIds(nodesById);
  if (
    roots.length === 0 ||
    rootSet.size !== roots.length ||
    roots.some(
      (nodeId) =>
        !isActiveMoveNode(nodesById[nodeId]) ||
        protectedMoveIds.has(nodeId)
    )
  ) {
    return false;
  }

  return buildNotesMoveDestinations(nodesById, roots).some((destination) => {
    if (roots.some((nodeId) => nodesById[nodeId].parentId !== destination.id)) {
      return true;
    }

    const currentOrder = activeChildren(nodesById, destination.id).map(
      (node) => node.id
    );
    const resultingOrder = [
      ...currentOrder.filter((nodeId) => !rootSet.has(nodeId)),
      ...roots
    ];
    return (
      currentOrder.length !== resultingOrder.length ||
      currentOrder.some((nodeId, index) => nodeId !== resultingOrder[index])
    );
  });
}

export function buildNotesMoveNodeInput(
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  movingNodeId: NoteId,
  destinationId: NoteId | null
): MoveNoteNodeInput | null {
  const moving = nodesById[movingNodeId];
  const protectedMoveIds = protectedNotesMoveRootIds(nodesById);
  if (
    !isActiveMoveNode(moving) ||
    protectedMoveIds.has(movingNodeId) ||
    (movingNodeId === GITHUB_NOTIFICATIONS_ROOT_ID &&
      destinationId !== null) ||
    (destinationId !== null &&
      (!isActiveMoveNode(nodesById[destinationId]) ||
        isPluginOwnedMoveNode(nodesById[destinationId]) ||
        insideAnySubtree(
          nodesById,
          destinationId,
          new Set([movingNodeId])
        )))
  ) {
    return null;
  }
  const siblings = activeChildren(nodesById, destinationId);
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
