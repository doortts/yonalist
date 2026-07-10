import type { MoveNoteNodeInput, NoteId } from "../../domain/notes";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";
import { visibleNodeIds } from "./outlineTree";

export type OutlineShortcutPlatform = "mac" | "other";

export function detectOutlineShortcutPlatform(
  platform = typeof navigator === "undefined" ? "" : navigator.platform
): OutlineShortcutPlatform {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "mac" : "other";
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
  | { type: "remove"; focusNodeId: NoteId | null };

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

  const primaryModifierPressed =
    input.platform === "mac"
      ? input.metaKey && !input.ctrlKey
      : input.ctrlKey && !input.metaKey;
  const duplicateModifierPressed =
    input.platform === "mac"
      ? input.metaKey && !input.altKey && !input.ctrlKey
      : input.altKey && !input.metaKey && !input.ctrlKey;
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

  if (input.key === "Enter") {
    return {
      type: "split",
      prefix: input.title.slice(0, selectionStart),
      suffix: input.title.slice(selectionEnd)
    };
  }

  if (input.key === "Tab") {
    if (input.shiftKey) {
      if (node.parentId === null) {
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
    const priorId = siblings[index - 1];
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

  const visibleIds =
    input.visibleNodeIds ??
    visibleNodeIds(input.workspace, input.workspace.zoomRootId);
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
    if (node.isCollapsed && childIds.length > 0) {
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
      visibleIndex < 0
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
