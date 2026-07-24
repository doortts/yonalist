import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isNotesMutationResult, type NoteAttachment, type NoteNode, type NotesHistoryContext, type NotesHistoryReplayOutcome, type NotesHistoryState, type NotesMutationResponse, type NotesMutationResult, type NotesStore, type NotesWorkspace } from "../../domain/notes";
import { useNotesWorkspace } from "./useNotesWorkspace";
import { notesWorkspaceCoordinatorRegistry, type NotesWorkspaceCoordinatorSession } from "./notesWorkspaceCoordinator";
import { notesExpansionSnapshotPool, type NotesHistorySession, type NotesHistorySnapshot } from "./notesHistory";

const createNoteIdMock = vi.hoisted(() => vi.fn());
const notesHistorySpies = vi.hoisted(() => ({
  discard: vi.fn(),
  beginStructural: vi.fn(),
  rememberAfter: vi.fn(),
  acceptMutationResult: vi.fn(),
  acceptReplayResult: vi.fn(),
  sessionsById: new Map<string, unknown>(),
  historyStatesBySessionId: new Map<string, unknown>()
}));

vi.mock("../../domain/notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../domain/notes")>()),
  createNoteId: createNoteIdMock
}));

vi.mock("./notesHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./notesHistory")>();
  return {
    ...actual,
    createNotesHistorySession: (
      options?: Parameters<typeof actual.createNotesHistorySession>[0]
    ) => {
      const session = actual.createNotesHistorySession(options);
      notesHistorySpies.sessionsById.set(session.sessionId, session);
      const bindInitialization = session.bindInitialization.bind(session);
      const beginStructuralEntry = session.beginStructuralEntry.bind(session);
      const acceptMutationResult = session.acceptMutationResult.bind(session);
      const acceptReplayResult = session.acceptReplayResult.bind(session);
      const reset = session.reset.bind(session);
      const discard = session.discard.bind(session);
      const rememberAfter = session.rememberAfter.bind(session);
      session.bindInitialization = (state) => {
        bindInitialization(state);
        notesHistorySpies.historyStatesBySessionId.set(session.sessionId, state);
      };
      session.beginStructuralEntry = (commandKind, before) => {
        notesHistorySpies.beginStructural(commandKind, before);
        return beginStructuralEntry(commandKind, before);
      };
      session.discard = (entryId) => {
        notesHistorySpies.discard(entryId);
        discard(entryId);
      };
      session.rememberAfter = (entryId, after) => {
        notesHistorySpies.rememberAfter(entryId, after);
        rememberAfter(entryId, after);
      };
      session.acceptMutationResult = (entryId, after, state) => {
        notesHistorySpies.acceptMutationResult(entryId, after, state);
        const acceptance = acceptMutationResult(entryId, after, state);
        if (acceptance.accepted) {
          notesHistorySpies.historyStatesBySessionId.set(session.sessionId, state);
        }
        return acceptance;
      };
      session.acceptReplayResult = (state, direction, entryId) => {
        notesHistorySpies.acceptReplayResult(state, direction, entryId);
        const accepted = acceptReplayResult(state, direction, entryId);
        if (accepted) {
          notesHistorySpies.historyStatesBySessionId.set(session.sessionId, state);
        }
        return accepted;
      };
      session.reset = (historyEpoch) => {
        reset(historyEpoch);
        notesHistorySpies.historyStatesBySessionId.set(
          session.sessionId,
          historyState(historyEpoch)
        );
      };
      return session;
    }
  };
});

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
    nodeKind: "text",
    parentId: null,
    sortKey: 1024,
    title: overrides.id,
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    imageOffsetUtf16: 0,
    ...overrides
  };
}

function workspace(nodes: NoteNode[]): NotesWorkspace {
  return { nodes };
}

function historyState(historyEpoch = "epoch-a"): NotesHistoryState {
  return {
    canUndo: false,
    canRedo: false,
    historyEpoch,
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: []
  };
}

function syntheticHistoryStatus(sessionId: string): NotesHistoryState {
  const session = notesHistorySpies.sessionsById.get(sessionId) as
    | NotesHistorySession
    | undefined;
  if (!session) return historyState();
  const state = notesHistorySpies.historyStatesBySessionId.get(sessionId) as
    | NotesHistoryState
    | undefined;
  return {
    ...(state ?? historyState(session.historyEpoch)),
    canUndo: session.canUndo(),
    canRedo: session.canRedo()
  };
}

function mutationResult(
  resultWorkspace: NotesWorkspace,
  context: NotesHistoryContext
): NotesMutationResult {
  return {
    workspace: resultWorkspace,
    historyEntryId: context.entryId,
    ...historyState(context.historyEpoch),
    canUndo: true,
    nextUndoEntryId: context.entryId
  };
}

function appliedReplay(
  resultWorkspace: NotesWorkspace,
  replayedEntryId: string | null,
  direction: "undo" | "redo"
): NotesHistoryReplayOutcome {
  if (replayedEntryId === null) {
    throw new Error("Applied replay fixtures require an entry ID.");
  }
  return {
    kind: "applied",
    workspace: resultWorkspace,
    replayedEntryId,
    ...historyState(),
    canUndo: direction === "redo",
    canRedo: direction === "undo",
    nextUndoEntryId: direction === "redo" ? replayedEntryId : null,
    nextRedoEntryId: direction === "undo" ? replayedEntryId : null
  };
}

function withEpochAwareMutation<
  TArgument,
  TResult extends NotesMutationResponse
>(
  operation: (
    vaultRoot: string,
    input: TArgument,
    context: NotesHistoryContext
  ) => Promise<TResult>
): (
  vaultRoot: string,
  input: TArgument,
  context: NotesHistoryContext
) => Promise<TResult> {
  return vi.fn(async (vaultRoot, input, context): Promise<TResult> => {
    const result = await operation(vaultRoot, input, context);
    if (
      isNotesMutationResult(result) &&
      result.canUndo &&
      result.nextUndoEntryId === null &&
      result.historyEntryId === context.entryId
    ) {
      return { ...result, nextUndoEntryId: context.entryId };
    }
    return result;
  });
}

function withEpochAwareReplay(
  direction: "undo" | "redo",
  operation: NonNullable<NotesStore["undo"]>
): NonNullable<NotesStore["undo"]> {
  return vi.fn(async (vaultRoot, input) => {
    const result = await operation(vaultRoot, input);
    if (result.kind !== "applied") {
      return result;
    }
    if (
      direction === "undo" &&
      result.canRedo &&
      result.nextRedoEntryId === null
    ) {
      return { ...result, nextRedoEntryId: result.replayedEntryId };
    }
    if (
      direction === "redo" &&
      result.canUndo &&
      result.nextUndoEntryId === null
    ) {
      return { ...result, nextUndoEntryId: result.replayedEntryId };
    }
    return result;
  });
}

