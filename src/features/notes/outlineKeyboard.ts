import type { MoveNoteNodeInput, NoteId } from "../../domain/notes";
import {
  selectionRangeIds,
  type NormalizedNotesWorkspace,
  type NotesSelection
} from "./notesWorkspaceReducer";
import { visibleNodeIds } from "./outlineTree";

export type OutlineShortcutPlatform = "mac" | "other";

export interface ResolveNotesHistoryShortcutInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  platform: OutlineShortcutPlatform;
}

export type NotesHistoryShortcut = "undo" | "redo";

export interface ResolveSupportingNoteKeyInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
  value: string;
}

export type SupportingNoteKeyResolution = "currentTitle" | "nextTitle";

export function resolveSupportingNoteKey(
  input: ResolveSupportingNoteKeyInput
): SupportingNoteKeyResolution | null {
  if (input.altKey || input.ctrlKey || input.metaKey || input.shiftKey) {
    return null;
  }
  if (input.key === "Escape") {
    return "currentTitle";
  }
  if (input.key === "ArrowUp" && input.selectionStart === 0) {
    return "currentTitle";
  }
  if (
    input.key === "ArrowDown" &&
    input.selectionEnd === input.value.length
  ) {
    return "nextTitle";
  }
  return null;
}

export function supportingNoteFocusTarget(
  resolution: SupportingNoteKeyResolution,
  nodeId: NoteId,
  visibleIds: readonly NoteId[]
): NoteId {
  if (resolution === "currentTitle") {
    return nodeId;
  }
  const index = visibleIds.indexOf(nodeId);
  return index >= 0 ? visibleIds[index + 1] ?? nodeId : nodeId;
}

export function detectOutlineShortcutPlatform(
  platform = typeof navigator === "undefined" ? "" : navigator.platform
): OutlineShortcutPlatform {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "mac" : "other";
}

export function resolveNotesHistoryShortcut(
  input: ResolveNotesHistoryShortcutInput
): NotesHistoryShortcut | null {
  if (input.isComposing || input.key === "Process" || input.altKey) {
    return null;
  }
  const primaryModifierPressed =
    input.platform === "mac"
      ? input.metaKey && !input.ctrlKey
      : input.ctrlKey && !input.metaKey;
  if (!primaryModifierPressed) {
    return null;
  }
  const key = input.key.toLowerCase();
  if (key === "z") {
    return input.shiftKey ? "redo" : "undo";
  }
  return input.platform === "other" && key === "y" && !input.shiftKey
    ? "redo"
    : null;
}

export interface ResolveOutlineKeyInput {
  target: "title" | "textarea";
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  repeat: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
  title: string;
  note: string;
  nodeId: NoteId;
  platform: OutlineShortcutPlatform;
  workspace: NormalizedNotesWorkspace;
  visibleNodeIds?: readonly NoteId[];
  // The live multi-node selection, if any. Shift+Arrow extends the head from
  // here; Escape clears only when a selection exists (so a bare Escape keeps its
  // default behaviour).
  selection?: NotesSelection | null;
}

export type OutlineKeyResolution =
  | { type: "split"; prefix: string; suffix: string }
  | {
      type: "move";
      input: MoveNoteNodeInput;
      focusNodeId: NoteId;
      expandNodeId?: NoteId;
    }
  | { type: "focus"; nodeId: NoteId }
  | { type: "focusNote" }
  | { type: "toggleComplete" }
  | { type: "duplicate" }
  | { type: "delete" }
  | { type: "toggleCollapsed" }
  | { type: "remove"; focusNodeId: NoteId | null }
  | { type: "extendSelection"; headId: NoteId }
  | { type: "clearSelection" }
  // Whole-selection structural ops (plan Phase 4.1c). Each carries the
  // materialized selection range in outline order so the caller forwards it to
  // notes_apply_batch as one transaction / one undo step.
  | { type: "batchComplete"; nodeIds: readonly NoteId[]; completed: boolean }
  | { type: "batchDelete"; nodeIds: readonly NoteId[]; focusNodeId: NoteId | null }
  | { type: "batchIndent"; nodeIds: readonly NoteId[] }
  | { type: "batchOutdent"; nodeIds: readonly NoteId[] };

