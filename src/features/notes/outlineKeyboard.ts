import type { MoveNoteNodeInput, NoteId } from "../../domain/notes";
import type { NotesHistoryPrimarySelection } from "./notesHistory";
import type { NotesSelectionActionIntent } from "./notesSelectionActions";
import {
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
  isComposing: boolean;
  repeat: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
  value: string;
}

export type SupportingNoteKeyResolution =
  | "currentTitle"
  | "nextTitle"
  | "nextTitleOrCreate";

export interface ResolveExternalEditorKeyInput {
  field: "title" | "note";
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  repeat: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
  value: string;
}

export type ExternalEditorKeyResolution =
  | { type: "complete" }
  | { type: "createSibling" }
  | { type: "focusNote" }
  | { type: "restore" }
  | { type: "focusTitle"; restore: boolean }
  | {
      type: "focus";
      direction: "previous" | "next";
      edge: "start" | "end" | null;
    }
  | { type: "consume" };

export function resolveExternalEditorKey(
  input: ResolveExternalEditorKeyInput
): ExternalEditorKeyResolution | null {
  if (input.isComposing || input.key === "Process") {
    return null;
  }
  const plain =
    !input.altKey && !input.ctrlKey && !input.metaKey && !input.shiftKey;
  const primary = !input.altKey && (input.ctrlKey !== input.metaKey);
  const collapsed =
    input.selectionStart !== null &&
    input.selectionStart === input.selectionEnd;

  if (input.field === "title") {
    if (
      input.key === "Enter" &&
      primary &&
      !input.shiftKey &&
      !input.repeat
    ) {
      return { type: "complete" };
    }
    if (
      input.key === "Enter" &&
      input.shiftKey &&
      !input.altKey &&
      !input.ctrlKey &&
      !input.metaKey &&
      !input.repeat
    ) {
      return { type: "focusNote" };
    }
    if (input.key === "Enter" && plain && !input.repeat) {
      return { type: "createSibling" };
    }
    if (input.key === "Escape" && plain) {
      return { type: "restore" };
    }
    if (
      plain &&
      (input.key === "ArrowUp" || input.key === "ArrowDown")
    ) {
      return {
        type: "focus",
        direction: input.key === "ArrowUp" ? "previous" : "next",
        edge: null
      };
    }
    if (
      plain &&
      collapsed &&
      input.key === "ArrowLeft" &&
      input.selectionStart === 0
    ) {
      return { type: "focus", direction: "previous", edge: "end" };
    }
    if (
      plain &&
      collapsed &&
      input.key === "ArrowRight" &&
      input.selectionEnd === input.value.length
    ) {
      return { type: "focus", direction: "next", edge: "start" };
    }
  } else {
    if (
      input.key === "Enter" &&
      input.shiftKey &&
      !input.altKey &&
      !input.ctrlKey &&
      !input.metaKey &&
      !input.repeat
    ) {
      return { type: "createSibling" };
    }
    if (input.key === "Escape" && plain) {
      return { type: "focusTitle", restore: true };
    }
    if (
      input.key === "ArrowUp" &&
      plain &&
      input.selectionStart === 0
    ) {
      return { type: "focusTitle", restore: false };
    }
    if (
      input.key === "ArrowDown" &&
      plain &&
      input.selectionEnd === input.value.length
    ) {
      return { type: "focus", direction: "next", edge: "start" };
    }
  }

  if (input.key === "Tab") {
    return { type: "consume" };
  }
  if (
    input.key === "Backspace" &&
    collapsed &&
    input.selectionStart === 0
  ) {
    return { type: "consume" };
  }
  const key = input.key.toLowerCase();
  if (
    (key === "backspace" && primary && input.shiftKey) ||
    (key === "d" &&
      input.shiftKey &&
      (input.metaKey || input.altKey)) ||
    ((input.key === "ArrowUp" || input.key === "ArrowDown") &&
      input.shiftKey &&
      (input.ctrlKey || input.altKey))
  ) {
    return { type: "consume" };
  }
  return null;
}

export function resolveSupportingNoteKey(
  input: ResolveSupportingNoteKeyInput
): SupportingNoteKeyResolution | null {
  if (input.isComposing || input.key === "Process") {
    return null;
  }
  if (
    input.key === "Enter" &&
    input.shiftKey &&
    !input.altKey &&
    !input.ctrlKey &&
    !input.metaKey &&
    !input.repeat
  ) {
    return "nextTitleOrCreate";
  }
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

export interface ResolveWorkflowyZoomShortcutInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  repeat: boolean;
  platform: OutlineShortcutPlatform;
}

