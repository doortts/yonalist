import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { OutlineIndex } from "./outlineIndex";
import { holdsCaret } from "./outlineModel";

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
  /**
   * Which end of a text selection the caret sits on. WebKit reports `"none"`
   * for a span it never gave a direction; an absent or `"none"` direction is
   * read as unknown, and a sweep over one only ever grows it.
   */
  readonly selectionDirection?: "forward" | "backward" | "none";
  readonly firstVisualLine: boolean;
  readonly lastVisualLine: boolean;
  readonly visibleNodes: readonly NoteView[];
  readonly structureNodes?: readonly NoteView[];
  readonly visibleIndex?: OutlineIndex;
  readonly structureIndex?: OutlineIndex;
  readonly selectionHeadId?: string | null;
  /**
   * The end of the band that stays put. Which side of it the head sits on is
   * what tells a growing band from a shrinking one.
   */
  readonly selectionAnchorId?: string | null;
  readonly hasSelection?: boolean;
  /** Which side of an image the caret stands on, when it stands on one. */
  readonly imageEdge?: "before" | "after";
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
      /**
       * Where the caret goes when `nodeId` has no editor to take it. Home is
       * the root itself and the root is nobody's title, so the pane draws no
       * heading there and the row below it is the top of the outline.
       */
      readonly fallbackNodeId?: string;
    }
  | { readonly kind: "removeEmpty"; readonly focusId: string | null }
  | {
      readonly kind: "mergeBackward";
      readonly previousId: string;
      readonly joinOffset: number;
    }
  | { readonly kind: "mergeIntoParent"; readonly parentId: string }
  | { readonly kind: "cycleComplete" }
  | { readonly kind: "clearMarker" }
  | { readonly kind: "duplicate" }
  /** The row to take, when it is not the caret's own: the station before a
   * picture names the picture behind it. Absent, the caret's row goes. */
  | { readonly kind: "trash"; readonly nodeId?: string }
  | { readonly kind: "moveTo" }
  | { readonly kind: "move"; readonly direction: "up" | "down" }
  | { readonly kind: "zoom"; readonly direction: "in" | "out" }
  | { readonly kind: "focusImage"; readonly nodeId: string }
  | { readonly kind: "focusNote" }
  | { readonly kind: "copyImage" }
  | { readonly kind: "cutImage" }
  // The caret's own row, subtree and all -- the same payload a one-row band
  // writes, and the same one the row menu's Copy and Cut already take.
  | { readonly kind: "copyRow" }
  | { readonly kind: "cutRow" }
  /**
   * Puts the band's far end on `headId`. Naming the key's own row takes just
   * that row: with no band up yet, the sweep anchors where it starts.
   *
   * `edge` is the side of the head row the caret rides to -- the side the key
   * pointed at, the way a swept span leaves its caret on the end it moved.
   */
  | {
      readonly kind: "extendSelection";
      readonly headId: string;
      readonly edge: "start" | "end";
    }
  /** One rung wider than whatever the band holds now. */
  | { readonly kind: "widenSelection" }
  | {
      readonly kind: "selectTextEdge";
      readonly start: number;
      readonly end: number;
      readonly direction: "forward" | "backward";
    }
  | {
      readonly kind: "clearSelection";
      /** Which end of the cleared band the caret lands on, when it moves. */
      readonly collapse?: "start" | "end";
      /**
       * Set by the vertical arrows, which carry the caret a row past that end:
       * the same row the key would have reached with no band in the way.
       */
      readonly step?: boolean;
    }
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
  | "removeEmptyNote"
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

/** The nearest row from `from` in one direction that can hold a caret. */
function caretRowNear(
  nodes: readonly NoteView[],
  from: number,
  step: -1 | 1
): string | null {
  for (let at = from + step; at >= 0 && at < nodes.length; at += step) {
    const node = nodes[at];
    if (node && holdsCaret(node)) return node.id;
  }
  return null;
}

function visiblePositionOf(
  input: OutlineKeyInput,
  id: string | null | undefined
): number {
  if (!id) return -1;
  return input.visibleIndex?.positionOf(id) ??
    input.visibleNodes.findIndex((candidate) => candidate.id === id);
}

/**
 * Where one press puts the band's far end: past every row the band holds either
 * way. A band holding a parent holds its whole subtree, so a row whose parent the
 * band also holds is selected wherever the head stands -- taking one in, or
 * handing one back, spends a press and changes nothing. The head stops at the
 * anchor, since a step past it would turn the band around, and an anchor the
 * visible list has no row for leaves the head stepping one row as it always has.
 */
