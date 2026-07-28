import type { IpcNotesCommand } from "../../../packages/contracts/generated/IpcNotesCommand";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { SearchPage } from "../../../packages/contracts/generated/SearchPage";
import type { ForestSnapshot } from "../../../packages/contracts/generated/ForestSnapshot";
import type { NotesApi } from "./api";
import { initialNotesState, type NotesState } from "./notesState";
import {
  cancelTimer, confirmedNote, confirmedText, DRAFT_DEBOUNCE_MS, freshId,
  messageFrom
} from "./storeSupport";
import { flattenPastedOutline, type PastedOutlineNode } from "./outlinePaste";
import { omitKeys, receiptState, subtreeIds, viewportState } from "./storeState";
import { runSlashEdit } from "./storeSlash";
import {
  StoreHistoryEvents, type NotesMutationHistoryEvent
} from "./storeHistory";
import { StoreViewport } from "./storeViewport";
import {
  projectCreateNode,
  projectMergeNodeBackward,
  projectRemoveEmptyNode,
  projectSplitNode
} from "./optimisticOutline";
import { orderOutline } from "./outlineModel";
import {
  StoreSubscriptions,
  type StoreInvalidation
} from "./storeSubscriptions";

export interface PendingOutlineMutation {
  readonly committed: Promise<void>;
}

