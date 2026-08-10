import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { OutlineIndex } from "./outlineIndex";

export interface OutlineKeyInput {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  readonly repeat: boolean;
  readonly nodeId: string;
  readonly pageId: string;
  readonly value: string;
  readonly supportingNote?: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  readonly firstVisualLine: boolean;
  readonly lastVisualLine: boolean;
  readonly visibleNodes: readonly NoteView[];
  readonly structureNodes?: readonly NoteView[];
  readonly visibleIndex?: OutlineIndex;
  readonly structureIndex?: OutlineIndex;
  readonly selectionHeadId?: string | null;
  readonly hasSelection?: boolean;
  readonly target: "page" | "row";
  readonly platform: "mac" | "other";
}

export type OutlineKeyIntent =
  | {
      readonly kind: "split";
      readonly prefix: string;
      readonly suffix: string;
      readonly parentId: string;
      readonly beforeId: string | null;
    }
  | { readonly kind: "createFirstChild"; readonly parentId: string }
  | {
      readonly kind: "createSibling";
      readonly parentId: string;
      readonly beforeId: string | null;
    }
  | { readonly kind: "indent"; readonly previousSiblingId: string }
  | {
      readonly kind: "outdent";
      readonly parentId: string;
      readonly beforeId: string | null;
    }
  | {
      readonly kind: "focus";
      readonly nodeId: string;
      readonly edge: "start" | "end" | "preserve";
    }
  | { readonly kind: "removeEmpty"; readonly focusId: string | null }
  | {
      readonly kind: "mergeBackward";
      readonly previousId: string;
      readonly joinOffset: number;
    }
  | { readonly kind: "mergeIntoParent"; readonly parentId: string }
  | { readonly kind: "toggleComplete" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "trash" }
  | { readonly kind: "moveTo" }
  | { readonly kind: "move"; readonly direction: "up" | "down" }
  | { readonly kind: "zoom"; readonly direction: "in" | "out" }
  | { readonly kind: "focusNote" }
  | { readonly kind: "extendSelection"; readonly headId: string }
  | { readonly kind: "clearSelection" }
  | { readonly kind: "consume" };

export interface SupportingNoteKeyInput {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  readonly repeat: boolean;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly value: string;
}

export type SupportingNoteKeyResolution =
  | "currentTitle"
  | "nextTitle"
  | "nextTitleOrCreate";

function primaryModifier(input: OutlineKeyInput): boolean {
  return input.platform === "mac"
    ? input.metaKey && !input.ctrlKey
    : input.ctrlKey && !input.metaKey;
}

function moveDirection(input: OutlineKeyInput): "up" | "down" | null {
  const modifier = input.platform === "mac"
    ? input.ctrlKey !== input.metaKey && !input.altKey
    : input.altKey && !input.ctrlKey && !input.metaKey;
  if (!input.shiftKey || !modifier) return null;
  if (input.key === "ArrowUp") return "up";
  if (input.key === "ArrowDown") return "down";
  return null;
}

function nodeById(
  nodes: readonly NoteView[],
  id: string,
  index?: OutlineIndex
): NoteView | undefined {
  return index?.node(id) ?? nodes.find((node) => node.id === id);
}

function siblingsOf(
  nodes: readonly NoteView[],
  parentId: string | null,
  index?: OutlineIndex
): readonly NoteView[] {
  if (parentId !== null && index) return index.childrenOf(parentId);
  return nodes.filter((node) => node.parentId === parentId);
}

function nextSiblingId(
  nodes: readonly NoteView[],
  node: NoteView,
  index?: OutlineIndex
): string | null {
  if (index) return index.nextSiblingId(node.id);
  const siblings = siblingsOf(nodes, node.parentId, index);
  const position = siblings.findIndex((candidate) => candidate.id === node.id);
  return position >= 0 ? siblings[position + 1]?.id ?? null : null;
}

