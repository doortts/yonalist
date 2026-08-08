import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { ImageView } from "../../../../packages/contracts/generated/ImageView";
import type { IpcEditorCommand } from "../../../../packages/contracts/generated/IpcEditorCommand";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import {
  pushMetadataUndo,
  type MetadataUndoElement
} from "./internalAdapter";
import {
  outlineBlockEnd,
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

/**
 * The half of a transition the editor batch cannot express. Image creation
 * inverts to a subtree delete, which is a notes command, so the step hands
 * that direction back to the store (design §5, last row of the failure table).
 */
export interface MonacoExternalHistoryStep {
  undo(): void | Promise<void>;
  redo(): void | Promise<void>;
}

export interface ImageInsertionAnchor {
  readonly parentId: string;
  readonly beforeId: string | null;
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
  readonly external?: MonacoExternalHistoryStep;
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
  /**
   * What an image line needs beyond its caption. Line metadata stays lean so
   * the preorder invariants keep holding; this map carries the pixels.
   */
  readonly imageByNodeId: ReadonlyMap<string, ImageView>;
  private readonly images = new Map<string, ImageView>();
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
    this.imageByNodeId = this.images;
    for (const [nodeId, image] of initial.images) this.images.set(nodeId, image);
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

  /**
   * Records a committed resize. The width lives beside the model, not in it,
   * so the view re-reads it through the one metadata sync point and no editor
   * command is owed — `resizeImage` is a notes command with its own history.
   */
  setImageDisplayWidth(nodeId: string, displayWidth: number): boolean {
    const image = this.images.get(nodeId);
    if (!image) return false;
    return this.setImage(nodeId, { ...image, displayWidth });
  }

  /**
   * The pixels a receipt brought back for a node the model already draws — a
   * replaced picture keeps its node and its caption and changes only its bytes.
   */
  setImage(nodeId: string, image: ImageView): boolean {
    const current = this.images.get(nodeId);
    if (
      !current ||
      (current.contentHash === image.contentHash &&
        current.displayWidth === image.displayWidth)
    ) {
      return false;
    }
    this.images.set(nodeId, image);
    this.emitMetadata(true);
    return true;
  }

  /**
   * The node a line belongs to. A note line copies its title's id (design §1),
   * so a gesture that lands on one acts on the node it hangs off.
   */
  nodeIdAtLine(lineNumber: number): string | null {
    return this.metadata.current().lines[lineNumber - 1]?.nodeId ?? null;
  }

  /** Where an image dropped on `nodeId` goes: after everything that node owns. */
  imageInsertionAnchor(nodeId: string | null): ImageInsertionAnchor | null {
    const current = this.metadata.current();
    if (nodeId === null) {
      return {
        parentId: this.pageId,
        beforeId: current.lines[0]?.nodeId ?? null
      };
    }
    const lineNumber = current.titleLineByNodeId.get(nodeId);
    const line = lineNumber === undefined
      ? undefined
      : current.lines[lineNumber - 1];
    if (lineNumber === undefined || !line) return null;
    return {
      parentId: line.parentId,
      beforeId: nextSiblingId(current.lines, lineNumber - 1)
    };
  }

  /**
   * Draws the image nodes an import receipt created. The backend already owns
   * them, so the transition carries no editor command; its inverse is the
   * external step, which is where the subtree delete lives.
   */
  insertImageNodes(input: {
    readonly anchor: ImageInsertionAnchor;
    readonly nodes: readonly NoteView[];
    readonly external?: MonacoExternalHistoryStep;
  }): number | null {
    if (input.nodes.length === 0 || !this.canAcceptStructuralEdit()) return null;
    const before = this.metadata.current();
    const placement = imagePlacement(before, input.anchor, this.pageId);
    if (!placement) return null;
    const texts = input.nodes.map((node) => node.text);
    this.pruneRedoBranch(before.alternativeVersionId);
    this.insertModelLines(placement.insertionIndex, texts);
    for (const node of input.nodes) {
      if (node.image) this.images.set(node.id, node.image);
    }
    const afterLines = [...before.lines];
    afterLines.splice(placement.insertionIndex, 0, ...input.nodes.map((node) => ({
      nodeId: node.id,
      parentId: input.anchor.parentId,
      depth: placement.depth,
      kind: "image" as const,
      // An image row is never a to-do: it carries a picture, not a task.
      marker: "bullet" as const,
      collapsed: false,
      completed: false
    })));
    this.recordModelTransition({
      before,
      afterLines,
      textPatch: {
        startIndex: placement.insertionIndex,
        deleteCount: 0,
        insertedTexts: texts
      },
      inverseTextPatch: {
        startIndex: placement.insertionIndex,
        deleteCount: texts.length,
        insertedTexts: []
      },
      forward: [],
      inverse: [],
      decorationLines: texts.length,
      external: input.external
    });
    return placement.insertionIndex + 1;
  }

  /**
   * Drops the rows of image nodes the backend no longer has. The caller owns
   * the delete itself, so again no editor command is owed.
   */
  removeImageNodes(nodeIds: readonly string[]): boolean {
    if (!this.canAcceptStructuralEdit()) return false;
    const targets = new Set(nodeIds);
    const lines = this.metadata.current().lines;
    const indices = lines.flatMap((line, index) =>
      line.kind === "image" && targets.has(line.nodeId) ? [index] : []
    );
    // An outline always keeps one editable line, so a page made only of these
    // images is a rehydration, not a line removal.
    if (indices.length === 0 || indices.length === lines.length) return false;
    // Descending runs so each splice leaves the earlier indices valid.
    for (const [start, count] of descendingRuns(indices)) {
      const before = this.metadata.current();
      const removedTexts = this.lineTexts.slice(start, start + count);
      this.pruneRedoBranch(before.alternativeVersionId);
      this.removeModelLines(start, count);
      const afterLines = [...before.lines];
      const removed = afterLines.splice(start, count);
      for (const line of removed) this.images.delete(line.nodeId);
      this.recordModelTransition({
        before,
        afterLines,
        textPatch: { startIndex: start, deleteCount: count, insertedTexts: [] },
        inverseTextPatch: {
          startIndex: start,
          deleteCount: 0,
          insertedTexts: removedTexts
        },
        forward: [],
        inverse: [],
        decorationLines: count
      });
    }
    return true;
  }

  /** An out-of-band image write failed; the queue is where the user sees it. */
  reportExternalFailure(cause: unknown): void {
    this.persistenceQueue.failExternally(cause);
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
    // A note run belongs to its title, so the first child goes below the run.
    const insertionIndex = parentLineNumber === undefined
      ? 0
      : before.noteRangeByNodeId.get(parentId)?.[1] ?? parentLineNumber;
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
      this.editModelSilently([{
        range: new monaco.Range(lineNumber, column, lineNumber, column),
        text: "\n"
      }]);
    } else {
      const lineNumber = insertionIndex + 1;
      this.editModelSilently([{
        range: new monaco.Range(lineNumber, 1, lineNumber, 1),
        text: "\n"
      }]);
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
    this.editModelSilently([{
      range: new monaco.Range(
        titleLine,
        this.model.getLineMaxColumn(titleLine),
        titleLine,
        this.model.getLineMaxColumn(titleLine)
      ),
      text: "\n"
    }]);
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

  /**
   * Enter on a title that owns a note run. Monaco's native split would drop
   * the new line between the title and its run, so the session performs the
   * edit itself: at column one the new empty bullet goes above the title,
   * otherwise the suffix moves to a bullet placed below the whole run — a
   * first child when the title has children, a sibling when it does not.
   * Returns the line the caret belongs on.
   */
  splitTitleWithNote(nodeId: string, column: number): number | null {
    if (!this.canAcceptStructuralEdit()) return null;
    const before = this.metadata.current();
    const titleLine = before.titleLineByNodeId.get(nodeId);
    const range = before.noteRangeByNodeId.get(nodeId);
    const title = titleLine === undefined
      ? undefined
      : before.lines[titleLine - 1];
    if (titleLine === undefined || !range || title?.kind !== "text") return null;
    const text = this.lineTexts[titleLine - 1] ?? "";
    const newId = this.allocateId();
    this.pruneRedoBranch(before.alternativeVersionId);
    if (column === 1 && text.length > 0) {
      return this.insertBulletAbove(before, title, titleLine, newId);
    }

    const prefix = text.slice(0, column - 1);
    const suffix = text.slice(column - 1);
    const runEnd = range[1];
    const following = before.lines[runEnd];
    const hasChildren = following?.parentId === nodeId;
    const expand = hasChildren && title.collapsed;
    const runTexts = this.lineTexts.slice(titleLine, runEnd);
    this.editModelSilently([
      {
        range: new monaco.Range(
          titleLine,
          column,
          titleLine,
          this.model.getLineMaxColumn(titleLine)
        ),
        text: ""
      },
      {
        range: new monaco.Range(
          runEnd,
          this.model.getLineMaxColumn(runEnd),
          runEnd,
          this.model.getLineMaxColumn(runEnd)
        ),
        text: `\n${suffix}`
      }
    ]);
    const afterLines = [...before.lines];
    if (expand) {
      for (let index = titleLine - 1; index < runEnd; index += 1) {
        afterLines[index] = { ...afterLines[index]!, collapsed: false };
      }
    }
    afterLines.splice(runEnd, 0, {
      nodeId: newId,
      parentId: hasChildren ? nodeId : title.parentId,
      depth: hasChildren ? title.depth + 1 : title.depth,
      kind: "text",
      marker: "bullet",
      collapsed: false,
      completed: false
    });
    const forward: IpcEditorCommand[] = [];
    if (prefix !== text) {
      forward.push({ kind: "updateText", id: nodeId, text: prefix });
    }
    if (expand) {
      forward.push({ kind: "setCollapsed", id: nodeId, collapsed: false });
    }
    forward.push({
      kind: "createNode",
      id: newId,
      parent_id: hasChildren ? nodeId : title.parentId,
      before_id: hasChildren
        ? following!.nodeId
        : nextSiblingId(before.lines, titleLine - 1),
      text: suffix
    });
    const inverse: IpcEditorCommand[] = [];
    if (suffix !== "") {
      inverse.push({ kind: "updateText", id: newId, text: "" });
    }
    inverse.push({ kind: "removeEmptyNode", id: newId });
    if (expand) {
      inverse.push({ kind: "setCollapsed", id: nodeId, collapsed: true });
    }
    if (prefix !== text) {
      inverse.push({ kind: "updateText", id: nodeId, text });
    }
    this.recordModelTransition({
      before,
      afterLines,
      textPatch: {
        startIndex: titleLine - 1,
        deleteCount: runTexts.length + 1,
        insertedTexts: [prefix, ...runTexts, suffix]
      },
      inverseTextPatch: {
        startIndex: titleLine - 1,
        deleteCount: runTexts.length + 2,
        insertedTexts: [text, ...runTexts]
      },
      forward,
      inverse,
      decorationLines: runTexts.length + 2
    });
    return runEnd + 1;
  }

  /**
   * Enter on an image caption. A caption is never split — the whole gesture is
   * a fresh empty sibling under the same parent, placed after everything the
   * node owns. Returns the line the caret belongs on.
   */
  createSiblingBelow(nodeId: string): number | null {
    if (!this.canAcceptStructuralEdit()) return null;
    const before = this.metadata.current();
    const lineNumber = before.titleLineByNodeId.get(nodeId);
    if (lineNumber === undefined) return null;
    const line = before.lines[lineNumber - 1];
    if (!line) return null;
    const insertionIndex = outlineBlockEnd(before.lines, lineNumber - 1);
    const newId = this.allocateId();
    this.pruneRedoBranch(before.alternativeVersionId);
    const column = this.model.getLineMaxColumn(insertionIndex);
    this.editModelSilently([{
      range: new monaco.Range(insertionIndex, column, insertionIndex, column),
      text: "\n"
    }]);
    const afterLines = [...before.lines];
    afterLines.splice(
      insertionIndex,
      0,
      emptyLine(newId, line.parentId, line.depth)
    );
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
        id: newId,
        parent_id: line.parentId,
        before_id: nextSiblingId(before.lines, lineNumber - 1),
        text: ""
      }],
      inverse: [{ kind: "removeEmptyNode", id: newId }],
      decorationLines: 1
    });
    return insertionIndex + 1;
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
    this.editModelSilently([{
      range: new monaco.Range(
        start - 1,
        this.model.getLineMaxColumn(start - 1),
        end,
        this.model.getLineMaxColumn(end)
      ),
      text: ""
    }]);
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
      (current.lines[previousIndex]!.depth > line.depth ||
        current.lines[previousIndex]!.kind === "note")
    ) {
      previousIndex -= 1;
    }
    const previous = current.lines[previousIndex];
    if (!previous || previous.depth !== line.depth) return;
    if (previous.kind === "image") return;
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
      ownsLine(line, candidate, index === lineIndex)
        ? { ...candidate, completed }
        : candidate
    );
    this.applyMetadataEdit(
      `${completed ? "Complete" : "Reopen"} ${nodeId}`,
      afterLines,
      [{ kind: "setCompleted", id: nodeId, completed }],
      [{ kind: "setCompleted", id: nodeId, completed: !completed }]
    );
  }

  setMarker(nodeId: string, marker: "bullet" | "todo"): void {
    if (!this.canAcceptStructuralEdit()) return;
    const current = this.metadata.current();
    const lineNumber = current.titleLineByNodeId.get(nodeId);
    if (lineNumber === undefined) return;
    const lineIndex = lineNumber - 1;
    const line = current.lines[lineIndex];
    if (line?.kind !== "text" || line.marker === marker) return;
    const afterLines = current.lines.map((candidate, index) =>
      ownsLine(line, candidate, index === lineIndex)
        ? { ...candidate, marker }
        : candidate
    );
    this.applyMetadataEdit(
      `${marker === "todo" ? "To-do" : "Bullet"} ${nodeId}`,
      afterLines,
      [{ kind: "setMarker", id: nodeId, marker }],
      [{ kind: "setMarker", id: nodeId, marker: line.marker }]
    );
  }

  toggleCollapsed(nodeId: string): void {
    if (!this.canAcceptStructuralEdit()) return;
    const current = this.metadata.current();
    const lineNumber = current.titleLineByNodeId.get(nodeId);
    if (lineNumber === undefined) return;
    const lineIndex = lineNumber - 1;
    const line = current.lines[lineIndex];
    if (!line) return;
    // Children sit below the note run, so a run alone never makes a parent.
    const next = current.lines[
      current.noteRangeByNodeId.get(nodeId)?.[1] ?? lineIndex + 1
    ];
    if (next?.parentId !== nodeId) return;
    const collapsed = !line.collapsed;
    const afterLines = current.lines.map((candidate, index) =>
      ownsLine(line, candidate, index === lineIndex)
        ? { ...candidate, collapsed }
        : candidate
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
    const subtreeEnd = outlineBlockEnd(current.lines, lineIndex);
    const followerIds: string[] = [];
    for (
      let index = subtreeEnd;
      index < current.lines.length && current.lines[index]!.depth >= line.depth;
      index += 1
    ) {
      const candidate = current.lines[index]!;
      // A follower's note run repeats its node ID; the move is per node.
      if (candidate.depth === line.depth && candidate.kind !== "note") {
        followerIds.push(candidate.nodeId);
      }
    }
    const followers = new Set(followerIds);
    const expand = line.collapsed && followerIds.length > 0;
    const afterLines = current.lines.map((candidate, index) => {
      if (ownsLine(line, candidate, index === lineIndex)) {
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

  private insertBulletAbove(
    before: OutlineMetadataSnapshot,
    title: OutlineLineMetadata,
    titleLine: number,
    newId: string
  ): number {
    this.editModelSilently([{
      range: new monaco.Range(titleLine, 1, titleLine, 1),
      text: "\n"
    }]);
    const afterLines = [...before.lines];
    afterLines.splice(
      titleLine - 1,
      0,
      emptyLine(newId, title.parentId, title.depth)
    );
    this.recordModelTransition({
      before,
      afterLines,
      textPatch: {
        startIndex: titleLine - 1,
        deleteCount: 0,
        insertedTexts: [""]
      },
      inverseTextPatch: {
        startIndex: titleLine - 1,
        deleteCount: 1,
        insertedTexts: []
      },
      forward: [{
        kind: "createNode",
        id: newId,
        parent_id: title.parentId,
        before_id: title.nodeId,
        text: ""
      }],
      inverse: [{ kind: "removeEmptyNode", id: newId }],
      decorationLines: 1
    });
    return titleLine + 1;
  }

  private insertModelLines(
    insertionIndex: number,
    texts: readonly string[]
  ): void {
    if (insertionIndex === this.model.getLineCount()) {
      const lineNumber = this.model.getLineCount();
      const column = this.model.getLineMaxColumn(lineNumber);
      this.editModelSilently([{
        range: new monaco.Range(lineNumber, column, lineNumber, column),
        text: `\n${texts.join("\n")}`
      }]);
      return;
    }
    const lineNumber = insertionIndex + 1;
    this.editModelSilently([{
      range: new monaco.Range(lineNumber, 1, lineNumber, 1),
      text: `${texts.join("\n")}\n`
    }]);
  }

  private removeModelLines(startIndex: number, count: number): void {
    const first = startIndex + 1;
    const last = startIndex + count;
    // The newline that joins the run to its neighbour is what removes it, and
    // only the last line of the model has no following newline to take.
    const range = last < this.model.getLineCount()
      ? new monaco.Range(first, 1, last + 1, 1)
      : new monaco.Range(
          first - 1,
          this.model.getLineMaxColumn(first - 1),
          last,
          this.model.getLineMaxColumn(last)
        );
    this.editModelSilently([{ range, text: "" }]);
  }

  private editModelSilently(
    edits: readonly monaco.editor.IIdentifiedSingleEditOperation[]
  ): void {
    this.suppressContentListener = true;
    try {
      this.model.pushEditOperations([], [...edits], () => null);
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
    readonly external?: MonacoExternalHistoryStep;
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
      inverse: input.inverse,
      external: input.external
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
    const external: MonacoExternalHistoryStep[] = [];
    const affectedLineNumbers = new Set<number>();
    let traversed = 0;
    while (this.metadata.current().alternativeVersionId !== target) {
      const transition = event.isUndoing
        ? this.transitionsTo.get(this.metadata.current().alternativeVersionId)
        : this.transitionsFrom.get(this.metadata.current().alternativeVersionId);
      if (!transition) {
        throw new Error(
          `Monaco ${event.isUndoing ? "Undo" : "Redo"} escaped the outline transition history.`
        );
      }
      const patch = event.isUndoing
        ? transition.inverseTextPatch
        : transition.textPatch;
      applyLineTextPatch(this.lineTexts, patch);
      addPatchLineNumbers(affectedLineNumbers, patch);
      this.metadata.replaceCurrent(
        event.isUndoing ? transition.beforeMetadata : transition.afterMetadata
      );
      commands.push(
        ...(event.isUndoing ? transition.inverse : transition.forward)
      );
      if (transition.external) external.push(transition.external);
      traversed += 1;
    }
    if (traversed === 0) return;
    const structural = external.length > 0 ||
      commands.some((command) => command.kind !== "updateText");
    this.recordDecorationMetric(affectedLineNumbers.size);
    this.emitMetadata(structural);
    this.persistenceQueue.enqueue(commands, structural ? "structural" : "text");
    for (const step of external) {
      void Promise.resolve(event.isUndoing ? step.undo() : step.redo())
        .catch(() => undefined);
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
  readonly images: ReadonlyMap<string, ImageView>;
} {
  const lines: OutlineLineMetadata[] = [];
  const texts: string[] = [];
  const images = new Map<string, ImageView>();
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
      marker: node.marker,
      collapsed: node.collapsed,
      completed: node.completed
    };
    lines.push(line);
    texts.push(node.text);
    byId.set(line.nodeId, line);
    // An image caption owns no note; a bullet note becomes one line per
    // newline so Monaco can edit it natively (design D1).
    if (line.kind === "image") {
      if (node.image) images.set(line.nodeId, node.image);
      continue;
    }
    if (node.note.length === 0) continue;
    for (const segment of node.note.split("\n")) {
      lines.push({ ...line, kind: "note" });
      texts.push(segment);
    }
  }
  return { lines, texts, images };
}

/** The line index an anchor points at, plus the depth its rows take. */
function imagePlacement(
  before: OutlineMetadataSnapshot,
  anchor: ImageInsertionAnchor,
  pageId: string
): { readonly insertionIndex: number; readonly depth: number } | null {
  const parentLine = anchor.parentId === pageId
    ? undefined
    : before.titleLineByNodeId.get(anchor.parentId);
  if (anchor.parentId !== pageId && parentLine === undefined) return null;
  const depth = parentLine === undefined
    ? 0
    : before.lines[parentLine - 1]!.depth + 1;
  const beforeLine = anchor.beforeId === null
    ? undefined
    : before.titleLineByNodeId.get(anchor.beforeId);
  if (beforeLine !== undefined) return { insertionIndex: beforeLine - 1, depth };
  // A sibling a racing write already removed leaves the anchor pointing at
  // nothing, so the rows land where a null `beforeId` puts them: the end of
  // the parent's block, or the end of the page.
  return {
    insertionIndex: parentLine === undefined
      ? before.lines.length
      : outlineBlockEnd(before.lines, parentLine - 1),
    depth
  };
}

/** Ascending indices as `[start, count]` runs, latest run first. */
function descendingRuns(
  indices: readonly number[]
): readonly (readonly [number, number])[] {
  const runs: [number, number][] = [];
  for (const index of indices) {
    const last = runs.at(-1);
    if (last && last[0] + last[1] === index) last[1] += 1;
    else runs.push([index, 1]);
  }
  return runs.reverse();
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
    marker: "bullet",
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
  const next = lines[outlineBlockEnd(lines, lineIndex)];
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
  const end = outlineBlockEnd(lines, lineIndex);
  return lines.map((line, index) => {
    if (index < lineIndex || index >= end) return line;
    return {
      ...line,
      // The moved node's own note run copies its title (V3), so it takes the
      // new parent with it.
      parentId: ownsLine(source, line, index === lineIndex)
        ? root.parentId
        : line.parentId,
      depth: line.depth + depthDelta
    };
  });
}

/** True for a moved title line and for the note lines welded to it. */
function ownsLine(
  source: OutlineLineMetadata,
  line: OutlineLineMetadata,
  isSource: boolean
): boolean {
  return isSource || (line.kind === "note" && line.nodeId === source.nodeId);
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
      before.marker !== after.marker ||
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
