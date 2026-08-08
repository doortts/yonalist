import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { IpcEditorCommand } from "../../../../packages/contracts/generated/IpcEditorCommand";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import {
  pushMetadataUndo,
  type MetadataUndoElement
} from "./internalAdapter";
import {
  OutlineMetadataTimeline,
  type OutlineLineMetadata,
  type OutlineMetadataSnapshot
} from "./metadata";
import {
  MonacoOutlinePersistenceQueue,
  type EditorPersistenceState,
  type MonacoPersistencePort
} from "./persistenceQueue";
import {
  interpretModelChanges,
  type OutlineLineTextPatch
} from "./structuralChanges";

export interface MonacoOutlineSessionInput {
  readonly pageId: string;
  readonly nodes: readonly NoteView[];
  readonly persistence: MonacoPersistencePort;
  readonly allocateId?: () => string;
}

export interface VersionTransition {
  readonly fromAlternativeVersionId: number;
  readonly toAlternativeVersionId: number;
  readonly beforeMetadata: OutlineMetadataSnapshot;
  readonly afterMetadata: OutlineMetadataSnapshot;
  readonly textPatch: OutlineLineTextPatch;
  readonly inverseTextPatch: OutlineLineTextPatch;
  readonly forward: readonly IpcEditorCommand[];
  readonly inverse: readonly IpcEditorCommand[];
}

export interface MonacoOutlineSessionMetrics {
  readonly fullModelReplacementCount: number;
  readonly maxDecorationLinesPerEdit: number;
}

export interface MonacoOutlineSessionDiagnostics {
  readonly boundEditors: number;
  readonly metadataListeners: number;
  readonly forwardTransitions: number;
  readonly reverseTransitions: number;
  readonly metadataVersions: number;
  readonly pendingPersistenceCommands: number;
  readonly persistenceKind: EditorPersistenceState["kind"];
  readonly fullModelReplacementCount: number;
  readonly maxDecorationLinesPerEdit: number;
}

export class MonacoOutlineSession {
  readonly pageId: string;
  readonly model: monaco.editor.ITextModel;
  readonly metadata: OutlineMetadataTimeline;
  private readonly metricState = {
    fullModelReplacementCount: 0,
    maxDecorationLinesPerEdit: 0
  };
  private readonly persistenceQueue: MonacoOutlinePersistenceQueue;
  private readonly allocateId: () => string;
  private readonly transitionsFrom = new Map<number, VersionTransition>();
  private readonly transitionsTo = new Map<number, VersionTransition>();
  private readonly boundEditors = new Set<monaco.editor.ICodeEditor>();
  private readonly metadataListeners =
    new Set<(structural: boolean) => void>();
  private readonly contentListener: monaco.IDisposable;
  private lineTexts: string[];
  private suppressContentListener = false;
  private disposal: Promise<void> | null = null;

  private constructor(input: MonacoOutlineSessionInput) {
    this.pageId = input.pageId;
    this.allocateId = input.allocateId ?? defaultId;
    this.persistenceQueue = new MonacoOutlinePersistenceQueue(
      input.persistence
    );
    const initial = hydrateLines(input.pageId, input.nodes);
    const seeded = initial.lines.length === 0
      ? [emptyLine(this.allocateId(), input.pageId)]
      : initial.lines;
    this.lineTexts = initial.texts.length === 0
      ? [""]
      : [...initial.texts];
    const uri = monaco.Uri.parse(
      `inmemory://yonalist/page/${encodeURIComponent(input.pageId)}`
    );
    if (monaco.editor.getModel(uri)) {
      throw new Error(`A Monaco outline session already exists for ${input.pageId}.`);
    }
    this.model = monaco.editor.createModel(
      this.lineTexts.join("\n"),
      "plaintext",
      uri
    );
    this.model.setEOL(monaco.editor.EndOfLineSequence.LF);
    this.metadata = OutlineMetadataTimeline.hydrate(
      this.model.getAlternativeVersionId(),
      seeded
    );
    this.contentListener = this.model.onDidChangeContent((event) => {
      if (event.isFlush) {
        this.metricState.fullModelReplacementCount += 1;
      }
      if (this.suppressContentListener) return;
      if (event.isUndoing || event.isRedoing) {
        this.applyUndoRedo(event);
      } else {
        this.applyNormalEdit(event);
      }
    });
    if (initial.lines.length === 0) {
      this.persistenceQueue.enqueue([{
        kind: "createNode",
        id: seeded[0]!.nodeId,
        parent_id: input.pageId,
        before_id: null,
        text: ""
      }], "structural");
    }
  }