/**
 * The first visible row after a to-be-deleted range, falling back to the row
 * before it, so a batch delete can hand focus to a surviving neighbor. The range
 * is a contiguous slice of `visibleIds`; the reducer reconciles the target if it
 * turns out to be inside a deleted subtree.
 */
function neighborAfterRange(
  visibleIds: readonly NoteId[],
  rangeIds: readonly NoteId[]
): NoteId | null {
  if (rangeIds.length === 0) {
    return null;
  }
  const first = visibleIds.indexOf(rangeIds[0]);
  const last = visibleIds.indexOf(rangeIds[rangeIds.length - 1]);
  if (first < 0 || last < 0) {
    return null;
  }
  return visibleIds[last + 1] ?? visibleIds[first - 1] ?? null;
}

/**
 * Batch indent (plan Phase 4.1c). Eligible when at least one selected node's
 * indent target — its nearest preceding sibling that is NOT itself selected,
 * which is exactly the sibling the backend would reparent it under — is visible.
 * Requiring a visible target mirrors the single-node Phase 0.3 rule so the batch
 * never indents a row under a hidden (e.g. completed) sibling. The full range is
 * forwarded; the backend reduces it to its roots and leaves ineligible nodes in
 * place.
 */
function resolveBatchIndent(
  input: ResolveOutlineKeyInput,
  rangeIds: readonly NoteId[],
  visibleIds: readonly NoteId[]
): OutlineKeyResolution | null {
  if (rangeIds.length === 0) {
    return null;
  }
  const selected = new Set(rangeIds);
  const eligible = rangeIds.some((id) => {
    const node = input.workspace.nodesById[id];
    if (!node) {
      return false;
    }
    const siblings =
      node.parentId === null
        ? input.workspace.rootIds
        : (input.workspace.childIdsByParent[node.parentId] ?? []);
    const index = siblings.indexOf(id);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (!selected.has(siblings[cursor])) {
        return visibleIds.includes(siblings[cursor]);
      }
    }
    return false;
  });
  return eligible ? { type: "batchIndent", nodeIds: rangeIds } : null;
}

/**
 * Batch outdent (plan Phase 4.1c). Confined to the zoomed subtree (Phase 0.3):
 * a selected node at the top level, or directly under the zoom root, cannot
 * outdent without escaping the zoom, so it is dropped from the batch. If nothing
 * survives the shortcut is a no-op.
 */
function resolveBatchOutdent(
  input: ResolveOutlineKeyInput,
  rangeIds: readonly NoteId[]
): OutlineKeyResolution | null {
  const zoomRootId = input.workspace.zoomRootId;
  const eligible = rangeIds.filter((id) => {
    const node = input.workspace.nodesById[id];
    return Boolean(
      node && node.parentId !== null && node.parentId !== zoomRootId
    );
  });
  return eligible.length > 0
    ? { type: "batchOutdent", nodeIds: eligible }
    : null;
}

