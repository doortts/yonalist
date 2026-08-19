import type { IpcMarkerKind } from "../../../packages/contracts/generated/IpcMarkerKind";
import type { IpcNotesCommand } from "../../../packages/contracts/generated/IpcNotesCommand";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { ExportFormat } from "../../../packages/contracts/generated/ExportFormat";
import type { NotesExportResult } from "../../../packages/contracts/generated/NotesExportResult";
import type { SearchPage } from "../../../packages/contracts/generated/SearchPage";
import type { ForestSnapshot } from "../../../packages/contracts/generated/ForestSnapshot";
import type { PaneSnapshot } from "./appNavigation";
import type { VaultChange } from "./syncChanged";
import type { NotesApi } from "./api";
import { initialNotesState, type NotesState } from "./notesState";
import {
  freshId, messageFrom, ROOT_ID, VIEWPORT_LIMIT
} from "./store/storeSupport";
import { provisionalPage } from "./optimisticOutline";
import { flattenPastedOutline, type PastedOutlineNode } from "./outline/outlinePaste";
import {
  omitKeys, receiptState, subtreeIds, viewportState
} from "./store/storeState";
import { runSlashEdit } from "./store/storeSlash";
import type { NotesMutationHistoryEvent } from "./store/storeHistory";
import { StoreViewport } from "./store/storeViewport";
import { StoreCommands } from "./store/storeCommands";
import { StoreDrafts } from "./store/storeDrafts";
import { LazyStoreImages } from "./lazyStoreImages";
import {
  StoreOutlineMutations,
  type MergeIntoParentInput,
  type PendingCreatedNode,
  type PendingOutlineMutation
} from "./store/storeOutlineMutations";
import {
  StoreSubscriptions,
  invalidationForPatch,
  type StoreInvalidation
} from "./store/storeSubscriptions";

/**
 * Whether a command is about this page: the row itself, or a row going inside
 * it. Everything else a command can name is a row inside some page, and a page
 * nobody has written in holds none: a move or a duplicate can only carry rows
 * that already exist, which means the page they came from already does too.
 */
function commandTouches(command: IpcNotesCommand, pageId: string): boolean {
  return ("id" in command && command.id === pageId) ||
    ("parent_id" in command && command.parent_id === pageId);
}

