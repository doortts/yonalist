import type { KeyboardEvent } from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "./notesStore";
import type { OutlineIndex } from "./outlineIndex";
import {
  focusAfterCommit,
  focusOutlineEditor
} from "./outlineFocus";
import {
  handleImageNodeKeyDown,
  resolveOutlineKey,
  type OutlineKeyIntent
} from "./outlineKeyboard";
import { measureTextareaCaretLines } from "./textareaCaretLines";

/**
 * The live row band, named rather than positional: the two ids are the same type,
 * so a swap would compile and invert the growing-or-shrinking decision the
 * resolver makes from them.
 */
export interface OutlineBandState {
  readonly headId: string | null;
  /** The end that stays put while an arrow moves the other one. */
  readonly anchorId: string | null;
  readonly hasSelection: boolean;
}

export interface SelectionKeyboardActions {
  readonly indent: () => void;
  readonly outdent: () => void;
  readonly move: (direction: "up" | "down") => void;
  readonly toggleComplete: () => void;
  readonly duplicate: () => void;
  readonly delete: () => void;
  readonly copy: () => void;
  readonly cut: () => void;
}

/**
 * Everything the two row keyboard entry points share. The event stays out of
 * it: the surfaces they read the caret off differ, so each names its own.
 */
interface OutlineRowKeyContext {
  readonly store: NotesStore;
  readonly node: NoteView;
  readonly nodes: readonly NoteView[];
  readonly visibleNodes: readonly NoteView[];
  readonly structureIndex: OutlineIndex;
  readonly visibleIndex: OutlineIndex;
  readonly pageId: string;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly band: OutlineBandState;
  readonly onExtendSelection: (originId: string, headId: string) => void;
  readonly onClearSelection: (collapse?: "start" | "end") => void;
  readonly onFocusNote: () => void;
  readonly onMoveTo: () => void;
  readonly selectionActions: SelectionKeyboardActions;
}

export interface OutlineRowKeyOptions extends OutlineRowKeyContext {
  readonly event: KeyboardEvent<HTMLTextAreaElement>;
  readonly supportingNote: string;
}

export interface ImageRowKeyOptions extends OutlineRowKeyContext {
  readonly event: KeyboardEvent<HTMLDivElement>;
  readonly onCopyImage: (nodeId: string) => void;
  readonly onCutImage: (nodeId: string) => void;
}

interface EnterSplitGesture {
  // The row holding the caret and the half after it, which is what the next
  // repeat splits again. Always the row the split just created.
  readonly tailId: string;
  readonly parentId: string;
  readonly beforeId: string | null;
}

const enterSplitGestures = new WeakMap<HTMLElement, EnterSplitGesture>();

export function endOutlineEnterGesture(target: HTMLElement): void {
  const scope = target.closest<HTMLElement>(".notes-outline");
  if (scope) enterSplitGestures.delete(scope);
}

export function handleOutlineKeyDown(options: OutlineRowKeyOptions) {
  const {
    event, store, node, nodes, visibleNodes, structureIndex, visibleIndex,
    pageId, band, onClearSelection, supportingNote, selectionActions
  } = options;
  const backspaceGroup = updateBackspaceGesture(event, store);
  const caretLines = event.key === "ArrowUp" || event.key === "ArrowDown"
    ? measureTextareaCaretLines(event.currentTarget)
    : { first: true, last: true };
  const intent = resolveOutlineKey({
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isComposing: event.nativeEvent.isComposing,
    repeat: event.repeat,
    nodeId: node.id,
    pageId,
    value: event.currentTarget.value,
    supportingNote,
    selectionStart: event.currentTarget.selectionStart,
    selectionEnd: event.currentTarget.selectionEnd,
    selectionDirection: event.currentTarget.selectionDirection ?? undefined,
    firstVisualLine: caretLines.first,
    lastVisualLine: caretLines.last,
    visibleNodes,
    structureNodes: nodes,
    visibleIndex,
    structureIndex,
    selectionHeadId: band.headId,
    selectionAnchorId: band.anchorId,
    hasSelection: band.hasSelection,
    target: "row",
    platform: outlinePlatform()
  });
  if (!intent) return;

  event.preventDefault();
  // The sweep over a row's own text stays inside the field it started in, so it
  // needs no outline scope and no store round trip.
  if (intent.kind === "selectTextEdge") {
    event.currentTarget.setSelectionRange(
      intent.start, intent.end, intent.direction
    );
    return;
  }
  // The band takes the whole row, so the sweep it grew out of has nothing left
  // to say: two lit ranges at once read as two selections. The caret keeps the
  // end it moved to, which is the end a bare arrow carries on from.
  if (intent.kind === "extendSelection") {
    const field = event.currentTarget;
    const caret = field.selectionDirection === "backward"
      ? field.selectionStart
      : field.selectionEnd;
    field.setSelectionRange(caret, caret);
  }
  const scope = event.currentTarget.closest<HTMLElement>(".notes-outline");
  if (!scope) return;
  if (band.hasSelection) {
    if (intent.kind === "indent") return selectionActions.indent();
    if (intent.kind === "outdent") return selectionActions.outdent();
    if (intent.kind === "move") return selectionActions.move(intent.direction);
    if (intent.kind === "toggleComplete") return selectionActions.toggleComplete();
    if (intent.kind === "duplicate") return selectionActions.duplicate();
    if (intent.kind === "trash") return selectionActions.delete();
    // The note field answers to none of the band's keys, so the band goes
    // before the caret leaves the row for it.
    if (intent.kind === "focusNote") onClearSelection();
  }
  executeRowIntent(intent, scope, options, backspaceGroup, event.repeat);
}