export type WorkflowyZoomShortcut = "zoomIn" | "zoomOut" | "consume";

export function resolveWorkflowyZoomShortcut(
  input: ResolveWorkflowyZoomShortcutInput
): WorkflowyZoomShortcut | null {
  if (
    input.isComposing ||
    input.key === "Process" ||
    input.shiftKey ||
    (input.key !== "." && input.key !== ",")
  ) {
    return null;
  }
  const modifierMatches =
    input.platform === "mac"
      ? input.metaKey && !input.altKey && !input.ctrlKey
      : input.altKey && !input.ctrlKey && !input.metaKey;
  if (!modifierMatches) return null;
  if (input.repeat) return "consume";
  return input.key === "." ? "zoomIn" : "zoomOut";
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
  target: "title" | "image" | "textarea";
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
  /** @deprecated Selection eligibility now belongs to the shared command router. */
  authoritativeWorkspace?: NormalizedNotesWorkspace;
  visibleNodeIds?: readonly NoteId[];
  /** Prevent an outdent from placing an ordinary row directly under this root. */
  outdentBoundaryRootId?: NoteId;
  /** Rows that may participate in a selection, excluding a zoom page header. */
  selectionVisibleNodeIds?: readonly NoteId[];
  readonly optimisticEnter?: {
    readonly hasChildren: boolean;
  };
  // The live multi-node selection, if any. Shift+Arrow extends the head from
  // here; Escape clears only when a selection exists (so a bare Escape keeps its
  // default behaviour).
  selection?: NotesSelection | null;
}

export type OutlineKeyResolution =
  | { type: "split"; prefix: string; suffix: string }
  | { type: "createFirstChild" }
  | { type: "createNextTextSibling" }
  | {
      type: "move";
      input: MoveNoteNodeInput;
      focusNodeId: NoteId;
      expandNodeId?: NoteId;
    }
  | {
      type: "focus";
      nodeId: NoteId;
      selection?: NotesHistoryPrimarySelection;
    }
  | { type: "focusNote" }
  | { type: "toggleComplete" }
  | { type: "duplicate" }
  | { type: "delete" }
  | { type: "confirmDelete" }
  | { type: "toggleCollapsed" }
  | { type: "remove"; focusNodeId: NoteId | null }
  | { type: "extendSelection"; headId: NoteId }
  | { type: "clearSelection" }
  | { type: "selectionAction"; action: NotesSelectionActionIntent }
  | { type: "consumeSelectionShortcut" }
  | { type: "consumeTabShortcut" }
  // Legacy variants remain until OutlineNodeRow is migrated in the integration
  // step. resolveOutlineKey no longer emits them for a live selection.
  | { type: "batchComplete"; nodeIds: readonly NoteId[]; completed: boolean }
  | { type: "batchDelete"; nodeIds: readonly NoteId[]; focusNodeId: NoteId | null }
  | { type: "batchIndent"; nodeIds: readonly NoteId[] }
  | { type: "batchOutdent"; nodeIds: readonly NoteId[] }
  | { type: "batchDuplicate"; nodeIds: readonly NoteId[] }
  | {
      type: "batchReorder";
      nodeIds: readonly NoteId[];
      parentId: NoteId | null;
      afterId: NoteId | null;
      beforeId?: NoteId | null;
    }
  | { type: "selectionCopy"; nodeIds: readonly NoteId[] }
  | { type: "selectionCut"; nodeIds: readonly NoteId[] };

function workflowyMoveDirection(
  input: Pick<
    ResolveOutlineKeyInput,
    "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "platform"
  >
): "up" | "down" | null {
  const moveModifierPressed =
    input.platform === "mac"
      ? input.ctrlKey !== input.metaKey && !input.altKey
      : input.altKey && !input.ctrlKey && !input.metaKey;
  if (!input.shiftKey || !moveModifierPressed) {
    return null;
  }
  return input.key === "ArrowUp"
    ? "up"
    : input.key === "ArrowDown"
      ? "down"
      : null;
}

export interface ResolveWorkflowySelectionMoveShortcutInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  repeat: boolean;
  platform: OutlineShortcutPlatform;
}

export type WorkflowySelectionMoveShortcut =
  | "moveUp"
  | "moveDown"
  | "consume";

export function resolveWorkflowySelectionMoveShortcut(
  input: ResolveWorkflowySelectionMoveShortcutInput
): WorkflowySelectionMoveShortcut | null {
  if (input.isComposing || input.key === "Process") {
    return null;
  }
  const direction = workflowyMoveDirection(input);
  if (direction === null) {
    return null;
  }
  if (input.repeat) {
    return "consume";
  }
  return direction === "up" ? "moveUp" : "moveDown";
}