  static create(input: MonacoOutlineSessionInput): MonacoOutlineSession {
    return new MonacoOutlineSession(input);
  }

  get metrics(): MonacoOutlineSessionMetrics {
    return this.metricState;
  }

  diagnostics(): MonacoOutlineSessionDiagnostics {
    return Object.freeze({
      boundEditors: this.boundEditors.size,
      metadataListeners: this.metadataListeners.size,
      forwardTransitions: this.transitionsFrom.size,
      reverseTransitions: this.transitionsTo.size,
      metadataVersions: this.metadata.versionCount,
      pendingPersistenceCommands:
        this.persistenceQueue.pendingCommandCount,
      persistenceKind: this.persistenceQueue.getSnapshot().kind,
      fullModelReplacementCount:
        this.metricState.fullModelReplacementCount,
      maxDecorationLinesPerEdit:
        this.metricState.maxDecorationLinesPerEdit
    });
  }

  ensureEditableLine(): void {
    if (this.metadata.current().lines.length > 0) return;
    throw new Error("An empty Monaco session must be seeded during hydration.");
  }

  canAcceptStructuralEdit(): boolean {
    const state = this.persistenceQueue.getSnapshot();
    return (
      state.kind !== "conflict" &&
      state.kind !== "fatal" &&
      state.kind !== "closed" &&
      this.metadata.current().lines.length === this.model.getLineCount()
    );
  }

  bindEditor(editor: monaco.editor.ICodeEditor): () => void {
    if (editor.getModel() !== this.model) {
      throw new Error("A bound Monaco editor must use the session model.");
    }
    this.boundEditors.add(editor);
    return () => this.boundEditors.delete(editor);
  }

  subscribeMetadata(
    listener: (structural: boolean) => void
  ): () => void {
    this.metadataListeners.add(listener);
    return () => this.metadataListeners.delete(listener);
  }

  hasFocusedEditor(target: EventTarget | null): boolean {
    return [...this.boundEditors].some((editor) => {
      const node = editor.getDomNode();
      return editor.hasTextFocus() ||
        Boolean(
          typeof Node !== "undefined" &&
          target instanceof Node &&
          node?.contains(target)
        );
    });
  }

  textForNode(nodeId: string): string | null {
    const lineNumber = this.metadata.current().titleLineByNodeId.get(nodeId);
    return lineNumber === undefined
      ? null
      : this.model.getLineContent(lineNumber);
  }

  updateNodeText(nodeId: string, text: string): void {
    const lineNumber = this.metadata.current().titleLineByNodeId.get(nodeId);
    if (lineNumber === undefined) return;
    const current = this.model.getLineContent(lineNumber);
    if (current === text) return;
    this.model.pushEditOperations([], [{
      range: new monaco.Range(
        lineNumber,
        1,
        lineNumber,
        this.model.getLineMaxColumn(lineNumber)
      ),
      text
    }], () => null);
  }

  async undo(): Promise<void> {
    await this.model.undo();
  }

  async redo(): Promise<void> {
    await this.model.redo();
  }

