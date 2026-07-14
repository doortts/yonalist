import type { NoteId, NoteNode } from "../../domain/notes";
import { hasValidNotesMoveDestination } from "./notesMoveTargets";
import {
  selectionRangeIds,
  type NormalizedNotesWorkspace,
  type NotesSelection
} from "./notesWorkspaceReducer";

export type NotesSelectionCompletion = "none" | "mixed" | "all";

export type NotesSelectionUnavailable = Readonly<{
  eligible: false;
  reason: string;
}>;

export type NotesSelectionTargetEligibility<
  Details extends object = Record<never, never>
> =
  | Readonly<
      {
        eligible: true;
        nodeIds: readonly NoteId[];
      } & Details
    >
  | NotesSelectionUnavailable;

export type NotesSelectionEligibility = NotesSelectionTargetEligibility;

export interface NotesSelectionMoveTarget {
  readonly parentId: NoteId | null;
  readonly afterId: NoteId | null;
}

export type NotesSelectionReorderEligibility =
  NotesSelectionTargetEligibility<{
    readonly target: Readonly<NotesSelectionMoveTarget>;
  }>;

export interface NotesSelectionActionEligibility {
  readonly copy: NotesSelectionEligibility;
  readonly cut: NotesSelectionEligibility;
  readonly delete: NotesSelectionEligibility;
  readonly duplicate: NotesSelectionEligibility;
  readonly indent: NotesSelectionEligibility;
  readonly outdent: NotesSelectionEligibility;
  readonly moveUp: NotesSelectionReorderEligibility;
  readonly moveDown: NotesSelectionReorderEligibility;
  readonly moveTo: NotesSelectionEligibility;
}

export interface NotesSelectionActionSnapshot {
  readonly selection: Readonly<NotesSelection>;
  /** Every explicitly selected visible row, always in outline order. */
  readonly selectedNodeIds: readonly NoteId[];
  /**
   * Structural forest roots in outline order. A selected node is suppressed
   * here when one of its ancestors is also explicitly selected.
   */
  readonly structuralRootIds: readonly NoteId[];
  readonly completion: NotesSelectionCompletion;
  readonly deleteFocusNodeId: NoteId | null;
  readonly eligibility: Readonly<NotesSelectionActionEligibility>;
}

export interface DeriveNotesSelectionActionSnapshotInput {
  readonly selection: NotesSelection | null;
  readonly visibleNodeIds: readonly NoteId[];
  readonly workspace: NormalizedNotesWorkspace;
  /**
   * Explicit complete active-tree source. A filtered/scoped projection is
   * never assumed complete when this value is absent.
   */
  readonly authoritativeWorkspace?: NormalizedNotesWorkspace;
}

const COMPLETE_STRUCTURE_REASON =
  "This action requires the complete active workspace.";

function unavailable(reason: string): NotesSelectionUnavailable {
  return Object.freeze({ eligible: false, reason });
}

function eligibleTargets(
  nodeIds: readonly NoteId[]
): NotesSelectionEligibility {
  return Object.freeze({
    eligible: true,
    nodeIds: Object.freeze([...nodeIds])
  });
}

function eligibleReorder(
  nodeIds: readonly NoteId[],
  target: NotesSelectionMoveTarget
): NotesSelectionReorderEligibility {
  return Object.freeze({
    eligible: true,
    nodeIds: Object.freeze([...nodeIds]),
    target: Object.freeze({ ...target })
  });
}

function compareNodes(left: NoteNode, right: NoteNode): number {
  return left.sortKey - right.sortKey || left.id.localeCompare(right.id);
}

function sameIds(
  actual: readonly NoteId[],
  expected: readonly NoteId[]
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((nodeId, index) => nodeId === expected[index])
  );
}