export interface PendingCreatedNode extends PendingOutlineMutation {
  readonly id: string;
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

function invalidationForPatch(
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

export class NotesStore {
  private state: NotesState = initialNotesState;
  private readonly listeners = new Set<() => void>();
  private readonly subscriptions: StoreSubscriptions;
  private readonly draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly noteDraftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly draftHistoryGroups = new Map<string, string>();
  private readonly historyEvents = new StoreHistoryEvents();
  private readonly viewport: StoreViewport;
  private commandQueue: Promise<void> = Promise.resolve();
  private activeBackspaceGroup: string | null = null;
  private backspaceSequence = 0;
  constructor(private readonly api: NotesApi) {
    this.subscriptions = new StoreSubscriptions(() => this.state);
    this.viewport = new StoreViewport(
      api,
      this.getSnapshot,
      (patch) => this.update(patch),
      (viewport, append) =>
        this.update(viewportState(this.state, viewport, append))
    );
  }
  readonly getSnapshot = (): NotesState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly subscribeShell = (listener: () => void): (() => void) =>
    this.subscriptions.subscribeShell(listener);
  readonly getShellSnapshot = () => this.subscriptions.getShellSnapshot();
  readonly subscribeOutline = (listener: () => void): (() => void) =>
    this.subscriptions.subscribeOutline(listener);
  readonly getOutlineSnapshot = () => this.subscriptions.getOutlineSnapshot();
  readonly subscribeNode = (
    id: string,
    listener: () => void
  ): (() => void) => this.subscriptions.subscribeNode(id, listener);
  readonly getNodeSnapshot = (id: string) =>
    this.subscriptions.getNodeSnapshot(id);
  readonly subscribeNodes = (
    ids: readonly string[],
    listener: () => void
  ): (() => void) => this.subscriptions.subscribeNodes(ids, listener);
  readonly getNodeEpoch = (ids: readonly string[]) =>
    this.subscriptions.getNodeEpoch(ids);
  readonly subscribeHistory = (
    listener: (event: NotesMutationHistoryEvent) => void
  ): (() => void) => this.historyEvents.subscribe(listener);
  breakHistoryGroup(): void {
    this.historyEvents.breakGroup();
  }

  beginBackspaceGesture(repeat: boolean): string {
    if (!repeat || this.activeBackspaceGroup === null) {
      this.breakHistoryGroup();
      this.backspaceSequence += 1;
      this.activeBackspaceGroup = `backspace:${this.backspaceSequence}`;
    }
    return this.activeBackspaceGroup;
  }

  endBackspaceGesture(): void {
    this.activeBackspaceGroup = null;
  }

  async bootstrap(): Promise<void> {
    if (this.state.status !== "idle") return;
    this.update({ status: "loading", error: null });
    try {
      const boot = await this.api.bootstrap();
      this.state = {
        status: "ready",
        sessionId: boot.sessionId,
        revision: boot.revision,
        pages: boot.pages,
        activePageId: boot.activePageId,
        nodes: boot.viewport?.nodes ?? [],
        drafts: {},
        noteDrafts: {},
        canUndo: boot.history.canUndo,
        canRedo: boot.history.canRedo,
        undoDepth: boot.history.undoDepth,
        redoDepth: boot.history.redoDepth,
        beforeCursor: boot.viewport?.beforeCursor ?? null,
        afterCursor: boot.viewport?.afterCursor ?? null,
        error: null,
        pendingWrites: 0
      };
      this.subscriptions.publish({
        shell: true,
        outline: true,
        nodeIds: this.state.nodes.map((node) => node.id)
      });
      this.emit();
    } catch (cause) {
      this.update({ status: "error", error: messageFrom(cause) });
    }
  }

  async openPage(pageId: string): Promise<void> {
    await this.viewport.openPage(pageId);
  }

  async loadMore(): Promise<void> {
    await this.viewport.loadMore();
  }

  queryForest(rootIds: readonly string[]): Promise<ForestSnapshot> {
    return this.api.queryForest({ rootIds: [...rootIds], limit: 2_000 });
  }

  setDraft(id: string, text: string): void {
    if (this.activeBackspaceGroup) {
      this.draftHistoryGroups.set(id, this.activeBackspaceGroup);
    } else {
      this.draftHistoryGroups.delete(id);
    }
    this.update({ drafts: { ...this.state.drafts, [id]: text } });
    this.cancelDraftTimer(id);
    this.draftTimers.set(id, setTimeout(() => void this.flushDraft(id), DRAFT_DEBOUNCE_MS));
  }

  async flushDraft(id: string): Promise<void> {
    this.cancelDraftTimer(id);
    const submittedText = this.state.drafts[id];
    if (submittedText === undefined || submittedText === confirmedText(this.state, id)) return;
    const historyGroup = this.draftHistoryGroups.get(id) ?? `text:${id}`;
    await this.executeCommand(
      { kind: "updateText", id, text: submittedText },
      historyGroup
    );
    if (this.state.drafts[id] === submittedText) {
      const drafts = { ...this.state.drafts };
      delete drafts[id];
      this.draftHistoryGroups.delete(id);
      this.update({ drafts });
    }
  }

  setNoteDraft(id: string, note: string): void {
    this.update({ noteDrafts: { ...this.state.noteDrafts, [id]: note } });
    this.cancelNoteDraftTimer(id);
    this.noteDraftTimers.set(
      id,
      setTimeout(() => void this.flushNoteDraft(id), DRAFT_DEBOUNCE_MS)
    );
  }

  async flushNoteDraft(id: string): Promise<void> {
    this.cancelNoteDraftTimer(id);
    const submittedNote = this.state.noteDrafts[id];
    if (submittedNote === undefined) return;
    if (submittedNote !== confirmedNote(this.state, id)) {
      await this.executeCommand(
        { kind: "updateNote", id, note: submittedNote },
        `note:${id}`
      );
    }
    if (this.state.noteDrafts[id] === submittedNote) {
      const noteDrafts = { ...this.state.noteDrafts };
      delete noteDrafts[id];
      this.update({ noteDrafts });
    }
  }

  async flushAllDrafts(): Promise<void> {
    await Promise.all([
      ...Object.keys(this.state.drafts).map((id) => this.flushDraft(id)),
      ...Object.keys(this.state.noteDrafts).map((id) => this.flushNoteDraft(id))
    ]);
    await this.commandQueue;
  }

  async createPage(): Promise<string> {
    const id = freshId();
    await this.executeCommand({ kind: "createPage", id, text: "Untitled page" });
    await this.openPage(id);
    return id;
  }

  async createNode(
    parentId: string,
    text = "",
    beforeId: string | null = null
  ): Promise<string> {
    const pending = this.beginCreateNode(parentId, text, beforeId);
    await pending.committed;
    return pending.id;
  }

  beginCreateNode(
    parentId: string,
    text = "",
    beforeId: string | null = null
  ): PendingCreatedNode {
    const id = freshId();
    this.update(projectCreateNode(this.state, {
      id,
      parentId,
      beforeId,
      text
    }));
    const committed = this.executeCommand({
      kind: "createNode",
      id,
      parent_id: parentId,
      before_id: beforeId,
      text
    }).then(() => undefined).catch((cause) => {
      const removedIds = subtreeIds(this.state.nodes, [id]);
      this.update({
        nodes: this.state.nodes.filter((node) => !removedIds.includes(node.id)),
        drafts: omitKeys(this.state.drafts, removedIds),
        noteDrafts: omitKeys(this.state.noteDrafts, removedIds)
      });
      throw cause;
    });
    return { id, committed };
  }

  async importOutline(
    parentId: string,
    beforeId: string | null,
    roots: readonly PastedOutlineNode[]
  ): Promise<string> {
    if (roots.length === 0) throw new Error("The imported outline is empty.");
    const { nodes, rootIds } = flattenPastedOutline(roots, parentId, freshId);
    await this.executeCommand({
      kind: "importNodes",
      parent_id: parentId,
      before_id: beforeId,
      nodes: [...nodes]
    });
    return rootIds[0];
  }

  async splitNode(input: {
    readonly id: string;
    readonly parentId: string;
    readonly beforeId: string | null;
    readonly prefix: string;
    readonly suffix: string;
  }): Promise<string> {
    const pending = this.beginSplitNode(input);
    await pending.committed;
    return pending.id;
  }

  beginSplitNode(input: {
    readonly id: string;
    readonly parentId: string;
    readonly beforeId: string | null;
    readonly prefix: string;
    readonly suffix: string;
  }): PendingCreatedNode {
    const previousDraft = this.state.drafts[input.id];
    const newId = freshId();
    this.cancelDraftTimer(input.id);
    this.update(projectSplitNode(this.state, { ...input, newId }));
    const committed = this.executeCommand({
        kind: "splitNode",
        id: input.id,
        new_id: newId,
        parent_id: input.parentId,
        before_id: input.beforeId,
        prefix: input.prefix,
        suffix: input.suffix
      }).then(() => {
      if (this.state.drafts[input.id] === input.prefix) {
        const drafts = { ...this.state.drafts };
        delete drafts[input.id];
        this.update({ drafts });
      }
    }).catch((cause) => {
      const removedIds = subtreeIds(this.state.nodes, [newId]);
      if (this.state.drafts[input.id] === input.prefix) {
        const drafts = { ...this.state.drafts };
        if (previousDraft === undefined) delete drafts[input.id];
        else drafts[input.id] = previousDraft;
        this.update({
          nodes: this.state.nodes.filter(
            (node) => !removedIds.includes(node.id)
          ),
          drafts,
          noteDrafts: omitKeys(this.state.noteDrafts, removedIds)
        });
      }
      throw cause;
    });
    return { id: newId, committed };
  }

  async removeEmptyNode(id: string): Promise<void> {
    await this.beginRemoveEmptyNode(id).committed;
  }

  beginRemoveEmptyNode(
    id: string,
    historyGroup: string | null = null
  ): PendingOutlineMutation {
    const previousDraft = this.state.drafts[id];
    const previousNoteDraft = this.state.noteDrafts[id];
    const affectedNodes = this.state.nodes.filter(
      (node) => node.id === id || node.parentId === id
    );
    this.cancelDraftTimer(id);
    this.cancelNoteDraftTimer(id);
    this.update(projectRemoveEmptyNode(this.state, id));
    const committed = this.executeCommand(
      { kind: "removeEmptyNode", id },
      historyGroup
    ).then(() => undefined).catch((cause) => {
      const restoredDrafts = previousDraft !== undefined &&
        this.state.drafts[id] === undefined
        ? { ...this.state.drafts, [id]: previousDraft }
        : this.state.drafts;
      const restoredNoteDrafts = previousNoteDraft !== undefined &&
        this.state.noteDrafts[id] === undefined
        ? { ...this.state.noteDrafts, [id]: previousNoteDraft }
        : this.state.noteDrafts;
      const affectedIds = new Set(affectedNodes.map((node) => node.id));
      const nodes = [
        ...this.state.nodes.filter((node) => !affectedIds.has(node.id)),
        ...affectedNodes
      ];
      this.update({
        nodes: orderOutline(nodes, this.state.activePageId),
        drafts: restoredDrafts,
        noteDrafts: restoredNoteDrafts
      });
      throw cause;
    });
    return { committed };
  }

  beginMergeNodeBackward(input: {
    readonly id: string;
    readonly previousId: string;
    readonly previousText: string;
    readonly currentText: string;
    readonly historyGroup?: string | null;
  }): PendingOutlineMutation {
    const previousNode = this.state.nodes.find(
      (node) => node.id === input.previousId
    );
    const currentNode = this.state.nodes.find((node) => node.id === input.id);
    const previousDraft = this.state.drafts[input.previousId];
    const currentDraft = this.state.drafts[input.id];
    const mergedText = input.previousText + input.currentText;
    this.cancelDraftTimer(input.previousId);
    this.cancelDraftTimer(input.id);
    this.cancelNoteDraftTimer(input.previousId);
    this.update(projectMergeNodeBackward(this.state, input));
    const committed = this.executeCommand({
      kind: "mergeNodeBackward",
      id: input.id,
      previous_id: input.previousId,
      previous_text: input.previousText,
      current_text: input.currentText
    }, input.historyGroup ?? null).then(() => {
      if (this.state.drafts[input.id] === mergedText) {
        const drafts = { ...this.state.drafts };
        delete drafts[input.id];
        this.update({ drafts });
      }
    }).catch((cause) => {
      const nodes = this.state.nodes
        .filter((node) => node.id !== input.previousId && node.id !== input.id);
      if (previousNode) nodes.push(previousNode);
      if (currentNode) nodes.push(currentNode);
      const drafts = { ...this.state.drafts };
      if (drafts[input.id] === mergedText) {
        if (currentDraft === undefined) delete drafts[input.id];
        else drafts[input.id] = currentDraft;
      }
      if (previousDraft !== undefined) {
        drafts[input.previousId] = previousDraft;
      }
      this.update({
        nodes: orderOutline(nodes, this.state.activePageId),
        drafts
      });
      throw cause;
    });
    return { committed };
  }

  async indent(id: string, newParentId: string): Promise<void> {
    await this.flushDraft(id);
    await this.executeCommand({ kind: "indent", id, new_parent_id: newParentId });
  }

  async moveNode(id: string, parentId: string, beforeId: string | null): Promise<void> {
    await this.flushDraft(id);
    await this.executeCommand({
      kind: "moveNode",
      id,
      parent_id: parentId,
      before_id: beforeId
    });
  }

  async moveNodes(
    moves: readonly { id: string; parentId: string; beforeId: string | null }[]
  ): Promise<void> {
    if (moves.length === 0) return;
    await Promise.all(moves.map(({ id }) => this.flushDraft(id)));
    await this.executeCommand({ kind: "moveNodes", moves: [...moves] });
  }

  async outdent(id: string, newParentId: string, beforeId: string | null): Promise<void> {
    await this.flushDraft(id);
    await this.executeCommand({
      kind: "outdent",
      id,
      new_parent_id: newParentId,
      before_id: beforeId
    });
  }

  async duplicate(
    id: string,
    parentId: string,
    beforeId: string | null = null
  ): Promise<string> {
    await this.flushDraft(id);
    const newId = freshId();
    await this.executeCommand({
      kind: "duplicate",
      id,
      new_id: newId,
      parent_id: parentId,
      before_id: beforeId
    });
    return newId;
  }

  async duplicateNodes(
    ids: readonly string[],
    parentId: string,
    beforeId: string | null
  ): Promise<readonly string[]> {
    if (ids.length === 0) return [];
    const affectedIds = subtreeIds(this.state.nodes, ids);
    await Promise.all(affectedIds.flatMap((id) => [
      this.flushDraft(id),
      this.flushNoteDraft(id)
    ]));
    const newIds = ids.map(() => freshId());
    await this.executeCommand({
      kind: "duplicateNodes",
      duplicates: ids.map((id, index) => ({
        id, newId: newIds[index], parentId, beforeId
      }))
    });
    return subtreeIds(this.state.nodes, newIds);
  }
  async setCompleted(id: string, completed: boolean): Promise<void> {
    await this.executeCommand({ kind: "setCompleted", id, completed }); }
  async setCompletedMany(ids: readonly string[], completed: boolean): Promise<void> {
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) => this.flushDraft(id)));
    await this.executeCommand({
      kind: "setCompletedMany",
      ids: [...ids],
      completed
    });
  }
  async setStarred(id: string, starred: boolean): Promise<void> {
    await this.executeCommand({ kind: "setStarred", id, starred }); }
  async setCollapsed(id: string, collapsed: boolean): Promise<void> {
    await this.executeCommand({ kind: "setCollapsed", id, collapsed }); }
  async setMarker(id: string, marker: "bullet" | "todo"): Promise<void> {
    await this.executeCommand({ kind: "setMarker", id, marker }); }
  async applySlashEdit(
    id: string,
    text: string,
    marker: "todo" | null
  ): Promise<void> {
    await runSlashEdit({
      getState: this.getSnapshot,
      cancelDraft: () => this.cancelDraftTimer(id),
      setDraft: (value) =>
        this.update({ drafts: { ...this.state.drafts, [id]: value } }),
      setDrafts: (drafts) => this.update({ drafts }),
      execute: (command, group) =>
        this.executeCommand(command, group).then(() => undefined)
    }, id, text, marker);
  }

  async deleteSubtree(id: string): Promise<void> {
    const deletesPage = this.state.pages.some((page) => page.id === id);
    this.cancelDraftTimer(id);
    this.cancelNoteDraftTimer(id);
    this.update({
      drafts: omitKeys(this.state.drafts, [id]),
      noteDrafts: omitKeys(this.state.noteDrafts, [id])
    });
    await this.executeCommand({ kind: "deleteSubtree", id });
    if (deletesPage) {
      const nextPage = this.state.pages[0];
      if (nextPage) await this.openPage(nextPage.id);
      else this.update({
        activePageId: null,
        nodes: [],
        beforeCursor: null,
        afterCursor: null
      });
    }
  }

  async deleteSubtrees(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const affectedIds = subtreeIds(this.state.nodes, ids);
    await Promise.all(affectedIds.flatMap((id) => [
      this.flushDraft(id),
      this.flushNoteDraft(id)
    ]));
    await this.executeCommand({ kind: "deleteSubtrees", ids: [...ids] });
  }

  async restoreSubtree(id: string): Promise<void> {
    await this.executeCommand({ kind: "restoreSubtree", id });
  }
  async undo(): Promise<void> {
    await this.flushAllDrafts();
    await this.executeHistory("undo");
  }
  async redo(): Promise<void> {
    await this.flushAllDrafts();
    await this.executeHistory("redo");
  }
  search(text: string): Promise<SearchPage> {
    return this.api.search({ text, cursor: null, limit: 30 });
  }
  async close(): Promise<void> {
    await this.flushAllDrafts();
    await this.api.closeSession();
  }

  private executeCommand(
    command: IpcNotesCommand,
    historyGroup: string | null = null
  ): Promise<MutationReceipt> {
    const scopedHistoryGroup = this.historyEvents.scopedGroup(historyGroup);
    return this.enqueue(async () => {
      const sessionId = this.state.sessionId;
      if (!sessionId) throw new Error("Notes session is not ready.");
      const previousUndoDepth = this.state.undoDepth;
      const receipt = await this.api.execute({
        sessionId,
        requestId: freshId(),
        baseRevision: this.state.revision,
        historyGroup: scopedHistoryGroup,
        command
      });
      this.applyReceipt(receipt);
      this.historyEvents.record(
        scopedHistoryGroup,
        previousUndoDepth,
        receipt
      );
      return receipt;
    });
  }

  private executeHistory(direction: "undo" | "redo"): Promise<void> {
    return this.enqueue(async () => {
      const sessionId = this.state.sessionId;
      if (!sessionId) throw new Error("Notes session is not ready.");
      const receipt = await this.api[direction]({
        sessionId,
        baseRevision: this.state.revision
      });
      this.applyReceipt(receipt);
      this.breakHistoryGroup();
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.commandQueue.then(async () => {
      this.update({ pendingWrites: this.state.pendingWrites + 1, error: null });
      try {
        return await operation();
      } catch (cause) {
        this.update({ error: messageFrom(cause) });
        throw cause;
      } finally {
        this.update({ pendingWrites: Math.max(0, this.state.pendingWrites - 1) });
      }
    });
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private applyReceipt(receipt: MutationReceipt): void {
    const result = receiptState(this.state, receipt);
    for (const id of result.removedDraftIds) {
      this.cancelDraftTimer(id);
      this.cancelNoteDraftTimer(id);
    }
    this.update(result.patch, {
      shell: true,
      outline: result.outlineChanged,
      nodeIds: result.changedNodeIds
    });
  }

  private cancelDraftTimer(id: string): void { cancelTimer(this.draftTimers, id); }
  private cancelNoteDraftTimer(id: string): void { cancelTimer(this.noteDraftTimers, id); }

  private update(
    patch: Partial<NotesState>,
    invalidation: StoreInvalidation = invalidationForPatch(this.state, patch)
  ): void {
    this.state = { ...this.state, ...patch };
    this.subscriptions.publish(invalidation);
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}