  createFirstChild(parentId: string): string | null {
    if (!this.canAcceptStructuralEdit()) return null;
    const before = this.metadata.current();
    const parentLineNumber = before.titleLineByNodeId.get(parentId);
    if (parentId !== this.pageId && parentLineNumber === undefined) return null;
    const insertionIndex = parentLineNumber ?? 0;
    const parentDepth = parentLineNumber === undefined
      ? -1
      : before.lines[parentLineNumber - 1]!.depth;
    const nextLine = before.lines[insertionIndex];
    const beforeId = nextLine?.parentId === parentId
      ? nextLine.nodeId
      : null;
    const nodeId = this.allocateId();
    this.pruneRedoBranch(before.alternativeVersionId);
    if (insertionIndex === this.model.getLineCount()) {
      const lineNumber = this.model.getLineCount();
      const column = this.model.getLineMaxColumn(lineNumber);
      this.editModelSilently(
        new monaco.Range(lineNumber, column, lineNumber, column),
        "\n"
      );
    } else {
      const lineNumber = insertionIndex + 1;
      this.editModelSilently(
        new monaco.Range(lineNumber, 1, lineNumber, 1),
        "\n"
      );
    }
    const afterLines = [...before.lines];
    afterLines.splice(insertionIndex, 0, emptyLine(
      nodeId,
      parentId,
      parentDepth + 1
    ));
    this.recordModelTransition({
      before,
      afterLines,
      textPatch: {
        startIndex: insertionIndex,
        deleteCount: 0,
        insertedTexts: [""]
      },
      inverseTextPatch: {
        startIndex: insertionIndex,
        deleteCount: 1,
        insertedTexts: []
      },
      forward: [{
        kind: "createNode",
        id: nodeId,
        parent_id: parentId,
        before_id: beforeId,
        text: ""
      }],
      inverse: [{ kind: "removeEmptyNode", id: nodeId }],
      decorationLines: 1
    });
    return nodeId;
  }

  /** Opens an empty note run under a bullet and returns its first line. */
  createNote(nodeId: string): number | null {
    if (!this.canAcceptStructuralEdit()) return null;
    const before = this.metadata.current();
    const existing = before.noteRangeByNodeId.get(nodeId);
    if (existing) return existing[0];
    const titleLine = before.titleLineByNodeId.get(nodeId);
    const title = titleLine === undefined
      ? undefined
      : before.lines[titleLine - 1];
    if (titleLine === undefined || title?.kind !== "text") return null;
    this.pruneRedoBranch(before.alternativeVersionId);
    this.editModelSilently(
      new monaco.Range(
        titleLine,
        this.model.getLineMaxColumn(titleLine),
        titleLine,
        this.model.getLineMaxColumn(titleLine)
      ),
      "\n"
    );
    const afterLines = [...before.lines];
    afterLines.splice(titleLine, 0, { ...title, kind: "note" });
    this.recordModelTransition({
      before,
      afterLines,
      textPatch: { startIndex: titleLine, deleteCount: 0, insertedTexts: [""] },
      inverseTextPatch: {
        startIndex: titleLine,
        deleteCount: 1,
        insertedTexts: []
      },
      forward: [{ kind: "updateNote", id: nodeId, note: "" }],
      inverse: [{ kind: "updateNote", id: nodeId, note: "" }],
      decorationLines: 1
    });
    return titleLine + 1;
  }

  removeNote(nodeId: string): boolean {
    if (!this.canAcceptStructuralEdit()) return false;
    const before = this.metadata.current();
    const range = before.noteRangeByNodeId.get(nodeId);
    if (!range) return false;
    const [start, end] = range;
    const removedTexts = this.lineTexts.slice(start - 1, end);
    this.pruneRedoBranch(before.alternativeVersionId);
    // A note run always trails its title line, so the newline that joins them
    // is what makes the run disappear.
    this.editModelSilently(
      new monaco.Range(
        start - 1,
        this.model.getLineMaxColumn(start - 1),
        end,
        this.model.getLineMaxColumn(end)
      ),
      ""
    );
    const afterLines = [...before.lines];
    afterLines.splice(start - 1, removedTexts.length);
    this.recordModelTransition({
      before,
      afterLines,
      textPatch: {
        startIndex: start - 1,
        deleteCount: removedTexts.length,
        insertedTexts: []
      },
      inverseTextPatch: {
        startIndex: start - 1,
        deleteCount: 0,
        insertedTexts: removedTexts
      },
      forward: [{ kind: "updateNote", id: nodeId, note: "" }],
      inverse: [{
        kind: "updateNote",
        id: nodeId,
        note: removedTexts.join("\n")
      }],
      decorationLines: removedTexts.length
    });
    return true;
  }