export function resolveOutlineKey(
  input: ResolveOutlineKeyInput
): OutlineKeyResolution | null {
  const imageTarget = input.target === "image";
  const imageAltStructuralKey =
    imageTarget &&
    input.altKey &&
    !input.ctrlKey &&
    !input.metaKey &&
    !input.shiftKey &&
    (input.key === "ArrowLeft" || input.key === "ArrowRight");
  if (
    input.target === "textarea" ||
    input.isComposing ||
    input.key === "Process"
  ) {
    return null;
  }
  if (
    input.optimisticEnter &&
    !input.workspace.nodesById[input.nodeId] &&
    (input.key !== "Enter" ||
      input.altKey ||
      input.ctrlKey ||
      input.metaKey ||
      input.shiftKey ||
      input.repeat)
  ) {
    return null;
  }
  const moveDirection = workflowyMoveDirection(input);

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
      input.selectionVisibleNodeIds ??
      input.visibleNodeIds ??
      visibleNodeIds(input.workspace, input.workspace.zoomRootId);
    const currentHead = input.selection?.headId ?? input.nodeId;
    const headIndex = selectionVisibleIds.indexOf(currentHead);
    if (headIndex < 0) {
      return null;
    }
    const nextHead =
      selectionVisibleIds[headIndex + (input.key === "ArrowUp" ? -1 : 1)];
    return nextHead
      ? { type: "extendSelection", headId: nextHead }
      : { type: "consumeSelectionShortcut" };
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

  // A live range owns recognized selection shortcuts semantically. Eligibility,
  // exact targets, authority freshness, and disabled feedback are all resolved
  // by the shared command router. Copy/Cut intentionally stay native here so
  // the synchronous clipboard event is their single owner.
  if (input.selection) {
    const selectionShortcut = (
      action: NotesSelectionActionIntent
    ): OutlineKeyResolution =>
      input.repeat
        ? { type: "consumeSelectionShortcut" }
        : { type: "selectionAction", action };

    if (
      input.key === "Enter" &&
      !input.shiftKey &&
      !input.altKey &&
      primaryModifierPressed
    ) {
      return selectionShortcut("toggleComplete");
    }
    if (
      input.key === "Backspace" &&
      input.shiftKey &&
      !input.altKey &&
      primaryModifierPressed
    ) {
      return selectionShortcut("delete");
    }
    if (
      input.key === "Tab" &&
      !input.altKey &&
      !input.ctrlKey &&
      !input.metaKey
    ) {
      return selectionShortcut(input.shiftKey ? "outdent" : "indent");
    }
    if (
      input.key.toLowerCase() === "d" &&
      input.shiftKey &&
      duplicateModifierPressed
    ) {
      return selectionShortcut("duplicate");
    }
    const selectionMoveShortcut = resolveWorkflowySelectionMoveShortcut(input);
    if (selectionMoveShortcut) {
      return selectionMoveShortcut === "consume"
        ? { type: "consumeSelectionShortcut" }
        : { type: "selectionAction", action: selectionMoveShortcut };
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

  if (moveDirection) {
    const workspace = input.authoritativeWorkspace;
    if (input.repeat || !workspace) {
      return { type: "consumeSelectionShortcut" };
    }
    const node = workspace.nodesById[input.nodeId];
    if (!node) {
      return { type: "consumeSelectionShortcut" };
    }
    const siblings =
      node.parentId === null
        ? workspace.rootIds
        : (workspace.childIdsByParent[node.parentId] ?? []);
    const index = siblings.indexOf(node.id);
    if (moveDirection === "up") {
      if (index <= 0) {
        return { type: "consumeSelectionShortcut" };
      }
      const beforeId = index === 1 ? siblings[0] : undefined;
      return {
        type: "move",
        input: {
          id: node.id,
          parentId: node.parentId,
          afterId: beforeId ? null : (siblings[index - 2] ?? null),
          ...(beforeId ? { beforeId } : {})
        },
        focusNodeId: node.id
      };
    }
    if (index < 0 || index >= siblings.length - 1) {
      return { type: "consumeSelectionShortcut" };
    }
    return {
      type: "move",
      input: {
        id: node.id,
        parentId: node.parentId,
        afterId: siblings[index + 1]!
      },
      focusNodeId: node.id
    };
  }

  if (
    (input.altKey && !imageAltStructuralKey) ||
    input.ctrlKey ||
    input.metaKey ||
    (input.shiftKey && input.key !== "Tab")
  ) {
    return null;
  }

  if (
    input.repeat &&
    (input.key === "Tab" ||
      input.key === "ArrowLeft" ||
      input.key === "ArrowRight")
  ) {
    return input.key === "Tab" ? { type: "consumeTabShortcut" } : null;
  }

  const { selectionStart, selectionEnd } = input;
  if (
    !imageTarget &&
    (selectionStart === null ||
      selectionEnd === null ||
      !Number.isInteger(selectionStart) ||
      !Number.isInteger(selectionEnd) ||
      selectionStart < 0 ||
      selectionEnd < selectionStart ||
      selectionEnd > input.title.length)
  ) {
    return null;
  }

  const node = input.workspace.nodesById[input.nodeId];
  const optimisticEnter =
    !node && input.key === "Enter" ? input.optimisticEnter : undefined;
  if (!node && !optimisticEnter) {
    return null;
  }

  const visibleIds =
    input.visibleNodeIds ??
    visibleNodeIds(input.workspace, input.workspace.zoomRootId);

  if (input.key === "Enter") {
    if (imageTarget) {
      return { type: "createNextTextSibling" };
    }
    const terminalCollapsedCaret =
      selectionStart === selectionEnd && selectionEnd === input.title.length;
    const hasChildren =
      optimisticEnter?.hasChildren ??
      (input.workspace.childIdsByParent[input.nodeId]?.length ?? 0) > 0;
    const outlineRow = input.nodeId !== input.workspace.zoomRootId;
    if (outlineRow && terminalCollapsedCaret && hasChildren) {
      return { type: "createFirstChild" };
    }
    return {
      type: "split",
      prefix: input.title.slice(0, selectionStart!),
      suffix: input.title.slice(selectionEnd!)
    };
  }

  if (!node) return null;

  if (input.key === "Tab" || imageAltStructuralKey) {
    const unavailableMove =
      input.key === "Tab" ? { type: "consumeTabShortcut" as const } : null;
    if (
      input.key === "Tab" &&
      input.nodeId === input.workspace.zoomRootId
    ) {
      return unavailableMove;
    }
    const outdent =
      input.key === "Tab" ? input.shiftKey : input.key === "ArrowLeft";
    if (outdent) {
      if (
        node.parentId === null ||
        node.parentId === input.workspace.zoomRootId
      ) {
        return unavailableMove;
      }
      const parent = input.workspace.nodesById[node.parentId];
      if (!parent) {
        return unavailableMove;
      }
      if (parent.parentId === input.outdentBoundaryRootId) {
        return unavailableMove;
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
      return unavailableMove;
    }
    let priorId: NoteId | null = null;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (visibleIds.includes(siblings[cursor])) {
        priorId = siblings[cursor];
        break;
      }
    }
    if (priorId === null) {
      return unavailableMove;
    }
    const prior = input.workspace.nodesById[priorId];
    if (!prior) {
      return unavailableMove;
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

  const collapsedSelection =
    imageTarget || selectionStart === selectionEnd;
  if (input.key === "ArrowLeft") {
    if (
      !collapsedSelection ||
      (!imageTarget && selectionStart !== 0)
    ) {
      return null;
    }
    const previousId = visibleIds[visibleIndex - 1];
    return previousId
      ? {
          type: "focus",
          nodeId: previousId,
          selection: {
            anchorUtf16: Number.MAX_SAFE_INTEGER,
            focusUtf16: Number.MAX_SAFE_INTEGER
          }
        }
      : null;
  }

  if (input.key === "ArrowRight") {
    if (
      !collapsedSelection ||
      (!imageTarget && selectionEnd !== input.title.length)
    ) {
      return null;
    }
    const nextId = visibleIds[visibleIndex + 1];
    return nextId
      ? {
          type: "focus",
          nodeId: nextId,
          selection: { anchorUtf16: 0, focusUtf16: 0 }
        }
      : null;
  }

  if (input.key === "Backspace") {
    if (imageTarget || node.isReadonly === true || node.pluginMeta !== undefined) {
      return null;
    }
    const hasAttachments =
      (input.workspace.attachmentsByNodeId[input.nodeId]?.length ?? 0) > 0;
    if (
      !collapsedSelection ||
      selectionStart! !== 0 ||
      input.title.trim() ||
      visibleIndex < 0
    ) {
      return null;
    }
    if (input.note.trim()) {
      return hasAttachments || input.repeat ? null : { type: "confirmDelete" };
    }
    if (hasAttachments) {
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