function isCompleteActiveAuthority(
  projection: NormalizedNotesWorkspace,
  authority: NormalizedNotesWorkspace | undefined
): authority is NormalizedNotesWorkspace {
  if (!authority || authority.status !== "ready") {
    return false;
  }

  const nodes = Object.values(authority.nodesById);
  const expectedRootIds = nodes
    .filter((node) => node.parentId === null)
    .sort(compareNodes)
    .map((node) => node.id);
  if (!sameIds(authority.rootIds, expectedRootIds)) {
    return false;
  }

  const expectedChildren = new Map<NoteId, NoteNode[]>();
  for (const node of nodes) {
    if (
      node.deletedAt !== null ||
      node.archivedAt !== null ||
      node.archiveRootId !== null
    ) {
      return false;
    }
    if (node.parentId === null) {
      continue;
    }
    if (!authority.nodesById[node.parentId]) {
      return false;
    }
    const siblings = expectedChildren.get(node.parentId) ?? [];
    siblings.push(node);
    expectedChildren.set(node.parentId, siblings);
  }

  const actualParentIds = Object.keys(authority.childIdsByParent);
  if (actualParentIds.length !== expectedChildren.size) {
    return false;
  }
  for (const [parentId, children] of expectedChildren) {
    const expectedIds = children.sort(compareNodes).map((node) => node.id);
    if (!sameIds(authority.childIdsByParent[parentId] ?? [], expectedIds)) {
      return false;
    }
  }

  const resolved = new Set<NoteId>();
  for (const node of nodes) {
    const path = new Set<NoteId>();
    let current: NoteNode | undefined = node;
    while (current && !resolved.has(current.id)) {
      if (path.has(current.id)) {
        return false;
      }
      path.add(current.id);
      current =
        current.parentId === null
          ? undefined
          : authority.nodesById[current.parentId];
    }
    for (const nodeId of path) {
      resolved.add(nodeId);
    }
  }

  for (const projected of Object.values(projection.nodesById)) {
    const authoritative = authority.nodesById[projected.id];
    if (
      !authoritative ||
      authoritative.parentId !== projected.parentId ||
      authoritative.sortKey !== projected.sortKey ||
      authoritative.title !== projected.title ||
      authoritative.note !== projected.note ||
      authoritative.deletedAt !== projected.deletedAt ||
      authoritative.archivedAt !== projected.archivedAt ||
      authoritative.archiveRootId !== projected.archiveRootId
    ) {
      return false;
    }
  }

  for (const [nodeId, projectedAttachments] of Object.entries(
    projection.attachmentsByNodeId
  )) {
    const authoritativeIds = new Set(
      (authority.attachmentsByNodeId[nodeId] ?? []).map(
        (attachment) => attachment.id
      )
    );
    if (
      projectedAttachments.some(
        (attachment) => !authoritativeIds.has(attachment.id)
      )
    ) {
      return false;
    }
  }
  for (const [nodeId, attachments] of Object.entries(
    authority.attachmentsByNodeId
  )) {
    if (
      !authority.nodesById[nodeId] ||
      attachments.some((attachment) => attachment.nodeId !== nodeId)
    ) {
      return false;
    }
  }

  return true;
}

function hasSelectedAncestor(
  nodeId: NoteId,
  selectedNodeIds: ReadonlySet<NoteId>,
  workspace: NormalizedNotesWorkspace
): boolean {
  let parentId = workspace.nodesById[nodeId]?.parentId ?? null;
  const visited = new Set<NoteId>();
  while (parentId !== null && !visited.has(parentId)) {
    if (selectedNodeIds.has(parentId)) {
      return true;
    }
    visited.add(parentId);
    parentId = workspace.nodesById[parentId]?.parentId ?? null;
  }
  return false;
}

function collectSubtreeIds(
  rootIds: readonly NoteId[],
  workspace: NormalizedNotesWorkspace
): ReadonlySet<NoteId> {
  const subtreeIds = new Set<NoteId>();
  const stack = [...rootIds].reverse();
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (!nodeId || subtreeIds.has(nodeId) || !workspace.nodesById[nodeId]) {
      continue;
    }
    subtreeIds.add(nodeId);
    const childIds = workspace.childIdsByParent[nodeId] ?? [];
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      stack.push(childIds[index]);
    }
  }
  return subtreeIds;
}

function completionAggregate(
  selectedNodeIds: readonly NoteId[],
  workspace: NormalizedNotesWorkspace
): NotesSelectionCompletion {
  let completedCount = 0;
  for (const nodeId of selectedNodeIds) {
    if (workspace.nodesById[nodeId].completedAt !== null) {
      completedCount += 1;
    }
  }
  if (completedCount === 0) {
    return "none";
  }
  return completedCount === selectedNodeIds.length ? "all" : "mixed";
}

function deleteFocusCandidate(
  selectedNodeIds: readonly NoteId[],
  visibleNodeIds: readonly NoteId[],
  deletedSubtreeIds: ReadonlySet<NoteId>
): NoteId | null {
  const firstIndex = visibleNodeIds.indexOf(selectedNodeIds[0]);
  const lastIndex = visibleNodeIds.indexOf(
    selectedNodeIds[selectedNodeIds.length - 1]
  );
  for (let index = lastIndex + 1; index < visibleNodeIds.length; index += 1) {
    if (!deletedSubtreeIds.has(visibleNodeIds[index])) {
      return visibleNodeIds[index];
    }
  }
  for (let index = firstIndex - 1; index >= 0; index -= 1) {
    if (!deletedSubtreeIds.has(visibleNodeIds[index])) {
      return visibleNodeIds[index];
    }
  }
  return null;
}

