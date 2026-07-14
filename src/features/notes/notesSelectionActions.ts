import type { NoteId } from "../../domain/notes";
import {
  selectionRangeIds,
  type NormalizedNotesWorkspace,
  type NotesSelection
} from "./notesWorkspaceReducer";

export type NotesSelectionCompletion = "none" | "mixed" | "all";

export type NotesSelectionEligibility =
  | Readonly<{ eligible: true }>
  | Readonly<{ eligible: false; reason: string }>;

export interface NotesSelectionMoveTarget {
  readonly parentId: NoteId | null;
  readonly afterId: NoteId | null;
}

export type NotesSelectionReorderEligibility =
  | Readonly<{
      eligible: true;
      target: Readonly<NotesSelectionMoveTarget>;
    }>
  | Readonly<{ eligible: false; reason: string }>;

export interface NotesSelectionActionEligibility {
  readonly cut: NotesSelectionEligibility;
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
}

const ELIGIBLE: NotesSelectionEligibility = Object.freeze({ eligible: true });

function unavailable(reason: string): NotesSelectionEligibility {
  return Object.freeze({ eligible: false, reason });
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
  return ELIGIBLE;
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
    ? ELIGIBLE
    : unavailable("Duplicate requires selected roots that share one parent.");
}

function indentEligibility(
  rootIds: readonly NoteId[],
  visibleNodeIds: readonly NoteId[],
  workspace: NormalizedNotesWorkspace
): NotesSelectionEligibility {
  const selectedRoots = new Set(rootIds);
  const visible = new Set(visibleNodeIds);
  const canIndent = rootIds.some((nodeId) => {
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
  return canIndent
    ? ELIGIBLE
    : unavailable(
        "Indent requires a visible preceding sibling outside the selection."
      );
}

function outdentEligibility(
  rootIds: readonly NoteId[],
  workspace: NormalizedNotesWorkspace
): NotesSelectionEligibility {
  const canOutdent = rootIds.some((nodeId) => {
    const parentId = workspace.nodesById[nodeId].parentId;
    return parentId !== null && parentId !== workspace.zoomRootId;
  });
  return canOutdent
    ? ELIGIBLE
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
  return Object.freeze({
    eligible: true,
    target: Object.freeze({ parentId: parent.parentId, afterId })
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

  const selectedSet = new Set(selectedNodeIds);
  const structuralRootIds = selectedNodeIds.filter(
    (nodeId) => !hasSelectedAncestor(nodeId, selectedSet, input.workspace)
  );
  const deletedSubtreeIds = collectSubtreeIds(
    structuralRootIds,
    input.workspace
  );
  const eligibility = Object.freeze({
    cut: cutEligibility(deletedSubtreeIds, input.workspace),
    duplicate: duplicateEligibility(structuralRootIds, input.workspace),
    indent: indentEligibility(
      structuralRootIds,
      input.visibleNodeIds,
      input.workspace
    ),
    outdent: outdentEligibility(structuralRootIds, input.workspace),
    moveUp: reorderEligibility(structuralRootIds, input.workspace, "up"),
    moveDown: reorderEligibility(structuralRootIds, input.workspace, "down"),
    moveTo: ELIGIBLE
  });

  return Object.freeze({
    selection: Object.freeze({ ...input.selection }),
    selectedNodeIds: Object.freeze([...selectedNodeIds]),
    structuralRootIds: Object.freeze([...structuralRootIds]),
    completion: completionAggregate(selectedNodeIds, input.workspace),
    deleteFocusNodeId: deleteFocusCandidate(
      selectedNodeIds,
      input.visibleNodeIds,
      deletedSubtreeIds
    ),
    eligibility
  });
}