function validSelection(input: OutlineKeyInput): boolean {
  const { selectionStart, selectionEnd } = input;
  return selectionStart !== null &&
    selectionEnd !== null &&
    Number.isInteger(selectionStart) &&
    Number.isInteger(selectionEnd) &&
    selectionStart >= 0 &&
    selectionEnd >= selectionStart &&
    selectionEnd <= input.value.length;
}

export function resolveOutlineKey(
  input: OutlineKeyInput
): OutlineKeyIntent | null {
  if (input.isComposing || input.key === "Process") return null;
  const structureNodes = input.structureNodes ?? input.visibleNodes;
  const zoomModifier = input.platform === "mac"
    ? input.metaKey && !input.altKey && !input.ctrlKey
    : input.altKey && !input.ctrlKey && !input.metaKey;
  if (
    zoomModifier &&
    !input.shiftKey &&
    (input.key === "." || input.key === ",")
  ) {
    if (input.repeat || (input.target === "page" && input.key === ".")) {
      return { kind: "consume" };
    }
    return {
      kind: "zoom",
      direction: input.key === "." ? "in" : "out"
    };
  }

  if (input.target === "row") {
    if (
      input.key === "Enter" &&
      input.shiftKey &&
      !input.altKey &&
      !input.ctrlKey &&
      !input.metaKey
    ) {
      return input.repeat ? { kind: "consume" } : { kind: "focusNote" };
    }
    if (
      input.key === "Enter" &&
      !input.altKey &&
      !input.shiftKey &&
      primaryModifier(input)
    ) {
      return input.repeat ? { kind: "consume" } : { kind: "toggleComplete" };
    }
    if (
      input.key === "Backspace" &&
      input.shiftKey &&
      !input.altKey &&
      primaryModifier(input)
    ) {
      return input.repeat ? { kind: "consume" } : { kind: "trash" };
    }
    // The one binding here that wants BOTH control and meta on a mac, which is
    // exactly what `primaryModifier` rules out, so it carries its own test.
    const moveToModifier = input.platform === "mac"
      ? input.ctrlKey && input.metaKey && !input.altKey
      : input.ctrlKey && input.altKey && !input.metaKey;
    if (
      input.key.toLowerCase() === "m" &&
      !input.shiftKey &&
      moveToModifier
    ) {
      return input.repeat ? { kind: "consume" } : { kind: "moveTo" };
    }
    const duplicateModifier = input.platform === "mac"
      ? input.metaKey && !input.altKey && !input.ctrlKey
      : input.altKey && !input.metaKey && !input.ctrlKey;
    if (
      input.key.toLowerCase() === "d" &&
      input.shiftKey &&
      duplicateModifier
    ) {
      return input.repeat ? { kind: "consume" } : { kind: "duplicate" };
    }
    const direction = moveDirection(input);
    if (direction) {
      return input.repeat
        ? { kind: "consume" }
        : { kind: "move", direction };
    }
    if (
      input.shiftKey &&
      !input.altKey &&
      !input.ctrlKey &&
      !input.metaKey &&
      (input.key === "ArrowUp" || input.key === "ArrowDown")
    ) {
      const currentId = input.selectionHeadId ?? input.nodeId;
      const index = input.visibleIndex?.positionOf(currentId) ??
        input.visibleNodes.findIndex((candidate) => candidate.id === currentId);
      const target = input.visibleNodes[
        index + (input.key === "ArrowUp" ? -1 : 1)
      ];
      return index >= 0 && target
        ? { kind: "extendSelection", headId: target.id }
        : { kind: "consume" };
    }
    if (
      input.key === "Escape" &&
      !input.altKey &&
      !input.ctrlKey &&
      !input.metaKey &&
      !input.shiftKey &&
      input.hasSelection
    ) {
      return { kind: "clearSelection" };
    }
  }

  if (input.altKey || input.ctrlKey || input.metaKey) return null;

  if (input.key === "Tab") {
    if (input.repeat || input.target === "page") return { kind: "consume" };
    const node = nodeById(structureNodes, input.nodeId, input.structureIndex);
    if (!node) return null;
    if (input.shiftKey) {
      const parent = nodeById(
        structureNodes,
        node.parentId ?? "",
        input.structureIndex
      );
      if (!parent || !parent.parentId) return { kind: "consume" };
      return {
        kind: "outdent",
        parentId: parent.parentId,
        beforeId: nextSiblingId(structureNodes, parent, input.structureIndex)
      };
    }
    const siblings = siblingsOf(
      structureNodes,
      node.parentId,
      input.structureIndex
    );
    const index = input.structureIndex?.siblingPositionOf(node.id) ??
      siblings.findIndex((candidate) => candidate.id === node.id);
    const previous = index > 0 ? siblings[index - 1] : undefined;
    return previous
      ? { kind: "indent", previousSiblingId: previous.id }
      : { kind: "consume" };
  }

  if (input.shiftKey) return null;

  if (input.key === "Enter") {
    if (input.target === "page") {
      return { kind: "createFirstChild", parentId: input.pageId };
    }
    if (!validSelection(input)) return null;
    const node = nodeById(structureNodes, input.nodeId, input.structureIndex);
    if (!node) return null;
    // A bullet with children always takes Enter as "make a first child": the
    // subtree hangs off the source, so the half after the caret goes inside it
    // rather than beside it, and a caret at the end just makes that half empty.
    // A childless bullet has nothing to straddle, so its half becomes the next
    // sibling as before.
    const firstChildId = input.structureIndex
      ? input.structureIndex.firstChildId(input.nodeId)
      : structureNodes.find(
          (candidate) => candidate.parentId === input.nodeId
        )?.id ?? null;
    return {
      kind: "split",
      prefix: input.value.slice(0, input.selectionStart!),
      suffix: input.value.slice(input.selectionEnd!),
      parentId: firstChildId === null
        ? node.parentId ?? input.pageId
        : input.nodeId,
      beforeId: firstChildId === null
        ? nextSiblingId(structureNodes, node, input.structureIndex)
        : firstChildId
    };
  }

  if (input.key === "ArrowUp" || input.key === "ArrowDown") {
    if (input.target === "page") {
      return input.key === "ArrowDown" && input.visibleNodes[0]
        ? {
            kind: "focus",
            nodeId: input.visibleNodes[0].id,
            edge: "start"
          }
        : null;
    }
    if (
      (input.key === "ArrowUp" && !input.firstVisualLine) ||
      (input.key === "ArrowDown" && !input.lastVisualLine)
    ) {
      return null;
    }
    const index = input.visibleIndex?.positionOf(input.nodeId) ??
      input.visibleNodes.findIndex((node) => node.id === input.nodeId);
    if (index < 0) return null;
    if (input.key === "ArrowUp" && index === 0) {
      return { kind: "focus", nodeId: input.pageId, edge: "start" };
    }
    const target = input.visibleNodes[
      index + (input.key === "ArrowUp" ? -1 : 1)
    ];
    return target
      ? { kind: "focus", nodeId: target.id, edge: "start" }
      : null;
  }

  if (input.key === "ArrowLeft" || input.key === "ArrowRight") {
    if (input.target === "page" || !validSelection(input)) return null;
    if (input.selectionStart !== input.selectionEnd) return null;
    const atBoundary = input.key === "ArrowLeft"
      ? input.selectionStart === 0
      : input.selectionEnd === input.value.length;
    if (!atBoundary) return null;
    const index = input.visibleIndex?.positionOf(input.nodeId) ??
      input.visibleNodes.findIndex((node) => node.id === input.nodeId);
    if (index < 0) return null;
    const target = input.visibleNodes[
      index + (input.key === "ArrowLeft" ? -1 : 1)
    ];
    if (target) {
      return {
        kind: "focus",
        nodeId: target.id,
        edge: input.key === "ArrowLeft" ? "end" : "start"
      };
    }
    return input.key === "ArrowLeft" && index === 0
      ? { kind: "focus", nodeId: input.pageId, edge: "end" }
      : null;
  }

  if (
    input.key === "Backspace" &&
    input.target === "row" &&
    validSelection(input) &&
    input.selectionStart === 0 &&
    input.selectionEnd === 0 &&
    input.value.trim().length > 0
  ) {
    const index = input.visibleIndex?.positionOf(input.nodeId) ??
      input.visibleNodes.findIndex((node) => node.id === input.nodeId);
    const current = nodeById(
      structureNodes,
      input.nodeId,
      input.structureIndex
    );
    const previous = index > 0 ? input.visibleNodes[index - 1] : undefined;
    // The row above a first child is its own parent. Workflowy no-ops here;
    // we fold the text up instead. The row goes away, so a note on it would
    // go with it, and an image row can never take the text.
    if (
      current &&
      previous &&
      previous.id === current.parentId &&
      previous.kind === "bullet" &&
      (input.supportingNote ?? current.note).trim().length === 0
    ) {
      return { kind: "mergeIntoParent", parentId: previous.id };
    }
    if (
      current &&
      previous &&
      current.parentId === previous.parentId &&
      previous.note.trim().length === 0 &&
      !(input.structureIndex?.hasChildren(previous.id) ??
        structureNodes.some((node) => node.parentId === previous.id))
    ) {
      return {
        kind: "mergeBackward",
        previousId: previous.id,
        joinOffset: previous.text.length
      };
    }
    return null;
  }

  if (
    input.key === "Backspace" &&
    input.target === "row" &&
    validSelection(input) &&
    input.selectionStart === input.selectionEnd &&
    input.selectionStart === 0 &&
    input.value.trim().length === 0 &&
    (input.supportingNote ?? "").trim().length === 0
  ) {
    const index = input.visibleIndex?.positionOf(input.nodeId) ??
      input.visibleNodes.findIndex((node) => node.id === input.nodeId);
    if (index < 0) return null;
    const firstChildId = input.visibleIndex?.firstChildId(input.nodeId);
    const firstChild = firstChildId
      ? input.visibleIndex?.node(firstChildId)
      : input.visibleNodes.find((node) => node.parentId === input.nodeId);
    return {
      kind: "removeEmpty",
      focusId: input.visibleNodes[index - 1]?.id ??
        firstChild?.id ??
        input.visibleNodes[index + 1]?.id ??
        input.pageId
    };
  }

  return null;
}

