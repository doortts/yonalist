import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { PageSummary } from "../../../../packages/contracts/generated/PageSummary";
import type { NotesState } from "../notesState";

type Listener = () => void;

export interface NotesShellSnapshot {
  readonly status: NotesState["status"];
  readonly sessionId: string | null;
  readonly revision: number;
  readonly pages: readonly PageSummary[];
  readonly activePageId: string | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoDepth: number;
  readonly redoDepth: number;
  readonly beforeCursor: string | null;
  readonly afterCursor: string | null;
  readonly error: string | null;
  readonly pendingWrites: number;
}

export interface NotesOutlineSnapshot {
  readonly revision: number;
  readonly nodes: readonly NoteView[];
  readonly beforeCursor: string | null;
  readonly afterCursor: string | null;
}

export interface NotesNodeSnapshot {
  readonly node: NoteView | null;
  readonly title: string;
  readonly note: string;
  readonly titleDraft: string | undefined;
  readonly noteDraft: string | undefined;
}

export interface StoreInvalidation {
  readonly shell?: boolean;
  readonly outline?: boolean;
  readonly nodeIds?: readonly string[];
}

function changedRecordKeys<T>(
  previous: Readonly<Record<string, T>>,
  next: Readonly<Record<string, T>>
): readonly string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((id) => previous[id] !== next[id]);
}

function changedNodeIds(
  previous: NotesState["nodes"],
  next: NotesState["nodes"]
): readonly string[] {
  const previousById = new Map(previous.map((node) => [node.id, node]));
  const nextById = new Map(next.map((node) => [node.id, node]));
  return [...new Set([...previousById.keys(), ...nextById.keys()])]
    .filter((id) => previousById.get(id) !== nextById.get(id));
}

export function invalidationForPatch(
  previous: NotesState,
  patch: Partial<NotesState>
): StoreInvalidation {
  const shell = [
    "status", "sessionId", "revision", "pages", "activePageId",
    "canUndo", "canRedo", "undoDepth", "redoDepth",
    "beforeCursor", "afterCursor", "error", "pendingWrites"
  ].some((key) => key in patch);
  const outline = [
    "nodes", "activePageId", "beforeCursor", "afterCursor"
  ].some((key) => key in patch);
  const ids = new Set<string>();
  if (patch.nodes) {
    changedNodeIds(previous.nodes, patch.nodes).forEach((id) => ids.add(id));
  }
  if ("pageNode" in patch && patch.pageNode !== previous.pageNode) {
    [previous.pageNode?.id, patch.pageNode?.id]
      .forEach((id) => id !== undefined && ids.add(id));
  }
  if (patch.drafts) {
    changedRecordKeys(previous.drafts, patch.drafts)
      .forEach((id) => ids.add(id));
  }
  if (patch.noteDrafts) {
    changedRecordKeys(previous.noteDrafts, patch.noteDrafts)
      .forEach((id) => ids.add(id));
  }
  return { shell, outline, nodeIds: [...ids] };
}

function shellSnapshot(state: NotesState): NotesShellSnapshot {
  return {
    status: state.status,
    sessionId: state.sessionId,
    revision: state.revision,
    pages: state.pages,
    activePageId: state.activePageId,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    undoDepth: state.undoDepth,
    redoDepth: state.redoDepth,
    beforeCursor: state.beforeCursor,
    afterCursor: state.afterCursor,
    error: state.error,
    pendingWrites: state.pendingWrites
  };
}

function outlineSnapshot(state: NotesState): NotesOutlineSnapshot {
  return {
    revision: state.revision,
    nodes: state.nodes,
    beforeCursor: state.beforeCursor,
    afterCursor: state.afterCursor
  };
}

function nodeSnapshot(state: NotesState, id: string): NotesNodeSnapshot {
  const node = state.nodes.find((candidate) => candidate.id === id) ??
    (state.pageNode?.id === id ? state.pageNode : null);
  const titleDraft = state.drafts[id];
  const noteDraft = state.noteDrafts[id];
  return {
    node,
    title:
      titleDraft ??
      node?.text ??
      state.pages.find((page) => page.id === id)?.title ??
      "",
    note: noteDraft ?? node?.note ?? "",
    titleDraft,
    noteDraft
  };
}

function addListener(listeners: Set<Listener>, listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export class StoreSubscriptions {
  private readonly shellListeners = new Set<Listener>();
  private readonly outlineListeners = new Set<Listener>();
  private readonly nodeListeners = new Map<string, Set<Listener>>();
  private readonly nodeSnapshots = new Map<string, NotesNodeSnapshot>();
  private readonly nodeEpochs = new Map<string, number>();
  private currentShellSnapshot: NotesShellSnapshot;
  private currentOutlineSnapshot: NotesOutlineSnapshot;

  constructor(private readonly readState: () => NotesState) {
    const state = readState();
    this.currentShellSnapshot = shellSnapshot(state);
    this.currentOutlineSnapshot = outlineSnapshot(state);
  }

  readonly subscribeShell = (listener: Listener): (() => void) =>
    addListener(this.shellListeners, listener);

  readonly getShellSnapshot = (): NotesShellSnapshot =>
    this.currentShellSnapshot;

  readonly subscribeOutline = (listener: Listener): (() => void) =>
    addListener(this.outlineListeners, listener);

  readonly getOutlineSnapshot = (): NotesOutlineSnapshot =>
    this.currentOutlineSnapshot;

  readonly subscribeNode = (id: string, listener: Listener): (() => void) => {
    const listeners = this.nodeListeners.get(id) ?? new Set<Listener>();
    this.nodeListeners.set(id, listeners);
    const unsubscribe = addListener(listeners, listener);
    return () => {
      unsubscribe();
      if (listeners.size === 0) {
        this.nodeListeners.delete(id);
      }
    };
  };

  readonly getNodeSnapshot = (id: string): NotesNodeSnapshot => {
    const cached = this.nodeSnapshots.get(id);
    if (cached) {
      return cached;
    }
    const snapshot = nodeSnapshot(this.readState(), id);
    this.nodeSnapshots.set(id, snapshot);
    return snapshot;
  };

  readonly subscribeNodes = (
    ids: readonly string[],
    listener: Listener
  ): (() => void) => {
    const unsubscribes = [...new Set(ids)].map((id) =>
      this.subscribeNode(id, listener)
    );
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  };

  readonly getNodeEpoch = (ids: readonly string[]): string =>
    [...new Set(ids)]
      .map((id) => `${id}:${this.nodeEpochs.get(id) ?? 0}`)
      .join("|");

  publish(invalidation: StoreInvalidation): void {
    const state = this.readState();
    if (invalidation.shell) {
      this.currentShellSnapshot = shellSnapshot(state);
      this.shellListeners.forEach((listener) => listener());
    }
    if (invalidation.outline) {
      this.currentOutlineSnapshot = outlineSnapshot(state);
      this.outlineListeners.forEach((listener) => listener());
    }
    for (const id of new Set(invalidation.nodeIds)) {
      this.nodeSnapshots.set(id, nodeSnapshot(state, id));
      this.nodeEpochs.set(id, (this.nodeEpochs.get(id) ?? 0) + 1);
      this.nodeListeners.get(id)?.forEach((listener) => listener());
    }
  }
}