  indent(nodeId: string): void {
    const current = this.metadata.current();
    const index = current.titleLineByNodeId.get(nodeId);
    if (index === undefined) return;
    const lineIndex = index - 1;
    const line = current.lines[lineIndex];
    if (!line) return;
    let previousIndex = lineIndex - 1;
    while (
      previousIndex >= 0 &&
      current.lines[previousIndex]!.depth > line.depth
    ) {
      previousIndex -= 1;
    }
    const previous = current.lines[previousIndex];
    if (!previous || previous.depth !== line.depth) return;
    const beforeId = nextSiblingId(current.lines, lineIndex);
    const afterLines = shiftSubtree(current.lines, lineIndex, 1, {
      parentId: previous.nodeId
    });
    this.applyMetadataEdit(
      `Indent ${nodeId}`,
      afterLines,
      [{ kind: "indent", id: nodeId, new_parent_id: previous.nodeId }],
      [{
        kind: "outdent",
        id: nodeId,
        new_parent_id: line.parentId,
        before_id: beforeId
      }]
    );
  }

  toggleCompleted(nodeId: string): void {
    if (!this.canAcceptStructuralEdit()) return;
    const current = this.metadata.current();
    const lineNumber = current.titleLineByNodeId.get(nodeId);
    if (lineNumber === undefined) return;
    const lineIndex = lineNumber - 1;
    const line = current.lines[lineIndex];
    if (!line) return;
    const completed = !line.completed;
    const afterLines = current.lines.map((candidate, index) =>
      index === lineIndex ? { ...candidate, completed } : candidate
    );
    this.applyMetadataEdit(
      `${completed ? "Complete" : "Reopen"} ${nodeId}`,
      afterLines,
      [{ kind: "setCompleted", id: nodeId, completed }],
      [{ kind: "setCompleted", id: nodeId, completed: !completed }]
    );
  }

  toggleCollapsed(nodeId: string): void {
    if (!this.canAcceptStructuralEdit()) return;
    const current = this.metadata.current();
    const lineNumber = current.titleLineByNodeId.get(nodeId);
    if (lineNumber === undefined) return;
    const lineIndex = lineNumber - 1;
    const line = current.lines[lineIndex];
    const next = current.lines[lineIndex + 1];
    if (!line || next?.parentId !== nodeId) return;
    const collapsed = !line.collapsed;
    const afterLines = current.lines.map((candidate, index) =>
      index === lineIndex ? { ...candidate, collapsed } : candidate
    );
    this.applyMetadataEdit(
      `${collapsed ? "Collapse" : "Expand"} ${nodeId}`,
      afterLines,
      [{ kind: "setCollapsed", id: nodeId, collapsed }],
      [{ kind: "setCollapsed", id: nodeId, collapsed: !collapsed }]
    );
  }

  outdent(nodeId: string): void {
    const current = this.metadata.current();
    const lineNumber = current.titleLineByNodeId.get(nodeId);
    if (lineNumber === undefined) return;
    const lineIndex = lineNumber - 1;
    const line = current.lines[lineIndex];
    if (!line || line.depth === 0) return;
    const parent = current.lines.find(
      (candidate) => candidate.nodeId === line.parentId
    );
    if (!parent) return;
    const beforeId = nextSiblingId(
      current.lines,
      current.titleLineByNodeId.get(parent.nodeId)! - 1
    );
    // Following siblings become children of the outdented node (Workflowy
    // semantics); leaving them in place would break the visible preorder.
    let subtreeEnd = lineIndex + 1;
    while (
      subtreeEnd < current.lines.length &&
      current.lines[subtreeEnd]!.depth > line.depth
    ) {
      subtreeEnd += 1;
    }
    const followerIds: string[] = [];
    for (
      let index = subtreeEnd;
      index < current.lines.length && current.lines[index]!.depth >= line.depth;
      index += 1
    ) {
      if (current.lines[index]!.depth === line.depth) {
        followerIds.push(current.lines[index]!.nodeId);
      }
    }
    const followers = new Set(followerIds);
    const expand = line.collapsed && followerIds.length > 0;
    const afterLines = current.lines.map((candidate, index) => {
      if (index === lineIndex) {
        return {
          ...candidate,
          parentId: parent.parentId,
          depth: candidate.depth - 1,
          collapsed: expand ? false : candidate.collapsed
        };
      }
      if (index > lineIndex && index < subtreeEnd) {
        return { ...candidate, depth: candidate.depth - 1 };
      }
      if (followers.has(candidate.nodeId)) {
        return { ...candidate, parentId: nodeId };
      }
      return candidate;
    });
    const forward: IpcEditorCommand[] = [{
      kind: "outdent",
      id: nodeId,
      new_parent_id: parent.parentId,
      before_id: beforeId
    }];
    if (expand) {
      forward.push({ kind: "setCollapsed", id: nodeId, collapsed: false });
    }
    for (const followerId of followerIds) {
      forward.push({
        kind: "moveNode",
        id: followerId,
        parent_id: nodeId,
        before_id: null
      });
    }
    const inverse: IpcEditorCommand[] = [];
    let nextId: string | null = null;
    for (const followerId of [...followerIds].reverse()) {
      inverse.push({
        kind: "moveNode",
        id: followerId,
        parent_id: line.parentId,
        before_id: nextId
      });
      nextId = followerId;
    }
    inverse.push({
      kind: "moveNode",
      id: nodeId,
      parent_id: line.parentId,
      before_id: nextId
    });
    if (expand) {
      inverse.push({ kind: "setCollapsed", id: nodeId, collapsed: true });
    }
    this.applyMetadataEdit(
      `Outdent ${nodeId}`,
      afterLines,
      forward,
      inverse
    );
  }