export function handleImageNodeKeyDown(
  input: OutlineKeyInput
): OutlineKeyIntent | null {
  if (input.isComposing || input.key === "Process") return null;
  const structureNodes = input.structureNodes ?? input.visibleNodes;
  if (
    input.key === "Enter" &&
    !input.altKey &&
    !input.ctrlKey &&
    !input.metaKey &&
    !input.shiftKey
  ) {
    const node = nodeById(
      structureNodes,
      input.nodeId,
      input.structureIndex
    );
    return node ? {
      kind: "createSibling",
      parentId: node.parentId ?? input.pageId,
      beforeId: nextSiblingId(structureNodes, node, input.structureIndex)
    } : null;
  }
  if (
    input.key === "Backspace" &&
    !input.altKey &&
    !input.ctrlKey &&
    !input.metaKey &&
    !input.shiftKey
  ) {
    return null;
  }
  return resolveOutlineKey({
    ...input,
    target: "row",
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    firstVisualLine: true,
    lastVisualLine: true
  });
}

export function resolveSupportingNoteKey(
  input: SupportingNoteKeyInput
): SupportingNoteKeyResolution | null {
  if (input.isComposing || input.key === "Process") return null;
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
  if (input.key === "Escape") return "currentTitle";
  if (input.key === "ArrowUp" && input.selectionStart === 0) {
    return "currentTitle";
  }
  if (input.key === "ArrowDown" && input.selectionEnd === input.value.length) {
    return "nextTitle";
  }
  return null;
}

export function supportingNoteFocusTarget(
  resolution: SupportingNoteKeyResolution,
  nodeId: string,
  visibleIds: readonly string[]
): string {
  if (resolution === "currentTitle") return nodeId;
  const index = visibleIds.indexOf(nodeId);
  return index >= 0 ? visibleIds[index + 1] ?? nodeId : nodeId;
}
