import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { IpcEditorCommand } from "../../../../packages/contracts/generated/IpcEditorCommand";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { OutlineDecorationSet } from "./decorations";
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

export class MonacoOutlineSession {
  readonly pageId: string;
  readonly model: monaco.editor.ITextModel;
  readonly metadata: OutlineMetadataTimeline;
  readonly decorations: OutlineDecorationSet;
  private readonly persistenceQueue: MonacoOutlinePersistenceQueue;
  private readonly allocateId: () => string;
  private readonly transitionsFrom = new Map<number, VersionTransition>();
  private readonly transitionsTo = new Map<number, VersionTransition>();
  private readonly boundEditors = new Set<monaco.editor.ICodeEditor>();
  private readonly metadataListeners = new Set<() => void>();
  private readonly contentListener: monaco.IDisposable;
  private lineTexts: string[];
  private disposal: Promise<void> | null = null;

  private constructor(input: MonacoOutlineSessionInput) {
    this.pageId = input.pageId;
    this.allocateId = input.allocateId ?? defaultId;
    this.persistenceQueue = new MonacoOutlinePersistenceQueue(
      input.persistence
    );
    const initial = hydrateLines(input.pageId, input.nodes);
    const seeded = initial.length === 0
      ? [emptyLine(this.allocateId(), input.pageId)]
      : initial;
    this.lineTexts = input.nodes.length === 0
      ? [""]
      : input.nodes.map((node) => node.text);
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
    this.decorations = new OutlineDecorationSet(
      this.model,
      () => this.metadata.current()
    );
    this.contentListener = this.model.onDidChangeContent((event) => {
      if (event.isUndoing || event.isRedoing) {
        this.applyUndoRedo(event);
      } else {
        this.applyNormalEdit(event);
      }
    });
    if (initial.length === 0) {
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

  subscribeMetadata(listener: () => void): () => void {
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

  indent(nodeId: string): void {
    const current = this.metadata.current();
    const index = current.lineByNodeId.get(nodeId);
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

  outdent(nodeId: string): void {
    const current = this.metadata.current();
    const lineNumber = current.lineByNodeId.get(nodeId);
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
      current.lineByNodeId.get(parent.nodeId)! - 1
    );
    const afterLines = shiftSubtree(current.lines, lineIndex, -1, {
      parentId: parent.parentId
    });
    this.applyMetadataEdit(
      `Outdent ${nodeId}`,
      afterLines,
      [{
        kind: "outdent",
        id: nodeId,
        new_parent_id: parent.parentId,
        before_id: beforeId
      }],
      [{ kind: "indent", id: nodeId, new_parent_id: parent.nodeId }]
    );
  }

  flush(reason: "blur" | "navigation" | "close"): Promise<void> {
    return this.persistenceQueue.flush(reason);
  }

  persistenceState(): EditorPersistenceState {
    return this.persistenceQueue.getSnapshot();
  }

  async dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce();
    await this.disposal;
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
    this.decorations.update(transition.affectedLineNumbers);
    this.emitMetadata();
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
      this.decorations.update([...affectedLineNumbers]);
      this.emitMetadata();
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
      this.metadata.rewriteCurrent(lines);
      this.decorations.update(
        this.metadata.current().lines.map((_, index) => index + 1)
      );
      this.emitMetadata();
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
      transition = this.transitionsFrom.get(transition.toAlternativeVersionId);
    }
  }

  private async disposeOnce(): Promise<void> {
    await this.flush("close");
    this.contentListener.dispose();
    this.boundEditors.clear();
    this.metadataListeners.clear();
    this.decorations.dispose();
    this.model.dispose();
  }

  private emitMetadata(): void {
    this.metadataListeners.forEach((listener) => listener());
  }
}

function hydrateLines(
  pageId: string,
  nodes: readonly NoteView[]
): readonly OutlineLineMetadata[] {
  const lines: OutlineLineMetadata[] = [];
  const byId = new Map<string, OutlineLineMetadata>();
  for (const node of nodes) {
    if (node.kind !== "bullet" || node.image !== null || node.note.length > 0) {
      throw new Error("A Monaco outline session requires text-only bullets.");
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
      kind: "text",
      collapsed: node.collapsed,
      completed: node.completed
    };
    lines.push(line);
    byId.set(line.nodeId, line);
  }
  return lines;
}

function emptyLine(nodeId: string, pageId: string): OutlineLineMetadata {
  return {
    nodeId,
    parentId: pageId,
    depth: 0,
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

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `monaco-node-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