  flush(reason: "blur" | "navigation" | "close"): Promise<void> {
    return this.persistenceQueue.flush(reason);
  }

  persistenceState(): EditorPersistenceState {
    return this.persistenceQueue.getSnapshot();
  }

  readonly subscribePersistence = (listener: () => void): (() => void) =>
    this.persistenceQueue.subscribe(listener);

  async dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce();
    await this.disposal;
  }

  private editModelSilently(range: monaco.Range, text: string): void {
    this.suppressContentListener = true;
    try {
      this.model.pushEditOperations([], [{ range, text }], () => null);
    } finally {
      this.suppressContentListener = false;
    }
  }

  /** Records a session-authored model edit as one undoable transition. */
  private recordModelTransition(input: {
    readonly before: OutlineMetadataSnapshot;
    readonly afterLines: readonly OutlineLineMetadata[];
    readonly textPatch: OutlineLineTextPatch;
    readonly inverseTextPatch: OutlineLineTextPatch;
    readonly forward: readonly IpcEditorCommand[];
    readonly inverse: readonly IpcEditorCommand[];
    readonly decorationLines: number;
  }): void {
    const after = this.metadata.record(
      this.model.getAlternativeVersionId(),
      input.afterLines
    );
    applyLineTextPatch(this.lineTexts, input.textPatch);
    const recorded: VersionTransition = {
      fromAlternativeVersionId: input.before.alternativeVersionId,
      toAlternativeVersionId: after.alternativeVersionId,
      beforeMetadata: input.before,
      afterMetadata: after,
      textPatch: input.textPatch,
      inverseTextPatch: input.inverseTextPatch,
      forward: input.forward,
      inverse: input.inverse
    };
    this.transitionsFrom.set(recorded.fromAlternativeVersionId, recorded);
    this.transitionsTo.set(recorded.toAlternativeVersionId, recorded);
    this.recordDecorationMetric(input.decorationLines);
    this.emitMetadata(true);
    this.persistenceQueue.enqueue(recorded.forward, "structural");
  }

  private applyNormalEdit(
    event: monaco.editor.IModelContentChangedEvent
  ): void {
    const before = this.metadata.current();
    this.pruneRedoBranch(before.alternativeVersionId);
    const transition = interpretModelChanges({
      before,
      beforeTexts: this.lineTexts,
      event,
      model: this.model,
      allocateId: this.allocateId
    });
    const after = this.metadata.record(
      this.model.getAlternativeVersionId(),
      transition.after.lines
    );
    applyLineTextPatch(this.lineTexts, transition.textPatch);
    const recorded: VersionTransition = {
      fromAlternativeVersionId: before.alternativeVersionId,
      toAlternativeVersionId: after.alternativeVersionId,
      beforeMetadata: before,
      afterMetadata: after,
      textPatch: transition.textPatch,
      inverseTextPatch: transition.inverseTextPatch,
      forward: transition.forward,
      inverse: transition.inverse
    };
    this.transitionsFrom.set(recorded.fromAlternativeVersionId, recorded);
    this.transitionsTo.set(recorded.toAlternativeVersionId, recorded);
    this.recordDecorationMetric(transition.affectedLineNumbers.length);
    this.emitMetadata(transition.structural);
    this.persistenceQueue.enqueue(
      recorded.forward,
      transition.structural ? "structural" : "text"
    );
  }

  private applyUndoRedo(
    event: monaco.editor.IModelContentChangedEvent
  ): void {
    const target = this.model.getAlternativeVersionId();
    const commands: IpcEditorCommand[] = [];
    const affectedLineNumbers = new Set<number>();
    if (event.isUndoing) {
      while (this.metadata.current().alternativeVersionId !== target) {
        const transition = this.transitionsTo.get(
          this.metadata.current().alternativeVersionId
        );
        if (!transition) {
          throw new Error("Monaco Undo escaped the outline transition history.");
        }
        applyLineTextPatch(this.lineTexts, transition.inverseTextPatch);
        addPatchLineNumbers(
          affectedLineNumbers,
          transition.inverseTextPatch
        );
        this.metadata.replaceCurrent(transition.beforeMetadata);
        commands.push(...transition.inverse);
      }
    } else {
      while (this.metadata.current().alternativeVersionId !== target) {
        const transition = this.transitionsFrom.get(
          this.metadata.current().alternativeVersionId
        );
        if (!transition) {
          throw new Error("Monaco Redo escaped the outline transition history.");
        }
        applyLineTextPatch(this.lineTexts, transition.textPatch);
        addPatchLineNumbers(affectedLineNumbers, transition.textPatch);
        this.metadata.replaceCurrent(transition.afterMetadata);
        commands.push(...transition.forward);
      }
    }
    if (commands.length > 0) {
      this.recordDecorationMetric(affectedLineNumbers.size);
      this.emitMetadata(
        commands.some((command) => command.kind !== "updateText")
      );
      this.persistenceQueue.enqueue(
        commands,
        commands.some((command) => command.kind !== "updateText")
          ? "structural"
          : "text"
      );
    }
  }

  private applyMetadataEdit(
    label: string,
    afterLines: readonly OutlineLineMetadata[],
    forward: readonly IpcEditorCommand[],
    inverse: readonly IpcEditorCommand[]
  ): void {
    const editor = [...this.boundEditors].find(
      (candidate) => candidate.hasTextFocus()
    ) ?? this.boundEditors.values().next().value;
    if (!editor) {
      throw new Error("Metadata edits require a bound Monaco editor.");
    }
    const before = this.metadata.current();
    const apply = (
      lines: readonly OutlineLineMetadata[],
      commands: readonly IpcEditorCommand[]
    ) => {
      const affectedLineNumbers = metadataChangedLineNumbers(
        this.metadata.current().lines,
        lines
      );
      this.metadata.rewriteCurrent(lines);
      this.recordDecorationMetric(affectedLineNumbers.length);
      this.emitMetadata(true);
      this.persistenceQueue.enqueue(commands, "structural");
    };
    const element: MetadataUndoElement = {
      resource: this.model.uri,
      label,
      code: "yonalist.outline.metadata",
      undo: () => apply(before.lines, inverse),
      redo: () => apply(afterLines, forward)
    };
    pushMetadataUndo(editor, element);
    apply(afterLines, forward);
  }

  private pruneRedoBranch(alternativeVersionId: number): void {
    let transition = this.transitionsFrom.get(alternativeVersionId);
    while (transition) {
      this.transitionsFrom.delete(transition.fromAlternativeVersionId);
      this.transitionsTo.delete(transition.toAlternativeVersionId);
      this.metadata.deleteVersion(transition.toAlternativeVersionId);
      transition = this.transitionsFrom.get(transition.toAlternativeVersionId);
    }
  }

  private async disposeOnce(): Promise<void> {
    await this.flush("close");
    this.contentListener.dispose();
    this.boundEditors.clear();
    this.metadataListeners.clear();
    this.model.dispose();
  }

  private emitMetadata(structural: boolean): void {
    this.metadataListeners.forEach((listener) => listener(structural));
  }

  private recordDecorationMetric(lineCount: number): void {
    if (lineCount <= this.metrics.maxDecorationLinesPerEdit) return;
    this.metricState.maxDecorationLinesPerEdit = lineCount;
  }
}