export class NotesStore {
  private state: NotesState = initialNotesState;
  private creatingPageId: string | null = null;
  private pageCreation: Promise<void> = Promise.resolve();
  private capturePaneSnapshot: () => PaneSnapshot | null = () => null;
  private readonly listeners = new Set<() => void>();
  private readonly subscriptions: StoreSubscriptions;
  private readonly commands: StoreCommands;
  readonly images: LazyStoreImages;
  private readonly drafts: StoreDrafts;
  private readonly outlineMutations: StoreOutlineMutations;
  private readonly viewport: StoreViewport;
  constructor(private readonly api: NotesApi) {
    this.subscriptions = new StoreSubscriptions(() => this.state);
    this.commands = new StoreCommands(api, {
      read: this.getSnapshot,
      write: (patch, invalidation) => this.update(patch, invalidation),
      applyReceipt: (receipt) => this.applyReceipt(receipt),
      flushDrafts: () => this.drafts.flushPending(),
      materializePage: (command) => this.materializePage(command),
      capturePaneSnapshot: () => this.capturePaneSnapshot()
    });
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

  /**
   * The app layer owns the DOM, so it hands the store a way to read what the
   * pane holds, and the store only ever asks for it at the command seam.
   */
  setPaneCapture(capture: () => PaneSnapshot | null): void {
    this.capturePaneSnapshot = capture;
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
        pageNode: boot.viewport?.pageNode ?? null,
        provisionalPageId: null,
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
        nodeIds: [
          ...this.state.nodes.map((node) => node.id),
          ...(this.state.pageNode ? [this.state.pageNode.id] : [])
        ]
      });
      this.emit();
    } catch (cause) {
      this.update({ status: "error", error: messageFrom(cause) });
    }
  }

  async openPage(pageId: string): Promise<void> {
    // Leaving a page nobody wrote in is all it takes to drop it: it was only
    // ever in this window.
    if (this.state.provisionalPageId !== null &&
      pageId !== this.state.provisionalPageId) {
      this.update({ provisionalPageId: null });
    }
    await this.viewport.openPage(pageId);
  }

  async loadMore(): Promise<void> {
    await this.viewport.loadMore();
  }

  /**
   * Another device's edit arrived. What it touched is named, so the named
   * rows are fetched and applied the way this window applies its own edits —
   * the caret and the scroll stay where the user left them, which a re-read
   * cannot promise.
   *
   * Two things send it down the other path. A change too wide to be worth
   * naming row by row, and an answer that came back incomplete: in both, the
   * page and the page list are read again, which is always correct and merely
   * more expensive.
   */
  async absorbVaultChange(change?: VaultChange): Promise<void> {
    // What the user was typing on a row another device deleted has nowhere
    // left to land, and only the receipt below knows that -- the re-read
    // replaces the rows without reading the drafts, so a draft left there goes
    // out as an `updateText` for a row that is gone, on its own debounce or at
    // the flush the next command runs. Ahead of the branch rather than inside
    // the re-read arm, because that also spans `patchFromVault`'s round trip,
    // which is long enough for the debounce to fire mid-flight.
    if (change && change.deletedNodeIds.length > 0) {
      this.drafts.cancel(change.deletedNodeIds);
      this.update({
        drafts: omitKeys(this.state.drafts, change.deletedNodeIds),
        noteDrafts: omitKeys(this.state.noteDrafts, change.deletedNodeIds)
      });
    }
    if (change && await this.patchFromVault(change)) return;
    await Promise.all([
      // A page the backend has never heard of cannot be read back; there is
      // also nothing in it for another device to have changed.
      this.state.provisionalPageId === null ? this.viewport.reload() : null,
      this.refreshPages()
    ]);
  }

  /** Answers whether the change was applied; `false` asks for the re-read. */
  private async patchFromVault(change: VaultChange): Promise<boolean> {
    const named = change.changedNodeIds.length + change.deletedNodeIds.length;
    if (named === 0 || named > VIEWPORT_LIMIT) return false;
    try {
      const snapshot = change.changedNodeIds.length === 0
        ? { revision: change.revision, nodes: [], complete: true }
        : await this.api.queryForest({
          rootIds: [...change.changedNodeIds],
          limit: VIEWPORT_LIMIT
        });
      // An answer that had to stop short describes less than what happened.
      if (!snapshot.complete) return false;
      this.applyReceipt({
        revision: snapshot.revision,
        changedNodes: snapshot.nodes,
        deletedIds: [...change.deletedNodeIds],
        // This window's own history, unchanged: what another device did is
        // not something it can undo, and the receipt shape carries the flags
        // whether or not they moved.
        history: {
          canUndo: this.state.canUndo,
          canRedo: this.state.canRedo,
          undoDepth: this.state.undoDepth,
          redoDepth: this.state.redoDepth
        }
      });
      return true;
    } catch {
      // Whatever went wrong, reading the page again is the answer that always
      // works.
      return false;
    }
  }

  private async refreshPages(): Promise<void> {
    try {
      const home = await this.api.queryViewport({
        pageId: ROOT_ID,
        anchorId: null,
        beforeCursor: null,
        afterCursor: null,
        limit: VIEWPORT_LIMIT
      });
      this.update({
        pages: home.nodes
          .filter((node) => !node.deleted)
          .map((node) => ({
            id: node.id,
            title: node.text,
            sortKey: node.sortKey
          }))
      });
    } catch {
      // The list stays as it was. A window showing a page list one edit
      // behind is better than one showing an error over it.
    }
  }

  queryForest(rootIds: readonly string[]): Promise<ForestSnapshot> {
    return this.api.queryForest({ rootIds: [...rootIds], limit: 2_000 });
  }

  setDraft(id: string, text: string): void {
    this.drafts.setTitle(id, text);
  }

  /**
   * The explicit flush, as opposed to the debounce: blur, an arrow key that
   * moves focus to another row, zooming, a batch rewrite. Each of those ends
   * the typing run, so what comes next undoes on its own.
   */
  async flushDraft(id: string): Promise<void> {
    this.drafts.endTypingRun(id);
    await this.drafts.flushTitle(id);
  }

  setNoteDraft(id: string, note: string): void {
    this.drafts.setNote(id, note);
  }

  async flushNoteDraft(id: string): Promise<void> {
    this.drafts.endTypingRun(id);
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

  /**
   * A page opens the moment it is asked for, but nothing is written: an empty
   * page nobody typed into is not a page yet, and one that is never typed into
   * has to leave nothing behind -- no row in the list, nothing to sync, nothing
   * to undo. `materializePage` below writes it as soon as anything does.
   */
  async createPage(): Promise<string> {
    const id = freshId();
    this.update({ provisionalPageId: id });
    this.viewport.openLocalPage(id, provisionalPage(id));
    return id;
  }

  /**
   * The page's own creation, run at the command choke point so that whatever
   * first writes into it -- a title keystroke, a row, an image -- finds it
   * there. It is created empty and the drafts land right behind it: the flush
   * that would otherwise run first would send an `updateText` to a row the
   * backend has never seen, which is why this one command skips it.
   *
   * The page stays provisional until the row exists. Nothing else knows the
   * page until then -- not the page list, not the vault -- so this is what the
   * pane reads to know it has a page to draw at all, and a creation that fails
   * leaves a page the next command tries again for.
   */
  private readonly materializePage = (
    command?: IpcNotesCommand
  ): Promise<void> => {
    const id = this.state.provisionalPageId;
    if (id === null || (command && !commandTouches(command, id))) {
      return Promise.resolve();
    }
    // A command that arrives while the creation is in flight waits for it, and
    // fails with it: writing into a page that was never created only earns a
    // second error. The creation itself comes back through here, and what it
    // must not wait on is itself, so the field below is emptied for the length
    // of the call that sends it.
    if (this.creatingPageId === id) return this.pageCreation;
    this.creatingPageId = id;
    this.pageCreation = Promise.resolve();
    this.pageCreation = this.commands.execute({
      kind: "createNode",
      id,
      parent_id: ROOT_ID,
      before_id: null,
      text: ""
    }, null, false).then(() => {
      this.settleCreation(id);
      // The receipt has already put the row in the page list, so the pane
      // reads the page off the list from here on.
      if (this.state.provisionalPageId === id) {
        this.update({ provisionalPageId: null });
      }
    }, (cause) => {
      // Nothing was written, so the marker stands and the next command tries
      // again.
      this.settleCreation(id);
      throw cause;
    });
    return this.pageCreation;
  };

  /**
   * Only the creation that is still the one under way may declare it over: a
   * second page opened while the first was in flight owns the field by then,
   * and taking it would send that page's creation a second time.
   */
  private settleCreation(id: string): void {
    if (this.creatingPageId === id) this.creatingPageId = null;
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
    beforeId: string | null = null,
    marker: IpcMarkerKind = "bullet"
  ): PendingCreatedNode {
    return this.outlineMutations.beginCreateNode(
      parentId, text, beforeId, marker
    );
  }

  /**
   * `historyGroup` is for a paste that replaces the row it landed on: the
   * removal that follows carries the same one, and the coalescer folds the two
   * commands into one undo step.
   */
  async importOutline(
    parentId: string,
    beforeId: string | null,
    roots: readonly PastedOutlineNode[],
    historyGroup: string | null = null
  ): Promise<string> {
    if (roots.length === 0) throw new Error("The imported outline is empty.");
    const { nodes, rootIds } = flattenPastedOutline(roots, parentId, freshId);
    await this.executeCommand({
      kind: "importNodes",
      parent_id: parentId,
      before_id: beforeId,
      nodes: [...nodes]
    }, historyGroup);
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

  beginMergeNodeIntoParent(
    input: MergeIntoParentInput
  ): PendingOutlineMutation {
    return this.outlineMutations.beginMergeNodeIntoParent(input);
  }

  async indent(id: string, newParentId: string): Promise<void> {
    await this.executeCommand({ kind: "indent", id, new_parent_id: newParentId });
  }

  async moveNode(id: string, parentId: string, beforeId: string | null): Promise<void> {
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
    await this.executeCommand({ kind: "moveNodes", moves: [...moves] });
  }

  /**
   * A batch of title and note rewrites that undo together. There is no batch
   * command for text, so each edit runs as its own `updateText`/`updateNote`
   * under one history group and the Rust coalescer folds them into a single
   * entry — one `⌘Z` for the whole batch. It stops folding past
   * `MAX_HISTORY_MUTATIONS_PER_ENTRY` (256) mutations, so callers bound the
   * batch themselves rather than letting it split without saying so.
   *
   * Drafts are flushed here rather than at the command choke point, which
   * exempts `updateText`/`updateNote` so a flush cannot recurse into itself.
   * Without this a debounce still in flight would land after these writes and
   * put the pre-edit text back.
   */
  async applyTextEdits(
    edits: readonly {
      readonly id: string;
      readonly text?: string;
      readonly note?: string;
    }[]
  ): Promise<void> {
    if (edits.length === 0) return;
    await Promise.all(edits.flatMap(({ id }) => [
      this.flushDraft(id),
      this.flushNoteDraft(id)
    ]));
    const historyGroup = `edits:${freshId()}`;
    for (const edit of edits) {
      if (edit.text !== undefined) {
        await this.executeCommand(
          { kind: "updateText", id: edit.id, text: edit.text },
          historyGroup
        );
      }
      if (edit.note !== undefined) {
        await this.executeCommand(
          { kind: "updateNote", id: edit.id, note: edit.note },
          historyGroup
        );
      }
    }
  }

  async outdent(id: string, newParentId: string, beforeId: string | null): Promise<void> {
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
    const newIds = ids.map(() => freshId());
    await this.executeCommand({
      kind: "duplicateNodes",
      duplicates: ids.map((id, index) => ({
        id, newId: newIds[index], parentId, beforeId
      }))
    });
    return subtreeIds(this.state.nodes, newIds);
  }
  /**
   * One row travels; the server settles the Todo chain around it, which is the
   * only place the whole chain is known -- the client holds a window of it.
   */
  async setCompleted(
    id: string,
    completed: boolean,
    historyGroup: string | null = null
  ): Promise<void> {
    await this.executeCommand(
      { kind: "setCompleted", id, completed }, historyGroup
    );
  }
  /**
   * One press of the completion chord. Which of its three moves this is comes
   * from the server, which holds the whole tree: the row itself, then its
   * children, then back again. A client only ever has a window of the page and
   * cannot see a collapsed row's children to judge it.
   */
  async cycleCompleted(id: string): Promise<void> {
    await this.executeCommand({ kind: "cycleCompleted", id });
  }
  async setCompletedMany(ids: readonly string[], completed: boolean): Promise<void> {
    if (ids.length === 0) return;
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
  /**
   * A guide click closes or reopens a whole range, and each row carries its own
   * value so a restore can hand back a mixed shape. There is no batch command
   * for collapse, so the rows run one at a time under a single history group
   * and the Rust coalescer folds them into the one undo entry the gesture reads
   * as.
   */
  async setCollapsedMany(
    changes: readonly { readonly id: string; readonly collapsed: boolean }[]
  ): Promise<void> {
    if (changes.length === 0) return;
    const historyGroup = `collapse:${freshId()}`;
    for (const change of changes) {
      await this.executeCommand(
        { kind: "setCollapsed", id: change.id, collapsed: change.collapsed },
        historyGroup
      );
    }
  }
  async setMarker(
    id: string,
    marker: IpcMarkerKind,
    historyGroup: string | null = null
  ): Promise<void> {
    await this.executeCommand({ kind: "setMarker", id, marker }, historyGroup);
  }
  async applySlashEdit(
    id: string,
    text: string,
    marker: IpcMarkerKind | null,
    completed?: boolean
  ): Promise<void> {
    await runSlashEdit({
      getState: this.getSnapshot,
      cancelDraft: () => this.drafts.cancelTitle(id),
      setDraft: (value) =>
        this.update({ drafts: { ...this.state.drafts, [id]: value } }),
      setDrafts: (drafts) => this.update({ drafts }),
      execute: (command, group) =>
        this.executeCommand(command, group).then(() => undefined)
    }, id, text, marker, completed);
  }

  /**
   * Trashing the page on screen leaves nothing to look at, so the view falls
   * back to Home. Trashing any other page leaves the view where it is.
   */
  async deleteSubtree(id: string): Promise<void> {
    const deletesOpenPage = this.state.activePageId === id;
    await this.executeCommand({ kind: "deleteSubtree", id });
    if (deletesOpenPage) await this.openPage(ROOT_ID);
  }

  async deleteSubtrees(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
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