function imageEdgeOf(target: EventTarget): "before" | "after" | undefined {
  const edge = target instanceof HTMLElement
    ? target.dataset.imageEdge
    : undefined;
  return edge === "before" || edge === "after" ? edge : undefined;
}

export function handleImagePrimaryKeyDown(options: ImageRowKeyOptions) {
  const {
    event, node, nodes, visibleNodes, structureIndex, visibleIndex, pageId,
    band, onClearSelection, selectionActions, onCopyImage, onCutImage
  } = options;
  const intent = handleImageNodeKeyDown({
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isComposing: event.nativeEvent.isComposing,
    repeat: event.repeat,
    nodeId: node.id,
    pageId,
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    firstVisualLine: true,
    lastVisualLine: true,
    visibleNodes,
    structureNodes: nodes,
    visibleIndex,
    structureIndex,
    selectionHeadId: band.headId,
    selectionAnchorId: band.anchorId,
    hasSelection: band.hasSelection,
    // The station the key came from is the caret's side of the image; a key on
    // the frame itself belongs to no side.
    imageEdge: imageEdgeOf(event.target),
    target: "row",
    platform: outlinePlatform()
  });
  if (!intent) return;
  event.preventDefault();
  const scope = event.currentTarget.closest<HTMLElement>(".notes-outline");
  if (!scope) return;
  if (band.hasSelection) {
    if (intent.kind === "indent") return selectionActions.indent();
    if (intent.kind === "outdent") return selectionActions.outdent();
    if (intent.kind === "move") return selectionActions.move(intent.direction);
    if (intent.kind === "toggleComplete") return selectionActions.toggleComplete();
    if (intent.kind === "duplicate") return selectionActions.duplicate();
    if (intent.kind === "trash") return selectionActions.delete();
    // Same as a bullet: the note field answers to none of the band's keys, so
    // the band goes before the caret leaves the row for it.
    if (intent.kind === "focusNote") onClearSelection();
  }
  // A selection already carries this image's bytes, so the chord goes to the
  // selection commands and only a bare station falls through to the node.
  if (intent.kind === "copyImage") {
    return band.hasSelection ? selectionActions.copy() : onCopyImage(node.id);
  }
  if (intent.kind === "cutImage") {
    return band.hasSelection ? selectionActions.cut() : onCutImage(node.id);
  }
  // The stop between the two stations is the image itself, which is the element
  // this handler is already mounted on.
  if (intent.kind === "focusImage") {
    event.currentTarget.focus();
    return;
  }
  executeRowIntent(intent, scope, options, null, event.repeat);
}

export function handlePageKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  store: NotesStore,
  pageId: string,
  nodes: readonly NoteView[],
  visibleNodes: readonly NoteView[],
  structureIndex: OutlineIndex,
  visibleIndex: OutlineIndex,
  onZoomOut: () => void,
  onFocusNote: () => void
) {
  updateBackspaceGesture(event, store);
  executePageIntent(event, resolveOutlineKey({
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isComposing: event.nativeEvent.isComposing,
    repeat: event.repeat,
    nodeId: pageId,
    pageId,
    value: event.currentTarget.value,
    selectionStart: event.currentTarget.selectionStart,
    selectionEnd: event.currentTarget.selectionEnd,
    firstVisualLine: true,
    lastVisualLine: true,
    visibleNodes,
    structureNodes: nodes,
    visibleIndex,
    structureIndex,
    target: "page",
    platform: outlinePlatform()
  }), store, pageId, structureIndex, onZoomOut, onFocusNote);
}