function hydrateLines(
  pageId: string,
  nodes: readonly NoteView[]
): {
  readonly lines: readonly OutlineLineMetadata[];
  readonly texts: readonly string[];
} {
  const lines: OutlineLineMetadata[] = [];
  const texts: string[] = [];
  const byId = new Map<string, OutlineLineMetadata>();
  for (const node of nodes) {
    if (node.kind === "page") {
      throw new Error("A Monaco outline session cannot hold a page node.");
    }
    const parentId = node.parentId ?? pageId;
    const depth = parentId === pageId
      ? 0
      : (byId.get(parentId)?.depth ?? (() => {
          throw new Error("Monaco page nodes must be in visible preorder.");
        })()) + 1;
    const line: OutlineLineMetadata = {
      nodeId: node.id,
      parentId,
      depth,
      kind: node.kind === "image" ? "image" : "text",
      collapsed: node.collapsed,
      completed: node.completed
    };
    lines.push(line);
    texts.push(node.text);
    byId.set(line.nodeId, line);
    // An image caption owns no note; a bullet note becomes one line per
    // newline so Monaco can edit it natively (design D1).
    if (line.kind === "image" || node.note.length === 0) continue;
    for (const segment of node.note.split("\n")) {
      lines.push({ ...line, kind: "note" });
      texts.push(segment);
    }
  }
  return { lines, texts };
}