function cutEligibility(
  rootIds: readonly NoteId[],
  subtreeIds: ReadonlySet<NoteId>,
  workspace: NormalizedNotesWorkspace
): NotesSelectionEligibility {
  for (const nodeId of subtreeIds) {
    const node = workspace.nodesById[nodeId];
    if (node.note.length > 0) {
      return unavailable(
        "Cut is unavailable because the selected subtrees contain supporting notes. Use Move To to preserve rich content."
      );
    }
    if ((workspace.attachmentsByNodeId[nodeId]?.length ?? 0) > 0) {
      return unavailable(
        "Cut is unavailable because the selected subtrees contain attachments. Use Move To to preserve rich content."
      );
    }
    if (node.title.includes("\n") || node.title.includes("\r")) {
      return unavailable(
        "Cut is unavailable because the selected subtrees contain embedded title newlines. Use Move To to preserve rich content."
      );
    }
  }
  return eligibleTargets(rootIds);
}

function sharedParentId(
  rootIds: readonly NoteId[],
  workspace: NormalizedNotesWorkspace
): { shared: true; parentId: NoteId | null } | { shared: false } {
  const parentId = workspace.nodesById[rootIds[0]].parentId;
  return rootIds.every(
    (nodeId) => workspace.nodesById[nodeId].parentId === parentId
  )
    ? { shared: true, parentId }
    : { shared: false };
}

function duplicateEligibility(
  rootIds: readonly NoteId[],
  workspace: NormalizedNotesWorkspace
): NotesSelectionEligibility {
  return sharedParentId(rootIds, workspace).shared
    ? eligibleTargets(rootIds)
    : unavailable("Duplicate requires selected roots that share one parent.");
}

function indentEligibility(
  rootIds: readonly NoteId[],
  visibleNodeIds: readonly NoteId[],
  workspace: NormalizedNotesWorkspace
): NotesSelectionEligibility {
  const selectedRoots = new Set(rootIds);
  const visible = new Set(visibleNodeIds);
  const eligibleRootIds = rootIds.filter((nodeId) => {
    const node = workspace.nodesById[nodeId];
    const siblings =
      node.parentId === null
        ? workspace.rootIds
        : (workspace.childIdsByParent[node.parentId] ?? []);
    let index = siblings.indexOf(nodeId) - 1;
    while (index >= 0 && selectedRoots.has(siblings[index])) {
      index -= 1;
    }
    return index >= 0 && visible.has(siblings[index]);
  });
  return eligibleRootIds.length > 0
    ? eligibleTargets(eligibleRootIds)
    : unavailable(
        "Indent requires a visible preceding sibling outside the selection."
      );
}

function outdentEligibility(
  rootIds: readonly NoteId[],
  workspace: NormalizedNotesWorkspace,
  zoomRootId: NoteId | null
): NotesSelectionEligibility {
  const eligibleRootIds = rootIds.filter((nodeId) => {
    const parentId = workspace.nodesById[nodeId].parentId;
    return parentId !== null && parentId !== zoomRootId;
  });
  return eligibleRootIds.length > 0
    ? eligibleTargets(eligibleRootIds)
    : unavailable(
        "Outdent cannot move the selected roots outside the current zoom."
      );
}