export function resolveOutlineKey(
  input: ResolveOutlineKeyInput
): OutlineKeyResolution | null {
  if (
    input.target !== "title" ||
    input.isComposing ||
    input.key === "Process"
  ) {
    return null;
  }

  // Selection controls are resolved before the modifier guard below (which
  // rejects any Shift chord other than Tab) so Shift+Arrow can extend the range.
  // Escape only resolves when a selection is live, leaving a bare Escape to its
  // default behaviour. Both require no other modifiers.
  const selectionModifiersClear =
    !input.altKey && !input.ctrlKey && !input.metaKey;
  if (
    selectionModifiersClear &&
    input.shiftKey &&
    (input.key === "ArrowUp" || input.key === "ArrowDown")
  ) {
    const selectionVisibleIds =
      input.visibleNodeIds ??
      visibleNodeIds(input.workspace, input.workspace.zoomRootId);
    const currentHead = input.selection?.headId ?? input.nodeId;
    const headIndex = selectionVisibleIds.indexOf(currentHead);
    if (headIndex < 0) {
      return null;
    }
    const nextHead =
      selectionVisibleIds[headIndex + (input.key === "ArrowUp" ? -1 : 1)];
    return nextHead ? { type: "extendSelection", headId: nextHead } : null;
  }
  if (
    selectionModifiersClear &&
    !input.shiftKey &&
    input.key === "Escape" &&
    input.selection
  ) {
    return { type: "clearSelection" };
  }

  const primaryModifierPressed =
    input.platform === "mac"
      ? input.metaKey && !input.ctrlKey
      : input.ctrlKey && !input.metaKey;
  const duplicateModifierPressed =
    input.platform === "mac"
      ? input.metaKey && !input.altKey && !input.ctrlKey
      : input.altKey && !input.metaKey && !input.ctrlKey;

  // With a live multi-node selection, the structural shortcuts act on the WHOLE
  // range as one batch (one undo step) instead of the focused node (plan Phase
  // 4.1c). These branches own their keys entirely: an ineligible batch resolves
  // to null (a no-op, matching an ineligible single-node command) and never
  // falls through to the single-node path, so the selection is never torn.
  // Extend/clear were already handled above; other keys (Enter split, arrows,
  // typing) keep single-node behavior and collapse the selection elsewhere.
  if (input.selection) {
    const selectionVisibleIds =
      input.visibleNodeIds ??
      visibleNodeIds(input.workspace, input.workspace.zoomRootId);
    const rangeIds = selectionRangeIds(input.selection, selectionVisibleIds);
    if (
      !input.repeat &&
      input.key === "Enter" &&
      !input.shiftKey &&
      !input.altKey &&
      primaryModifierPressed
    ) {
      if (rangeIds.length === 0) {
        return null;
      }
      const focused = input.workspace.nodesById[input.nodeId];
      return {
        type: "batchComplete",
        nodeIds: rangeIds,
        completed: focused ? focused.completedAt === null : true
      };
    }
    if (
      !input.repeat &&
      input.key === "Backspace" &&
      input.shiftKey &&
      !input.altKey &&
      primaryModifierPressed
    ) {
      return rangeIds.length === 0
        ? null
        : {
            type: "batchDelete",
            nodeIds: rangeIds,
            focusNodeId: neighborAfterRange(selectionVisibleIds, rangeIds)
          };
    }
    if (
      !input.repeat &&
      input.key === "Tab" &&
      !input.altKey &&
      !input.ctrlKey &&
      !input.metaKey
    ) {
      return input.shiftKey
        ? resolveBatchOutdent(input, rangeIds)
        : resolveBatchIndent(input, rangeIds, selectionVisibleIds);
    }
  }

  if (!input.repeat) {
    if (
      input.key === "Enter" &&
      input.shiftKey &&
      !input.altKey &&
      !input.ctrlKey &&
      !input.metaKey
    ) {
      return { type: "focusNote" };
    }
    if (
      input.key === "Enter" &&
      !input.shiftKey &&
      !input.altKey &&
      primaryModifierPressed
    ) {
      return { type: "toggleComplete" };
    }
    if (
      input.key.toLowerCase() === "d" &&
      input.shiftKey &&
      duplicateModifierPressed
    ) {
      return { type: "duplicate" };
    }
    if (
      input.key === "Backspace" &&
      input.shiftKey &&
      !input.altKey &&
      primaryModifierPressed
    ) {
      return { type: "delete" };
    }
  }

  if (
    input.altKey ||
    input.ctrlKey ||
    input.metaKey ||
    (input.shiftKey && input.key !== "Tab")
  ) {
    return null;
  }

  if (
    input.repeat &&
    (input.key === "Enter" ||
      input.key === "Tab" ||
      input.key === "ArrowLeft" ||
      input.key === "ArrowRight")
  ) {
    return null;
  }

  const { selectionStart, selectionEnd } = input;
  if (
    selectionStart === null ||
    selectionEnd === null ||
    !Number.isInteger(selectionStart) ||
    !Number.isInteger(selectionEnd) ||
    selectionStart < 0 ||
    selectionEnd < selectionStart ||
    selectionEnd > input.title.length
  ) {
    return null;
  }

  const node = input.workspace.nodesById[input.nodeId];
  if (!node) {
    return null;
  }

  const visibleIds =
    input.visibleNodeIds ??
    visibleNodeIds(input.workspace, input.workspace.zoomRootId);

  if (input.key === "Enter") {
    return {
      type: "split",
      prefix: input.title.slice(0, selectionStart),
      suffix: input.title.slice(selectionEnd)
    };
  }

  if (input.key === "Tab") {
    if (input.shiftKey) {
      if (
        node.parentId === null ||
        node.parentId === input.workspace.zoomRootId
      ) {
        return null;
      }
      const parent = input.workspace.nodesById[node.parentId];
      if (!parent) {
        return null;
      }
      return {
        type: "move",
        input: {
          id: input.nodeId,
          parentId: parent.parentId,
          afterId: parent.id
        },
        focusNodeId: input.nodeId
      };
    }

    const siblings =
      node.parentId === null
        ? input.workspace.rootIds
        : (input.workspace.childIdsByParent[node.parentId] ?? []);
    const index = siblings.indexOf(input.nodeId);
    if (index <= 0) {
      return null;
    }
    let priorId: NoteId | null = null;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (visibleIds.includes(siblings[cursor])) {
        priorId = siblings[cursor];
        break;
      }
    }
    if (priorId === null) {
      return null;
    }
    const prior = input.workspace.nodesById[priorId];
    if (!prior) {
      return null;
    }
    return {
      type: "move",
      input: {
        id: input.nodeId,
        parentId: priorId,
        afterId: input.workspace.childIdsByParent[priorId]?.at(-1) ?? null
      },
      focusNodeId: input.nodeId,
      ...(prior.isCollapsed ? { expandNodeId: priorId } : {})
    };
  }

  const visibleIndex = visibleIds.indexOf(input.nodeId);

  if (input.key === "ArrowUp" || input.key === "ArrowDown") {
    if (visibleIndex < 0) {
      return null;
    }
    const offset = input.key === "ArrowUp" ? -1 : 1;
    const focusId = visibleIds[visibleIndex + offset];
    return focusId ? { type: "focus", nodeId: focusId } : null;
  }

  const collapsedSelection = selectionStart === selectionEnd;
  if (input.key === "ArrowLeft") {
    if (!collapsedSelection || selectionStart !== 0) {
      return null;
    }
    const hasVisibleChildren = (
      input.workspace.childIdsByParent[input.nodeId] ?? []
    ).some((childId) => visibleIds.includes(childId));
    if (!node.isCollapsed && hasVisibleChildren) {
      return { type: "toggleCollapsed" };
    }
    return node.parentId !== null && visibleIds.includes(node.parentId)
      ? { type: "focus", nodeId: node.parentId }
      : null;
  }

  if (input.key === "ArrowRight") {
    if (!collapsedSelection || selectionEnd !== input.title.length) {
      return null;
    }
    const childIds = input.workspace.childIdsByParent[input.nodeId] ?? [];
    if (
      node.isCollapsed &&
      input.nodeId !== input.workspace.zoomRootId &&
      childIds.length > 0
    ) {
      return { type: "toggleCollapsed" };
    }
    const firstVisibleChild = childIds.find((childId) =>
      visibleIds.includes(childId)
    );
    return firstVisibleChild
      ? { type: "focus", nodeId: firstVisibleChild }
      : null;
  }

  if (input.key === "Backspace") {
    if (
      input.repeat ||
      !collapsedSelection ||
      selectionStart !== 0 ||
      input.title.trim() ||
      input.note.trim() ||
      visibleIndex < 0 ||
      (input.workspace.attachmentsByNodeId[input.nodeId]?.length ?? 0) > 0
    ) {
      return null;
    }
    return {
      type: "remove",
      focusNodeId:
        visibleIds[visibleIndex - 1] ??
        input.workspace.childIdsByParent[input.nodeId]?.[0] ??
        visibleIds[visibleIndex + 1] ??
        null
    };
  }

  return null;
}