/**
 * The same keys for the zoom header when the zoom root is an image: it has no
 * text field to type into, so the caret station answers in its place.
 */
export function handleImagePageKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  store: NotesStore,
  pageId: string,
  nodes: readonly NoteView[],
  visibleNodes: readonly NoteView[],
  structureIndex: OutlineIndex,
  visibleIndex: OutlineIndex,
  onZoomOut: () => void,
  onFocusNote: () => void
) {
  executePageIntent(event, resolveOutlineKey({
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isComposing: event.nativeEvent.isComposing,
    repeat: event.repeat,
    nodeId: pageId,
    pageId,
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    firstVisualLine: true,
    lastVisualLine: true,
    visibleNodes,
    structureNodes: nodes,
    visibleIndex,
    structureIndex,
    target: "page",
    platform: outlinePlatform()
  }), store, pageId, structureIndex, onZoomOut, onFocusNote);
}

function executePageIntent(
  event: KeyboardEvent<HTMLElement>,
  intent: OutlineKeyIntent | null,
  store: NotesStore,
  pageId: string,
  structureIndex: OutlineIndex,
  onZoomOut: () => void,
  onFocusNote: () => void
): void {
  if (!intent) return;
  event.preventDefault();
  const scope = event.currentTarget.closest<HTMLElement>(".notes-outline");
  if (!scope) return;
  if (intent.kind === "focus") {
    focusOutlineEditor(scope, intent.nodeId, intent.edge);
  } else if (intent.kind === "createFirstChild") {
    createFirstChild(scope, store, structureIndex, intent.parentId);
  } else if (intent.kind === "zoom" && intent.direction === "out") {
    void store.flushDraft(pageId).then(onZoomOut);
  } else if (intent.kind === "focusNote") {
    onFocusNote();
  }
}

export function outlinePlatform(): "mac" | "other" {
  return /Mac|iPhone|iPad|iPod/iu.test(globalThis.navigator?.platform ?? "")
    ? "mac"
    : "other";
}

function updateBackspaceGesture(
  event: KeyboardEvent<HTMLTextAreaElement>,
  store: NotesStore
): string | null {
  const isPlainBackspace = event.key === "Backspace" &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing;
  if (isPlainBackspace) return store.beginBackspaceGesture(event.repeat);
  store.endBackspaceGesture();
  return null;
}

function createFirstChild(
  scope: HTMLElement,
  store: NotesStore,
  index: OutlineIndex,
  parentId: string
): void {
  const beforeId = index.firstChildId(parentId);
  const pending = store.beginCreateNode(parentId, "", beforeId);
  focusAfterCommit(scope, pending.id, "start");
  void pending.committed.catch(() => undefined);
}

