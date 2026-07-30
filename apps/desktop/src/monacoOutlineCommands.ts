import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import type { NotesStore } from "./notesStore";
import type { OutlineIndex } from "./outlineIndex";
import type { MonacoOutlineGesture } from "./monacoOutlineKeyboard";
import type { MonacoOutlineProjection } from "./monacoOutlineProjection";

export interface MonacoOutlineCommandRuntime {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  readonly model: monaco.editor.ITextModel;
  projection: MonacoOutlineProjection;
  enterGesture: EnterSplitGesture | null;
  pendingCaret: PendingCaret | null;
}

export interface MonacoOutlineCommandContext {
  readonly index: OutlineIndex;
  readonly rootId: string;
  readonly structuralContextComplete: boolean;
  readonly onUndo: () => Promise<void>;
  readonly onRedo: () => Promise<void>;
}

interface EnterSplitGesture {
  readonly tailId: string;
  readonly parentId: string;
  readonly beforeId: string | null;
}

interface PendingCaret {
  readonly nodeId: string;
  readonly column: number;
}

export function executeMonacoOutlineGesture(
  gesture: MonacoOutlineGesture,
  repeated: boolean,
  backspaceGroup: string | null,
  runtime: MonacoOutlineCommandRuntime,
  store: NotesStore,
  context: MonacoOutlineCommandContext
): void {
  if (gesture.kind !== "split") runtime.enterGesture = null;
  if (
    !context.structuralContextComplete &&
    gesture.kind !== "undo" &&
    gesture.kind !== "redo" &&
    gesture.kind !== "consume"
  ) {
    return;
  }
  switch (gesture.kind) {
    case "native":
    case "consume":
      return;
    case "undo":
      void context.onUndo();
      return;
    case "redo":
      void context.onRedo();
      return;
    case "split":
      executeSplit(gesture, repeated, runtime, store, context);
      return;
    case "mergeBackward":
      executeMergeBackward(
        gesture,
        backspaceGroup,
        runtime,
        store,
        context
      );
      return;
    case "removeEmpty":
      executeRemoveEmpty(
        gesture,
        backspaceGroup,
        runtime,
        store,
        context
      );
      return;
    case "indent":
      executeIndent(gesture.nodeId, runtime, store, context);
      return;
    case "outdent":
      executeOutdent(gesture.nodeId, runtime, store, context);
  }
}

function executeSplit(
  gesture: Extract<MonacoOutlineGesture, { kind: "split" }>,
  repeated: boolean,
  runtime: MonacoOutlineCommandRuntime,
  store: NotesStore,
  context: MonacoOutlineCommandContext
): void {
  const activeGesture = repeated ? runtime.enterGesture : null;
  const activeTail = activeGesture
    ? store.getSnapshot().nodes.find(
        (candidate) => candidate.id === activeGesture.tailId
      )
    : undefined;
  const source = context.index.node(gesture.nodeId);
  if (!activeTail && !source) return;
  const parentId = activeGesture?.parentId ??
    source?.parentId ??
    context.rootId;
  const beforeId = activeGesture?.beforeId ??
    context.index.nextSiblingId(gesture.nodeId);
  const currentText = activeTail
    ? store.getNodeSnapshot(activeTail.id).title
    : runtime.model.getLineContent(
        runtime.projection.lineByNodeId.get(gesture.nodeId) ?? 1
      );
  const pending = store.beginSplitNode(activeTail && activeGesture ? {
    id: activeTail.id,
    parentId,
    beforeId,
    prefix: "",
    suffix: currentText
  } : {
    id: gesture.nodeId,
    parentId,
    beforeId,
    prefix: currentText.slice(0, gesture.startOffset),
    suffix: currentText.slice(gesture.endOffset)
  });
  runtime.enterGesture = {
    tailId: pending.id,
    parentId,
    beforeId
  };
  runtime.pendingCaret = { nodeId: pending.id, column: 1 };
  void pending.committed.catch(() => undefined);
}

function executeMergeBackward(
  gesture: Extract<MonacoOutlineGesture, { kind: "mergeBackward" }>,
  backspaceGroup: string | null,
  runtime: MonacoOutlineCommandRuntime,
  store: NotesStore,
  context: MonacoOutlineCommandContext
): void {
  const current = context.index.node(gesture.nodeId);
  const previous = context.index.node(gesture.previousId);
  if (
    !current ||
    !previous ||
    previous.kind === "image" ||
    current.parentId !== previous.parentId ||
    previous.note.trim().length > 0 ||
    context.index.hasChildren(previous.id)
  ) {
    return;
  }
  const previousText = store.getNodeSnapshot(previous.id).title;
  const currentText = store.getNodeSnapshot(current.id).title;
  const pending = store.beginMergeNodeBackward({
    id: current.id,
    previousId: previous.id,
    previousText,
    currentText,
    historyGroup: backspaceGroup
  });
  runtime.pendingCaret = {
    nodeId: current.id,
    column: previousText.length + 1
  };
  void pending.committed.catch(() => undefined);
}

function executeRemoveEmpty(
  gesture: Extract<MonacoOutlineGesture, { kind: "removeEmpty" }>,
  backspaceGroup: string | null,
  runtime: MonacoOutlineCommandRuntime,
  store: NotesStore,
  context: MonacoOutlineCommandContext
): void {
  const node = context.index.node(gesture.nodeId);
  const state = store.getSnapshot();
  const supportingNote = state.noteDrafts[gesture.nodeId] ?? node?.note ?? "";
  if (!node || supportingNote.trim().length > 0) return;
  const pending = store.beginRemoveEmptyNode(gesture.nodeId, backspaceGroup);
  const fallbackId = context.index.firstChildId(gesture.nodeId) ??
    runtime.projection.nodeIdByLine[
      runtime.projection.lineByNodeId.get(gesture.nodeId) ?? 1
    ] ??
    null;
  const focusId = gesture.focusId ?? fallbackId;
  if (focusId) {
    runtime.pendingCaret = {
      nodeId: focusId,
      column: store.getNodeSnapshot(focusId).title.length + 1
    };
  }
  void pending.committed.catch(() => undefined);
}

function executeIndent(
  nodeId: string,
  runtime: MonacoOutlineCommandRuntime,
  store: NotesStore,
  context: MonacoOutlineCommandContext
): void {
  const node = context.index.node(nodeId);
  if (!node?.parentId) return;
  const siblings = context.index.childrenOf(node.parentId);
  const position = context.index.siblingPositionOf(node.id);
  const previous = position > 0 ? siblings[position - 1] : undefined;
  if (!previous) return;
  const column = runtime.editor.getPosition()?.column ?? 1;
  runtime.pendingCaret = { nodeId: node.id, column };
  void store.indent(node.id, previous.id);
}

function executeOutdent(
  nodeId: string,
  runtime: MonacoOutlineCommandRuntime,
  store: NotesStore,
  context: MonacoOutlineCommandContext
): void {
  const node = context.index.node(nodeId);
  const parent = node?.parentId
    ? context.index.node(node.parentId)
    : undefined;
  if (!node || !parent?.parentId) return;
  const column = runtime.editor.getPosition()?.column ?? 1;
  runtime.pendingCaret = { nodeId: node.id, column };
  void store.outdent(
    node.id,
    parent.parentId,
    context.index.nextSiblingId(parent.id)
  );
}