function reorderEligibility(
  rootIds: readonly NoteId[],
  workspace: NormalizedNotesWorkspace,
  direction: "up" | "down"
): NotesSelectionReorderEligibility {
  const parent = sharedParentId(rootIds, workspace);
  if (!parent.shared) {
    return Object.freeze({
      eligible: false,
      reason: "Reorder requires selected roots that share one parent."
    });
  }

  const siblings =
    parent.parentId === null
      ? workspace.rootIds
      : (workspace.childIdsByParent[parent.parentId] ?? []);
  const positions = rootIds.map((nodeId) => siblings.indexOf(nodeId));
  const contiguous = positions.every(
    (position, index) =>
      position >= 0 && (index === 0 || position === positions[index - 1] + 1)
  );
  if (!contiguous) {
    return Object.freeze({
      eligible: false,
      reason: "Reorder requires contiguous selected siblings."
    });
  }

  const firstIndex = positions[0];
  const lastIndex = positions[positions.length - 1];
  if (direction === "up" && firstIndex === 0) {
    return Object.freeze({
      eligible: false,
      reason: "The selection is already first among its siblings."
    });
  }
  if (direction === "up" && firstIndex === 1) {
    return Object.freeze({
      eligible: false,
      reason: "Moving this selection first is unavailable."
    });
  }
  if (direction === "down" && lastIndex === siblings.length - 1) {
    return Object.freeze({
      eligible: false,
      reason: "The selection is already last among its siblings."
    });
  }

  const afterId =
    direction === "up"
      ? (siblings[firstIndex - 2] ?? null)
      : siblings[lastIndex + 1];
  return eligibleReorder(rootIds, {
    parentId: parent.parentId,
    afterId
  });
}

export function deriveNotesSelectionActionSnapshot(
  input: DeriveNotesSelectionActionSnapshotInput
): NotesSelectionActionSnapshot | null {
  const selectedNodeIds = selectionRangeIds(
    input.selection,
    input.visibleNodeIds
  );
  if (
    !input.selection ||
    selectedNodeIds.length === 0 ||
    selectedNodeIds.some((nodeId) => !input.workspace.nodesById[nodeId])
  ) {
    return null;
  }

  const completion = completionAggregate(selectedNodeIds, input.workspace);
  const authoritativeWorkspace = input.authoritativeWorkspace;
  if (!isCompleteActiveAuthority(input.workspace, authoritativeWorkspace)) {
    const eligibility = Object.freeze({
      copy: unavailable(COMPLETE_STRUCTURE_REASON),
      cut: unavailable(COMPLETE_STRUCTURE_REASON),
      delete: unavailable(COMPLETE_STRUCTURE_REASON),
      duplicate: unavailable(COMPLETE_STRUCTURE_REASON),
      indent: unavailable(COMPLETE_STRUCTURE_REASON),
      outdent: unavailable(COMPLETE_STRUCTURE_REASON),
      moveUp: unavailable(COMPLETE_STRUCTURE_REASON),
      moveDown: unavailable(COMPLETE_STRUCTURE_REASON),
      moveTo: unavailable(COMPLETE_STRUCTURE_REASON)
    });
    return Object.freeze({
      selection: Object.freeze({ ...input.selection }),
      selectedNodeIds: Object.freeze([...selectedNodeIds]),
      structuralRootIds: Object.freeze([]),
      completion,
      deleteFocusNodeId: null,
      eligibility
    });
  }

  const selectedSet = new Set(selectedNodeIds);
  const structuralRootIds = selectedNodeIds.filter(
    (nodeId) =>
      !hasSelectedAncestor(nodeId, selectedSet, authoritativeWorkspace)
  );
  const deletedSubtreeIds = collectSubtreeIds(
    structuralRootIds,
    authoritativeWorkspace
  );
  const eligibility = Object.freeze({
    copy: eligibleTargets(structuralRootIds),
    cut: cutEligibility(
      structuralRootIds,
      deletedSubtreeIds,
      authoritativeWorkspace
    ),
    delete: eligibleTargets(structuralRootIds),
    duplicate: duplicateEligibility(
      structuralRootIds,
      authoritativeWorkspace
    ),
    indent: indentEligibility(
      structuralRootIds,
      input.visibleNodeIds,
      authoritativeWorkspace
    ),
    outdent: outdentEligibility(
      structuralRootIds,
      authoritativeWorkspace,
      input.workspace.zoomRootId
    ),
    moveUp: reorderEligibility(
      structuralRootIds,
      authoritativeWorkspace,
      "up"
    ),
    moveDown: reorderEligibility(
      structuralRootIds,
      authoritativeWorkspace,
      "down"
    ),
    moveTo: hasValidNotesMoveDestination(
      authoritativeWorkspace.nodesById,
      structuralRootIds
    )
      ? eligibleTargets(structuralRootIds)
      : unavailable(
          "Move To requires a destination that would change the selection."
        )
  });

  return Object.freeze({
    selection: Object.freeze({ ...input.selection }),
    selectedNodeIds: Object.freeze([...selectedNodeIds]),
    structuralRootIds: Object.freeze([...structuralRootIds]),
    completion,
    deleteFocusNodeId: deleteFocusCandidate(
      selectedNodeIds,
      input.visibleNodeIds,
      deletedSubtreeIds
    ),
    eligibility
  });
}