function executeRowIntent(
  intent: OutlineKeyIntent,
  scope: HTMLElement,
  context: OutlineRowKeyContext,
  backspaceGroup: string | null,
  repeated: boolean
): void {
  const { store, node, nodes, structureIndex } = context;
  switch (intent.kind) {
    case "consume":
    // Only the image surface resolves these, and it routes them itself.
    case "copyImage":
    case "cutImage":
    // Only a text field resolves this one, and it answers before it gets here.
    case "selectTextEdge":
      return;
    case "split":
      {
        const activeGesture = repeated
          ? enterSplitGestures.get(scope)
          : undefined;
        const activeTail = activeGesture
          ? store.getSnapshot().nodes.find(
              (candidate) => candidate.id === activeGesture.tailId
            )
          : undefined;
        const split = activeTail && activeGesture ? {
          id: activeTail.id,
          parentId: activeGesture.parentId,
          beforeId: activeGesture.beforeId,
          prefix: "",
          suffix: store.getSnapshot().drafts[activeTail.id] ?? activeTail.text
        } : {
          id: node.id,
          parentId: intent.parentId,
          beforeId: intent.beforeId,
          prefix: intent.prefix,
          suffix: intent.suffix
        };
        const pending = store.beginSplitNode(split);
        enterSplitGestures.set(scope, {
          tailId: pending.id,
          parentId: split.parentId,
          beforeId: split.beforeId
        });
        focusAfterCommit(scope, pending.id, "start");
        void pending.committed.catch(() => undefined);
      }
      return;
    // No `createFirstChild` here: only the page title still resolves to it, and
    // a row with children now reaches the same result through the split.
    case "createSibling":
      {
        const activeGesture = repeated
          ? enterSplitGestures.get(scope)
          : undefined;
        const parentId = activeGesture?.parentId ?? intent.parentId;
        const beforeId = activeGesture?.beforeId ?? intent.beforeId;
        const pending = store.beginCreateNode(parentId, "", beforeId);
        enterSplitGestures.set(scope, {
          tailId: pending.id,
          parentId,
          beforeId
        });
        focusAfterCommit(scope, pending.id, "start");
        void pending.committed.catch(() => undefined);
      }
      return;
    case "indent":
      void store.indent(node.id, intent.previousSiblingId)
        .then(() => focusAfterCommit(scope, node.id, "preserve"));
      return;
    case "outdent":
      void store.outdent(node.id, intent.parentId, intent.beforeId)
        .then(() => focusAfterCommit(scope, node.id, "preserve"));
      return;
    case "focus":
      focusOutlineEditor(scope, intent.nodeId, intent.edge);
      void store.flushDraft(node.id);
      return;
    case "clearMarker":
      // The caret stays where it is: the row is the same row, minus its box.
      void store.setMarker(node.id, "bullet");
      return;
    case "removeEmpty":
      {
        const pending = store.beginRemoveEmptyNode(node.id, backspaceGroup);
        if (intent.focusId) focusAfterCommit(scope, intent.focusId, "end");
        void pending.committed.catch(() => undefined);
      }
      return;
    case "mergeBackward": {
      const state = store.getSnapshot();
      const previous = state.nodes.find(
        (candidate) => candidate.id === intent.previousId
      );
      if (!previous) return;
      const previousText = state.drafts[previous.id] ?? previous.text;
      const pending = store.beginMergeNodeBackward({
        id: node.id,
        previousId: previous.id,
        previousText,
        currentText: state.drafts[node.id] ?? node.text,
        historyGroup: backspaceGroup
      });
      focusAfterCommit(scope, node.id, previousText.length);
      void pending.committed.catch(() => undefined);
      return;
    }
    case "mergeIntoParent": {
      const state = store.getSnapshot();
      const parent = state.nodes.find(
        (candidate) => candidate.id === intent.parentId
      );
      if (!parent) return;
      const parentText = state.drafts[parent.id] ?? parent.text;
      const pending = store.beginMergeNodeIntoParent({
        id: node.id,
        parentId: parent.id,
        parentText,
        currentText: state.drafts[node.id] ?? node.text,
        historyGroup: backspaceGroup
      });
      focusAfterCommit(scope, parent.id, parentText.length);
      void pending.committed.catch(() => undefined);
      return;
    }
    case "toggleComplete":
      void store.setCompleted(node.id, !node.completed);
      return;
    case "trash":
      void store.deleteSubtree(node.id);
      return;
    // The chooser is mounted by the row and already scopes itself to the live
    // selection, so the key needs no diversion of its own: it flips the same
    // state the menu item flips.
    case "moveTo":
      context.onMoveTo();
      return;
    case "duplicate": {
      const siblings = node.parentId
        ? structureIndex.childrenOf(node.parentId)
        : nodes.filter((candidate) => candidate.parentId === null);
      const index = node.parentId
        ? structureIndex.siblingPositionOf(node.id)
        : siblings.findIndex((candidate) => candidate.id === node.id);
      const beforeId = index >= 0 ? siblings[index + 1]?.id ?? null : null;
      void store.duplicate(node.id, node.parentId ?? "", beforeId)
        .then((id) => focusAfterCommit(scope, id, "start"));
      return;
    }
    case "move": {
      const siblings = node.parentId
        ? structureIndex.childrenOf(node.parentId)
        : nodes.filter((candidate) => candidate.parentId === null);
      const index = node.parentId
        ? structureIndex.siblingPositionOf(node.id)
        : siblings.findIndex((candidate) => candidate.id === node.id);
      const beforeId = intent.direction === "up"
        ? siblings[index - 1]?.id
        : siblings[index + 2]?.id ?? null;
      if (index < 0 || (intent.direction === "up" && !beforeId)) return;
      void store.moveNode(node.id, node.parentId ?? "", beforeId ?? null)
        .then(() => focusAfterCommit(scope, node.id, "preserve"));
      return;
    }
    case "zoom":
      void store.flushDraft(node.id).then(
        intent.direction === "in" ? context.onZoomIn : context.onZoomOut
      );
      return;
    case "focusNote":
      context.onFocusNote();
      return;
    case "extendSelection":
      context.onExtendSelection(node.id, intent.headId);
      return;
    case "clearSelection":
      context.onClearSelection(intent.collapse);
  }
}