function bandHeadStep(
  input: OutlineKeyInput,
  headAt: number,
  step: -1 | 1
): number {
  const anchorAt = visiblePositionOf(input, input.selectionAnchorId);
  let at = headAt + step;
  if (anchorAt < 0) return at;
  // Growing takes the row ahead of the head in; giving rows back drops the one
  // the head leaves behind, which sits one step outside the band it lands in.
  const growing = (headAt - anchorAt) * step >= 0;
  while (at !== anchorAt && at >= 0 && at < input.visibleNodes.length) {
    const changed = input.visibleNodes[growing ? at : at - step];
    const parentAt = visiblePositionOf(input, changed?.parentId);
    if (
      parentAt < Math.min(anchorAt, at) ||
      parentAt > Math.max(anchorAt, at)
    ) {
      break;
    }
    at += step;
  }
  return at;
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

  // Rows and the page title alike: the page (or zoom root) is a node with its
  // own supporting note, so Shift+Enter opens it there too.
  if (
    input.key === "Enter" &&
    input.shiftKey &&
    !input.altKey &&
    !input.ctrlKey &&
    !input.metaKey
  ) {
    return input.repeat ? { kind: "consume" } : { kind: "focusNote" };
  }

  // The ends of the outline, not the ends of the row's own text: the chord runs
  // to the top of the page or to its last row, and answers from the title as
  // readily as from a row. Shift with the same modifier moves rows instead.
  if (
    (input.key === "ArrowUp" || input.key === "ArrowDown") &&
    !input.shiftKey &&
    !input.altKey &&
    primaryModifier(input)
  ) {
    if (input.repeat) return { kind: "consume" };
    const last = input.key === "ArrowDown"
      ? input.visibleNodes.at(-1)
      : undefined;
    return last
      ? { kind: "focus", nodeId: last.id, edge: "end" }
      : {
          kind: "focus",
          nodeId: input.pageId,
          edge: input.key === "ArrowUp" ? "start" : "end",
          fallbackNodeId: input.visibleNodes[0]?.id
        };
  }

  if (input.target === "row") {
    // A blank beside the row, whatever the caret is doing and whatever the row
    // carries: Enter has to read the caret and the children to decide between a
    // split, a first child and a blank above, and none of that is wanted when
    // the ask is simply one more row at this level.
    if (
      input.key === "Enter" &&
      input.shiftKey &&
      !input.altKey &&
      primaryModifier(input)
    ) {
      if (input.repeat) return { kind: "consume" };
      const node = nodeById(structureNodes, input.nodeId, input.structureIndex);
      return node
        ? {
            kind: "createSibling",
            parentId: node.parentId ?? input.pageId,
            beforeId: nextSiblingId(structureNodes, node, input.structureIndex)
          }
        : null;
    }
    if (
      input.key === "Enter" &&
      !input.altKey &&
      !input.shiftKey &&
      primaryModifier(input)
    ) {
      return input.repeat ? { kind: "consume" } : { kind: "cycleComplete" };
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
    // A ladder: the row's own text first, then its siblings, then their parent,
    // then the parent's siblings, up to every row the outline is showing. A row
    // with no text to take -- an empty bullet, an image -- has only the rows to
    // give, and a band already up has left the text rung behind.
    if (
      input.key.toLowerCase() === "a" &&
      !input.shiftKey &&
      !input.altKey &&
      primaryModifier(input)
    ) {
      if (input.repeat) return { kind: "consume" };
      const swept = validSelection(input) &&
        input.selectionStart === 0 &&
        input.selectionEnd === input.value.length;
      return swept || input.hasSelection
        ? { kind: "widenSelection" }
        : {
            kind: "selectTextEdge",
            start: 0,
            end: input.value.length,
            direction: "forward"
          };
    }
    // Nothing selected anywhere: the chord takes the caret's own row, the way
    // the row menu's Copy and Cut do. A swept span keeps the textarea's native
    // copy, and a live band keeps the section's own clipboard event.
    const clipboardKey = input.key.toLowerCase();
    if (
      (clipboardKey === "c" || clipboardKey === "x") &&
      !input.shiftKey &&
      !input.altKey &&
      primaryModifier(input) &&
      !input.hasSelection &&
      validSelection(input) &&
      input.selectionStart === input.selectionEnd
    ) {
      if (input.repeat) return { kind: "consume" };
      return { kind: clipboardKey === "c" ? "copyRow" : "cutRow" };
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
    // Shift and an arrow sweep in three stages: over the row's own text first,
    // then over the row itself, then over its neighbours. Each stage begins
    // where the one before it left the caret, so holding the chord climbs them
    // in order.
    if (
      input.shiftKey &&
      !input.altKey &&
      !input.ctrlKey &&
      !input.metaKey &&
      (input.key === "ArrowUp" || input.key === "ArrowDown")
    ) {
      const up = input.key === "ArrowUp";
      if (input.hasSelection) {
        const currentId = input.selectionHeadId ?? input.nodeId;
        const index = visiblePositionOf(input, currentId);
        const target = index >= 0
          ? input.visibleNodes[bandHeadStep(input, index, up ? -1 : 1)]
          : undefined;
        return target
          ? {
              kind: "extendSelection",
              headId: target.id,
              edge: up ? "start" : "end"
            }
          : { kind: "consume" };
      }
      if (!validSelection(input)) return null;
      // The caret is one end of the text selection and the anchor the other; a
      // sweep leaves the anchor where it stands and carries the caret on to the
      // row's edge. A row with no text to sweep -- an empty bullet, an image --
      // has both ends on the one edge, so it goes straight to taking the row.
      //
      // WKWebView, which is what ships, hands back `"none"` for a span it never
      // gave a direction -- a span the mouse drew, most of the time. Guessing
      // its caret end wrong would drop the far half of what the user had, so an
      // undirected span keeps both ends and only grows: the anchor is the end
      // the arrow points away from.
      const undirected = input.selectionDirection === undefined ||
        input.selectionDirection === "none";
      const backward = input.selectionDirection === "backward" ||
        (undirected && up);
      const anchor = backward ? input.selectionEnd! : input.selectionStart!;
      const caret = backward ? input.selectionStart! : input.selectionEnd!;
      if (up) {
        return caret === 0
          ? { kind: "extendSelection", headId: input.nodeId, edge: "start" }
          : {
              kind: "selectTextEdge",
              start: 0,
              end: anchor,
              direction: "backward"
            };
      }
      return caret === input.value.length
        ? { kind: "extendSelection", headId: input.nodeId, edge: "end" }
        : {
            kind: "selectTextEdge",
            start: anchor,
            end: input.value.length,
            direction: "forward"
          };
    }
    // A bare arrow off a row band drops the band and leaves one caret behind,
    // the way it collapses a swept span of letters: the edge it points at is
    // the edge the caret lands on.
    if (
      input.hasSelection &&
      !input.altKey &&
      !input.ctrlKey &&
      !input.metaKey &&
      !input.shiftKey &&
      (input.key === "ArrowUp" || input.key === "ArrowDown" ||
        input.key === "ArrowLeft" || input.key === "ArrowRight")
    ) {
      return {
        kind: "clearSelection",
        collapse: input.key === "ArrowUp" || input.key === "ArrowLeft"
          ? "start"
          : "end",
        step: input.key === "ArrowUp" || input.key === "ArrowDown"
      };
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
    // A band answers the delete keys with itself. The caret is parked in one of
    // the banded rows, and letting the key through would take a letter nobody
    // is looking at instead of the rows they are. A held key consumes the
    // repeats the way every other command binding here does.
    if (
      input.hasSelection &&
      (input.key === "Backspace" || input.key === "Delete") &&
      !input.altKey &&
      !input.ctrlKey &&
      !input.metaKey &&
      !input.shiftKey
    ) {
      return input.repeat ? { kind: "consume" } : { kind: "trash" };
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
    // Enter at the head of the text opens a blank line above instead of
    // splitting. A split hands the half after the caret to the new row, so with
    // the whole text in that half the row would give away its text -- and with
    // children, the new row goes inside the source, which reads as the parent
    // demoting itself into its own first child. The row keeps its text, its
    // children, its note and its tick; the blank becomes its previous sibling.
    // A held Enter is the gesture's to place: it stacks blanks off the row that
    // carries the caret, and the first press already decided where that is.
    if (
      !input.repeat &&
      input.selectionStart === 0 &&
      input.selectionEnd === 0 &&
      input.value.length > 0
    ) {
      return {
        kind: "createSibling",
        parentId: node.parentId ?? input.pageId,
        beforeId: input.nodeId
      };
    }
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
    input.value.trim().length === 0
  ) {
    // The box comes off before the row does: one Backspace leaves an ordinary
    // empty bullet, and the next takes that away as it always has.
    const current = nodeById(structureNodes, input.nodeId, input.structureIndex);
    if (current?.marker === "todo") return { kind: "clearMarker" };
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
    // The row above, then the rows below -- the first child of a row with
    // children is the row below it, so one downward scan covers both. The page
    // title is the last resort and always takes a caret.
    return {
      kind: "removeEmpty",
      focusId: caretRowNear(input.visibleNodes, index, -1) ??
        caretRowNear(input.visibleNodes, index, 1) ??
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
  // Plain Enter, because a picture has no text to split, and the chord that
  // says the same thing from a row with text, so one gesture reaches every row.
  const siblingChord = input.key === "Enter" &&
    !input.altKey &&
    input.shiftKey &&
    primaryModifier(input);
  if (
    input.key === "Enter" &&
    !input.altKey &&
    ((!input.ctrlKey && !input.metaKey && !input.shiftKey) || siblingChord)
  ) {
    // A held plain Enter stacks blanks off a picture the way it does off a row.
    // The chord asks for one row, and asks for it the same way here as it does
    // from a row with text.
    if (siblingChord && input.repeat) return { kind: "consume" };
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
  // Backspace takes whatever stands behind the caret. From the station past the
  // picture -- and from the caret standing on the picture -- that is the
  // picture; from the station before it, it is the previous visible row, and a
  // picture of the same parent is taken there the way the other station takes
  // its own, one row boundary back. Anything else behind the caret stays: a
  // text row merges on its own surface and never dies to a neighbour's key, a
  // picture at another depth is the reach the head-of-line merge also refuses,
  // and the caret's own parent would take the caret's row down with it. That
  // refusal still keeps the station out of the fall-through below, whose empty
  // value would reach a command written for blank bullets, and a band still
  // falls through to the one rule that owns both delete keys.
  if (
    input.key === "Backspace" &&
    !input.altKey &&
    !input.ctrlKey &&
    !input.metaKey &&
    !input.shiftKey &&
    !input.hasSelection
  ) {
    if (input.imageEdge === "before") {
      const rows = input.visibleNodes;
      const at = visiblePositionOf(input, input.nodeId);
      const current = rows[at];
      const above = rows[at - 1];
      if (
        !current ||
        above?.kind !== "image" ||
        above.parentId !== current.parentId
      ) return null;
      return input.repeat
        ? { kind: "consume" }
        : { kind: "trash", nodeId: above.id };
    }
    return input.repeat ? { kind: "consume" } : { kind: "trash" };
  }
  // A textarea gets its copy and cut as native clipboard events; WebKit sends
  // none for a focused div, so the image reads the chord itself.
  const clipboardKey = input.key.toLowerCase();
  if (
    (clipboardKey === "c" || clipboardKey === "x") &&
    !input.shiftKey &&
    !input.altKey &&
    primaryModifier(input)
  ) {
    if (input.repeat) return { kind: "consume" };
    return { kind: clipboardKey === "c" ? "copyImage" : "cutImage" };
  }
  // No character sits beside the station for a shifted arrow to sweep over, so
  // it takes the image itself the way the same key takes a letter -- but only
  // sweeping toward the image. The station on the far side has nothing to take.
  if (
    (input.key === "ArrowLeft" || input.key === "ArrowRight") &&
    input.shiftKey &&
    !input.altKey &&
    !input.ctrlKey &&
    !input.metaKey
  ) {
    const toward = input.key === "ArrowRight" ? "before" : "after";
    return input.imageEdge === undefined || input.imageEdge === toward
      ? {
          kind: "extendSelection",
          headId: input.nodeId,
          edge: input.key === "ArrowRight" ? "end" : "start"
        }
      : null;
  }
  // Caret, image, caret: the image is a stop between its two stations, so a
  // plain arrow lands on it before the row boundary is even in question. The
  // caret standing on the image itself is the stop with no station under it.
  // A live band comes first, though -- the same key has to drop it here as it
  // does on a bullet, rather than walking the caret out from under it.
  if (
    (input.key === "ArrowLeft" || input.key === "ArrowRight") &&
    !input.hasSelection &&
    !input.shiftKey &&
    !input.altKey &&
    !input.ctrlKey &&
    !input.metaKey
  ) {
    const toward = input.key === "ArrowRight" ? "before" : "after";
    if (input.imageEdge === toward) {
      return { kind: "focusImage", nodeId: input.nodeId };
    }
    if (input.imageEdge === undefined) {
      return {
        kind: "focus",
        nodeId: input.nodeId,
        edge: input.key === "ArrowRight" ? "end" : "start"
      };
    }
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
  // Backspace past the last character takes the note away and hands the caret
  // back to its title. A held key stops here rather than running on into the
  // title's own text.
  if (input.key === "Backspace" && input.value.length === 0 && !input.repeat) {
    return "removeEmptyNote";
  }
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
