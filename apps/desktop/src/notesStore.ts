import type { IpcNotesCommand } from "../../../packages/contracts/generated/IpcNotesCommand";
import type { IpcEditorCommand } from "../../../packages/contracts/generated/IpcEditorCommand";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { ExportFormat } from "../../../packages/contracts/generated/ExportFormat";
import type { NotesExportResult } from "../../../packages/contracts/generated/NotesExportResult";
import type { SearchPage } from "../../../packages/contracts/generated/SearchPage";
import type { ForestSnapshot } from "../../../packages/contracts/generated/ForestSnapshot";
import type { NotesApi } from "./api";
import { initialNotesState, type NotesState } from "./notesState";
import { freshId, messageFrom } from "./storeSupport";
import { flattenPastedOutline, type PastedOutlineNode } from "./outlinePaste";
import { omitKeys, receiptState, subtreeIds, viewportState } from "./storeState";
import { runSlashEdit } from "./storeSlash";
import type { NotesMutationHistoryEvent } from "./storeHistory";
import { StoreViewport } from "./storeViewport";
import { StoreCommands } from "./storeCommands";
import { StoreDrafts } from "./storeDrafts";
import { LazyStoreImages } from "./lazyStoreImages";
import {
  StoreOutlineMutations,
  type PendingCreatedNode,
  type PendingOutlineMutation
} from "./storeOutlineMutations";
import {
  StoreSubscriptions,
  invalidationForPatch,
  type StoreInvalidation
} from "./storeSubscriptions";
import {
  StoreMonaco,
  type MonacoPageSnapshot
} from "./storeMonaco";
export { MonacoPageUnsupportedError } from "./storeMonaco";

export class NotesStore {
  private state: NotesState = initialNotesState;
  private readonly listeners = new Set<() => void>();
  private readonly subscriptions: StoreSubscriptions;
  private readonly commands: StoreCommands;
  private readonly monaco: StoreMonaco;
  readonly images: LazyStoreImages;
  private readonly drafts: StoreDrafts;
  private readonly outlineMutations: StoreOutlineMutations;
  private readonly viewport: StoreViewport;
  constructor(private readonly api: NotesApi) {
    this.subscriptions = new StoreSubscriptions(() => this.state);
    this.commands = new StoreCommands(api, {
      read: this.getSnapshot,
      write: (patch, invalidation) => this.update(patch, invalidation),
      applyReceipt: (receipt) => this.applyReceipt(receipt)
    });
    this.monaco = new StoreMonaco(api, this.commands, this.getSnapshot);
    this.images = new LazyStoreImages(api, this.commands, this.getSnapshot);
    this.drafts = new StoreDrafts({
      read: this.getSnapshot,
      write: (patch, invalidation) => this.update(patch, invalidation),
      execute: (command, group) => this.commands.execute(command, group),
      settled: () => this.commands.settled(),
      breakHistoryGroup: () => this.commands.breakHistoryGroup()
    });
    this.outlineMutations = new StoreOutlineMutations({
      read: this.getSnapshot,
      write: (patch) => this.update(patch),
      execute: (command, group) => this.commands.execute(command, group),
      cancelTitle: (id) => this.drafts.cancelTitle(id),
      cancelNote: (id) => this.drafts.cancelNote(id),
      cancelDrafts: (ids) => this.drafts.cancel(ids)
    });
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
  ): (() => void) => this.commands.subscribeHistory(listener);
  breakHistoryGroup(): void {
    this.commands.breakHistoryGroup();
  }

  beginBackspaceGesture(repeat: boolean): string {
    return this.drafts.beginBackspace(repeat);
  }

  endBackspaceGesture(): void {
    this.drafts.endBackspace();
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

  executeEditorBatch(
    requestId: string,
    commands: readonly IpcEditorCommand[]
  ): Promise<MutationReceipt> {
    return this.monaco.executeEditorBatch(requestId, commands);
  }

  async loadMonacoPage(pageId: string): Promise<MonacoPageSnapshot> {
    return this.monaco.loadPage(pageId);
  }

  setDraft(id: string, text: string): void {
    this.drafts.setTitle(id, text);
  }

  async flushDraft(id: string): Promise<void> {
    await this.drafts.flushTitle(id);
  }

  setNoteDraft(id: string, note: string): void {
    this.drafts.setNote(id, note);
  }

  async flushNoteDraft(id: string): Promise<void> {
    await this.drafts.flushNote(id);
  }

  async flushAllDrafts(): Promise<void> {
    await this.drafts.flushAll();
  }

  async exportNotes(input: {
    readonly rootNodeId: string;
    readonly format: ExportFormat;
    readonly destinationPath: string;
    readonly overwrite: boolean;
  }): Promise<NotesExportResult> {
    const { sessionId, revision } = this.state;
    if (!sessionId) throw new Error("The Notes session is not ready.");
    return this.api.exportNotes({
      sessionId,
      baseRevision: revision,
      rootNodeId: input.rootNodeId,
      format: input.format,
      destinationPath: input.destinationPath,
      overwrite: input.overwrite
    });
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
    return this.outlineMutations.createNode(parentId, text, beforeId);
  }

  beginCreateNode(
    parentId: string,
    text = "",
    beforeId: string | null = null
  ): PendingCreatedNode {
    return this.outlineMutations.beginCreateNode(parentId, text, beforeId);
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
    return this.outlineMutations.splitNode(input);
  }

  beginSplitNode(input: {
    readonly id: string;
    readonly parentId: string;
    readonly beforeId: string | null;
    readonly prefix: string;
    readonly suffix: string;
  }): PendingCreatedNode {
    return this.outlineMutations.beginSplitNode(input);
  }

  async removeEmptyNode(id: string): Promise<void> {
    await this.outlineMutations.removeEmptyNode(id);
  }

  beginRemoveEmptyNode(
    id: string,
    historyGroup: string | null = null
  ): PendingOutlineMutation {
    return this.outlineMutations.beginRemoveEmptyNode(id, historyGroup);
  }

  beginMergeNodeBackward(input: {
    readonly id: string;
    readonly previousId: string;
    readonly previousText: string;
    readonly currentText: string;
    readonly historyGroup?: string | null;
  }): PendingOutlineMutation {
    return this.outlineMutations.beginMergeNodeBackward(input);
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
      cancelDraft: () => this.drafts.cancelTitle(id),
      setDraft: (value) =>
        this.update({ drafts: { ...this.state.drafts, [id]: value } }),
      setDrafts: (drafts) => this.update({ drafts }),
      execute: (command, group) =>
        this.executeCommand(command, group).then(() => undefined)
    }, id, text, marker);
  }

  async deleteSubtree(id: string): Promise<void> {
    const deletesPage = this.state.pages.some((page) => page.id === id);
    this.drafts.cancel([id]);
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
    await this.commands.executeHistory("undo");
  }
  async redo(): Promise<void> {
    await this.flushAllDrafts();
    await this.commands.executeHistory("redo");
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
    return this.commands.execute(command, historyGroup);
  }

  private applyReceipt(receipt: MutationReceipt): void {
    const result = receiptState(this.state, receipt);
    this.drafts.cancel(result.removedDraftIds);
    this.update(result.patch, {
      shell: true,
      outline: result.outlineChanged,
      nodeIds: result.changedNodeIds
    });
  }

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