function emptyLine(
  nodeId: string,
  parentId: string,
  depth = 0
): OutlineLineMetadata {
  return {
    nodeId,
    parentId,
    depth,
    kind: "text",
    collapsed: false,
    completed: false
  };
}

function applyLineTextPatch(
  texts: string[],
  patch: OutlineLineTextPatch
): void {
  texts.splice(
    patch.startIndex,
    patch.deleteCount,
    ...patch.insertedTexts
  );
}

function addPatchLineNumbers(
  target: Set<number>,
  patch: OutlineLineTextPatch
): void {
  const count = Math.max(patch.deleteCount, patch.insertedTexts.length);
  for (let index = 0; index < count; index += 1) {
    target.add(patch.startIndex + index + 1);
  }
}

function nextSiblingId(
  lines: readonly OutlineLineMetadata[],
  lineIndex: number
): string | null {
  const line = lines[lineIndex];
  if (!line) return null;
  let index = lineIndex + 1;
  while (index < lines.length && lines[index]!.depth > line.depth) index += 1;
  const next = lines[index];
  return next?.depth === line.depth && next.parentId === line.parentId
    ? next.nodeId
    : null;
}

function shiftSubtree(
  lines: readonly OutlineLineMetadata[],
  lineIndex: number,
  depthDelta: number,
  root: { readonly parentId: string }
): readonly OutlineLineMetadata[] {
  const source = lines[lineIndex];
  if (!source) return lines;
  let end = lineIndex + 1;
  while (end < lines.length && lines[end]!.depth > source.depth) end += 1;
  return lines.map((line, index) => {
    if (index < lineIndex || index >= end) return line;
    return {
      ...line,
      parentId: index === lineIndex ? root.parentId : line.parentId,
      depth: line.depth + depthDelta
    };
  });
}

function metadataChangedLineNumbers(
  current: readonly OutlineLineMetadata[],
  next: readonly OutlineLineMetadata[]
): readonly number[] {
  const count = Math.max(current.length, next.length);
  const changed: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const before = current[index];
    const after = next[index];
    if (
      !before ||
      !after ||
      before.nodeId !== after.nodeId ||
      before.parentId !== after.parentId ||
      before.depth !== after.depth ||
      before.collapsed !== after.collapsed ||
      before.completed !== after.completed
    ) {
      changed.push(index + 1);
    }
  }
  return changed;
}

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `monaco-node-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