function attachment(
  overrides: Partial<NoteAttachment> & Pick<NoteAttachment, "id" | "nodeId">
): NoteAttachment {
  const contentHash = overrides.contentHash ?? "a".repeat(64);
  return {
    sortKey: 1024,
    relativePath: `notes-assets/${contentHash}.png`,
    contentHash,
    originalName: `${overrides.id}.png`,
    mimeType: "image/png",
    byteSize: 4,
    intrinsicWidth: 640,
    intrinsicHeight: 320,
    displayWidth: 320,
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z",
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function repository(overrides: Partial<NotesStore> = {}): NotesStore {
  const empty = vi.fn().mockResolvedValue(workspace([]));
  const store: NotesStore = {
    initialize: vi.fn().mockResolvedValue(historyState()),
    loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
    createNode: empty,
    updateNode: empty,
    setReadonly: empty,
    materializeGithubNotificationAndCreateSibling: empty,
    materializeGithubNotificationAndReparent: empty,
    refreshMaterializedGithubNotifications: empty,
    setGithubGroupCollapsed: empty,
    markMaterializedGithubNotificationRead: empty,
    deleteNodes: empty,
    splitNode: empty,
    applyImageAtomEdit: vi.fn<NotesStore["applyImageAtomEdit"]>(),
    applyImageAtomPaste: vi.fn<NotesStore["applyImageAtomPaste"]>(),
    moveNode: empty,
    applyBatch: empty,
    importSubtree: empty,
    importMarkdown: vi.fn<NotesStore["importMarkdown"]>(),
    toggleComplete: empty,
    toggleCollapsed: empty,
    toggleStar: empty,
    duplicateNode: empty,
    removeEmptyNode: empty,
    softDeleteNode: empty,
    restoreNode: empty,
    archiveNode: empty,
    unarchiveNode: empty,
    undo: vi.fn().mockResolvedValue({
      kind: "entryMissing",
      ...historyState()
    }),
    redo: vi.fn().mockResolvedValue({
      kind: "entryMissing",
      ...historyState()
    }),
    lookupImageAtomOperation: vi.fn<NotesStore["lookupImageAtomOperation"]>(
      async (_vaultPath, _sessionId, historyEpoch) => ({
        kind: "missing",
        historyEpoch
      })
    ),
    ackImageAtomOperation: vi.fn<NotesStore["ackImageAtomOperation"]>(
      async () => undefined
    ),
    clearHistory: vi.fn().mockResolvedValue({
      ...historyState(),
      historyReset: true
    }),
    historyStatus: vi
      .fn()
      .mockImplementation((_vaultRoot, sessionId) => syntheticHistoryStatus(sessionId)),
    pruneHistoryEntries: vi.fn().mockResolvedValue(historyState()),
    prepareNavigation: vi
      .fn()
      .mockImplementation((_vaultRoot, input) =>
        syntheticHistoryStatus(input.sessionId)
      ),
    closeHistorySession: vi.fn().mockResolvedValue(undefined),
    emptyTrash: empty,
    search: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
    listTagsWithCounts: vi.fn().mockResolvedValue([]),
    deleteDatabase: vi
      .fn()
      .mockResolvedValue({ attachmentCleanupFailed: false }),
    importAttachmentPaths: vi.fn().mockResolvedValue(workspace([])),
    importAttachmentBytes: vi.fn().mockResolvedValue(workspace([])),
    importImageNodePaths: vi.fn().mockResolvedValue(workspace([])),
    importImageNodeBytes: vi.fn().mockResolvedValue(workspace([])),
    ...overrides
  };
  return {
    ...store,
    createNode: withEpochAwareMutation(store.createNode),
    updateNode: withEpochAwareMutation(store.updateNode),
    splitNode: withEpochAwareMutation(store.splitNode),
    moveNode: withEpochAwareMutation(store.moveNode),
    applyBatch: withEpochAwareMutation(store.applyBatch),
    importSubtree: withEpochAwareMutation(store.importSubtree),
    importMarkdown: withEpochAwareMutation(store.importMarkdown),
    toggleComplete: withEpochAwareMutation(store.toggleComplete),
    toggleCollapsed: withEpochAwareMutation(store.toggleCollapsed),
    toggleStar: withEpochAwareMutation(store.toggleStar),
    duplicateNode: withEpochAwareMutation(store.duplicateNode),
    removeEmptyNode: withEpochAwareMutation(store.removeEmptyNode),
    softDeleteNode: withEpochAwareMutation(store.softDeleteNode),
    restoreNode: withEpochAwareMutation(store.restoreNode),
    archiveNode: withEpochAwareMutation(store.archiveNode),
    unarchiveNode: withEpochAwareMutation(store.unarchiveNode),
    undo: withEpochAwareReplay("undo", store.undo),
    redo: withEpochAwareReplay("redo", store.redo),
    importAttachment: store.importAttachment
      ? withEpochAwareMutation(store.importAttachment)
      : undefined,
    importAttachmentPaths: withEpochAwareMutation(store.importAttachmentPaths),
    importAttachmentBytes: withEpochAwareMutation(store.importAttachmentBytes),
    importImageNodePaths: store.importImageNodePaths
      ? withEpochAwareMutation(store.importImageNodePaths)
      : undefined,
    importImageNodeBytes: store.importImageNodeBytes
      ? withEpochAwareMutation(store.importImageNodeBytes)
      : undefined,
    resizeAttachment: store.resizeAttachment
      ? withEpochAwareMutation(store.resizeAttachment)
      : undefined,
    removeAttachment: store.removeAttachment
      ? withEpochAwareMutation(store.removeAttachment)
      : undefined,
    restoreAttachment: store.restoreAttachment
      ? withEpochAwareMutation(store.restoreAttachment)
      : undefined,
    expandAll: store.expandAll
      ? withEpochAwareMutation(store.expandAll)
      : undefined,
    collapseAll: store.collapseAll
      ? withEpochAwareMutation(store.collapseAll)
      : undefined,
    sortSubtreeAscending: store.sortSubtreeAscending
      ? withEpochAwareMutation(store.sortSubtreeAscending)
      : undefined,
    sortSubtreeDescending: store.sortSubtreeDescending
      ? withEpochAwareMutation(store.sortSubtreeDescending)
      : undefined
  };
}

describe("Task 5 shared session replay and reset", () => {
  it("recovers an atomic mutation whose scoped projection cannot be loaded", async () => {
    const scopedBefore = workspace([
      node({ id: "root", title: "Before", isStarred: true })
    ]);
    const fullBefore = workspace([
      ...scopedBefore.nodes,
      node({ id: "outside", sortKey: 2048 })
    ]);
    const scopedAfter = workspace([
      node({ id: "root", title: "After", isStarred: true })
    ]);
    const fullAfter = workspace([
      ...scopedAfter.nodes,
      node({ id: "outside", sortKey: 2048 })
    ]);
    const reset = deferred<NotesHistoryState & { historyReset: true }>();
    let rejectProjection = false;
    let recoveryMayLoad = false;
    const loadWorkspace = vi.fn(async (_vaultRoot, scope) => {
      if (scope.kind === "starred") {
        if (rejectProjection && !recoveryMayLoad) {
          throw new Error("Scoped projection failed");
        }
        return recoveryMayLoad ? scopedAfter : scopedBefore;
      }
      return fullBefore;
    });
    const updateNode = vi.fn(async (_vaultRoot, _input, context) => ({
      workspace: fullAfter,
      historyEntryId: context.entryId,
      ...historyState(),
      canUndo: true,
      nextUndoEntryId: context.entryId
    }));
    const clearHistory = vi.fn().mockReturnValue(reset.promise);
    const store = repository({ loadWorkspace, updateNode, clearHistory });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/task-5-projection-recovery",
        repository: store
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("starred"));
    rejectProjection = true;

    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.actions.updateNode("root", {
        title: "After",
        note: ""
      });
    });
    await waitFor(() => expect(clearHistory).toHaveBeenCalledOnce());

    expect(result.current.state.rootIds).toEqual(["root"]);
    expect(result.current.state.nodesById.root.title).toBe("Before");
    expect(result.current.state.nodesById.outside).toBeUndefined();
    expect(result.current.canUndo).toBe(true);
    expect(clearHistory).toHaveBeenCalledWith(
      "/task-5-projection-recovery",
      expect.objectContaining({
        sessionId: expect.any(String),
        historyEpoch: "epoch-a"
      })
    );

    recoveryMayLoad = true;
    reset.resolve({ ...historyState("epoch-b"), historyReset: true });
    await act(async () => completion);

    expect(result.current.state.rootIds).toEqual(["root"]);
    expect(result.current.state.nodesById.root.title).toBe("After");
    expect(result.current.state.nodesById.outside).toBeUndefined();
    expect(result.current).toMatchObject({ canUndo: false, canRedo: false });
  });

  it("recovers an invalid same-ID intermediate compound state before running the move", async () => {
    const initial = workspace([
      node({ id: "target", isCollapsed: true }),
      node({ id: "moving", sortKey: 2048 })
    ]);
    const expanded = workspace([
      node({ id: "target", isCollapsed: false }),
      node({ id: "moving", sortKey: 2048 })
    ]);
    const moved = workspace([
      node({ id: "target", isCollapsed: false }),
      node({ id: "moving", parentId: "target" })
    ]);
    const toggleCollapsed = vi.fn(async (_vaultRoot, _nodeId, context) => ({
      workspace: expanded,
      historyEntryId: context.entryId,
      ...historyState(),
      canUndo: true,
      nextUndoEntryId: "not-the-compound-entry"
    }));
    const moveNode = vi.fn(async (_vaultRoot, _input, context) =>
      mutationResult(moved, context)
    );
    const clearHistory = vi.fn().mockResolvedValue({
      ...historyState("epoch-b"),
      historyReset: true
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleCollapsed,
      moveNode,
      clearHistory
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/task-5-compound-entry",
        repository: store
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.moveNode(
        { id: "moving", parentId: "target", afterId: null },
        "moving",
        { expandNodeId: "target" }
      )
    );

    expect(toggleCollapsed).toHaveBeenCalledOnce();
    expect(moveNode).not.toHaveBeenCalled();
    expect(clearHistory).toHaveBeenCalledOnce();
    expect(result.current.state.rootIds).toEqual(["target", "moving"]);
    expect(result.current.state.nodesById.target.isCollapsed).toBe(true);
    expect(result.current).toMatchObject({ canUndo: false, canRedo: false });
  });

  it("recovers a compound split when its scoped projection fails", async () => {
    const root = node({ id: "root", isStarred: true });
    const outside = node({ id: "outside", sortKey: 2048 });
    const split = node({ id: "split", sortKey: 1536, isStarred: true });
    const fullBefore = workspace([root, outside]);
    const fullAfter = workspace([root, split, outside]);
    const scopedBefore = workspace([root]);
    const scopedAfter = workspace([root, split]);
    let rejectProjection = false;
    let recoveryMayLoad = false;
    const loadWorkspace = vi.fn(async (_vaultRoot, scope) => {
      if (scope.kind === "starred") {
        if (rejectProjection && !recoveryMayLoad) {
          throw new Error("Compound projection failed");
        }
        return recoveryMayLoad ? scopedAfter : scopedBefore;
      }
      return fullBefore;
    });
    const splitNode = vi.fn(async (_vaultRoot, _input, context) =>
      mutationResult(fullAfter, context)
    );
    const clearHistory = vi.fn(async () => {
      recoveryMayLoad = true;
      return { ...historyState("epoch-b"), historyReset: true as const };
    });
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) =>
      mutationResult(scopedAfter, context)
    );
    const onSuccess = vi.fn();
    const store = repository({
      loadWorkspace,
      splitNode,
      clearHistory,
      toggleStar
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/task-5-compound-projection",
        repository: store
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("starred"));
    rejectProjection = true;

    await act(async () =>
      result.current.actions.splitNode("root", "split", "Root", "", {
        onSuccess
      })
    );

    expect(clearHistory).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.state.rootIds).toEqual(["root", "split"]);
    expect(result.current.state.nodesById.outside).toBeUndefined();
    expect(result.current).toMatchObject({ canUndo: false, canRedo: false });
    await act(async () => result.current.actions.toggleStar("root"));
    expect(toggleStar).toHaveBeenCalledOnce();
  });

  it("settles a late old-vault image import into a surviving old-vault session", async () => {
    const oldRoot = node({ id: "old-root" });
    const newRoot = node({ id: "new-root" });
    const imageNodeId = "72500000-0000-4000-8000-000000000001";
    const attachmentId = "72500000-0000-4000-8000-000000000002";
    createNoteIdMock
      .mockReturnValueOnce(imageNodeId)
      .mockReturnValueOnce(attachmentId);
    const imported = node({
      id: imageNodeId,
      nodeKind: "image",
      sortKey: 2048,
      title: "late.png"
    });
    const importedAttachment = attachment({
      id: attachmentId,
      nodeId: imageNodeId,
      originalName: "late.png"
    });
    const response = deferred<NotesMutationResult>();
    const importImageNodePaths = vi.fn().mockReturnValue(response.promise);
    const sessions: NotesWorkspaceCoordinatorSession[] = [];
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        sessions.push(session);
        return session;
      });
    const store = repository({
      loadWorkspace: vi.fn(async (vaultRoot) =>
        workspace([vaultRoot === "/old-vault" ? oldRoot : newRoot])
      ),
      importImageNodePaths
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/old-vault", repository: store })
    );
    const owner = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old-vault" } }
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));
    const order: string[] = [];
    const oldSession = sessions.at(-1)!;
    const acceptMutationResult = oldSession.history.acceptMutationResult.bind(
      oldSession.history
    );
    vi.spyOn(oldSession.history, "acceptMutationResult").mockImplementation(
      (...args) => {
        order.push("accept");
        return acceptMutationResult(...args);
      }
    );
    act(() => owner.result.current.actions.setImageImportMaxDisplayWidth(480));
    const completion = owner.result.current.actions
      .importDroppedImagePaths!(oldRoot.id, ["/incoming/late.png"])
      .then((value) => {
        order.push("complete");
        return value;
      });
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());

    owner.rerender({ vaultRoot: "/new-vault" });
    await waitFor(() =>
      expect(owner.result.current.state.nodesById[newRoot.id]).toBeDefined()
    );
    const entryId = importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null;
    response.resolve({
      workspace: {
        nodes: [oldRoot, imported],
        attachmentsByNodeId: { [imageNodeId]: [importedAttachment] }
      },
      historyEntryId: entryId,
      ...historyState(),
      canUndo: true,
      canRedo: false,
      nextUndoEntryId: entryId,
      importedRootIds: [imageNodeId]
    });
    await act(async () => completion);

    await waitFor(() =>
      expect(sibling.result.current.state.nodesById[imageNodeId]).toBeDefined()
    );
    expect(sibling.result.current.canUndo).toBe(true);
    expect(notesHistorySpies.discard).not.toHaveBeenCalledWith(entryId);
    expect(notesHistorySpies.acceptMutationResult).toHaveBeenCalledWith(
      entryId,
      expect.anything(),
      expect.anything()
    );
    expect(order).toEqual(["accept", "complete"]);
    owner.unmount();
    sibling.unmount();
    openSession.mockRestore();
  });

  it("recovers a late image import through its old vault and saved location", async () => {
    const oldRoot = node({ id: "old-root" });
    const newRoot = node({ id: "new-root" });
    const imageNodeId = "72600000-0000-4000-8000-000000000001";
    const attachmentId = "72600000-0000-4000-8000-000000000002";
    createNoteIdMock
      .mockReturnValueOnce(imageNodeId)
      .mockReturnValueOnce(attachmentId);
    const response = deferred<NotesMutationResult>();
    const importImageNodePaths = vi.fn().mockReturnValue(response.promise);
    const loadWorkspace = vi.fn(async (vaultRoot) =>
      workspace([vaultRoot === "/old-vault-recovery" ? oldRoot : newRoot])
    );
    const clearHistory = vi.fn().mockResolvedValue({
      ...historyState("epoch-b"),
      historyReset: true
    });
    const store = repository({
      loadWorkspace,
      importImageNodePaths,
      clearHistory
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/old-vault-recovery", repository: store })
    );
    const owner = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old-vault-recovery" } }
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));
    await act(async () => owner.result.current.actions.focusNode(oldRoot.id));
    act(() => owner.result.current.actions.setImageImportMaxDisplayWidth(480));
    const completion = owner.result.current.actions.importDroppedImagePaths!(
      oldRoot.id,
      ["/incoming/late-invalid.png"]
    );
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());

    owner.rerender({ vaultRoot: "/new-vault-recovery" });
    await waitFor(() =>
      expect(owner.result.current.state.nodesById[newRoot.id]).toBeDefined()
    );
    const context = importImageNodePaths.mock.calls[0]?.[2];
    response.resolve({
      workspace: workspace([oldRoot, node({ id: imageNodeId })]),
      historyEntryId: context.entryId,
      ...historyState(context.historyEpoch),
      canUndo: false,
      nextUndoEntryId: context.entryId,
      importedRootIds: [imageNodeId]
    });
    await act(async () => completion);

    expect(clearHistory).toHaveBeenCalledWith("/old-vault-recovery", {
      sessionId: context.sessionId,
      historyEpoch: context.historyEpoch
    });
    expect(loadWorkspace).toHaveBeenLastCalledWith("/old-vault-recovery", {
      kind: "active"
    });
    await waitFor(() =>
      expect(sibling.result.current.state).toMatchObject({
        selectedId: oldRoot.id,
        pendingFocusId: oldRoot.id,
        pendingFocusField: "title"
      })
    );
    expect(sibling.result.current.state.nodesById[imageNodeId]).toBeUndefined();
    expect(sibling.result.current.canUndo).toBe(false);
    expect(owner.result.current.state.rootIds).toEqual([newRoot.id]);
    owner.unmount();
    sibling.unmount();
  });

  it("preflights an intervening navigation with the nearest mutation ID", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const starred = workspace([
      node({ id: "root", isStarred: true }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const clearHistory = vi.fn().mockResolvedValue({
      ...historyState("epoch-b"),
      historyReset: true
    });
    const undo = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleStar: vi.fn(async (_vaultRoot, _nodeId, context) =>
        mutationResult(starred, context)
      ),
      clearHistory,
      undo
    });
    const sessions: NotesWorkspaceCoordinatorSession[] = [];
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        sessions.push(session);
        return session;
      });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/task-5-nearest-mutation",
        repository: store
      })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      await act(async () => rendered.result.current.actions.toggleStar("root"));
      const session = sessions.at(-1)!;
      const mutationCandidate = session.history.next("undo");
      const mutationEntryId =
        mutationCandidate?.kind === "mutation"
          ? mutationCandidate.entryId
          : null;
      const before: NotesHistorySnapshot = {
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        selectedId: "root",
        zoomRootId: null,
        expansion: notesExpansionSnapshotPool.acquire([]),
        focus: { nodeId: "root", field: "title" }
      };
      const after: NotesHistorySnapshot = {
        ...before,
        selectedId: "other",
        expansion: notesExpansionSnapshotPool.acquire([]),
        focus: { nodeId: "other", field: "title" }
      };
      session.history.appendNavigation(before, after);

      await act(async () => rendered.result.current.actions.undo!());

      expect(clearHistory).not.toHaveBeenCalled();
      expect(undo).not.toHaveBeenCalled();
      expect(session.history.next("undo")).toMatchObject({
        kind: "mutation",
        entryId: mutationEntryId
      });
      expect(session.history.next("redo")?.kind).toBe("navigation");
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("drops a stale Empty Trash request before old-vault admission", async () => {
    const oldRoot = node({ id: "old-root" });
    const newRoot = node({ id: "new-root" });
    const pendingMutation = deferred<NotesMutationResult>();
    const toggleStar = vi.fn().mockReturnValue(pendingMutation.promise);
    const emptyTrash = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn(async (vaultRoot) =>
        workspace([vaultRoot === "/stale-empty-old" ? oldRoot : newRoot])
      ),
      toggleStar,
      emptyTrash
    });
    const rendered = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/stale-empty-old" } }
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    let mutationCompletion!: Promise<unknown>;
    act(() => {
      mutationCompletion = rendered.result.current.actions.toggleStar(oldRoot.id);
    });
    await waitFor(() => expect(toggleStar).toHaveBeenCalledOnce());
    let emptyCompletion!: Promise<unknown>;
    act(() => {
      emptyCompletion = rendered.result.current.actions.emptyTrash();
    });
    rendered.rerender({ vaultRoot: "/stale-empty-new" });
    await waitFor(() =>
      expect(rendered.result.current.state.nodesById[newRoot.id]).toBeDefined()
    );
    const context = toggleStar.mock.calls[0]?.[2];
    pendingMutation.resolve(mutationResult(workspace([oldRoot]), context));
    await act(async () => Promise.all([mutationCompletion, emptyCompletion]));

    expect(emptyTrash).not.toHaveBeenCalled();
    expect(rendered.result.current.state.rootIds).toEqual([newRoot.id]);
  });

  it("preserves Empty Trash rows, cursor, canonical state, and epoch when projection fails", async () => {
    const root = node({ id: "root" });
    const deleted = node({
      id: "deleted",
      deletedAt: "2026-07-18T00:00:00Z",
      sortKey: 2048
    });
    const starred = workspace([node({ ...root, isStarred: true }), deleted]);
    let activeWorkspace = workspace([root, deleted]);
    let rejectTrashProjection = false;
    const loadWorkspace = vi.fn(async (_vaultRoot, scope) => {
      if (scope.kind === "trash") {
        if (rejectTrashProjection) throw new Error("Trash projection failed");
        return workspace([deleted]);
      }
      return activeWorkspace;
    });
    const emptyTrash = vi.fn().mockResolvedValue({
      workspace: workspace([node({ ...root, isStarred: true })]),
      ...historyState("epoch-b"),
      historyReset: true
    });
    const publishFeedback = vi.fn();
    const sessions: NotesWorkspaceCoordinatorSession[] = [];
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        sessions.push(session);
        return session;
      });
    const store = repository({
      loadWorkspace,
      toggleStar: vi.fn(async (_vaultRoot, _nodeId, context) => {
        activeWorkspace = starred;
        return mutationResult(starred, context);
      }),
      emptyTrash
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/task-5-empty-projection",
        repository: store,
        publishFeedback
      })
    );
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/task-5-empty-projection",
        repository: store,
        publishFeedback
      })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      await waitFor(() => expect(sibling.result.current.status).toBe("ready"));
      await act(async () => rendered.result.current.actions.toggleStar(root.id));
      await waitFor(() =>
        expect(sibling.result.current.state.nodesById.root?.isStarred).toBe(true)
      );
      await act(async () =>
        rendered.result.current.actions.selectLibraryView("trash")
      );
      const session = sessions.at(-1)!;
      const cursorBefore = session.history.next("undo");
      expect(cursorBefore?.kind).toBe("navigation");
      rejectTrashProjection = true;

      await act(async () => rendered.result.current.actions.emptyTrash());

      expect(emptyTrash).toHaveBeenCalledWith(
        "/task-5-empty-projection",
        expect.objectContaining({
          sessionId: session.history.sessionId,
          historyEpoch: "epoch-a"
        })
      );
      expect(rendered.result.current.state.rootIds).toEqual([deleted.id]);
      expect(rendered.result.current.canUndo).toBe(true);
      expect(session.history.historyEpoch).toBe("epoch-a");
      expect(session.history.next("undo")).toEqual(cursorBefore);
      expect(publishFeedback).toHaveBeenCalledWith({
        kind: "error",
        message: "Trash projection failed"
      });
      expect(sibling.result.current.state.nodesById.root?.isStarred).toBe(true);
      expect(sibling.result.current.state.nodesById.deleted).toBeDefined();
      expect(sibling.result.current.canUndo).toBe(true);
    } finally {
      rendered.unmount();
      sibling.unmount();
      openSession.mockRestore();
    }
  });

  it("drains cleanup before replay preflight and backend replay", async () => {
    const initial = workspace([node({ id: "root" })]);
    const starred = workspace([node({ id: "root", isStarred: true })]);
    const completed = workspace([
      node({ id: "root", completedAt: "2026-07-18T00:00:00Z" })
    ]);
    const calls: string[] = [];
    let firstEntryId: string | null = null;
    let secondEntryId: string | null = null;
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) => {
      firstEntryId = context.entryId;
      return mutationResult(starred, context);
    });
    const toggleComplete = vi.fn(async (_vaultRoot, _nodeId, context) => {
      secondEntryId = context.entryId;
      return mutationResult(completed, context);
    });
    const undo = vi.fn(async (_vaultRoot, input) => {
      calls.push("replay");
      return appliedReplay(
        input.expectedEntryId === firstEntryId ? initial : starred,
        input.expectedEntryId,
        "undo"
      );
    });
    const historyStatus = vi.fn(async () => {
      calls.push("status");
      return {
        ...historyState(),
        canUndo: true,
        nextUndoEntryId: secondEntryId
      };
    });
    const pruneHistoryEntries = vi.fn(async () => {
      calls.push("cleanup");
      return {
        ...historyState(),
        canUndo: true,
        nextUndoEntryId: secondEntryId
      };
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleStar,
      toggleComplete,
      undo,
      historyStatus,
      pruneHistoryEntries
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-cleanup-order", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.toggleStar("root"));
    historyStatus.mockImplementationOnce(async () => ({
      ...historyState(),
      canUndo: true,
      nextUndoEntryId: firstEntryId
    }));
    await act(async () => result.current.actions.undo!());
    await act(async () => result.current.actions.toggleComplete("root"));
    calls.length = 0;

    await act(async () => result.current.actions.undo!());

    expect(calls).toEqual(["cleanup", "status", "replay"]);
    expect(pruneHistoryEntries).toHaveBeenCalledWith(
      "/task-5-cleanup-order",
      expect.objectContaining({ entryIds: [firstEntryId] })
    );
  });

  it.each(["acceptance", "entryNotNext"] as const)(
    "blocks later replay and mutation after %s recovery cannot reset history",
    async (failureKind) => {
      const initial = workspace([node({ id: "root" })]);
      const starred = workspace([node({ id: "root", isStarred: true })]);
      const publishFeedback = vi.fn();
      const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) =>
        mutationResult(starred, context)
      );
      const toggleComplete = vi.fn();
      const undo = vi.fn(async () => {
        const entryId = toggleStar.mock.calls[0]?.[2]?.entryId ?? null;
        return failureKind === "acceptance"
          ? {
              ...appliedReplay(initial, entryId, "undo"),
              nextRedoEntryId: "inconsistent-entry"
            }
          : {
              kind: "entryNotNext" as const,
              ...historyState(),
              canUndo: true,
              nextUndoEntryId: entryId
            };
      });
      const clearHistory = vi.fn().mockResolvedValue({
        ...historyState("epoch-b"),
        historyReset: false
      });
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(initial),
        toggleStar,
        toggleComplete,
        undo,
        clearHistory
      });
      const rendered = renderHook(() =>
        useNotesWorkspace({
          vaultRoot: `/task-5-replay-block-${failureKind}`,
          repository: store,
          publishFeedback
        })
      );
      try {
        await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
        await act(async () => rendered.result.current.actions.toggleStar("root"));

        await act(async () => rendered.result.current.actions.undo!());

        expect(publishFeedback).toHaveBeenCalledWith({
          kind: "error",
          message:
            "Undo/Redo history could not be synchronized. Close and reopen this Vault."
        });
        await act(async () => {
          await rendered.result.current.actions.undo!();
          await rendered.result.current.actions.toggleComplete("root");
        });
        expect(undo).toHaveBeenCalledOnce();
        expect(toggleComplete).not.toHaveBeenCalled();
      } finally {
        rendered.unmount();
      }
    }
  );

  it("accepts a text mutation before its flush action completes", async () => {
    const initial = workspace([node({ id: "root", title: "Before" })]);
    const saved = workspace([node({ id: "root", title: "After" })]);
    const response = deferred<NotesMutationResult>();
    const updateNode = vi.fn().mockReturnValue(response.promise);
    const sessions: NotesWorkspaceCoordinatorSession[] = [];
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        sessions.push(session);
        return session;
      });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/task-5-text-settlement",
        repository: store
      })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      const order: string[] = [];
      const session = sessions.at(-1)!;
      const acceptMutationResult = session.history.acceptMutationResult.bind(
        session.history
      );
      vi.spyOn(session.history, "acceptMutationResult").mockImplementation(
        (...args) => {
          order.push("accept");
          return acceptMutationResult(...args);
        }
      );
      act(() =>
        rendered.result.current.actions.updateNodeDraft("root", {
          title: "After",
          note: ""
        , imageOffsetUtf16: 0})
      );
      const completion = rendered.result.current.actions
        .flushNodeDraft("root")
        .then((value) => {
          order.push("complete");
          return value;
        });
      await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
      const context = updateNode.mock.calls[0]?.[2];
      response.resolve(mutationResult(saved, context));
      await act(async () => completion);

      expect(order).toEqual(["accept", "complete"]);
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("accepts a compound structural mutation before its action completes", async () => {
    const initial = workspace([node({ id: "root", title: "Before" })]);
    const saved = workspace([node({ id: "root", title: "Root" })]);
    const split = workspace([
      node({ id: "root" }),
      node({ id: "split", sortKey: 2048 })
    ]);
    const response = deferred<NotesMutationResult>();
    const splitNode = vi.fn().mockReturnValue(response.promise);
    const updateNode = vi.fn(async (_vaultRoot, _input, context) =>
      mutationResult(saved, context)
    );
    const sessions: NotesWorkspaceCoordinatorSession[] = [];
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        sessions.push(session);
        return session;
      });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      splitNode
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-compound-settlement", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      const order: string[] = [];
      const session = sessions.at(-1)!;
      const acceptMutationResult = session.history.acceptMutationResult.bind(
        session.history
      );
      vi.spyOn(session.history, "acceptMutationResult").mockImplementation(
        (...args) => {
          order.push("accept");
          return acceptMutationResult(...args);
        }
      );
      const completion = rendered.result.current.actions
        .splitNode("root", "split", "Root", "", {
          draft: { title: "Root", note: "" , imageOffsetUtf16: 0}
        })
        .then((value) => {
          order.push("complete");
          return value;
        });
      await waitFor(() => expect(splitNode).toHaveBeenCalledOnce());
      const context = splitNode.mock.calls[0]?.[2];
      response.resolve(mutationResult(split, context));
      await act(async () => completion);

      expect(updateNode).toHaveBeenCalledOnce();
      expect(order).toEqual(["accept", "accept", "complete"]);
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("preflights shared history before replaying the exact mutation entry", async () => {
    const initial = workspace([node({ id: "root" })]);
    const starred = workspace([node({ id: "root", isStarred: true })]);
    const calls: string[] = [];
    let entryId: string | null = null;
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) => {
      entryId = context.entryId;
      return mutationResult(starred, context);
    });
    const historyStatus = vi.fn(async () => {
      calls.push("status");
      return {
        ...historyState(),
        canUndo: true,
        nextUndoEntryId: entryId
      };
    });
    const undo = vi.fn(async (_vaultRoot, input) => {
      calls.push("undo");
      return appliedReplay(initial, input.expectedEntryId, "undo");
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleStar,
      historyStatus,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-replay-preflight", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.toggleStar("root"));
    await act(async () => result.current.actions.undo!());

    expect(calls).toEqual(["status", "undo"]);
    expect(undo).toHaveBeenCalledWith(
      "/task-5-replay-preflight",
      expect.objectContaining({ expectedEntryId: entryId })
    );
  });

  it("restores a local navigation location without asking the backend to replay", async () => {
    const active = workspace([node({ id: "active" })]);
    const tagged = workspace([node({ id: "tagged", isCollapsed: true })]);
    const historyStatus = vi.fn().mockResolvedValue(historyState());
    const redo = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn((_vaultRoot, scope) =>
        Promise.resolve(scope?.kind === "tags" ? tagged : active)
      ),
      historyStatus,
      redo
    });
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    let capturedSession: NotesWorkspaceCoordinatorSession | null = null;
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        capturedSession = session;
        return session;
      });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-navigation", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      const session = capturedSession as unknown as NotesWorkspaceCoordinatorSession;
      const before: NotesHistorySnapshot = {
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        selectedId: "active",
        zoomRootId: "active",
        expansion: notesExpansionSnapshotPool.acquire(["active"]),
        focus: { nodeId: "active", field: "title" }
      };
      const after: NotesHistorySnapshot = {
        scope: { kind: "tags", tags: [] },
        libraryView: "tags",
        activeTagFilters: [],
        selectedId: "tagged",
        zoomRootId: "tagged",
        expansion: notesExpansionSnapshotPool.acquire(["tagged"]),
        focus: { nodeId: "tagged", field: "note" }
      };
      session.history.appendNavigation(before, after);
      session.history.commitReplay("undo");

      await act(async () => rendered.result.current.actions.redo!());

      expect(historyStatus).toHaveBeenCalledWith(
        "/task-5-navigation",
        session.history.sessionId
      );
      expect(redo).not.toHaveBeenCalled();
      expect(rendered.result.current.canUndo).toBe(true);
      expect(rendered.result.current.canRedo).toBe(false);
      expect(rendered.result.current).toMatchObject({
        libraryView: "tags",
        activeTagFilters: [],
        locallyExpandedNodeIds: new Set(["tagged"])
      });
      expect(rendered.result.current.state).toMatchObject({
        selectedId: "tagged",
        zoomRootId: "tagged",
        editingNoteId: "tagged",
        pendingFocusId: "tagged",
        pendingFocusField: "note"
      });
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("normalizes a stale replay selection to one legal caret without dropping the replay", async () => {
    const initial = workspace([node({ id: "root", title: "😀" })]);
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    let session: NotesWorkspaceCoordinatorSession | null = null;
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const opened = realOpenSession(options);
        session = opened;
        return opened;
      });
    const store = repository({ loadWorkspace: vi.fn().mockResolvedValue(initial) });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/replay-stale-selection",
        repository: store
      })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      const before: NotesHistorySnapshot = {
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        selectedId: "root",
        zoomRootId: "root",
        expansion: notesExpansionSnapshotPool.acquire(["root"]),
        focus: { nodeId: "root", field: "title" }
      };
      const stale: NotesHistorySnapshot = {
        ...before,
        expansion: notesExpansionSnapshotPool.acquire(["root"]),
        focus: {
          nodeId: "root",
          field: "title",
          primarySelection: { anchorUtf16: 1, focusUtf16: 99 }
        }
      };
      session!.history.appendNavigation(before, stale);
      session!.history.commitReplay("undo");

      await act(async () => rendered.result.current.actions.redo!());

      expect(rendered.result.current.state.nodesById.root?.title).toBe("😀");
      expect(
        (
          rendered.result.current as typeof rendered.result.current & {
            pendingPrimarySelection?: {
              selection: { anchorUtf16: number; focusUtf16: number };
            } | null;
          }
        ).pendingPrimarySelection
      ).toMatchObject({ selection: { anchorUtf16: 2, focusUtf16: 2 } });
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("drops a missing replay focus without aborting its resolved workspace location", async () => {
    const initial = workspace([node({ id: "root", title: "survives" })]);
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    let session: NotesWorkspaceCoordinatorSession | null = null;
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const opened = realOpenSession(options);
        session = opened;
        return opened;
      });
    const store = repository({ loadWorkspace: vi.fn().mockResolvedValue(initial) });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/replay-missing-focus",
        repository: store
      })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      const before: NotesHistorySnapshot = {
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        selectedId: "root",
        zoomRootId: "root",
        expansion: notesExpansionSnapshotPool.acquire(["root"]),
        focus: { nodeId: "root", field: "title" }
      };
      const missing: NotesHistorySnapshot = {
        ...before,
        expansion: notesExpansionSnapshotPool.acquire(["root"]),
        focus: {
          nodeId: "missing",
          field: "title",
          primarySelection: { anchorUtf16: 0, focusUtf16: 1 }
        }
      };
      session!.history.appendNavigation(before, missing);
      session!.history.commitReplay("undo");

      await act(async () => rendered.result.current.actions.redo!());

      expect(rendered.result.current.state.nodesById.root?.title).toBe("survives");
      expect(rendered.result.current.state.pendingFocusId).toBeNull();
      expect(
        (
          rendered.result.current as typeof rendered.result.current & {
            pendingPrimarySelection?: unknown;
          }
        ).pendingPrimarySelection
      ).toBeNull();
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("keeps a newer same-control replay request when an older acknowledgement arrives", async () => {
    const initial = workspace([node({ id: "root", title: "abcdef" })]);
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    let session: NotesWorkspaceCoordinatorSession | null = null;
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const opened = realOpenSession(options);
        session = opened;
        return opened;
      });
    const store = repository({ loadWorkspace: vi.fn().mockResolvedValue(initial) });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/replay-request-ownership",
        repository: store
      })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      const location = (
        selection: { anchorUtf16: number; focusUtf16: number } | null
      ): NotesHistorySnapshot => ({
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        selectedId: "root",
        zoomRootId: "root",
        expansion: notesExpansionSnapshotPool.acquire(["root"]),
        focus: selection
          ? { nodeId: "root", field: "title", primarySelection: selection }
          : { nodeId: "root", field: "title" }
      });
      const base = location(null);
      const first = location({ anchorUtf16: 1, focusUtf16: 3 });
      const second = location({ anchorUtf16: 5, focusUtf16: 2 });
      session!.history.appendNavigation(base, first);
      session!.history.appendNavigation(first, second);
      session!.history.commitReplay("undo");
      session!.history.commitReplay("undo");

      await act(async () => rendered.result.current.actions.redo!());
      const firstRequest = (
        rendered.result.current as typeof rendered.result.current & {
          pendingPrimarySelection?: {
            requestId: number;
            selection: { anchorUtf16: number; focusUtf16: number };
          } | null;
        }
      ).pendingPrimarySelection;
      expect(firstRequest).toMatchObject({
        selection: { anchorUtf16: 1, focusUtf16: 3 }
      });

      await act(async () => rendered.result.current.actions.redo!());
      const secondRequest = (
        rendered.result.current as typeof rendered.result.current & {
          pendingPrimarySelection?: {
            requestId: number;
            selection: { anchorUtf16: number; focusUtf16: number };
          } | null;
        }
      ).pendingPrimarySelection;
      expect(secondRequest).toMatchObject({
        selection: { anchorUtf16: 5, focusUtf16: 2 }
      });
      expect(secondRequest!.requestId).toBeGreaterThan(firstRequest!.requestId);

      await act(async () =>
        (
          rendered.result.current.actions as typeof rendered.result.current.actions & {
            acknowledgeFocus(nodeId: string, requestId?: number): Promise<void>;
          }
        ).acknowledgeFocus("root", firstRequest!.requestId)
      );
      expect(
        (
          rendered.result.current as typeof rendered.result.current & {
            pendingPrimarySelection?: { requestId: number } | null;
          }
        ).pendingPrimarySelection?.requestId
      ).toBe(secondRequest!.requestId);
      expect(rendered.result.current.state.pendingFocusId).toBe("root");

      await act(async () =>
        (
          rendered.result.current.actions as typeof rendered.result.current.actions & {
            acknowledgeFocus(nodeId: string, requestId?: number): Promise<void>;
          }
        ).acknowledgeFocus("root", secondRequest!.requestId)
      );
      expect(rendered.result.current.state.pendingFocusId).toBeNull();
      expect(
        (
          rendered.result.current as typeof rendered.result.current & {
            pendingPrimarySelection?: unknown;
          }
        ).pendingPrimarySelection
      ).toBeNull();
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("retires a replay selection when editing focus moves to another row", async () => {
    const initial = workspace([node({ id: "root" }), node({ id: "other" })]);
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    let session: NotesWorkspaceCoordinatorSession | null = null;
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const opened = realOpenSession(options);
        session = opened;
        return opened;
      });
    const store = repository({ loadWorkspace: vi.fn().mockResolvedValue(initial) });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/replay-editing-focus-retire", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      const before: NotesHistorySnapshot = {
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        selectedId: "root",
        zoomRootId: "root",
        expansion: notesExpansionSnapshotPool.acquire(["root"]),
        focus: { nodeId: "root", field: "title" }
      };
      const replay: NotesHistorySnapshot = {
        ...before,
        expansion: notesExpansionSnapshotPool.acquire(["root"]),
        focus: {
          nodeId: "root",
          field: "title",
          primarySelection: { anchorUtf16: 1, focusUtf16: 3 }
        }
      };
      session!.history.appendNavigation(before, replay);
      session!.history.commitReplay("undo");

      await act(async () => rendered.result.current.actions.redo!());
      expect(rendered.result.current.pendingPrimarySelection).not.toBeNull();

      act(() => rendered.result.current.actions.markEditingFocus?.("other", "title"));

      expect(rendered.result.current.pendingPrimarySelection).toBeNull();
      expect(rendered.result.current.state.pendingFocusId).toBeNull();
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("retires a replay selection when typing in its same title field", async () => {
    const initial = workspace([node({ id: "root", title: "before" })]);
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    let session: NotesWorkspaceCoordinatorSession | null = null;
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const opened = realOpenSession(options);
        session = opened;
        return opened;
      });
    const store = repository({ loadWorkspace: vi.fn().mockResolvedValue(initial) });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/replay-draft-retire", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      const before: NotesHistorySnapshot = {
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        selectedId: "root",
        zoomRootId: "root",
        expansion: notesExpansionSnapshotPool.acquire(["root"]),
        focus: { nodeId: "root", field: "title" }
      };
      const replay: NotesHistorySnapshot = {
        ...before,
        expansion: notesExpansionSnapshotPool.acquire(["root"]),
        focus: {
          nodeId: "root",
          field: "title",
          primarySelection: { anchorUtf16: 1, focusUtf16: 3 }
        }
      };
      session!.history.appendNavigation(before, replay);
      session!.history.commitReplay("undo");

      await act(async () => rendered.result.current.actions.redo!());
      expect(rendered.result.current.pendingPrimarySelection).not.toBeNull();

      act(() =>
        rendered.result.current.actions.updateNodeDraft(
          "root",
          { title: "typed", note: "", imageOffsetUtf16: 0 },
          "title"
        )
      );

      await waitFor(() =>
        expect(rendered.result.current.draftsByNodeId.root).toBeDefined()
      );
      expect(rendered.result.current.pendingPrimarySelection).toBeNull();
      expect(rendered.result.current.state.pendingFocusId).toBeNull();
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("keeps the page and timeline when Empty Trash lacks an acknowledged reset", async () => {
    const initial = workspace([node({ id: "root" })]);
    const starred = workspace([node({ id: "root", isStarred: true })]);
    const publishFeedback = vi.fn();
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) =>
      mutationResult(starred, context)
    );
    const emptyTrash = vi.fn().mockResolvedValue({
      workspace: workspace([]),
      ...historyState("epoch-b"),
      historyReset: false
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleStar,
      emptyTrash
    });
    const options = {
      vaultRoot: "/task-5-empty-trash",
      repository: store,
      publishFeedback
    } as Parameters<typeof useNotesWorkspace>[0] & {
      publishFeedback: typeof publishFeedback;
    };
    const owner = renderHook(() => useNotesWorkspace(options));
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));

    await act(async () => owner.result.current.actions.toggleStar("root"));
    const mutationContext = toggleStar.mock.calls[0]?.[2];
    expect(owner.result.current.canUndo).toBe(true);
    await act(async () => owner.result.current.actions.emptyTrash());

    expect(emptyTrash).toHaveBeenCalledWith("/task-5-empty-trash", {
      sessionId: mutationContext.sessionId,
      historyEpoch: "epoch-a"
    });
    expect(owner.result.current.canUndo).toBe(true);
    expect(owner.result.current.state.nodesById.root?.isStarred).toBe(true);
    expect(publishFeedback).toHaveBeenCalledWith({
      kind: "error",
      message: "Empty Trash did not acknowledge the history reset."
    });
    const survivor = renderHook(() => useNotesWorkspace(options));
    await waitFor(() => expect(survivor.result.current.status).toBe("ready"));
    expect(survivor.result.current.canUndo).toBe(true);
    expect(survivor.result.current.state.nodesById.root?.isStarred).toBe(true);
    owner.unmount();
    survivor.unmount();
  });

  it("projects Empty Trash before resetting the shared timeline", async () => {
    const calls: string[] = [];
    const completed = workspace([
      node({ id: "root", isStarred: true, completedAt: "2026-07-18T00:00:00Z" })
    ]);
    let emptied = false;
    const loadWorkspace = vi.fn(async () => {
      if (emptied) calls.push("projection");
      return emptied ? workspace([]) : completed;
    });
    const emptyTrash = vi.fn(async () => {
      calls.push("empty");
      emptied = true;
      return {
        workspace: workspace([]),
        ...historyState("epoch-b"),
        historyReset: true as const
      };
    });
    const toggleComplete = vi.fn(async (_vaultRoot, _nodeId, context) =>
      mutationResult(completed, context)
    );
    const sessions: NotesWorkspaceCoordinatorSession[] = [];
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        sessions.push(session);
        return session;
      });
    const store = repository({
      loadWorkspace,
      toggleComplete,
      emptyTrash
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-empty-order", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      await act(async () => rendered.result.current.actions.toggleComplete("root"));
      const mutationContext = toggleComplete.mock.calls[0]?.[2];
      await act(async () =>
        rendered.result.current.actions.selectLibraryView("starred")
      );
      const session = sessions.at(-1)!;
      const resetHistory = session.resetHistory.bind(session);
      vi.spyOn(session, "resetHistory").mockImplementation((epoch, location) => {
        calls.push("reset");
        resetHistory(epoch, location);
      });
      calls.length = 0;

      await act(async () => rendered.result.current.actions.emptyTrash());

      expect(calls).toEqual(["empty", "projection", "reset"]);
      expect(emptyTrash).toHaveBeenCalledWith("/task-5-empty-order", {
        sessionId: mutationContext.sessionId,
        historyEpoch: "epoch-a"
      });
      expect(rendered.result.current.state.rootIds).toEqual([]);
      expect(rendered.result.current.canUndo).toBe(false);
      expect(session.history.historyEpoch).toBe("epoch-b");
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("recovers a preflight mismatch without replaying or moving the cursor", async () => {
    const initial = workspace([node({ id: "root" })]);
    const starred = workspace([node({ id: "root", isStarred: true })]);
    const undo = vi.fn();
    const clearHistory = vi.fn().mockResolvedValue({
      ...historyState("epoch-b"),
      historyReset: true
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleStar: vi.fn(async (_vaultRoot, _nodeId, context) =>
        mutationResult(starred, context)
      ),
      historyStatus: vi.fn().mockResolvedValue({
        ...historyState(),
        canUndo: true,
        nextUndoEntryId: "backend-only-entry"
      }),
      clearHistory,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-preflight-mismatch", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.toggleStar("root"));
    expect(result.current.canUndo).toBe(true);

    await act(async () => result.current.actions.undo!());

    expect(undo).not.toHaveBeenCalled();
    expect(clearHistory).toHaveBeenCalledOnce();
    await waitFor(() => expect(result.current.canUndo).toBe(false));
    expect(result.current.state.nodesById.root?.isStarred).toBe(false);
  });

  it("preserves the navigation cursor when its target scope cannot load", async () => {
    const active = workspace([node({ id: "active" })]);
    const publishFeedback = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn((_vaultRoot, scope) =>
        scope?.kind === "tags"
          ? Promise.reject(new Error("offline"))
          : Promise.resolve(active)
      ),
      historyStatus: vi.fn().mockResolvedValue(historyState()),
      redo: vi.fn()
    });
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    let capturedSession: NotesWorkspaceCoordinatorSession | null = null;
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        capturedSession = session;
        return session;
      });
    const survivor = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/task-5-navigation-missing",
        repository: store,
        publishFeedback
      })
    );
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/task-5-navigation-missing",
        repository: store,
        publishFeedback
      })
    );
    let ownerMounted = true;
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      await waitFor(() => expect(survivor.result.current.status).toBe("ready"));
      await act(async () => rendered.result.current.actions.focusNode("active"));
      expect(rendered.result.current.state).toMatchObject({
        selectedId: "active",
        editingNoteId: "active",
        pendingFocusId: "active",
        pendingFocusField: "title"
      });
      const before: NotesHistorySnapshot = {
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        selectedId: "active",
        zoomRootId: null,
        expansion: notesExpansionSnapshotPool.acquire([]),
        focus: { nodeId: "active", field: "title" }
      };
      const after: NotesHistorySnapshot = {
        ...before,
        scope: { kind: "tags", tags: [] },
        libraryView: "tags",
        expansion: notesExpansionSnapshotPool.acquire([])
      };
      const session = capturedSession as unknown as NotesWorkspaceCoordinatorSession;
      const historyEpoch = session.history.historyEpoch;
      session.history.appendNavigation(before, after);
      session.history.commitReplay("undo");

      await act(async () => rendered.result.current.actions.redo!());

      expect(store.redo).not.toHaveBeenCalled();
      expect(session.history.next("redo")?.kind).toBe("navigation");
      expect(session.history.historyEpoch).toBe(historyEpoch);
      expect(rendered.result.current).toMatchObject({
        libraryView: "all",
        canUndo: false,
        canRedo: true
      });
      expect(rendered.result.current.state.rootIds).toEqual(["active"]);
      expect(rendered.result.current.state).toMatchObject({
        selectedId: "active",
        editingNoteId: "active",
        pendingFocusId: "active",
        pendingFocusField: "title"
      });
      expect(publishFeedback).toHaveBeenCalledWith({
        kind: "error",
        message: "Undo/Redo history could not restore its saved location."
      });
      rendered.unmount();
      ownerMounted = false;
      await waitFor(() =>
        expect(survivor.result.current.state).toMatchObject({
          selectedId: "active",
          editingNoteId: "active",
          pendingFocusId: "active",
          pendingFocusField: "title"
        })
      );
      expect(survivor.result.current.libraryView).toBe("all");
      expect(survivor.result.current.state.rootIds).toEqual(["active"]);
    } finally {
      if (ownerMounted) rendered.unmount();
      survivor.unmount();
      openSession.mockRestore();
    }
  });

  it("installs successful navigation replay canonically after owner transfer", async () => {
    const active = workspace([node({ id: "active" })]);
    const tagged = workspace([node({ id: "tagged" })]);
    const taggedLoad = deferred<NotesWorkspace>();
    let deferTaggedLoad = false;
    const store = repository({
      loadWorkspace: vi.fn((_vaultRoot, scope) =>
        scope.kind === "tags" && deferTaggedLoad
          ? taggedLoad.promise
          : Promise.resolve(scope.kind === "tags" ? tagged : active)
      ),
      historyStatus: vi.fn().mockResolvedValue(historyState())
    });
    const sessions: NotesWorkspaceCoordinatorSession[] = [];
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        sessions.push(session);
        return session;
      });
    const survivor = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-nav-transfer", repository: store })
    );
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-nav-transfer", repository: store })
    );
    try {
      await waitFor(() => expect(owner.result.current.status).toBe("ready"));
      await waitFor(() => expect(survivor.result.current.status).toBe("ready"));
      const session = sessions.at(-1)!;
      const before: NotesHistorySnapshot = {
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        selectedId: "active",
        zoomRootId: null,
        expansion: notesExpansionSnapshotPool.acquire([]),
        focus: null
      };
      const after: NotesHistorySnapshot = {
        scope: { kind: "tags", tags: [] },
        libraryView: "tags",
        activeTagFilters: [],
        selectedId: "tagged",
        zoomRootId: "tagged",
        expansion: notesExpansionSnapshotPool.acquire(["tagged"]),
        focus: { nodeId: "tagged", field: "note" }
      };
      session.history.appendNavigation(before, after);
      session.history.commitReplay("undo");
      deferTaggedLoad = true;

      let replay!: Promise<void>;
      act(() => {
        replay = owner.result.current.actions.redo!();
      });
      await waitFor(() =>
        expect(store.loadWorkspace).toHaveBeenCalledWith(
          "/task-5-nav-transfer",
          expect.objectContaining({ kind: "tags" })
        )
      );
      owner.unmount();
      taggedLoad.resolve(tagged);
      await act(async () => replay);

      await waitFor(() => {
        expect(survivor.result.current.libraryView).toBe("tags");
        expect(survivor.result.current.state.rootIds).toEqual(["tagged"]);
      });
      expect(survivor.result.current.state).toMatchObject({
        selectedId: "tagged",
        zoomRootId: "tagged",
        pendingFocusId: "tagged",
        pendingFocusField: "note"
      });
      expect(session.history.next("redo")).toBeNull();
    } finally {
      survivor.unmount();
      openSession.mockRestore();
    }
  });

  it("awaits wrong atomic mutation IDs, recovers, and never publishes their projection", async () => {
    const initial = workspace([node({ id: "root" })]);
    const stale = workspace([node({ id: "root", isStarred: true })]);
    const reset = deferred<NotesHistoryState & { historyReset: true }>();
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) => ({
      workspace: stale,
      historyEntryId: "wrong-history-entry",
      ...historyState(),
      canUndo: true,
      nextUndoEntryId: context.entryId
    }));
    const clearHistory = vi.fn().mockReturnValue(reset.promise);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleStar,
      historyStatus: vi.fn().mockResolvedValue(historyState()),
      clearHistory
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-wrong-mutation", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let first!: Promise<unknown>;
    act(() => {
      first = result.current.actions.toggleStar("root");
    });
    await waitFor(() => expect(clearHistory).toHaveBeenCalledOnce());
    act(() => {
      void result.current.actions.toggleStar("root");
    });
    expect(toggleStar).toHaveBeenCalledOnce();

    reset.resolve({ ...historyState("epoch-b"), historyReset: true });
    await act(async () => first);
    expect(result.current.state.nodesById.root?.isStarred).toBe(false);
  });

  it("recovers a correct-ID atomic mutation with an invalid history state", async () => {
    const initial = workspace([node({ id: "root" })]);
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) => ({
      workspace: workspace([node({ id: "root", isStarred: true })]),
      historyEntryId: context.entryId,
      ...historyState(context.historyEpoch),
      canUndo: false,
      nextUndoEntryId: context.entryId
    }));
    const clearHistory = vi.fn().mockResolvedValue({
      ...historyState("epoch-b"),
      historyReset: true
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleStar,
      clearHistory
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-invalid-state", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.toggleStar("root"));

    expect(clearHistory).toHaveBeenCalledOnce();
    expect(result.current.state.nodesById.root?.isStarred).toBe(false);
    expect(result.current.canUndo).toBe(false);
  });

  it("does not let a projection failure mask a later reused wrong mutation ID", async () => {
    const initial = workspace([node({ id: "root" })]);
    const starred = workspace([node({ id: "root", isStarred: true })]);
    let rejectNextProjection = false;
    const loadWorkspace = vi.fn(async () => {
      if (rejectNextProjection) {
        rejectNextProjection = false;
        throw new Error("projection unavailable");
      }
      return initial;
    });
    const toggleStar = vi.fn(async () => ({
      workspace: starred,
      historyEntryId: "reused-wrong-id",
      ...historyState(),
      canUndo: true,
      nextUndoEntryId: "reused-wrong-id"
    }));
    const clearHistory = vi
      .fn()
      .mockResolvedValueOnce({ ...historyState("epoch-b"), historyReset: true })
      .mockResolvedValueOnce({ ...historyState("epoch-c"), historyReset: true });
    const store = repository({ loadWorkspace, toggleStar, clearHistory });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-projection-marker", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("starred"));

    rejectNextProjection = true;
    await act(async () => result.current.actions.toggleStar("root"));
    expect(clearHistory).toHaveBeenCalledOnce();

    await act(async () => result.current.actions.toggleStar("root"));
    expect(clearHistory).toHaveBeenCalledTimes(2);
    expect(result.current.state.nodesById.root?.isStarred).toBe(false);
  });

  it("recovers a wrong inline text ID before a compound split can run", async () => {
    const initial = workspace([node({ id: "root", title: "before" })]);
    const stale = workspace([node({ id: "root", title: "stale draft" })]);
    const splitNode = vi.fn();
    const onSuccess = vi.fn();
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) =>
      mutationResult(initial, context)
    );
    const clearHistory = vi.fn().mockResolvedValue({
      ...historyState("epoch-b"),
      historyReset: true
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode: vi.fn(async () => ({
        workspace: stale,
        historyEntryId: "wrong-inline-entry",
        ...historyState(),
        canUndo: true,
        nextUndoEntryId: "wrong-inline-entry"
      })),
      splitNode,
      toggleStar,
      clearHistory
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-inline-mismatch", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.splitNode("root", "split", "pre", "post", {
        draft: { title: "stale draft", note: "" , imageOffsetUtf16: 0},
        onSuccess
      })
    );

    expect(clearHistory).toHaveBeenCalledOnce();
    expect(splitNode).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.state.nodesById.root?.title).toBe("before");
    await act(async () => result.current.actions.toggleStar("root"));
    expect(toggleStar).toHaveBeenCalledOnce();
  });

  it.each(["move", "remove"] as const)(
    "recovers a wrong inline text ID before a compound %s can run",
    async (operation) => {
      const initial = workspace([node({ id: "root", title: "before" })]);
      const stale = workspace([node({ id: "root", title: "stale draft" })]);
      const moveNode = vi.fn();
      const removeEmptyNode = vi.fn();
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(initial),
        updateNode: vi.fn(async () => ({
          workspace: stale,
          historyEntryId: "wrong-inline-entry",
          ...historyState(),
          canUndo: true,
          nextUndoEntryId: "wrong-inline-entry"
        })),
        moveNode,
        removeEmptyNode,
        clearHistory: vi.fn().mockResolvedValue({
          ...historyState("epoch-b"),
          historyReset: true
        })
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({
          vaultRoot: `/task-5-inline-${operation}`,
          repository: store
        })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));

      await act(async () => {
        if (operation === "move") {
          await result.current.actions.moveNode(
            { id: "root", parentId: null, afterId: null, beforeId: null },
            null,
            { draft: { title: "stale draft", note: "" , imageOffsetUtf16: 0} }
          );
        } else {
          await result.current.actions.removeEmptyNode("root", null, {
            draft: { title: "stale draft", note: "" , imageOffsetUtf16: 0}
          });
        }
      });

      expect(moveNode).not.toHaveBeenCalled();
      expect(removeEmptyNode).not.toHaveBeenCalled();
      expect(result.current.state.nodesById.root?.title).toBe("before");
    }
  );

  it("shares navigation-only availability and sanitizes its target for two live hooks", async () => {
    const active = workspace([
      node({ id: "active" }),
      node({ id: "origin-only", sortKey: 2048 })
    ]);
    const tagged = workspace([node({ id: "tagged" })]);
    const workFilter = { prefix: "#" as const, normalizedTag: "work" };
    const store = repository({
      loadWorkspace: vi.fn((_vaultRoot, scope) =>
        Promise.resolve(scope?.kind === "tags" ? tagged : active)
      ),
      historyStatus: vi.fn().mockResolvedValue(historyState())
    });
    const sessions: NotesWorkspaceCoordinatorSession[] = [];
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        sessions.push(session);
        return session;
      });
    const first = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-nav-siblings", repository: store })
    );
    const second = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-nav-siblings", repository: store })
    );
    try {
      await waitFor(() => expect(second.result.current.status).toBe("ready"));
      const session = sessions.at(-1)!;
      const before: NotesHistorySnapshot = {
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        selectedId: "active",
        zoomRootId: "active",
        expansion: notesExpansionSnapshotPool.acquire(["active"]),
        focus: { nodeId: "active", field: "title" }
      };
      const after: NotesHistorySnapshot = {
        scope: { kind: "tags", tags: [workFilter] },
        libraryView: "tags",
        activeTagFilters: [workFilter],
        selectedId: "missing-selection",
        zoomRootId: "missing-zoom",
        expansion: notesExpansionSnapshotPool.acquire(["missing-expansion"]),
        focus: { nodeId: "missing-focus", field: "note" },
        tagFilterOrigin: {
          scope: { kind: "active" },
          libraryView: "all",
          activeTagFilters: [],
          selectedId: "origin-only",
          zoomRootId: "active",
          expansion: notesExpansionSnapshotPool.acquire(["active"]),
          focus: { nodeId: "origin-only", field: "title" }
        }
      };
      session.history.appendNavigation(before, after);
      session.history.commitReplay("undo");

      await act(async () => second.result.current.actions.redo!());

      await waitFor(() => {
        expect(first.result.current.canUndo).toBe(true);
        expect(second.result.current.canUndo).toBe(true);
        expect(first.result.current.canRedo).toBe(false);
        expect(second.result.current.canRedo).toBe(false);
      });
      expect(second.result.current).toMatchObject({
        libraryView: "tags",
        locallyExpandedNodeIds: new Set()
      });
      expect(second.result.current.state).toMatchObject({
        selectedId: null,
        zoomRootId: null,
        editingNoteId: null,
        pendingFocusId: null,
        pendingFocusField: null
      });
      await act(async () =>
        second.result.current.actions.toggleTagFilter(workFilter)
      );
      expect(second.result.current).toMatchObject({
        libraryView: "all",
        locallyExpandedNodeIds: new Set(["active"])
      });
      expect(second.result.current.state).toMatchObject({
        selectedId: "origin-only",
        zoomRootId: "active",
        pendingFocusId: "origin-only",
        pendingFocusField: "title"
      });

      const mixedAfter: NotesHistorySnapshot = {
        ...after,
        selectedId: "tagged",
        zoomRootId: "missing-zoom",
        expansion: notesExpansionSnapshotPool.acquire([
          "tagged",
          "missing-expansion"
        ]),
        focus: { nodeId: "tagged", field: "note" }
      };
      session.history.appendNavigation(before, mixedAfter);
      session.history.commitReplay("undo");
      await act(async () => second.result.current.actions.redo!());

      expect(second.result.current.locallyExpandedNodeIds).toEqual(
        new Set(["tagged"])
      );
      expect(second.result.current.state).toMatchObject({
        selectedId: "tagged",
        zoomRootId: null,
        editingNoteId: "tagged",
        pendingFocusId: "tagged",
        pendingFocusField: "note"
      });
    } finally {
      first.unmount();
      second.unmount();
      openSession.mockRestore();
    }
  });

  it("keeps the tag-origin expansion retained by lifecycle canonical state after timeline reset", async () => {
    const root = node({ id: "root", isCollapsed: true });
    const child = node({ id: "child", parentId: root.id });
    const other = node({ id: "other", sortKey: 2048 });
    const initial = workspace([root, child, other]);
    const archived = workspace([other]);
    let archiveCommitted = false;
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "tags"
          ? archiveCommitted
            ? workspace([other])
            : initial
          : archiveCommitted
            ? archived
            : initial
      ),
      archiveNode: vi.fn(async (_vaultRoot, _nodeId, context) => {
        archiveCommitted = true;
        return mutationResult(archived, context);
      })
    });
    const sessions: NotesWorkspaceCoordinatorSession[] = [];
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        sessions.push(session);
        return session;
      });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-lifecycle-origin", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      await act(async () => rendered.result.current.actions.openSearchResult(child.id));
      expect(rendered.result.current.locallyExpandedNodeIds).toEqual(
        new Set([root.id])
      );
      await act(async () =>
        rendered.result.current.actions.toggleTagFilter({
          prefix: "#",
          normalizedTag: "work"
        })
      );

      await act(async () => rendered.result.current.actions.archiveNode(root.id));

      const session = sessions.at(-1)!;
      const accepted = session.history.next("undo");
      expect(accepted?.kind).toBe("mutation");
      const originExpansion = accepted!.after.tagFilterOrigin!.expansion;
      session.history.reset("epoch-b");
      expect(() => notesExpansionSnapshotPool.retain(originExpansion)).not.toThrow();
      notesExpansionSnapshotPool.release(originExpansion);
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("records an empty CreateRoot expansion when Starred transitions to All", async () => {
    createNoteIdMock.mockReturnValue("created");
    const collapsed = workspace([
      node({ id: "root", isStarred: true, isCollapsed: true }),
      node({ id: "child", parentId: "root" })
    ]);
    const created = workspace([
      ...collapsed.nodes,
      node({ id: "created", sortKey: 2048 })
    ]);
    let active = collapsed;
    const store = repository({
      loadWorkspace: vi.fn(async () => active),
      createNode: vi.fn(async (_vaultRoot, _input, context) => {
        active = created;
        return mutationResult(created, context);
      })
    });
    const sessions: NotesWorkspaceCoordinatorSession[] = [];
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        sessions.push(session);
        return session;
      });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-create-expansion", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      await act(async () => rendered.result.current.actions.selectLibraryView("starred"));
      const session = sessions.at(-1)!;
      const before: NotesHistorySnapshot = {
        scope: { kind: "starred" },
        libraryView: "starred",
        activeTagFilters: [],
        selectedId: null,
        zoomRootId: null,
        expansion: notesExpansionSnapshotPool.acquire([]),
        focus: null,
        tagFilterOrigin: null
      };
      const after: NotesHistorySnapshot = {
        ...before,
        expansion: notesExpansionSnapshotPool.acquire(["root"])
      };
      session.history.appendNavigation(before, after);
      session.history.commitReplay("undo");
      await act(async () => rendered.result.current.actions.redo!());
      expect(rendered.result.current.locallyExpandedNodeIds).toEqual(
        new Set(["root"])
      );

      await act(async () => rendered.result.current.actions.createRoot());

      const accepted = session.history.next("undo");
      expect(accepted?.kind).toBe("mutation");
      expect(accepted!.after).toMatchObject({
        libraryView: "all",
        expansion: { nodeIds: [] },
        tagFilterOrigin: null
      });
      expect(rendered.result.current).toMatchObject({
        libraryView: "all",
        locallyExpandedNodeIds: new Set()
      });
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("resets shared history and canonical state after Empty Trash owner transfer", async () => {
    const starred = workspace([node({ id: "root", isStarred: true })]);
    const emptied = workspace([]);
    const reset = deferred<NotesHistoryState & {
      historyReset: true;
      workspace: NotesWorkspace;
    }>();
    let emptiedCommitted = false;
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(() =>
        Promise.resolve(emptiedCommitted ? emptied : starred)
      ),
      toggleStar: vi.fn(async (_vaultRoot, _nodeId, context) =>
        mutationResult(starred, context)
      ),
      emptyTrash: vi.fn().mockReturnValue(reset.promise)
    });
    const sessions: NotesWorkspaceCoordinatorSession[] = [];
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        sessions.push(session);
        return session;
      });
    const first = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-empty-transfer", repository: store })
    );
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    await act(async () => first.result.current.actions.toggleStar("root"));
    expect(first.result.current.canUndo).toBe(true);

    let empty!: Promise<unknown>;
    act(() => {
      empty = first.result.current.actions.emptyTrash();
    });
    await waitFor(() => expect(store.emptyTrash).toHaveBeenCalledOnce());
    const second = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-5-empty-transfer", repository: store })
    );
    first.unmount();
    emptiedCommitted = true;
    reset.resolve({
      workspace: emptied,
      ...historyState("epoch-b"),
      historyReset: true
    });
    await act(async () => empty);

    await waitFor(() => {
      expect(second.result.current.status).toBe("ready");
      expect(second.result.current.canUndo).toBe(false);
      expect(second.result.current.canRedo).toBe(false);
      expect(second.result.current.state.rootIds).toEqual([]);
    });
    expect(sessions[0]!.history.historyEpoch).toBe("epoch-b");
    second.unmount();
    openSession.mockRestore();
  });
});
