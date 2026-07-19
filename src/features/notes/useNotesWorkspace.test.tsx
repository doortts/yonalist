import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, Suspense, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isNotesMutationResult, MAX_NOTE_ATTACHMENT_BATCH_BYTES, MAX_NOTE_ATTACHMENT_BYTES, type ImportImageNodeBytesInput, type NoteNode, type NotesHistoryContext, type NotesHistoryReplayOutcome, type NotesHistoryState, type NotesMutationResponse, type NotesMutationResult, type NotesStore, type NotesWorkspace, type NotesWorkspaceScope, type PendingImageNodeByteItem } from "../../domain/notes";
import { isNotesDraftsFlushFailedError, NOTES_DRAFTS_FLUSH_FAILED_CODE, resetImageImportRecoveryForTests, useNotesWorkspace, type NotesDeleteAllResult } from "./useNotesWorkspace";
import { notesWorkspaceCoordinatorRegistry, type NotesWorkspaceCoordinatorSession } from "./notesWorkspaceCoordinator";
import { type NotesHistorySession } from "./notesHistory";
import { journalNotesRepository } from "./testing/notesWorkspaceTestHarness";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sizedImageBlob(size: number): Blob {
  const blob = new Blob([new Uint8Array([0])], { type: "image/png" });
  Object.defineProperty(blob, "size", { value: size });
  return blob;
}

function pendingImageBatch(
  prefix: string,
  sizes: readonly number[]
): PendingImageNodeByteItem[] {
  return sizes.map((size, index) => ({
    originalName: `${prefix}-${index}.png`,
    mimeType: "image/png",
    blob: sizedImageBlob(size)
  }));
}

function strictMode({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>;
}

function suspenseMode({ children }: PropsWithChildren) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

function repository(overrides: Partial<NotesStore> = {}): NotesStore {
  const empty = vi.fn().mockResolvedValue(workspace([]));
  const store: NotesStore = {
    initialize: vi.fn().mockResolvedValue(historyState()),
    loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
    createNode: empty,
    updateNode: empty,
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

function historyContext(commandKind: string) {
  return expect.objectContaining({
    sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    historyEpoch: "epoch-a",
    entryId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    commandKind
  });
}

describe("useNotesWorkspace", () => {
  beforeEach(() => {
    createNoteIdMock.mockReset();
    notesHistorySpies.sessionsById.clear();
    notesHistorySpies.historyStatesBySessionId.clear();
    notesHistorySpies.discard.mockClear();
    notesHistorySpies.rememberAfter.mockClear();
    notesHistorySpies.acceptMutationResult.mockClear();
    notesHistorySpies.acceptReplayResult.mockClear();
  });

  afterEach(() => {
    resetImageImportRecoveryForTests();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("gates hook actions while Notes data deletion is in progress", async () => {
    const deletion = deferred<void>();
    const store = repository({
      deleteDatabase: vi.fn().mockReturnValue(deletion.promise),
      createNode: vi.fn().mockResolvedValue(workspace([node({ id: "created" })])),
      updateNode: vi.fn().mockResolvedValue(workspace([node({ id: "updated" })]))
    });
    createNoteIdMock.mockReturnValue("created");
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let deletionCompletion!: Promise<unknown>;
    act(() => {
      deletionCompletion = result.current.actions.deleteAllNotesData();
    });
    await waitFor(() => expect(store.deleteDatabase).toHaveBeenCalledOnce());
    expect(result.current.deletingNotesData).toBe(true);

    await act(async () => {
      result.current.actions.updateNodeDraft("root", {
        title: "Blocked draft",
        note: ""
      , imageOffsetUtf16: 0});
      await Promise.all([
        result.current.actions.createRoot(),
        result.current.actions.updateNode("root", {
          title: "Blocked update",
          note: ""
        }),
        result.current.actions.selectLibraryView("recent"),
        result.current.actions.searchNotes("blocked")
      ]);
    });

    expect(store.createNode).not.toHaveBeenCalled();
    expect(store.updateNode).not.toHaveBeenCalled();
    expect(store.search).not.toHaveBeenCalled();
    expect(store.loadWorkspace).toHaveBeenCalledOnce();
    expect(result.current.draftsByNodeId.root).toBeUndefined();

    await act(async () => {
      deletion.resolve();
      await deletionCompletion;
    });

    expect(result.current.deletingNotesData).toBe(false);
    expect(result.current.state.rootIds).toEqual([]);
    expect(store.loadWorkspace).toHaveBeenCalledOnce();
  });

  it("keeps same-vault hooks gated until deletion settles after the owner unmounts", async () => {
    const deletion = deferred<{ attachmentCleanupFailed: boolean }>();
    const store = repository({
      deleteDatabase: vi.fn().mockReturnValue(deletion.promise),
      createNode: vi.fn().mockResolvedValue(workspace([node({ id: "created" })]))
    });
    createNoteIdMock.mockReturnValue("created");
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-delete", repository: store })
    );
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-delete", repository: store })
    );
    await waitFor(() => {
      expect(owner.result.current.status).toBe("ready");
      expect(sibling.result.current.status).toBe("ready");
    });

    let deletionCompletion!: Promise<NotesDeleteAllResult>;
    act(() => {
      deletionCompletion = owner.result.current.actions.deleteAllNotesData();
    });
    await waitFor(() => expect(store.deleteDatabase).toHaveBeenCalledOnce());
    await waitFor(() => expect(sibling.result.current.deletingNotesData).toBe(true));

    owner.unmount();
    await act(async () => Promise.resolve());

    await act(async () => {
      sibling.result.current.actions.updateNodeDraft("root", {
        title: "Must not survive deletion",
        note: ""
      , imageOffsetUtf16: 0});
      expect(await sibling.result.current.actions.createRoot()).toBe("skipped");
    });
    expect(store.createNode).not.toHaveBeenCalled();
    expect(sibling.result.current.draftsByNodeId.root).toBeUndefined();
    expect(sibling.result.current.deletingNotesData).toBe(true);

    await act(async () => {
      deletion.resolve({ attachmentCleanupFailed: false });
      await deletionCompletion;
    });

    await waitFor(() => expect(sibling.result.current.deletingNotesData).toBe(false));
    expect(sibling.result.current.state.rootIds).toEqual([]);
    await act(async () => {
      expect(await sibling.result.current.actions.createRoot()).toBe("committed");
    });
    expect(store.createNode).toHaveBeenCalledOnce();
  });

  it("continues retained deletion after an immediate clean owner unmount", async () => {
    const deletion = deferred<{ attachmentCleanupFailed: boolean }>();
    const store = repository({
      deleteDatabase: vi.fn().mockReturnValue(deletion.promise)
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/clean-owner-close", repository: store })
    );
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/clean-owner-close", repository: store })
    );
    await waitFor(() => {
      expect(owner.result.current.status).toBe("ready");
      expect(sibling.result.current.status).toBe("ready");
    });

    let deletionCompletion!: Promise<NotesDeleteAllResult>;
    act(() => {
      deletionCompletion = owner.result.current.actions.deleteAllNotesData();
      owner.unmount();
    });
    await waitFor(() => expect(store.deleteDatabase).toHaveBeenCalledOnce());
    expect(sibling.result.current.deletingNotesData).toBe(true);

    await act(async () => {
      deletion.resolve({ attachmentCleanupFailed: false });
      await deletionCompletion;
    });

    expect(sibling.result.current.deletingNotesData).toBe(false);
    expect(sibling.result.current.state.rootIds).toEqual([]);
  });

  it("retains deletion when the owner unmounts during a sibling draft barrier", async () => {
    const draftWrite = deferred<NotesWorkspace>();
    const store = repository({
      updateNode: vi.fn().mockReturnValue(draftWrite.promise),
      deleteDatabase: vi.fn().mockResolvedValue({
        attachmentCleanupFailed: false
      })
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/barrier-delete", repository: store })
    );
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/barrier-delete", repository: store })
    );
    await waitFor(() => {
      expect(owner.result.current.status).toBe("ready");
      expect(sibling.result.current.status).toBe("ready");
    });
    act(() => {
      sibling.result.current.actions.updateNodeDraft("root", {
        title: "Saved before delete",
        note: ""
      , imageOffsetUtf16: 0});
    });

    let deletionCompletion!: Promise<NotesDeleteAllResult>;
    act(() => {
      deletionCompletion = owner.result.current.actions.deleteAllNotesData();
    });
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());
    expect(store.deleteDatabase).not.toHaveBeenCalled();

    owner.unmount();
    await act(async () => {
      draftWrite.resolve(
        workspace([node({ id: "root", title: "Saved before delete" })])
      );
      await deletionCompletion;
    });

    expect(store.deleteDatabase).toHaveBeenCalledWith("/barrier-delete");
    await waitFor(() => expect(sibling.result.current.deletingNotesData).toBe(false));
    expect(sibling.result.current.state.rootIds).toEqual([]);
    expect(sibling.result.current.draftsByNodeId.root).toBeUndefined();
  });

  it("cancels retained deletion when an unmounted participant draft fails", async () => {
    const draftWrite = deferred<NotesWorkspace>();
    const store = repository({
      updateNode: vi.fn().mockReturnValue(draftWrite.promise),
      deleteDatabase: vi.fn().mockResolvedValue({
        attachmentCleanupFailed: false
      })
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/failed-barrier", repository: store })
    );
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/failed-barrier", repository: store })
    );
    await waitFor(() => {
      expect(owner.result.current.status).toBe("ready");
      expect(sibling.result.current.status).toBe("ready");
    });
    act(() => {
      sibling.result.current.actions.updateNodeDraft("root", {
        title: "Must survive failed delete",
        note: ""
      , imageOffsetUtf16: 0});
    });

    let deletionCompletion!: Promise<NotesDeleteAllResult>;
    act(() => {
      deletionCompletion = owner.result.current.actions.deleteAllNotesData();
    });
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());
    sibling.unmount();

    let rejection: unknown;
    await act(async () => {
      draftWrite.reject(new Error("Draft save failed after close"));
      rejection = await deletionCompletion.then(
        () => undefined,
        (cause) => cause
      );
    });

    expect(isNotesDraftsFlushFailedError(rejection)).toBe(true);
    expect((rejection as Error).message).toBe("Draft save failed after close");
    expect(store.deleteDatabase).not.toHaveBeenCalled();
    expect(owner.result.current.deletingNotesData).toBe(false);
    expect(owner.result.current.state.nodesById.root).toBeDefined();
  });

  it("purges retained image retries after deleting all Notes data", async () => {
    const root = node({ id: "delete-retry-root" });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `98100000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    let replacementRootId = "";
    const deletion = deferred<{ attachmentCleanupFailed: boolean }>();
    const importImageNodeBytes = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost after commit"))
      .mockImplementation(
        async (
          _vaultRoot: string,
          input: ImportImageNodeBytesInput,
          context?: NotesHistoryContext | null
        ): Promise<NotesMutationResult> => ({
          workspace: workspace([
            node({ id: replacementRootId }),
            ...input.items.map((item, index) =>
              node({
                id: item.nodeId,
                nodeKind: "image",
                sortKey: 2048 + index * 1024
              })
            )
          ]),
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: input.items.map((item) => item.nodeId)
        })
      );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([root])),
      createNode: vi.fn(async (_vaultRoot, input) => {
        replacementRootId = input.id;
        return workspace([node({ id: replacementRootId })]);
      }),
      deleteDatabase: vi.fn().mockReturnValue(deletion.promise),
      importImageNodeBytes
    });
    const deleter = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/delete-retries", repository: store })
    );
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/delete-retries", repository: store })
    );
    await waitFor(() => {
      expect(owner.result.current.status).toBe("ready");
      expect(deleter.result.current.status).toBe("ready");
    });
    act(() => {
      owner.result.current.actions.setImageImportMaxDisplayWidth(320);
      deleter.result.current.actions.setImageImportMaxDisplayWidth(320);
    });
    const fullBatchSizes = Array.from(
      {
        length:
          MAX_NOTE_ATTACHMENT_BATCH_BYTES / MAX_NOTE_ATTACHMENT_BYTES
      },
      () => MAX_NOTE_ATTACHMENT_BYTES
    );

    await act(async () =>
      owner.result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("before-delete", fullBatchSizes)
      )
    );
    const retainedEntryId = importImageNodeBytes.mock.calls[0]?.[2]?.entryId;
    const retryAttemptId =
      owner.result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(retryAttemptId).toBeDefined();

    let deletionCompletion!: Promise<unknown>;
    act(() => {
      deletionCompletion = owner.result.current.actions.deleteAllNotesData();
    });
    await waitFor(() => expect(store.deleteDatabase).toHaveBeenCalledOnce());
    let retryCompletion!: Promise<void>;
    act(() => {
      retryCompletion = owner.result.current.actions.retryImageUpload!(
        root.id,
        retryAttemptId
      );
    });
    await act(async () => Promise.resolve());
    expect(importImageNodeBytes).toHaveBeenCalledOnce();
    await act(async () => {
      deletion.resolve({ attachmentCleanupFailed: false });
      await Promise.all([deletionCompletion, retryCompletion]);
    });
    expect(importImageNodeBytes).toHaveBeenCalledOnce();

    expect(owner.result.current.attachmentUploadErrorsByNodeId).toEqual({});
    expect(owner.result.current.attachmentUploadRetryAttemptIdsByNodeId).toEqual(
      {}
    );
    expect(deleter.result.current.attachmentUploadErrorsByNodeId).toEqual({});
    expect(
      deleter.result.current.attachmentUploadRetryAttemptIdsByNodeId
    ).toEqual({});
    expect(notesHistorySpies.discard).toHaveBeenCalledWith(retainedEntryId);

    await act(async () => owner.result.current.actions.createRoot());
    expect(replacementRootId).not.toBe("");
    await waitFor(() =>
      expect(owner.result.current.state.nodesById[replacementRootId]).toBeDefined()
    );
    await act(async () =>
      owner.result.current.actions.importClipboardImages!(
        replacementRootId,
        pendingImageBatch("after-delete", fullBatchSizes)
      )
    );

    expect(importImageNodeBytes).toHaveBeenCalledTimes(2);
    expect(
      owner.result.current.attachmentUploadErrorsByNodeId?.[replacementRootId]
    ).toBeUndefined();
  });

  it("does not clear new-vault image retries when an old-vault deletion settles", async () => {
    const deletion = deferred<{ attachmentCleanupFailed: boolean }>();
    const importImageNodeBytes = vi
      .fn()
      .mockRejectedValue(new Error("response lost after commit"));
    const store = repository({
      loadWorkspace: vi.fn(async (vaultRoot: string) =>
        workspace([
          node({ id: vaultRoot === "/vault-a" ? "root-a" : "root-b" })
        ])
      ),
      deleteDatabase: vi.fn().mockReturnValue(deletion.promise),
      importImageNodeBytes
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }: { vaultRoot: string }) =>
        useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/vault-a" } }
    );
    await waitFor(() => expect(result.current.state.nodesById["root-a"]).toBeDefined());

    let deletionCompletion!: Promise<NotesDeleteAllResult>;
    act(() => {
      deletionCompletion = result.current.actions.deleteAllNotesData();
    });
    await waitFor(() => expect(store.deleteDatabase).toHaveBeenCalledOnce());

    rerender({ vaultRoot: "/vault-b" });
    await waitFor(() => expect(result.current.state.nodesById["root-b"]).toBeDefined());
    act(() => result.current.actions.setImageImportMaxDisplayWidth(320));
    await act(async () =>
      result.current.actions.importClipboardImages!(
        "root-b",
        pendingImageBatch("vault-b-retry", [1024])
      )
    );
    const retryAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.["root-b"];
    expect(retryAttemptId).toBeDefined();
    expect(result.current.attachmentUploadErrorsByNodeId?.["root-b"]).toContain(
      "response lost"
    );

    await act(async () => {
      deletion.resolve({ attachmentCleanupFailed: false });
      await deletionCompletion;
    });

    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.["root-b"]
    ).toBe(retryAttemptId);
    expect(result.current.attachmentUploadErrorsByNodeId?.["root-b"]).toContain(
      "response lost"
    );
    expect(importImageNodeBytes).toHaveBeenCalledOnce();
  });

  it("releases the deletion gate and retains a draft when flushing fails", async () => {
    const store = repository({
      updateNode: vi.fn().mockRejectedValue(new Error("Draft save failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "Recoverable draft",
        note: "Keep me"
      , imageOffsetUtf16: 0});
    });

    let rejection: unknown;
    await act(async () => {
      rejection = await result.current.actions
        .deleteAllNotesData()
        .then(
          () => undefined,
          (cause) => cause
        );
    });

    expect(isNotesDraftsFlushFailedError(rejection)).toBe(true);
    expect((rejection as { code?: string }).code).toBe(
      NOTES_DRAFTS_FLUSH_FAILED_CODE
    );
    expect((rejection as Error).message).toBe("Draft save failed");
    expect(store.deleteDatabase).not.toHaveBeenCalled();
    expect(result.current.deletingNotesData).toBe(false);
    expect(result.current.draftsByNodeId.root).toMatchObject({
      title: "Recoverable draft",
      note: "Keep me",
      status: "failed"
    });
    expect(result.current.state.nodesById.root).toBeDefined();
  });

  it("discards unsaved drafts and deletes when asked to skip the flush", async () => {
    const store = repository({
      updateNode: vi.fn().mockRejectedValue(new Error("Draft save failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "Unsaveable draft",
        note: "drop me"
      , imageOffsetUtf16: 0});
    });
    expect(result.current.draftsByNodeId.root).toBeDefined();

    // The regular path bails before touching the database because the draft
    // can never be written.
    let rejection: unknown;
    await act(async () => {
      rejection = await result.current.actions
        .deleteAllNotesData()
        .then(
          () => undefined,
          (cause) => cause
        );
    });
    expect(isNotesDraftsFlushFailedError(rejection)).toBe(true);
    expect(store.deleteDatabase).not.toHaveBeenCalled();

    // Discarding the drafts skips that gate and deletes anyway.
    await act(async () => {
      await result.current.actions.deleteAllNotesData({ discardDrafts: true });
    });

    expect(store.deleteDatabase).toHaveBeenCalledWith("/vault");
    expect(result.current.deletingNotesData).toBe(false);
    expect(result.current.draftsByNodeId.root).toBeUndefined();
    expect(result.current.writeError).toBeNull();
    expect(result.current.state.rootIds).toEqual([]);
  });

  it("discards failed drafts from every same-vault hook before deleting", async () => {
    const deletion = deferred<{ attachmentCleanupFailed: boolean }>();
    const store = repository({
      updateNode: vi.fn().mockRejectedValue(new Error("Draft save failed")),
      deleteDatabase: vi.fn().mockReturnValue(deletion.promise)
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-drafts", repository: store })
    );
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-drafts", repository: store })
    );
    await waitFor(() => {
      expect(owner.result.current.status).toBe("ready");
      expect(sibling.result.current.status).toBe("ready");
    });

    act(() => {
      sibling.result.current.actions.updateNodeDraft("root", {
        title: "Unsaveable sibling draft",
        note: "discard me"
      , imageOffsetUtf16: 0});
    });
    await act(async () => {
      expect(await sibling.result.current.actions.flushAllDrafts()).toBe(false);
    });
    expect(sibling.result.current.draftsByNodeId.root?.status).toBe("failed");

    let deletionCompletion!: Promise<NotesDeleteAllResult>;
    act(() => {
      deletionCompletion = owner.result.current.actions.deleteAllNotesData({
        discardDrafts: true
      });
    });
    await waitFor(() => expect(store.deleteDatabase).toHaveBeenCalledOnce());
    expect(owner.result.current.deletingNotesData).toBe(true);
    expect(sibling.result.current.deletingNotesData).toBe(true);
    expect(sibling.result.current.draftsByNodeId.root).toBeUndefined();

    await act(async () => {
      deletion.resolve({ attachmentCleanupFailed: false });
      await deletionCompletion;
    });

    expect(owner.result.current.state.rootIds).toEqual([]);
    expect(sibling.result.current.state.rootIds).toEqual([]);
    expect(sibling.result.current.writeError).toBeNull();
    expect(sibling.result.current.deletingNotesData).toBe(false);
  });

  it("keeps the loading state untouched while a debounced draft save settles", async () => {
    // Hold the draft write in flight so loading is asserted while the write is
    // genuinely pending — otherwise the pending->settle window collapses into a
    // single commit and never captures an intermediate loading flash.
    const write = deferred<NotesWorkspace>();
    const store = repository({
      updateNode: vi.fn().mockReturnValue(write.promise)
    });
    const observedLoading: boolean[] = [];
    const { result } = renderHook(() => {
      const value = useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store
      });
      observedLoading.push(value.loading);
      return value;
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    observedLoading.length = 0;
    vi.useFakeTimers();

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "typed",
        note: ""
      , imageOffsetUtf16: 0});
    });
    // Debounce fires and the silent write goes in flight, but does not settle.
    await act(async () => vi.advanceTimersByTimeAsync(300));

    // The write is genuinely pending here: loading must stay false while a
    // draft save is outstanding.
    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(result.current.loading).toBe(false);
    expect(observedLoading).not.toContain(true);

    // The authoritative result settles through the drafts slice only.
    await act(async () => {
      write.resolve(workspace([node({ id: "root", title: "typed" })]));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.status).toBe("ready");
    expect(result.current.state.nodesById.root?.title).toBe("typed");
    expect(observedLoading).not.toContain(true);
  });

  it("still drives the loading state for a structural command", async () => {
    const command = deferred<NotesWorkspace>();
    const store = repository({
      updateNode: vi.fn().mockReturnValue(command.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.loading).toBe(false);

    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.actions.updateNode("root", {
        title: "structural",
        note: ""
      });
    });

    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.status).toBe("loading");

    await act(async () => {
      command.resolve(workspace([node({ id: "root", title: "structural" })]));
      await completion;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.status).toBe("ready");
  });

  it("surfaces a failing draft write through writeError without a loading flash", async () => {
    // Hold the write in flight so the no-flash claim is asserted while the
    // draft save is genuinely outstanding, not after it has already settled.
    const write = deferred<NotesWorkspace>();
    const store = repository({
      updateNode: vi.fn().mockReturnValue(write.promise)
    });
    const observedLoading: boolean[] = [];
    const { result } = renderHook(() => {
      const value = useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store
      });
      observedLoading.push(value.loading);
      return value;
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    observedLoading.length = 0;
    vi.useFakeTimers();

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "unsaved",
        note: ""
      , imageOffsetUtf16: 0});
    });
    // Debounce fires and the silent write goes in flight, but does not settle.
    await act(async () => vi.advanceTimersByTimeAsync(300));

    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(result.current.loading).toBe(false);
    expect(observedLoading).not.toContain(true);

    // The write fails: the Phase 0.8 banner surfaces without a loading flash.
    await act(async () => {
      write.reject(new Error("disk full"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.draftsByNodeId.root).toMatchObject({
      title: "unsaved",
      status: "failed"
    });
    expect(result.current.writeError).toMatchObject({
      operation: "write",
      retryable: true,
      message: "disk full"
    });
    expect(result.current.loading).toBe(false);
    expect(observedLoading).not.toContain(true);
  });

  it("keeps a pending draft and split in one coordinator command", async () => {
    const draftWrite = deferred<NotesWorkspace>();
    const invocations: string[] = [];
    const before = workspace([
      node({ id: "source", title: "source" }),
      node({ id: "other", sortKey: 2048, title: "other" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      updateNode: vi.fn((_vaultRoot, input) => {
        invocations.push(`update:${input.id}`);
        return input.id === "source"
          ? draftWrite.promise
          : Promise.resolve(before);
      }),
      splitNode: vi.fn().mockImplementation(async () => {
        invocations.push("split");
        return before;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft("source", {
        title: "source edited",
        note: ""
      , imageOffsetUtf16: 0});
    });
    let splitCompletion!: Promise<unknown>;
    let otherCompletion!: Promise<unknown>;
    act(() => {
      splitCompletion = result.current.actions.splitNode(
        "source",
        "new-node",
        "source",
        " edited"
      );
      otherCompletion = result.current.actions.updateNode("other", {
        title: "other edited",
        note: ""
      });
    });
    await waitFor(() => expect(invocations).toEqual(["update:source"]));

    await act(async () =>
      draftWrite.resolve(
        workspace([
          node({ id: "source", title: "source edited" }),
          node({ id: "other", sortKey: 2048, title: "other" })
        ])
      )
    );
    await act(async () => Promise.all([splitCompletion, otherCompletion]));

    expect(invocations).toEqual(["update:source", "split", "update:other"]);
  });

  it("orders a pending text burst before split with stable distinct history IDs", async () => {
    const initial = workspace([node({ id: "source", title: "source" })]);
    const base = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode: vi.fn().mockResolvedValue(
        workspace([node({ id: "source", title: "source edited" })])
      ),
      splitNode: vi.fn().mockResolvedValue(
        workspace([
          node({ id: "source", title: "source" }),
          node({ id: "split", sortKey: 2048, title: "edited" })
        ])
      )
    });
    const { repository: store, events } = journalNotesRepository(base);
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    events.clear();

    act(() => {
      result.current.actions.updateNodeDraft(
        "source",
        { title: "source e", note: "" , imageOffsetUtf16: 0},
        "title"
      );
      result.current.actions.updateNodeDraft(
        "source",
        { title: "source edited", note: "" , imageOffsetUtf16: 0},
        "title"
      );
    });
    await act(async () =>
      result.current.actions.splitNode("source", "split", "source", " edited")
    );

    const [textEvent] = events.for("updateNode");
    const [splitEvent] = events.for("splitNode");
    expect(textEvent).toMatchObject({ commandKind: "text" });
    expect(splitEvent).toMatchObject({ commandKind: "split" });
    expect(textEvent?.historySessionId).toBe(splitEvent?.historySessionId);
    expect(textEvent?.historyEntryId).not.toBe(splitEvent?.historyEntryId);
    expect(textEvent?.historyEntryId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(textEvent?.historyEntryId).not.toBe("source");
  });

  it("orders cross-node edits after a structural cutoff behind structural work", async () => {
    const initial = workspace([
      node({ id: "draft", title: "before" }),
      node({ id: "target", sortKey: 2048, title: "target" })
    ]);
    const firstWrite = deferred<NotesWorkspace>();
    const updateNode = vi
      .fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue(
        workspace([
          node({ id: "draft", title: "second" }),
          node({ id: "target", sortKey: 2048, title: "target" })
        ])
      );
    const splitNode = vi.fn().mockResolvedValue(initial);
    const base = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      splitNode
    });
    const { repository: store, events } = journalNotesRepository(base);
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    events.clear();

    act(() => {
      result.current.actions.updateNodeDraft(
        "draft",
        { title: "first", note: "" , imageOffsetUtf16: 0},
        "title"
      );
    });
    let structural!: Promise<unknown>;
    act(() => {
      structural = result.current.actions.splitNode(
        "target",
        "split",
        "tar",
        "get"
      );
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
    act(() => {
      result.current.actions.updateNodeDraft(
        "draft",
        { title: "second", note: "" , imageOffsetUtf16: 0},
        "title"
      );
    });
    await act(async () => firstWrite.resolve(initial));
    await act(async () => structural);
    await act(async () => result.current.actions.flushAllDrafts());

    expect(updateNode).toHaveBeenCalledTimes(2);
    expect(
      events.all
        .filter(({ operation }) =>
          operation === "updateNode" || operation === "splitNode"
        )
        .map(({ operation }) => operation)
    ).toEqual(["updateNode", "splitNode", "updateNode"]);
    const [firstUpdate, secondUpdate] = events.for("updateNode");
    const [split] = events.for("splitNode");
    expect(firstUpdate?.historyEntryId).not.toBe(secondUpdate?.historyEntryId);
    expect(secondUpdate?.historyEntryId).not.toBe(split?.historyEntryId);
  });

  it("orders sibling-hook drafts after a shared structural cutoff", async () => {
    const initial = workspace([
      node({ id: "draft", title: "before" }),
      node({ id: "target", sortKey: 2048 })
    ]);
    const firstWrite = deferred<NotesWorkspace>();
    const updateNode = vi
      .fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue(initial);
    const toggleStar = vi.fn().mockResolvedValue(
      workspace([
        node({ id: "draft", title: "second" }),
        node({ id: "target", sortKey: 2048, isStarred: true })
      ])
    );
    const base = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      toggleStar
    });
    const { repository: store, events } = journalNotesRepository(base);
    const first = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-barrier", repository: store })
    );
    const second = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-barrier", repository: store })
    );
    await waitFor(() => {
      expect(first.result.current.status).toBe("ready");
      expect(second.result.current.status).toBe("ready");
    });
    events.clear();

    act(() => {
      first.result.current.actions.updateNodeDraft(
        "draft",
        { title: "first", note: "" , imageOffsetUtf16: 0},
        "title"
      );
    });
    let structural!: Promise<unknown>;
    act(() => {
      structural = second.result.current.actions.toggleStar("target");
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
    act(() => {
      first.result.current.actions.updateNodeDraft(
        "draft",
        { title: "second", note: "" , imageOffsetUtf16: 0},
        "title"
      );
    });
    await act(async () => firstWrite.resolve(initial));
    await act(async () => structural);
    await act(async () => first.result.current.actions.flushAllDrafts());

    expect(updateNode).toHaveBeenCalledTimes(2);
    expect(
      events.all
        .filter(({ operation }) =>
          operation === "updateNode" || operation === "toggleStar"
        )
        .map(({ operation }) => operation)
    ).toEqual(["updateNode", "toggleStar", "updateNode"]);
    const [firstUpdate, secondUpdate] = events.for("updateNode");
    expect(firstUpdate?.historyEntryId).not.toBe(secondUpdate?.historyEntryId);

    act(() => {
      first.result.current.actions.updateNodeDraft(
        "draft",
        { title: "after", note: "" , imageOffsetUtf16: 0},
        "title"
      );
    });
    await act(async () => first.result.current.actions.flushAllDrafts());
    expect(
      events.all
        .filter(({ operation }) =>
          operation === "updateNode" || operation === "toggleStar"
        )
        .map(({ operation }) => operation)
    ).toEqual(["updateNode", "toggleStar", "updateNode", "updateNode"]);
    const [, priorUpdate, latestUpdate] = events.for("updateNode");
    expect(latestUpdate?.historyEntryId).not.toBe(priorUpdate?.historyEntryId);
  });

  it("orders typing after the structural cutoff behind the structural command", async () => {
    const initial = workspace([
      node({ id: "draft-a" }),
      node({ id: "draft-b", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 })
    ]);
    const blockedB = deferred<NotesWorkspace>();
    const order: string[] = [];
    const updateNode = vi.fn((_vaultRoot, input) => {
      order.push(`update:${input.id}:${input.title}`);
      return input.id === "draft-b"
        ? blockedB.promise
        : Promise.resolve(initial);
    });
    const toggleStar = vi.fn().mockImplementation(async () => {
      order.push("structural");
      return initial;
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      toggleStar
    });
    const first = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/epoch-hooks", repository: store })
    );
    const second = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/epoch-hooks", repository: store })
    );
    const structuralOwner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/epoch-hooks", repository: store })
    );
    await waitFor(() => {
      expect(first.result.current.status).toBe("ready");
      expect(second.result.current.status).toBe("ready");
      expect(structuralOwner.result.current.status).toBe("ready");
    });
    act(() => {
      first.result.current.actions.updateNodeDraft("draft-a", {
        title: "first",
        note: ""
      , imageOffsetUtf16: 0});
      second.result.current.actions.updateNodeDraft("draft-b", {
        title: "blocked",
        note: ""
      , imageOffsetUtf16: 0});
    });

    const structural = structuralOwner.result.current.actions.toggleStar(
      "target"
    );
    await waitFor(() =>
      expect(order).toEqual([
        "update:draft-a:first",
        "update:draft-b:blocked"
      ])
    );
    act(() => {
      first.result.current.actions.updateNodeDraft("draft-a", {
        title: "second",
        note: ""
      , imageOffsetUtf16: 0});
      first.result.current.actions.updateNodeDraft("draft-a", {
        title: "third",
        note: ""
      , imageOffsetUtf16: 0});
      first.result.current.actions.updateNodeDraft("draft-a", {
        title: "latest",
        note: ""
      , imageOffsetUtf16: 0});
    });
    blockedB.resolve(initial);
    await act(async () => structural);
    await act(async () => first.result.current.actions.flushAllDrafts());

    expect(order).toEqual([
      "update:draft-a:first",
      "update:draft-b:blocked",
      "structural",
      "update:draft-a:latest"
    ]);
  });

  it("keeps same-hook post-cutoff fields distinct behind a queued pre-cutoff write", async () => {
    const initial = workspace([
      node({ id: "root", title: "before", note: "before note" }),
      node({ id: "blocker", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 }),
      node({ id: "other", sortKey: 4096 })
    ]);
    const preCutoffSaved = workspace([
      node({ id: "root", title: "pre-cutoff", note: "before note" }),
      node({ id: "blocker", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 }),
      node({ id: "other", sortKey: 4096 })
    ]);
    const titleSaved = workspace([
      node({ id: "root", title: "title edit", note: "before note" }),
      node({ id: "blocker", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 }),
      node({ id: "other", sortKey: 4096 })
    ]);
    const noteSaved = workspace([
      node({ id: "root", title: "title edit", note: "note edit" }),
      node({ id: "blocker", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 }),
      node({ id: "other", sortKey: 4096 })
    ]);
    const blockerWrite = deferred<NotesMutationResult>();
    const order: string[] = [];
    const updateNode = vi.fn((_vaultRoot, input, context) => {
      order.push(`update:${input.id}:${input.title}:${input.note}`);
      if (input.id === "blocker") {
        return blockerWrite.promise;
      }
      return Promise.resolve(
        mutationResult(
          input.note === "note edit"
            ? noteSaved
            : input.title === "title edit"
              ? titleSaved
              : preCutoffSaved,
          context
        )
      );
    });
    const toggleStar = vi.fn().mockImplementation(async () => {
      order.push("structural");
      return initial;
    });
    let undoIndex = 0;
    const undo = vi.fn(async () => {
      const rootCalls = updateNode.mock.calls.filter(
        ([, input]) => input.id === "root"
      );
      const callIndex = undoIndex++;
      const replayedEntryId =
        rootCalls[callIndex === 0 ? 2 : 1]?.[2]?.entryId ?? null;
      return {
        ...appliedReplay(
          callIndex === 0 ? titleSaved : preCutoffSaved,
          replayedEntryId,
          "undo"
        ),
        canUndo: callIndex === 0,
        nextUndoEntryId:
          callIndex === 0
            ? (rootCalls[1]?.[2]?.entryId ?? null)
            : (toggleStar.mock.calls[0]?.[2]?.entryId ?? null)
      };
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      toggleStar,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/cutoff-field", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let blockerFlush!: Promise<boolean>;
    act(() => {
      result.current.actions.updateNodeDraft(
        "blocker",
        { title: "blocking", note: "" , imageOffsetUtf16: 0},
        "title"
      );
      blockerFlush = result.current.actions.flushNodeDraft("blocker");
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
    act(() => {
      result.current.actions.updateNodeDraft(
        "root",
        { title: "pre-cutoff", note: "before note" , imageOffsetUtf16: 0},
        "title"
      );
    });
    let structural!: Promise<unknown>;
    act(() => {
      structural = result.current.actions.toggleStar("target");
    });

    act(() => {
      result.current.actions.updateNodeDraft(
        "root",
        { title: "title edit", note: "before note" , imageOffsetUtf16: 0},
        "title"
      );
      result.current.actions.updateNodeDraft(
        "root",
        { title: "title edit", note: "note edit" , imageOffsetUtf16: 0},
        "note"
      );
    });
    expect(updateNode).toHaveBeenCalledOnce();

    await act(async () => {
      blockerWrite.resolve(
        mutationResult(initial, updateNode.mock.calls[0]![2]));
      await Promise.all([blockerFlush, structural]);
    });
    await act(async () => result.current.actions.flushAllDrafts());

    expect(order).toEqual([
      "update:blocker:blocking:",
      "update:root:pre-cutoff:before note",
      "structural",
      "update:root:title edit:before note",
      "update:root:title edit:note edit"
    ]);
    const rootCalls = updateNode.mock.calls.filter(
      ([, input]) => input.id === "root"
    );
    expect(rootCalls).toHaveLength(3);
    expect(rootCalls[1]?.[2]?.entryId).not.toBe(rootCalls[2]?.[2]?.entryId);

    await act(async () => result.current.actions.focusNode("other"));
    await act(async () => result.current.actions.undo!());
    expect(result.current.state).toMatchObject({
      selectedId: "root",
      pendingFocusId: "root",
      pendingFocusField: "note"
    });
    await act(async () => result.current.actions.focusNode("other"));
    await act(async () => result.current.actions.undo!());
    expect(result.current.state).toMatchObject({
      selectedId: "root",
      pendingFocusId: "root",
      pendingFocusField: "title"
    });
  });

  it("retires a same-hook stale-marker owner when its node disappears", async () => {
    const ids = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
      "10000000-0000-4000-8000-000000000004",
      "10000000-0000-4000-8000-000000000005",
      "10000000-0000-4000-8000-000000000006"
    ] as const;
    let idIndex = 0;
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockImplementation(() => ids[idIndex++] ?? ids.at(-1)!);
    try {
      const initial = workspace([
        node({ id: "root", title: "", note: "" }),
        node({ id: "blocker", sortKey: 2048 }),
        node({ id: "other", sortKey: 3072 })
      ]);
      const removed = workspace([
        node({ id: "blocker", sortKey: 2048 }),
        node({ id: "other", sortKey: 3072 })
      ]);
      const blockerWrite = deferred<NotesWorkspace>();
      const updateNode = vi.fn((_vaultRoot, input) =>
        input.id === "blocker"
          ? blockerWrite.promise
          : Promise.resolve(initial)
      );
      const undo = vi.fn(async () => ({
        workspace: removed,
        replayedEntryId: ids[3],
        ...historyState(),
        kind: "applied" as const,
        canUndo: false,
        canRedo: true
      }));
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(initial),
        updateNode,
        removeEmptyNode: vi.fn().mockResolvedValue(removed),
        undo
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({ vaultRoot: "/retire-field", repository: store })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));

      let blockerFlush!: Promise<boolean>;
      act(() => {
        result.current.actions.updateNodeDraft("blocker", {
          title: "blocking",
          note: ""
        , imageOffsetUtf16: 0});
        blockerFlush = result.current.actions.flushNodeDraft("blocker");
      });
      await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
      act(() => {
        result.current.actions.updateNodeDraft(
          "root",
          { title: "", note: "" , imageOffsetUtf16: 0},
          "title"
        );
      });
      let removal!: Promise<unknown>;
      act(() => {
        removal = result.current.actions.removeEmptyNode("root", "other");
      });
      act(() => {
        result.current.actions.updateNodeDraft(
          "root",
          { title: "title edit", note: "" , imageOffsetUtf16: 0},
          "title"
        );
        result.current.actions.updateNodeDraft(
          "root",
          { title: "title edit", note: "note edit" , imageOffsetUtf16: 0},
          "note"
        );
      });
      expect(randomUUID.mock.results[3]?.value).toBe(ids[3]);

      await act(async () => {
        blockerWrite.resolve(initial);
        await Promise.all([blockerFlush, removal]);
      });
      await act(async () => result.current.actions.flushAllDrafts());
      await act(async () => result.current.actions.focusNode("other"));
      await act(async () => result.current.actions.undo!());

      expect(result.current.state).toMatchObject({
        selectedId: "other",
        pendingFocusId: "other"
      });
    } finally {
      randomUUID.mockRestore();
    }
  });

  it("retries the failed pre-cutoff snapshot before post-click typing", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "blocker", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 })
    ]);
    const blockedWrite = deferred<NotesWorkspace>();
    const order: string[] = [];
    let rootAttempt = 0;
    const updateNode = vi.fn((_vaultRoot, input) => {
      order.push(`update:${input.id}:${input.title}`);
      if (input.id === "root" && rootAttempt++ === 0) {
        return Promise.reject(new Error("disk full"));
      }
      return input.id === "blocker"
        ? blockedWrite.promise
        : Promise.resolve(initial);
    });
    const toggleStar = vi.fn().mockImplementation(async () => {
      order.push("structural");
      return initial;
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      toggleStar
    });
    const blocker = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/failed-cutoff", repository: store })
    );
    const editor = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/failed-cutoff", repository: store })
    );
    const requester = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/failed-cutoff", repository: store })
    );
    await waitFor(() => {
      expect(blocker.result.current.status).toBe("ready");
      expect(editor.result.current.status).toBe("ready");
      expect(requester.result.current.status).toBe("ready");
    });

    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "before click",
        note: "before note"
      , imageOffsetUtf16: 0});
    });
    await act(async () => editor.result.current.actions.flushNodeDraft("root"));
    act(() => {
      blocker.result.current.actions.updateNodeDraft("blocker", {
        title: "blocking",
        note: ""
      , imageOffsetUtf16: 0});
    });
    const structural = requester.result.current.actions.toggleStar("target");
    await waitFor(() =>
      expect(order.at(-1)).toBe("update:blocker:blocking")
    );
    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "after click",
        note: "after note"
      , imageOffsetUtf16: 0});
    });

    blockedWrite.resolve(initial);
    await act(async () => structural);
    await act(async () => editor.result.current.actions.flushAllDrafts());

    expect(order).toEqual([
      "update:root:before click",
      "update:blocker:blocking",
      "update:root:before click",
      "structural",
      "update:root:after click"
    ]);
    const rootCalls = vi
      .mocked(store.updateNode)
      .mock.calls.filter(([, input]) => input.id === "root");
    expect(rootCalls[1]?.[1]).toMatchObject({
      title: "before click",
      note: "before note"
    });
    expect(rootCalls[1]?.[2]?.entryId).not.toBe(rootCalls[2]?.[2]?.entryId);
  });

  it("keeps explicit failed retry immutable during a structural cutoff", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "blocker", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 })
    ]);
    const blockedWrite = deferred<NotesWorkspace>();
    const order: string[] = [];
    let rootAttempt = 0;
    const updateNode = vi.fn((_vaultRoot, input) => {
      order.push(`update:${input.id}:${input.title}`);
      if (input.id === "root" && rootAttempt++ === 0) {
        return Promise.reject(new Error("disk full"));
      }
      return input.id === "blocker"
        ? blockedWrite.promise
        : Promise.resolve(initial);
    });
    const toggleStar = vi.fn().mockImplementation(async () => {
      order.push("structural");
      return initial;
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      toggleStar
    });
    const blocker = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/explicit-cutoff", repository: store })
    );
    const editor = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/explicit-cutoff", repository: store })
    );
    const requester = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/explicit-cutoff", repository: store })
    );
    await waitFor(() => {
      expect(blocker.result.current.status).toBe("ready");
      expect(editor.result.current.status).toBe("ready");
      expect(requester.result.current.status).toBe("ready");
    });

    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "failed value",
        note: "failed note"
      , imageOffsetUtf16: 0});
    });
    await act(async () => editor.result.current.actions.flushNodeDraft("root"));
    act(() => {
      blocker.result.current.actions.updateNodeDraft("blocker", {
        title: "blocking",
        note: ""
      , imageOffsetUtf16: 0});
    });
    const structural = requester.result.current.actions.toggleStar("target");
    await waitFor(() =>
      expect(order.at(-1)).toBe("update:blocker:blocking")
    );
    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "new value",
        note: "new note"
      , imageOffsetUtf16: 0});
    });
    const retry = editor.result.current.retryFailedDraft("root");

    blockedWrite.resolve(initial);
    await act(async () => Promise.all([retry, structural]));
    await act(async () => editor.result.current.actions.flushAllDrafts());

    expect(order).toEqual([
      "update:root:failed value",
      "update:blocker:blocking",
      "update:root:failed value",
      "structural",
      "update:root:new value"
    ]);
  });

  it("shuts down with the captured failed snapshot during a cutoff", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "blocker", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 })
    ]);
    const blockedWrite = deferred<NotesWorkspace>();
    const order: string[] = [];
    let rootAttempt = 0;
    const updateNode = vi.fn((_vaultRoot, input) => {
      order.push(`update:${input.id}:${input.title}`);
      if (input.id === "root" && rootAttempt++ === 0) {
        return Promise.reject(new Error("disk full"));
      }
      return input.id === "blocker"
        ? blockedWrite.promise
        : Promise.resolve(initial);
    });
    const toggleStar = vi.fn().mockImplementation(async () => {
      order.push("structural");
      return initial;
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      toggleStar
    });
    const blocker = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shutdown-cutoff", repository: store })
    );
    const editor = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shutdown-cutoff", repository: store })
    );
    const requester = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shutdown-cutoff", repository: store })
    );
    await waitFor(() => {
      expect(blocker.result.current.status).toBe("ready");
      expect(editor.result.current.status).toBe("ready");
      expect(requester.result.current.status).toBe("ready");
    });

    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "shutdown value",
        note: "shutdown note"
      , imageOffsetUtf16: 0});
    });
    await act(async () => editor.result.current.actions.flushNodeDraft("root"));
    act(() => {
      blocker.result.current.actions.updateNodeDraft("blocker", {
        title: "blocking",
        note: ""
      , imageOffsetUtf16: 0});
    });
    const structural = requester.result.current.actions.toggleStar("target");
    await waitFor(() =>
      expect(order.at(-1)).toBe("update:blocker:blocking")
    );
    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "post-click value",
        note: "post-click note"
      , imageOffsetUtf16: 0});
    });
    editor.unmount();

    blockedWrite.resolve(initial);
    await act(async () => structural);

    expect(order).toEqual([
      "update:root:shutdown value",
      "update:blocker:blocking",
      "update:root:shutdown value",
      "structural"
    ]);
  });

  it("admits one failed retry when cutoff, explicit retry, and shutdown race", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "blocker", sortKey: 2048 })
    ]);
    const blockedWrite = deferred<NotesMutationResult>();
    const successfulEntryIds: string[] = [];
    let rootAttempt = 0;
    const updateNode = vi.fn((_vaultRoot, input, history) => {
      if (input.id === "root" && rootAttempt++ === 0) {
        return Promise.reject(new Error("disk full"));
      }
      if (input.id === "blocker") {
        return blockedWrite.promise;
      }
      if (input.id === "root" && history) {
        successfulEntryIds.push(history.entryId);
      }
      return Promise.resolve(mutationResult(initial, history));
    });
    const undo = vi.fn().mockImplementation(async () => {
      const replayedEntryId = successfulEntryIds.at(-1) ?? null;
      return {
        ...appliedReplay(initial, replayedEntryId, "undo"),
        canUndo: true,
        nextUndoEntryId:
          updateNode.mock.calls.find(([, input]) => input.id === "blocker")?.[2]
            ?.entryId ?? null
      };
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      undo
    });
    const editor = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/reserved-cutoff", repository: store })
    );
    const requester = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/reserved-cutoff", repository: store })
    );
    await waitFor(() => {
      expect(editor.result.current.status).toBe("ready");
      expect(requester.result.current.status).toBe("ready");
    });

    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "failed value",
        note: "failed note"
      , imageOffsetUtf16: 0});
    });
    await act(async () => editor.result.current.actions.flushNodeDraft("root"));
    act(() => {
      editor.result.current.actions.updateNodeDraft("blocker", {
        title: "blocking",
        note: ""
      , imageOffsetUtf16: 0});
    });
    const blockerFlush = editor.result.current.actions.flushNodeDraft("blocker");
    await waitFor(() =>
      expect(updateNode.mock.calls.at(-1)?.[1].id).toBe("blocker")
    );

    const replay = requester.result.current.actions.undo!();
    await Promise.resolve();
    const explicitRetry = editor.result.current.retryFailedDraft("root");
    editor.unmount();

    blockedWrite.resolve(
      mutationResult(initial, updateNode.mock.calls.at(-1)![2])
    );
    await act(async () => Promise.all([blockerFlush, explicitRetry, replay]));

    const rootCalls = vi
      .mocked(store.updateNode)
      .mock.calls.filter(([, input]) => input.id === "root");
    expect(rootCalls).toHaveLength(2);
    expect(successfulEntryIds).toHaveLength(1);
    expect(new Set(successfulEntryIds).size).toBe(1);
    expect(undo).toHaveBeenCalledOnce();
    expect(requester.result.current.canUndo).toBe(true);
    expect(requester.result.current.canRedo).toBe(true);
  });

  it("flushes a visible note draft before undo and restores field-aware UI", async () => {
    const initial = workspace([
      node({ id: "root", title: "before" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const updated = workspace([
      node({ id: "root", title: "before", note: "supporting" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    let savedEntryId: string | null = null;
    const updateNode = vi.fn(async (_vaultRoot, _input, context) => {
      savedEntryId = context.entryId;
      return mutationResult(updated, context);
    });
    const undo = vi.fn().mockImplementation(async () =>
      appliedReplay(initial, savedEntryId, "undo")
    );
    const base = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      undo
    });
    const { repository: store, events } = journalNotesRepository(base);
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    events.clear();

    await act(async () => {
      await result.current.actions.focusNode("root");
      await result.current.actions.zoomTo("root");
    });
    act(() => {
      result.current.actions.updateNodeDraft(
        "root",
        { title: "before", note: "supporting" , imageOffsetUtf16: 0},
        "note"
      );
    });
    let replay!: Promise<unknown>;
    act(() => {
      replay = result.current.actions.undo!();
    });
    await act(async () => replay);

    expect(
      events.all
        .filter(({ operation }) => operation === "updateNode" || operation === "undo")
        .map(({ operation }) => operation)
    ).toEqual(["updateNode", "undo"]);
    const [updateEvent] = events.for("updateNode");
    expect(events.for("undo")[0]?.input).toEqual({
      sessionId: updateEvent?.historySessionId,
      historyEpoch: "epoch-a",
      expectedEntryId: updateEvent?.historyEntryId,
      scope: { kind: "active" }
    });
    expect(result.current.state).toMatchObject({
      selectedId: "root",
      zoomRootId: "root",
      editingNoteId: "root",
      pendingFocusId: null,
      pendingFocusField: null
    });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(true);
  });

  it("separates a fast title-to-note transition into field-aware Undo entries", async () => {
    const initial = workspace([
      node({ id: "root", title: "before", note: "before note" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const titleSaved = workspace([
      node({ id: "root", title: "title edit", note: "before note" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const noteSaved = workspace([
      node({ id: "root", title: "title edit", note: "note edit" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const titleWrite = deferred<NotesMutationResult>();
    const noteWrite = deferred<NotesMutationResult>();
    const updateNode = vi
      .fn()
      .mockReturnValueOnce(titleWrite.promise)
      .mockReturnValueOnce(noteWrite.promise);
    let undoIndex = 0;
    const undo = vi.fn(async () => {
      const callIndex = undoIndex++;
      const replayedEntryId =
        updateNode.mock.calls[callIndex === 0 ? 1 : 0]?.[2]?.entryId ?? null;
      return {
        ...appliedReplay(
          callIndex === 0 ? titleSaved : initial,
          replayedEntryId,
          "undo"
        ),
        canUndo: callIndex === 0,
        nextUndoEntryId:
          callIndex === 0
            ? (updateNode.mock.calls[0]?.[2]?.entryId ?? null)
            : null
      };
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/field-transition", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft(
        "root",
        { title: "title edit", note: "before note" , imageOffsetUtf16: 0},
        "title"
      );
    });
    let titleFlush!: Promise<boolean>;
    act(() => {
      titleFlush = result.current.actions.flushNodeDraft("root");
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());

    act(() => {
      result.current.actions.updateNodeDraft(
        "root",
        { title: "title edit", note: "note edit" , imageOffsetUtf16: 0},
        "note"
      );
    });
    const titleContext = updateNode.mock.calls[0]?.[2];
    await act(async () => {
      titleWrite.resolve({
        workspace: titleSaved,
        historyEntryId: titleContext?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      });
      await titleFlush;
    });

    let noteFlush!: Promise<boolean>;
    act(() => {
      noteFlush = result.current.actions.flushNodeDraft("root");
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledTimes(2));
    const noteContext = updateNode.mock.calls[1]?.[2];
    await act(async () => {
      noteWrite.resolve({
        workspace: noteSaved,
        historyEntryId: noteContext?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      });
      await noteFlush;
    });

    expect(titleContext?.entryId).not.toBe(noteContext?.entryId);

    await act(async () => result.current.actions.focusNode("other"));
    await act(async () => result.current.actions.undo!());
    expect(result.current.state).toMatchObject({
      selectedId: "root",
      pendingFocusId: "root",
      pendingFocusField: "note"
    });
    await act(async () => result.current.actions.focusNode("other"));
    await act(async () => result.current.actions.undo!());
    expect(result.current.state).toMatchObject({
      selectedId: "root",
      pendingFocusId: "root",
      pendingFocusField: "title"
    });
  });

  it("does not ask the backend to skip a local navigation without a mutation candidate", async () => {
    const initial = workspace([node({ id: "root" })]);
    const replayedEntryId = "90000000-0000-4000-8000-000000000009";
    const undo = vi.fn().mockResolvedValue({
      workspace: workspace([node({ id: "other" })]),
      replayedEntryId,
      ...historyState(),
      kind: "applied" as const,
      canUndo: false,
      canRedo: true
    });
    const store = repository({
      initialize: vi.fn().mockResolvedValue({
        ...historyState(),
        canUndo: true,
        nextUndoEntryId: replayedEntryId
      }),
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.actions.focusNode("root");
      await result.current.actions.zoomTo("root");
      await result.current.actions.undo!();
    });

    expect(undo).not.toHaveBeenCalled();
    expect(result.current.state.nodesById.root).toBeDefined();
    expect(result.current.state).toMatchObject({
      selectedId: "root",
      zoomRootId: null,
      editingNoteId: "root"
    });
  });

  it("accepts an applied replay through the shared timeline before settling UI", async () => {
    const initial = workspace([node({ id: "root" })]);
    const starred = workspace([node({ id: "root", isStarred: true })]);
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) =>
      mutationResult(starred, context)
    );
    const undo = vi.fn(async () =>
      appliedReplay(
        initial,
        toggleStar.mock.calls[0]?.[2]?.entryId ?? null,
        "undo"
      )
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleStar,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/replay-acceptance", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.toggleStar("root"));
    const entryId = toggleStar.mock.calls[0]?.[2]?.entryId;
    await act(async () => result.current.actions.undo!());

    expect(notesHistorySpies.acceptReplayResult).toHaveBeenCalledWith(
      expect.objectContaining({ nextRedoEntryId: entryId }),
      "undo",
      entryId
    );
    expect(undo).toHaveBeenCalledWith(
      "/replay-acceptance",
      expect.objectContaining({ expectedEntryId: entryId })
    );
    expect(result.current.state.nodesById.root?.isStarred).toBe(false);
  });

  it("settles an applied replay whose backend pruning releases the replayed entry", async () => {
    const before = workspace([
      node({ id: "target", sortKey: 1, isCollapsed: true }),
      node({ id: "moving", sortKey: 2 })
    ]);
    const after = workspace([
      node({ id: "target", sortKey: 1, isCollapsed: true }),
      node({ id: "moving", parentId: "target", sortKey: 1 })
    ]);
    let active = before;
    let entryId: string | null = null;
    const applyBatch = vi.fn(async (_vaultRoot, _input, context) => {
      entryId = context?.entryId ?? null;
      active = after;
      return {
        workspace: after,
        historyEntryId: entryId,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        nextUndoEntryId: entryId
      };
    });
    const undo = vi.fn(async () => {
      active = before;
      return {
        kind: "applied" as const,
        workspace: before,
        replayedEntryId: entryId ?? "missing-entry",
        ...historyState(),
        canUndo: false,
        canRedo: false,
        prunedEntryIds: entryId ? [entryId] : []
      };
    });
    const closeHistorySession = vi.fn().mockResolvedValue(undefined);
    const clearHistory = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(() => Promise.resolve(active)),
      applyBatch,
      undo,
      clearHistory,
      closeHistorySession
    });
    const first = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/replay-pruned-presentation", repository: store })
    );
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    const second = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/replay-pruned-presentation", repository: store })
    );
    await waitFor(() => expect(second.result.current.status).toBe("ready"));

    act(() => second.result.current.actions.setSelectionAnchor("moving"));
    const prepared = await act(async () =>
      second.result.current.prepareSelectionAuthority!(["moving"])
    );
    await act(async () =>
      second.result.current.applyPreparedSelectionBatch!(
        prepared,
        { type: "move", parentId: "target", afterId: null },
        { expandNodeId: "target" }
      )
    );
    expect(second.result.current.locallyExpandedNodeIds).toEqual(
      new Set(["target"])
    );

    await act(async () => second.result.current.actions.undo!());

    expect(undo).toHaveBeenCalledOnce();
    expect(clearHistory).not.toHaveBeenCalled();
    expect(second.result.current.state.nodesById.moving?.parentId).toBeNull();
    expect(second.result.current.locallyExpandedNodeIds).toEqual(new Set());
    expect(second.result.current.canUndo).toBe(false);
    expect(second.result.current.canRedo).toBe(false);

    second.unmount();
    first.unmount();
    await waitFor(() => expect(closeHistorySession).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        notesWorkspaceCoordinatorRegistry.hasCoordinator(
          store,
          "/replay-pruned-presentation"
        )
      ).toBe(false)
    );
  });

  it("blocks new work while an applied replay mismatch recovers through the coordinator", async () => {
    const initial = workspace([node({ id: "root" })]);
    const starred = workspace([node({ id: "root", isStarred: true })]);
    const clear = deferred<NotesHistoryState & { historyReset: true }>();
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) =>
      mutationResult(starred, context)
    );
    const undo = vi.fn().mockResolvedValue(
      appliedReplay(initial, "not-the-timeline-entry", "undo")
    );
    const clearHistory = vi.fn().mockReturnValue(clear.promise);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleStar,
      undo,
      historyStatus: vi.fn().mockResolvedValue(historyState()),
      clearHistory
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/replay-mismatch", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.toggleStar("root"));
    let replay!: Promise<void>;
    act(() => {
      replay = result.current.actions.undo!();
    });
    await waitFor(() => expect(clearHistory).toHaveBeenCalledOnce());

    act(() => {
      void result.current.actions.toggleStar("root");
    });
    expect(toggleStar).toHaveBeenCalledOnce();

    clear.resolve({ ...historyState("epoch-b"), historyReset: true });
    await act(async () => replay);
    await waitFor(() =>
      expect(store.loadWorkspace).toHaveBeenCalledTimes(2)
    );
  });

  it.each(["entryNotNext", "entryMissing", "epochMismatch"] as const)(
    "recovers a backend %s replay response after calling Undo",
    async (kind) => {
      const initial = workspace([node({ id: "root" })]);
      const starred = workspace([node({ id: "root", isStarred: true })]);
      const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) =>
        mutationResult(starred, context)
      );
      const undo = vi.fn(async () => ({
        kind,
        ...historyState(kind === "epochMismatch" ? "epoch-b" : "epoch-a"),
        ...(kind === "entryNotNext"
          ? {
              canUndo: true,
              nextUndoEntryId: toggleStar.mock.calls[0]?.[2]?.entryId ?? null
            }
          : {})
      }));
      const clearHistory = vi.fn().mockResolvedValue({
        ...historyState("epoch-b"),
        historyReset: true as const
      });
      const historyStatus = vi.fn(async () => ({
        ...historyState(),
        canUndo: true,
        nextUndoEntryId: toggleStar.mock.calls[0]?.[2]?.entryId ?? null
      }));
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(initial),
        toggleStar,
        undo,
        historyStatus,
        clearHistory
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({
          vaultRoot: `/replay-${kind}`,
          repository: store
        })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));

      await act(async () => result.current.actions.toggleStar("root"));
      await act(async () => result.current.actions.undo!());

      expect(undo).toHaveBeenCalledOnce();
      await waitFor(() => expect(clearHistory).toHaveBeenCalledOnce());
      expect(clearHistory).toHaveBeenCalledWith(
        `/replay-${kind}`,
        expect.objectContaining({ historyEpoch: "epoch-a" })
      );
    }
  );

  it("blocks mutations when an applied replay cannot reload its cross-scope location", async () => {
    const initial = workspace([node({ id: "root" })]);
    const starred = workspace([node({ id: "root", isStarred: true })]);
    const clear = deferred<NotesHistoryState & { historyReset: true }>();
    let activeLoads = 0;
    const loadWorkspace = vi.fn((_vaultRoot: string, scope?: NotesWorkspaceScope) => {
      if (scope?.kind === "starred") return Promise.resolve(starred);
      activeLoads += 1;
      if (activeLoads === 1) return Promise.resolve(initial);
      if (activeLoads === 2) return Promise.reject(new Error("active reload failed"));
      return Promise.resolve(initial);
    });
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) =>
      mutationResult(starred, context)
    );
    const undo = vi.fn(async () =>
      appliedReplay(initial, toggleStar.mock.calls[0]?.[2]?.entryId ?? null, "undo")
    );
    const clearHistory = vi.fn().mockReturnValue(clear.promise);
    const store = repository({
      loadWorkspace,
      toggleStar,
      undo,
      historyStatus: vi.fn().mockImplementation(() => ({
        ...historyState(),
        canUndo: true,
        nextUndoEntryId: toggleStar.mock.calls[0]?.[2]?.entryId ?? null
      })),
      clearHistory
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/replay-cross-scope", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.toggleStar("root"));
    await act(async () => result.current.actions.selectLibraryView("starred"));
    const session = [...notesHistorySpies.sessionsById.values()].at(
      -1
    ) as NotesHistorySession;
    expect(session.next("undo")?.kind).toBe("navigation");
    session.commitReplay("undo");
    expect(session.next("undo")).toMatchObject({
      kind: "mutation",
      entryId: toggleStar.mock.calls[0]?.[2]?.entryId
    });
    let replay!: Promise<void>;
    act(() => {
      replay = result.current.actions.undo!();
    });
    await waitFor(() => expect(clearHistory).toHaveBeenCalledOnce());

    act(() => {
      void result.current.actions.toggleStar("root");
    });
    expect(toggleStar).toHaveBeenCalledOnce();

    clear.resolve({ ...historyState("epoch-b"), historyReset: true });
    await act(async () => replay);
    await waitFor(() => expect(activeLoads).toBe(2));
  });

  it("lets the backend invalidate redo after a new structural mutation", async () => {
    const initial = workspace([node({ id: "root" })]);
    const starred = workspace([node({ id: "root", isStarred: true })]);
    const completed = workspace([
      node({
        id: "root",
        isStarred: false,
        completedAt: "2026-07-11T00:00:00Z"
      })
    ]);
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) =>
      mutationResult(starred, context)
    );
    const toggleComplete = vi.fn(async (_vaultRoot, _nodeId, context) =>
      mutationResult(completed, context)
    );
    const undo = vi
      .fn()
      .mockImplementation(async () =>
        appliedReplay(
          initial,
          toggleStar.mock.calls[0]?.[2]?.entryId ?? null,
          "undo"
        )
      );
    const redo = vi.fn().mockResolvedValue({
      kind: "entryMissing" as const,
      ...historyState()
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleStar,
      toggleComplete,
      undo,
      redo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.toggleStar("root"));
    await act(async () => result.current.actions.undo!());
    await act(async () => result.current.actions.toggleComplete("root"));
    await act(async () => result.current.actions.redo!());

    expect(toggleComplete.mock.calls[0]?.[2]?.entryId).not.toBe(
      toggleStar.mock.calls[0]?.[2]?.entryId
    );
    expect(redo).not.toHaveBeenCalled();
    expect(result.current.state.nodesById.root.completedAt).not.toBeNull();
  });

  it("broadcasts mutation and replay authority to sibling hooks without replacing local navigation", async () => {
    const initial = workspace([node({ id: "root" })]);
    const starred = workspace([node({ id: "root", isStarred: true })]);
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) =>
      mutationResult(starred, context)
    );
    const undo = vi.fn().mockImplementation(async () =>
      appliedReplay(
        initial,
        toggleStar.mock.calls[0]?.[2]?.entryId ?? null,
        "undo"
      )
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleStar,
      undo
    });
    const second = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared", repository: store })
    );
    await waitFor(() => expect(second.result.current.status).toBe("ready"));
    await act(async () => second.result.current.actions.zoomTo("root"));
    const first = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared", repository: store })
    );
    await waitFor(() => expect(first.result.current.status).toBe("ready"));

    await act(async () => first.result.current.actions.toggleStar("root"));
    await waitFor(() =>
      expect(second.result.current.state.nodesById.root?.isStarred).toBe(true)
    );
    expect(second.result.current.state.zoomRootId).toBe("root");

    await act(async () => first.result.current.actions.undo!());
    await waitFor(() =>
      expect(second.result.current.state.nodesById.root?.isStarred).toBe(false)
    );
    expect(second.result.current.state.zoomRootId).toBe("root");
  });

  it("keeps owner-only split snapshots out of sibling replay after owner unmount", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const splitResult = deferred<NotesWorkspace>();
    const splitNode = vi.fn().mockReturnValue(splitResult.promise);
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initial,
      replayedEntryId: splitNode.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      kind: "applied" as const,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      splitNode,
      undo
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/owner-replay", repository: store })
    );
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));
    await act(async () => {
      await sibling.result.current.actions.focusNode("other");
      await sibling.result.current.actions.zoomTo("other");
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/owner-replay", repository: store })
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));

    const split = owner.result.current.actions.splitNode(
      "root",
      "split",
      "ro",
      "ot"
    );
    await waitFor(() => expect(splitNode).toHaveBeenCalledOnce());
    owner.unmount();
    splitResult.resolve(
      workspace([
        node({ id: "root", title: "ro" }),
        node({ id: "split", parentId: null, sortKey: 1536, title: "ot" }),
        node({ id: "other", sortKey: 2048 })
      ])
    );
    await act(async () => split);
    await waitFor(() =>
      expect(sibling.result.current.state.nodesById.split).toBeDefined()
    );
    expect(sibling.result.current.state).toMatchObject({
      selectedId: "split",
      zoomRootId: "other",
      pendingFocusId: "split"
    });

    await act(async () => sibling.result.current.actions.undo!());
    expect(sibling.result.current.state).toMatchObject({
      selectedId: null,
      zoomRootId: "other",
      pendingFocusId: null
    });
  });

  it("broadcasts replay authority when the replay owner unmounts after commit", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const replay = deferred<NotesHistoryReplayOutcome>();
    const undo = vi.fn().mockReturnValue(replay.promise);
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) =>
      mutationResult(
        workspace([
          node({ id: "root", isStarred: true }),
          node({ id: "other", sortKey: 2048 })
        ]),
        context
      )
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleStar,
      undo
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/replay-unmount", repository: store })
    );
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));
    await act(async () => {
      await sibling.result.current.actions.focusNode("other");
      await sibling.result.current.actions.zoomTo("other");
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/replay-unmount", repository: store })
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    await act(async () => owner.result.current.actions.toggleStar("root"));

    const completion = owner.result.current.actions.undo!();
    await waitFor(() => expect(undo).toHaveBeenCalledOnce());
    owner.unmount();
    replay.resolve(
      appliedReplay(
        workspace([
          node({ id: "after-undo" }),
          node({ id: "other", sortKey: 2048 })
        ]),
        toggleStar.mock.calls[0]?.[2]?.entryId ?? null,
        "undo"
      )
    );
    await act(async () => completion);

    await waitFor(() =>
      expect(sibling.result.current.state.nodesById["after-undo"]).toBeDefined()
    );
    expect(sibling.result.current).toMatchObject({
      canUndo: true,
      canRedo: true
    });
    expect(sibling.result.current.state).toMatchObject({
      selectedId: "other",
      zoomRootId: "other",
      editingNoteId: "other",
      pendingFocusId: "other"
    });
  });

  it("settles create history when its owner unmounts after backend commit", async () => {
    createNoteIdMock.mockReturnValue("created");
    const initial = workspace([]);
    const created = workspace([node({ id: "created" })]);
    const committed = deferred<NotesMutationResult>();
    let createContext!: NotesHistoryContext;
    const createNode = vi.fn((_vaultRoot, _input, context) => {
      createContext = context;
      return committed.promise;
    });
    const undo = vi.fn((_vaultRoot, input) =>
      Promise.resolve(appliedReplay(initial, input.expectedEntryId, "undo"))
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      createNode,
      undo
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/create-unmount", repository: store })
    );
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/create-unmount", repository: store })
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));

    const completion = owner.result.current.actions.createRoot();
    await waitFor(() => expect(createNode).toHaveBeenCalledOnce());
    owner.unmount();
    committed.resolve(mutationResult(created, createContext));
    await act(async () => completion);

    expect(notesHistorySpies.acceptMutationResult).toHaveBeenCalledWith(
      createContext.entryId,
      expect.anything(),
      expect.objectContaining({ nextUndoEntryId: createContext.entryId })
    );
    await waitFor(() => expect(sibling.result.current.canUndo).toBe(true));
    await act(async () => sibling.result.current.actions.undo!());
    expect(undo).toHaveBeenCalledWith("/create-unmount", {
      sessionId: createContext.sessionId,
      historyEpoch: createContext.historyEpoch,
      expectedEntryId: createContext.entryId,
      scope: { kind: "active" }
    });
    expect(sibling.result.current.state.rootIds).toEqual([]);
  });

  it("settles archive history when its owner unmounts after backend commit", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const after = workspace([node({ id: "other" })]);
    const archived = deferred<NotesMutationResult>();
    let archiveContext!: NotesHistoryContext;
    const archiveNode = vi.fn((_vaultRoot, _nodeId, context) => {
      archiveContext = context;
      return archived.promise;
    });
    const undo = vi.fn((_vaultRoot, input) =>
      Promise.resolve(appliedReplay(initial, input.expectedEntryId, "undo"))
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      archiveNode,
      undo
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/archive-unmount", repository: store })
    );
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));
    await act(async () => {
      await sibling.result.current.actions.focusNode("other");
      await sibling.result.current.actions.zoomTo("other");
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/archive-unmount", repository: store })
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));

    const completion = owner.result.current.actions.archiveNode("root");
    await waitFor(() => expect(archiveNode).toHaveBeenCalledOnce());
    owner.unmount();
    archived.resolve(mutationResult(after, archiveContext));
    await act(async () => completion);

    await waitFor(() =>
      expect(sibling.result.current.state.nodesById.root).toBeUndefined()
    );
    expect(notesHistorySpies.acceptMutationResult).toHaveBeenCalledWith(
      archiveContext.entryId,
      expect.anything(),
      expect.objectContaining({ nextUndoEntryId: archiveContext.entryId })
    );
    expect(sibling.result.current.canUndo).toBe(true);
    await act(async () => sibling.result.current.actions.undo!());
    expect(undo).toHaveBeenCalledWith("/archive-unmount", {
      sessionId: archiveContext.sessionId,
      historyEpoch: archiveContext.historyEpoch,
      expectedEntryId: archiveContext.entryId,
      scope: { kind: "active" }
    });
    expect(sibling.result.current.state.nodesById.root).toBeDefined();
    expect(sibling.result.current.state).toMatchObject({
      selectedId: "other",
      zoomRootId: "other",
      editingNoteId: "other",
      pendingFocusId: "other"
    });
  });

  it("reloads an Archive sibling when its lifecycle owner unmounts after commit", async () => {
    const active = workspace([node({ id: "active-root" })]);
    const archived = workspace([
      node({
        id: "archive-root",
        archivedAt: "2026-07-11T00:00:00Z"
      }),
      node({
        id: "archive-other",
        sortKey: 2048,
        archivedAt: "2026-07-11T00:00:00Z"
      })
    ]);
    const afterUnarchive = workspace([
      node({ id: "active-root" }),
      node({ id: "archive-root", sortKey: 2048 })
    ]);
    const committed = deferred<NotesWorkspace>();
    const loadWorkspace = vi.fn((_vaultRoot, scope) =>
      Promise.resolve(scope?.kind === "archive" ? archived : active)
    );
    const store = repository({
      loadWorkspace,
      unarchiveNode: vi.fn().mockReturnValue(committed.promise)
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/archive-ownerless", repository: store })
    );
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));
    await act(async () => {
      await sibling.result.current.actions.selectLibraryView("archive");
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/archive-ownerless", repository: store })
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    await act(async () => owner.result.current.actions.selectLibraryView("archive"));

    const completion =
      owner.result.current.actions.unarchiveNode("archive-root");
    await waitFor(() => expect(store.unarchiveNode).toHaveBeenCalledOnce());
    owner.unmount();
    committed.resolve(afterUnarchive);
    await act(async () => completion);

    await waitFor(() =>
      expect(
        loadWorkspace.mock.calls.filter(
          ([, scope]) => scope?.kind === "archive"
        )
      ).toHaveLength(3)
    );
    expect(
      sibling.result.current.state.nodesById["archive-other"]
    ).toBeDefined();
    expect(
      sibling.result.current.state.nodesById["active-root"]
    ).toBeUndefined();
  });

  it("reloads each sibling's own scope instead of installing the owner's projection", async () => {
    const active = workspace([node({ id: "active-root" })]);
    const archived = workspace([
      node({ id: "archive-root", archivedAt: "2026-07-11T00:00:00Z" })
    ]);
    const loadWorkspace = vi.fn((_vaultRoot, scope) =>
      Promise.resolve(scope?.kind === "archive" ? archived : active)
    );
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) =>
      mutationResult(
        workspace([node({ id: "active-root", isStarred: true })]),
        context
      )
    );
    const store = repository({ loadWorkspace, toggleStar });
    const archive = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/scoped-siblings", repository: store })
    );
    await waitFor(() => expect(archive.result.current.status).toBe("ready"));
    await act(async () =>
      archive.result.current.actions.selectLibraryView("archive")
    );
    expect(
      archive.result.current.state.nodesById["archive-root"]
    ).toBeDefined();
    const all = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/scoped-siblings", repository: store })
    );
    await waitFor(() => expect(all.result.current.status).toBe("ready"));
    expect(all.result.current.libraryView).toBe("archive");
    await act(async () => all.result.current.actions.selectLibraryView("all"));
    const archiveLoadsBeforeMutation = loadWorkspace.mock.calls.filter(
      ([, scope]) => scope?.kind === "archive"
    ).length;

    await act(async () => all.result.current.actions.toggleStar("active-root"));

    await waitFor(() =>
      expect(
        loadWorkspace.mock.calls.filter(
          ([, scope]) => scope?.kind === "archive"
        )
      ).toHaveLength(archiveLoadsBeforeMutation + 1)
    );
    expect(
      archive.result.current.state.nodesById["archive-root"]
    ).toBeDefined();
    expect(
      archive.result.current.state.nodesById["active-root"]
    ).toBeUndefined();
    expect(all.result.current.state.nodesById["active-root"]?.isStarred).toBe(
      true
    );
  });

  it("keeps canonical tag and active scopes independent across coordinated hooks", async () => {
    let starred = false;
    const activeWorkspace = () =>
      workspace([
        node({ id: "active-root", isStarred: starred }),
        node({ id: "outside", sortKey: 2 })
      ]);
    const taggedWorkspace = () =>
      workspace([node({ id: "active-root", isStarred: starred })]);
    const loadWorkspace = vi.fn(async (_vaultRoot, scope) =>
      scope.kind === "tags" ? taggedWorkspace() : activeWorkspace()
    );
    const store = repository({
      loadWorkspace,
      toggleStar: vi.fn().mockImplementation(async () => {
        starred = true;
        return activeWorkspace();
      })
    });
    const tagged = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/tag-siblings", repository: store })
    );
    await waitFor(() => expect(tagged.result.current.status).toBe("ready"));

    await act(async () =>
      tagged.result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    const all = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/tag-siblings", repository: store })
    );
    await waitFor(() => expect(all.result.current.status).toBe("ready"));
    expect(all.result.current.activeTagFilters).toEqual([
      { prefix: "#", normalizedTag: "work" }
    ]);
    await act(async () => all.result.current.actions.selectLibraryView("all"));
    await act(async () =>
      all.result.current.actions.toggleStar("active-root")
    );

    await waitFor(() => {
      expect(
        tagged.result.current.state.nodesById["active-root"]?.isStarred
      ).toBe(true);
      expect(all.result.current.state.nodesById["active-root"]?.isStarred).toBe(
        true
      );
    });
    expect(tagged.result.current.activeTagFilters).toEqual([
      { prefix: "#", normalizedTag: "work" }
    ]);
    expect(tagged.result.current.state.nodesById.outside).toBeUndefined();
    expect(all.result.current.activeTagFilters).toEqual([]);
    expect(all.result.current.libraryView).toBe("all");
    expect(all.result.current.state.nodesById.outside).toBeDefined();
    expect(loadWorkspace).toHaveBeenCalledWith("/tag-siblings", {
      kind: "tags",
      tags: [{ prefix: "#", normalizedTag: "work" }]
    });
  });

  it("resets and generation-guards activation history status across vaults", async () => {
    const firstInitialization = deferred<ReturnType<typeof historyState>>();
    const secondInitialization = deferred<ReturnType<typeof historyState>>();
    const initialize = vi.fn((vaultRoot: string) =>
      vaultRoot === "/first"
        ? firstInitialization.promise
        : secondInitialization.promise
    );
    const store = repository({ initialize });
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
    const rendered = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/first" } }
    );
    const { result, rerender } = rendered;
    await waitFor(() =>
      expect(initialize).toHaveBeenCalledWith(
        "/first",
        expect.objectContaining({ sessionId: expect.any(String) })
      )
    );

    rerender({ vaultRoot: "/second" });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    await waitFor(() =>
      expect(initialize).toHaveBeenCalledWith(
        "/second",
        expect.objectContaining({ sessionId: expect.any(String) })
      )
    );

    secondInitialization.resolve({
      ...historyState("epoch-b"),
      canUndo: false,
      canRedo: false
    });
    await waitFor(() => expect(result.current.canRedo).toBe(false));
    firstInitialization.resolve({
      ...historyState("epoch-a"),
      canUndo: false,
      canRedo: false
    });
    await Promise.resolve();
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(sessions.at(-1)!.history.historyEpoch).toBe("epoch-b");
    rendered.unmount();
    openSession.mockRestore();
  });

  it("flushes pending drafts before creating a new root", async () => {
    createNoteIdMock.mockReturnValue("new-root");
    const invocations: string[] = [];
    const afterDraft = workspace([node({ id: "root", title: "edited" })]);
    const store = repository({
      updateNode: vi.fn().mockImplementation(async () => {
        invocations.push("update");
        return afterDraft;
      }),
      createNode: vi.fn().mockImplementation(async () => {
        invocations.push("create");
        return workspace([
          node({ id: "root", title: "edited" }),
          node({ id: "new-root", sortKey: 2048 })
        ]);
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "edited",
        note: ""
      , imageOffsetUtf16: 0});
    });
    await act(async () => result.current.actions.createRoot());

    expect(invocations).toEqual(["update", "create"]);
  });

  it("flushes an old-vault draft without publishing its response into the new vault", async () => {
    const oldWrite = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi.fn((vaultRoot) =>
        Promise.resolve(
          workspace([
            node({ id: vaultRoot === "/old" ? "old-root" : "new-root" })
          ])
        )
      ),
      updateNode: vi.fn().mockReturnValue(oldWrite.promise)
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() =>
      expect(result.current.state.nodesById["old-root"]).toBeDefined()
    );

    act(() => {
      result.current.actions.updateNodeDraft("old-root", {
        title: "old draft",
        note: ""
      , imageOffsetUtf16: 0});
    });
    rerender({ vaultRoot: "/new" });

    expect(store.updateNode).toHaveBeenCalledWith(
      "/old",
      {
        id: "old-root",
        title: "old draft",
        note: "",
        imageOffsetUtf16: 0
      },
      historyContext("text")
    );
    await waitFor(() =>
      expect(result.current.state.nodesById["new-root"]).toBeDefined()
    );

    await act(async () =>
      oldWrite.resolve(workspace([node({ id: "old-saved" })]))
    );
    expect(result.current.state.nodesById["new-root"]).toBeDefined();
    expect(result.current.state.nodesById["old-saved"]).toBeUndefined();
    expect(result.current.draftsByNodeId).toEqual({});
  });

  it("does not let a late old-vault draft poison the next history UI snapshot", async () => {
    const oldWrite = deferred<NotesWorkspace>();
    const newWorkspace = workspace([node({ id: "new-root" })]);
    const toggleStar = vi
      .fn()
      .mockResolvedValue(
        workspace([node({ id: "new-root", isStarred: true })])
      );
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: newWorkspace,
      replayedEntryId: toggleStar.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      kind: "applied" as const,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi.fn((vaultRoot) =>
        Promise.resolve(
          vaultRoot === "/old"
            ? workspace([node({ id: "old-root" })])
            : newWorkspace
        )
      ),
      updateNode: vi.fn().mockReturnValue(oldWrite.promise),
      toggleStar,
      undo
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() =>
      expect(result.current.state.nodesById["old-root"]).toBeDefined()
    );

    act(() => {
      result.current.actions.updateNodeDraft("old-root", {
        title: "late old draft",
        note: ""
      , imageOffsetUtf16: 0});
    });
    rerender({ vaultRoot: "/new" });
    await waitFor(() =>
      expect(result.current.state.nodesById["new-root"]).toBeDefined()
    );
    await act(async () => {
      await result.current.actions.focusNode("new-root");
      await result.current.actions.zoomTo("new-root");
    });
    await act(async () => {
      oldWrite.resolve(workspace([node({ id: "old-root", title: "late" })]));
    });

    await act(async () => result.current.actions.toggleStar("new-root"));
    await act(async () => result.current.actions.undo!());

    expect(result.current.state.nodesById["new-root"]).toBeDefined();
    expect(result.current.state.nodesById["old-root"]).toBeUndefined();
    expect(result.current.state).toMatchObject({
      selectedId: "new-root",
      zoomRootId: "new-root",
      pendingFocusId: "new-root",
      pendingFocusField: "title"
    });
  });

  it("recovers a failed shutdown draft only when its vault becomes active again", async () => {
    const oldBefore = workspace([node({ id: "old-root", title: "Old title" })]);
    const oldSaved = workspace([
      node({ id: "old-root", title: "Recovered old draft" })
    ]);
    const base = repository({
      loadWorkspace: vi.fn((vaultRoot) =>
        Promise.resolve(
          vaultRoot === "/old"
            ? oldBefore
            : workspace([node({ id: "new-root", title: "New title" })])
        )
      ),
      updateNode: vi
        .fn()
        .mockRejectedValueOnce(new Error("old vault disk full"))
        .mockResolvedValueOnce(oldSaved)
    });
    const { repository: store, events } = journalNotesRepository(base);
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() =>
      expect(result.current.state.nodesById["old-root"]).toBeDefined()
    );
    events.clear();

    act(() => {
      result.current.actions.updateNodeDraft("old-root", {
        title: "Recovered old draft",
        note: ""
      , imageOffsetUtf16: 0});
    });
    rerender({ vaultRoot: "/new" });

    await waitFor(() =>
      expect(result.current.state.nodesById["new-root"]).toBeDefined()
    );
    expect(result.current.draftsByNodeId).toEqual({});
    expect(result.current.writeError).toBeNull();

    rerender({ vaultRoot: "/old" });
    await waitFor(() =>
      expect(result.current.draftsByNodeId["old-root"]).toMatchObject({
        title: "Recovered old draft",
        status: "failed"
      })
    );
    expect(result.current.writeError).toMatchObject({
      operation: "write",
      retryable: true,
      message: "old vault disk full"
    });

    await act(async () => result.current.retryFailedDraft("old-root"));

    const [failedWrite, retriedWrite] = events.for("updateNode");
    expect(retriedWrite?.historyEntryId).not.toBe(failedWrite?.historyEntryId);
    expect(retriedWrite).toMatchObject({
      vaultRoot: "/old",
      commandKind: "text",
      input: {
        id: "old-root",
        title: "Recovered old draft",
        note: "",
        imageOffsetUtf16: 0
      }
    });
    await waitFor(() =>
      expect(result.current.draftsByNodeId["old-root"]).toBeUndefined()
    );
    expect(result.current.writeError).toBeNull();
  });

  it("flushes a dirty unmount before a same-vault remount activation", async () => {
    const unmountWrite = deferred<NotesWorkspace>();
    let loadCount = 0;
    const store = repository({
      loadWorkspace: vi.fn(() => {
        loadCount += 1;
        return Promise.resolve(
          workspace([
            node({
              id: "root",
              title: loadCount === 1 ? "before" : "saved"
            })
          ])
        );
      }),
      updateNode: vi.fn().mockReturnValue(unmountWrite.promise)
    });
    const firstMount = renderHook(
      () => useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
      { wrapper: strictMode }
    );
    await waitFor(() => expect(firstMount.result.current.status).toBe("ready"));

    act(() => {
      firstMount.result.current.actions.updateNodeDraft("root", {
        title: "saved",
        note: ""
      , imageOffsetUtf16: 0});
    });
    firstMount.unmount();
    expect(store.updateNode).toHaveBeenCalledOnce();

    const secondMount = renderHook(
      () => useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
      { wrapper: strictMode }
    );
    expect(store.loadWorkspace).toHaveBeenCalledOnce();

    await act(async () =>
      unmountWrite.resolve(
        workspace([node({ id: "root", title: "saved" })])
      )
    );
    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(secondMount.result.current.state.nodesById.root.title).toBe(
        "saved"
      )
    );
    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(secondMount.result.current.draftsByNodeId).toEqual({});
    expect(secondMount.result.current.writeError).toBeNull();
  });

  it("does not launch or publish old-identity queued work after a vault change", async () => {
    const oldLoad = deferred<NotesWorkspace>();
    const newLoad = deferred<NotesWorkspace>();
    const oldStore = repository({
      loadWorkspace: vi.fn().mockReturnValue(oldLoad.promise),
      updateNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "old-command" })]))
    });
    const newStore = repository({
      loadWorkspace: vi.fn().mockReturnValue(newLoad.promise)
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot, repository: current }) =>
        useNotesWorkspace({ vaultRoot, repository: current }),
      { initialProps: { vaultRoot: "/old", repository: oldStore } }
    );
    await waitFor(() => expect(oldStore.loadWorkspace).toHaveBeenCalledOnce());

    let oldCompletion!: Promise<unknown>;
    act(() => {
      oldCompletion = result.current.actions.updateNode("old", {
        title: "stale",
        note: ""
      });
    });

    rerender({ vaultRoot: "/new", repository: newStore });
    expect(result.current.status).toBe("loading");
    expect(result.current.state.rootIds).toEqual([]);
    await waitFor(() => expect(newStore.loadWorkspace).toHaveBeenCalledOnce());

    await act(async () => {
      oldLoad.resolve(workspace([node({ id: "old" })]));
      await oldCompletion;
    });

    expect(oldStore.updateNode).not.toHaveBeenCalled();
    expect(result.current.state.nodesById.old).toBeUndefined();
    expect(result.current.status).toBe("loading");

    await act(async () =>
      newLoad.resolve(workspace([node({ id: "new" })]))
    );
    expect(result.current.state.nodesById.new).toBeDefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("does not publish in-flight work or launch later queued work after unmount", async () => {
    const load = deferred<NotesWorkspace>();
    const loadingStore = repository({ loadWorkspace: vi.fn().mockReturnValue(load.promise) });
    const loadingHook = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/loading", repository: loadingStore })
    );
    await waitFor(() => expect(loadingStore.loadWorkspace).toHaveBeenCalledOnce());
    loadingHook.unmount();

    await act(async () => load.resolve(workspace([node({ id: "late-load" })])));
    expect(loadingHook.result.current.state.nodesById["late-load"]).toBeUndefined();

    const command = deferred<NotesWorkspace>();
    const commandStore = repository({
      updateNode: vi
        .fn()
        .mockReturnValueOnce(command.promise)
        .mockResolvedValueOnce(workspace([node({ id: "never-launched" })]))
    });
    const commandHook = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/command", repository: commandStore })
    );
    await waitFor(() => expect(commandHook.result.current.status).toBe("ready"));
    let firstCompletion!: Promise<unknown>;
    let secondCompletion!: Promise<unknown>;
    act(() => {
      firstCompletion = commandHook.result.current.actions.updateNode("root", {
        title: "first",
        note: ""
      });
      secondCompletion = commandHook.result.current.actions.updateNode("root", {
        title: "second",
        note: ""
      });
    });
    await waitFor(() =>
      expect(commandStore.updateNode).toHaveBeenCalledOnce()
    );
    commandHook.unmount();

    await act(async () => {
      command.resolve(workspace([node({ id: "late-command" })]));
      await Promise.all([firstCompletion, secondCompletion]);
    });
    expect(commandStore.updateNode).toHaveBeenCalledOnce();
    expect(commandHook.result.current.state.nodesById["late-command"]).toBeUndefined();
  });

  it("keeps a running mutation as the barrier across unmount and remount", async () => {
    const running = deferred<NotesWorkspace>();
    const refresh = deferred<NotesWorkspace>();
    const invocations: string[] = [];
    let loadCount = 0;
    const base = repository({
      initialize: vi.fn(async () => {
        invocations.push("initialize");
        return historyState();
      }),
      loadWorkspace: vi.fn(() => {
        loadCount += 1;
        invocations.push(`load:${loadCount}`);
        return loadCount === 1
          ? Promise.resolve(workspace([node({ id: "before-a1" })]))
          : refresh.promise;
      }),
      updateNode: vi.fn((_vaultRoot, input) => {
        invocations.push(`update:${input.title}`);
        return input.title === "A1"
          ? running.promise
          : Promise.resolve(workspace([node({ id: "after-a3" })]));
      })
    });
    const { repository: store, events } = journalNotesRepository(base);
    const firstMount = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault-a", repository: store })
    );
    await waitFor(() => expect(firstMount.result.current.status).toBe("ready"));

    let firstCompletion!: Promise<unknown>;
    let oldQueuedCompletion!: Promise<unknown>;
    let oldQueuedSettled = false;
    act(() => {
      firstCompletion = firstMount.result.current.actions.updateNode("before-a1", {
        title: "A1",
        note: ""
      });
      oldQueuedCompletion = firstMount.result.current.actions.updateNode("before-a1", {
        title: "old-A2",
        note: ""
      });
      void oldQueuedCompletion.then(() => {
        oldQueuedSettled = true;
      });
    });
    await waitFor(() => expect(events.for("updateNode")).toHaveLength(1));

    firstMount.unmount();
    await act(async () => Promise.resolve());
    expect(oldQueuedSettled).toBe(true);

    const secondMount = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault-a", repository: store })
    );
    let newCompletion!: Promise<unknown>;
    act(() => {
      newCompletion = secondMount.result.current.actions.updateNode("a1-response", {
        title: "A3",
        note: ""
      });
    });

    expect(events.for("loadWorkspace")).toHaveLength(1);
    expect(events.for("updateNode")).toHaveLength(1);
    expect(secondMount.result.current.state.rootIds).toEqual([]);

    await act(async () => {
      running.resolve(workspace([node({ id: "a1-response" })]));
      await firstCompletion;
    });
    await waitFor(() => expect(events.for("loadWorkspace")).toHaveLength(2));
    expect(events.for("updateNode")).toHaveLength(1);
    expect(secondMount.result.current.state.rootIds).toEqual(["a1-response"]);

    await act(async () =>
      refresh.resolve(workspace([node({ id: "after-a1" })]))
    );
    await waitFor(() => expect(events.for("updateNode")).toHaveLength(2));
    await act(async () => {
      await newCompletion;
      await oldQueuedCompletion;
    });

    expect(
      events.for("updateNode").map(({ vaultRoot, commandKind, input }) => ({
        vaultRoot,
        commandKind,
        input
      }))
    ).toEqual([
      {
        vaultRoot: "/vault-a",
        commandKind: "update",
        input: { id: "before-a1", title: "A1", note: "", imageOffsetUtf16: 0 }
      },
      {
        vaultRoot: "/vault-a",
        commandKind: "update",
        input: { id: "a1-response", title: "A3", note: "", imageOffsetUtf16: 0 }
      }
    ]);
    expect(invocations).toEqual([
      "initialize",
      "load:1",
      "update:A1",
      "load:2",
      "update:A3"
    ]);
    expect(secondMount.result.current.state.nodesById["after-a3"]).toBeDefined();
  });

  it("serializes A -> B -> A per vault without blocking B", async () => {
    const runningA1 = deferred<NotesWorkspace>();
    const refreshedA = deferred<NotesWorkspace>();
    let aLoadCount = 0;
    const base = repository({
      loadWorkspace: vi.fn((vaultRoot) => {
        if (vaultRoot === "/vault-b") {
          return Promise.resolve(workspace([node({ id: "b-root" })]));
        }
        aLoadCount += 1;
        return aLoadCount === 1
          ? Promise.resolve(workspace([node({ id: "a-before" })]))
          : refreshedA.promise;
      }),
      updateNode: vi.fn((vaultRoot, input) => {
        if (input.title === "A1") {
          return runningA1.promise;
        }
        return Promise.resolve(
          workspace([
            node({
              id: vaultRoot === "/vault-b" ? "b-updated" : "a3-updated"
            })
          ])
        );
      })
    });
    const { repository: store, events } = journalNotesRepository(base);
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/vault-a" } }
    );
    await waitFor(() => expect(result.current.state.nodesById["a-before"]).toBeDefined());

    let a1Completion!: Promise<unknown>;
    let oldA2Completion!: Promise<unknown>;
    act(() => {
      a1Completion = result.current.actions.updateNode("a-before", {
        title: "A1",
        note: ""
      });
      oldA2Completion = result.current.actions.updateNode("a-before", {
        title: "old-A2",
        note: ""
      });
    });
    await waitFor(() => expect(events.for("updateNode")).toHaveLength(1));

    rerender({ vaultRoot: "/vault-b" });
    await waitFor(() => expect(result.current.state.nodesById["b-root"]).toBeDefined());
    await act(async () =>
      result.current.actions.updateNode("b-root", { title: "B1", note: "" })
    );
    expect(events.for("updateNode")[1]).toMatchObject({
      vaultRoot: "/vault-b",
      commandKind: "update",
      input: { id: "b-root", title: "B1", note: "", imageOffsetUtf16: 0 }
    });

    rerender({ vaultRoot: "/vault-a" });
    let a3Completion!: Promise<unknown>;
    act(() => {
      a3Completion = result.current.actions.updateNode("a1-response", {
        title: "A3",
        note: ""
      });
    });
    await act(async () => Promise.resolve());
    expect(aLoadCount).toBe(1);
    expect(result.current).toMatchObject({ status: "loading", error: null });
    expect(result.current.state.rootIds).toEqual([]);

    await act(async () => {
      runningA1.resolve(workspace([node({ id: "a1-response" })]));
      await a1Completion;
      await oldA2Completion;
    });
    await waitFor(() => expect(aLoadCount).toBe(2));
    expect(result.current.state.rootIds).toEqual(["a1-response"]);
    expect(events.for("updateNode")).toHaveLength(2);

    await act(async () =>
      refreshedA.resolve(workspace([node({ id: "after-a1" })]))
    );
    await act(async () => a3Completion);

    expect(events.for("updateNode")[2]).toMatchObject({
      vaultRoot: "/vault-a",
      commandKind: "update",
      input: { id: "a1-response", title: "A3", note: "", imageOffsetUtf16: 0 }
    });
    expect(result.current.state.nodesById["a3-updated"]).toBeDefined();
    expect(result.current.state.nodesById["a-before"]).toBeUndefined();
  });

  it("keeps the committed identity active when a different render is abandoned", async () => {
    const firstCommand = deferred<NotesWorkspace>();
    const suspended = deferred<void>();
    const base = repository({
      updateNode: vi
        .fn()
        .mockReturnValueOnce(firstCommand.promise)
        .mockResolvedValueOnce(workspace([node({ id: "second-a-result" })]))
    });
    const { repository: store, events } = journalNotesRepository(base);
    const { result, rerender } = renderHook(
      ({ vaultRoot, shouldSuspend }) => {
        const current = useNotesWorkspace({ vaultRoot, repository: store });
        if (shouldSuspend) {
          throw suspended.promise;
        }
        return current;
      },
      {
        initialProps: { vaultRoot: "/vault-a", shouldSuspend: false },
        wrapper: suspenseMode
      }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<unknown>;
    let secondCompletion!: Promise<unknown>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("root", {
        title: "committed-A1",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("root", {
        title: "committed-A2",
        note: ""
      });
    });
    await waitFor(() => expect(events.for("updateNode")).toHaveLength(1));

    rerender({ vaultRoot: "/vault-b", shouldSuspend: true });
    expect(events.for("initialize")).toHaveLength(1);

    await act(async () => {
      firstCommand.resolve(workspace([
        node({ id: "root" }),
        node({ id: "first-a-result" })
      ]));
      await Promise.all([firstCompletion, secondCompletion]);
    });

    expect(events.for("updateNode")).toHaveLength(2);
    expect(events.for("updateNode")[1]).toMatchObject({
      vaultRoot: "/vault-a",
      commandKind: "update",
      input: { id: "root", title: "committed-A2", note: "", imageOffsetUtf16: 0 }
    });
  });

  it("retains a root creation failure when its queued child dependency is missing", async () => {
    createNoteIdMock
      .mockReturnValueOnce("new-parent")
      .mockReturnValueOnce("new-child");
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
      createNode: vi.fn().mockRejectedValue(new Error("root failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let rootCompletion!: Promise<unknown>;
    let childCompletion!: Promise<unknown>;
    act(() => {
      rootCompletion = result.current.actions.createRoot();
      childCompletion = result.current.actions.createChild("new-parent");
    });
    await act(async () => {
      await Promise.all([rootCompletion, childCompletion]);
    });

    expect(store.createNode).toHaveBeenCalledOnce();
    expect(result.current.state.rootIds).toEqual([]);
    expect(result.current).toMatchObject({ status: "error", error: "root failed" });
  });

  it("retains a split failure when its queued duplicate dependency is missing", async () => {
    const store = repository({
      splitNode: vi.fn().mockRejectedValue(new Error("split failed")),
      duplicateNode: vi.fn().mockResolvedValue(workspace([]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let splitCompletion!: Promise<unknown>;
    let duplicateCompletion!: Promise<unknown>;
    act(() => {
      splitCompletion = result.current.actions.splitNode(
        "root",
        "split-child",
        "prefix",
        "suffix"
      );
      duplicateCompletion = result.current.actions.duplicateNode("split-child");
    });
    await act(async () => {
      await Promise.all([splitCompletion, duplicateCompletion]);
    });

    expect(store.splitNode).toHaveBeenCalledOnce();
    expect(store.duplicateNode).not.toHaveBeenCalled();
    expect(result.current.state.nodesById.root).toBeDefined();
    expect(result.current).toMatchObject({ status: "error", error: "split failed" });
  });

  it("handles a synchronous createNoteId throw and clears it on later authoritative success", async () => {
    createNoteIdMock
      .mockImplementationOnce(() => {
        throw new Error("id creation failed");
      })
      .mockReturnValueOnce("created-after-failure");
    const store = repository({
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "created-after-failure" })]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let failedCompletion!: Promise<unknown>;
    act(() => {
      failedCompletion = result.current.actions.createRoot();
    });
    await act(async () => {
      await expect(failedCompletion).resolves.toBe("failed");
    });
    expect(store.createNode).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      status: "error",
      error: "id creation failed"
    });

    await act(async () => result.current.actions.createRoot());
    expect(store.createNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "created-after-failure",
        parentId: null,
        afterId: "root",
        title: "",
        note: ""
      },
      historyContext("create")
    );
    expect(result.current.state.nodesById["created-after-failure"]).toBeDefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("isolates the same vault across different repository objects", async () => {
    const firstRepositoryCommand = deferred<NotesWorkspace>();
    const firstStore = repository({
      updateNode: vi.fn().mockReturnValue(firstRepositoryCommand.promise)
    });
    const secondStore = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "second-root" })])),
      updateNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "second-updated" })]))
    });
    const { result, rerender } = renderHook(
      ({ repository: current }) =>
        useNotesWorkspace({ vaultRoot: "/shared-vault", repository: current }),
      { initialProps: { repository: firstStore } }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<unknown>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("root", {
        title: "first repository",
        note: ""
      });
    });
    await waitFor(() => expect(firstStore.updateNode).toHaveBeenCalledOnce());

    rerender({ repository: secondStore });
    await waitFor(() => expect(result.current.state.nodesById["second-root"]).toBeDefined());
    await act(async () =>
      result.current.actions.updateNode("second-root", {
        title: "second repository",
        note: ""
      })
    );

    expect(secondStore.updateNode).toHaveBeenCalledOnce();
    expect(result.current.state.nodesById["second-updated"]).toBeDefined();

    await act(async () => {
      firstRepositoryCommand.resolve(workspace([node({ id: "first-late" })]));
      await firstCompletion;
    });
    expect(result.current.state.nodesById["first-late"]).toBeUndefined();
  });

  it("allows restore to target a node absent from the active workspace", async () => {
    const store = repository({
      restoreNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "restored" })]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.restoreNode("restored"));

    expect(store.restoreNode).toHaveBeenCalledWith(
      "/vault",
      "restored",
      historyContext("restore")
    );
    expect(result.current.state.nodesById.restored).toBeDefined();
  });

  it("follows the currently viewed restored Trash root into Active with title focus", async () => {
    const activeBefore = workspace([node({ id: "active", sortKey: 1 })]);
    const deleted = node({
      id: "deleted",
      sortKey: 2,
      title: "Deleted",
      deletedAt: "2026-07-10T01:00:00Z"
    });
    const activeAfter = workspace([
      node({ id: "active", sortKey: 1 }),
      { ...deleted, deletedAt: null }
    ]);
    let restored = false;
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "trash"
          ? workspace(restored ? [] : [deleted])
          : restored
            ? activeAfter
            : activeBefore
      ),
      restoreNode: vi.fn(async () => {
        restored = true;
        return activeAfter;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("trash"));
    await act(async () => {
      await result.current.actions.zoomTo("deleted");
      await result.current.actions.focusNode("deleted");
    });

    await act(async () => result.current.actions.restoreNode("deleted"));

    expect(store.restoreNode).toHaveBeenCalledWith(
      "/vault",
      "deleted",
      historyContext("restore")
    );
    expect(result.current.libraryView).toBe("all");
    expect(result.current.state).toMatchObject({
      rootIds: ["active", "deleted"],
      selectedId: "deleted",
      zoomRootId: "deleted",
      editingNoteId: "deleted",
      pendingFocusId: "deleted",
      pendingFocusField: "title"
    });
  });

  it("flushes every draft before archiving a root and selects the next visible root", async () => {
    const before = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "second-child", parentId: "second", sortKey: 1 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const after = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const base = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      updateNode: vi.fn().mockResolvedValue(before),
      archiveNode: vi.fn().mockResolvedValue(after),
      listTagsWithCounts: vi.fn().mockResolvedValue([
        {
          prefix: "#",
          normalizedTag: "remaining",
          displayTag: "remaining",
          count: 1
        }
      ])
    });
    const { repository: store, events } = journalNotesRepository(base);
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.rootIds).toEqual([
      "first",
      "second",
      "third"
    ]));
    events.clear();

    act(() => {
      void result.current.actions.zoomTo("second");
      result.current.actions.updateNodeDraft("second-child", {
        title: "Saved before archive",
        note: ""
      , imageOffsetUtf16: 0});
    });
    await act(async () => result.current.actions.archiveNode("second"));

    expect(events.for("updateNode")).toEqual([
      expect.objectContaining({
        vaultRoot: "/vault",
        nodeId: "second-child",
        commandKind: "text",
        input: {
        id: "second-child",
        title: "Saved before archive",
        note: "",
        imageOffsetUtf16: 0
        }
      })
    ]);
    expect(events.for("archiveNode")).toEqual([
      expect.objectContaining({
        vaultRoot: "/vault",
        nodeId: "second",
        commandKind: "archive"
      })
    ]);
    expect(
      events.all
        .filter(({ operation }) =>
          operation === "updateNode" || operation === "archiveNode"
        )
        .map(({ operation }) => operation)
    ).toEqual(["updateNode", "archiveNode"]);
    expect(
      events
        .for("listTagsWithCounts")
        .some(({ vaultRoot }) => vaultRoot === "/vault")
    ).toBe(true);
    expect(result.current.tagSummaries).toEqual([
      {
        prefix: "#",
        normalizedTag: "remaining",
        displayTag: "remaining",
        count: 1
      }
    ]);
    expect(result.current.state).toMatchObject({
      rootIds: ["first", "third"],
      selectedId: "third",
      zoomRootId: "third",
      editingNoteId: "third",
      pendingFocusId: "third"
    });
  });

  it("falls back to the active projection when a post-archive scoped reload fails", async () => {
    const target = node({ id: "target", isStarred: true, sortKey: 1 });
    const outside = node({ id: "outside", sortKey: 2 });
    const before = workspace([target, outside]);
    const after = workspace([outside]);
    let archived = false;
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) => {
        if (scope.kind === "starred") {
          if (archived) {
            throw new Error("Starred projection failed");
          }
          return workspace([target]);
        }
        return archived ? after : before;
      }),
      archiveNode: vi.fn(async () => {
        archived = true;
        return after;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("starred"));
    await act(async () => result.current.actions.zoomTo("target"));

    await act(async () => result.current.actions.archiveNode("target"));

    expect(store.archiveNode).toHaveBeenCalledWith(
      "/vault",
      "target",
      historyContext("archive")
    );
    expect(result.current.error).toBeNull();
    expect(result.current.libraryView).toBe("all");
    expect(result.current.state).toMatchObject({
      rootIds: ["outside"],
      selectedId: null,
      zoomRootId: null,
      editingNoteId: null,
      pendingFocusId: null
    });
  });

  it("preserves navigation made while a root lifecycle mutation is pending", async () => {
    const before = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const after = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const archive = deferred<NotesMutationResult>();
    let archiveContext!: NotesHistoryContext;
    const archiveNode = vi.fn((_vaultRoot, _nodeId, context) => {
      archiveContext = context;
      return archive.promise;
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      archiveNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.zoomTo("second"));

    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.actions.archiveNode("second");
    });
    await waitFor(() => expect(store.archiveNode).toHaveBeenCalledOnce());

    let navigation!: Promise<unknown>;
    act(() => {
      navigation = result.current.actions.zoomTo("first");
    });
    expect(result.current.state.zoomRootId).toBe("second");

    await act(async () => {
      archive.resolve(mutationResult(after, archiveContext));
      await Promise.all([completion, navigation]);
    });

    expect(result.current.state).toMatchObject({
      rootIds: ["first", "third"],
      selectedId: "first",
      zoomRootId: "first",
      editingNoteId: "first",
      pendingFocusId: "first"
    });
    await act(async () => result.current.actions.focusNode("first"));
    expect(result.current.state).toMatchObject({
      selectedId: "first",
      zoomRootId: "first",
      editingNoteId: "first",
      pendingFocusId: "first"
    });
  });

  it("preserves navigation when the lifecycle mutation resolves before React renders it", async () => {
    const before = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const after = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const archive = deferred<NotesMutationResult>();
    let archiveContext!: NotesHistoryContext;
    const archiveNode = vi.fn((_vaultRoot, _nodeId, context) => {
      archiveContext = context;
      return archive.promise;
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      archiveNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.zoomTo("second"));

    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.actions.archiveNode("second");
    });
    await waitFor(() => expect(store.archiveNode).toHaveBeenCalledOnce());

    let navigation!: Promise<unknown>;
    await act(async () => {
      navigation = result.current.actions.zoomTo("first");
      expect(result.current.state.zoomRootId).toBe("second");
      archive.resolve(mutationResult(after, archiveContext));
      await Promise.all([completion, navigation]);
    });

    expect(result.current.state).toMatchObject({
      rootIds: ["first", "third"],
      selectedId: "first",
      zoomRootId: "first",
      editingNoteId: "first",
      pendingFocusId: "first"
    });
    await act(async () => result.current.actions.focusNode("first"));
    expect(result.current.state).toMatchObject({
      selectedId: "first",
      zoomRootId: "first",
      editingNoteId: "first",
      pendingFocusId: "first"
    });
  });

  it("falls back to the previous root and then the empty state", async () => {
    let current = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async () => current),
      archiveNode: vi.fn().mockImplementation(async (_vault, nodeId) => {
        current = workspace(current.nodes.filter((currentNode) => currentNode.id !== nodeId));
        return current;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.rootIds).toEqual(["first", "second"]));

    await act(async () => result.current.actions.zoomTo("second"));
    await act(async () => result.current.actions.archiveNode("second"));
    expect(result.current.state.zoomRootId).toBe("first");

    await act(async () => result.current.actions.archiveNode("first"));
    expect(result.current.state).toMatchObject({
      rootIds: [],
      selectedId: null,
      zoomRootId: null
    });
  });

  it("uses the same deterministic fallback when an open root moves to Trash", async () => {
    const before = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const after = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      softDeleteNode: vi.fn().mockResolvedValue(after)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.rootIds).toEqual([
      "first",
      "second",
      "third"
    ]));

    await act(async () => result.current.actions.zoomTo("second"));
    await act(async () => result.current.actions.deleteNode("second"));

    expect(result.current.state).toMatchObject({
      rootIds: ["first", "third"],
      selectedId: "third",
      zoomRootId: "third",
      editingNoteId: "third",
      pendingFocusId: "third"
    });
  });

  it("rejects non-root archive and unarchive targets before invoking storage", async () => {
    const child = node({ id: "child", parentId: "root" });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([
        node({ id: "root" }),
        child
      ]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.nodesById.child).toBeDefined());

    await act(async () => {
      await result.current.actions.archiveNode("child");
      await result.current.actions.unarchiveNode("child");
    });

    expect(store.archiveNode).not.toHaveBeenCalled();
    expect(store.unarchiveNode).not.toHaveBeenCalled();
  });

  it("unarchives a root through the archive scope and chooses its next archived sibling", async () => {
    const active = workspace([node({ id: "active" })]);
    let archived = workspace([
      node({
        id: "archived-first",
        sortKey: 1,
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-first"
      }),
      node({
        id: "archived-second",
        sortKey: 2,
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-second"
      })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async (_vault, scope) =>
        scope.kind === "archive" ? archived : active
      ),
      unarchiveNode: vi.fn().mockImplementation(async () => {
        archived = workspace(archived.nodes.filter((current) => current.id !== "archived-first"));
        return active;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("archive"));
    await act(async () => result.current.actions.zoomTo("archived-first"));
    await act(async () => result.current.actions.unarchiveNode("archived-first"));

    expect(store.unarchiveNode).toHaveBeenCalledWith(
      "/vault",
      "archived-first",
      historyContext("unarchive")
    );
    expect(store.loadWorkspace).toHaveBeenLastCalledWith("/vault", {
      kind: "archive"
    });
    expect(result.current.state).toMatchObject({
      rootIds: ["archived-second"],
      selectedId: "archived-second",
      zoomRootId: "archived-second",
      editingNoteId: "archived-second",
      pendingFocusId: "archived-second"
    });
  });

  it("focuses the next archived sibling after moving the open archived root to Trash", async () => {
    const active = workspace([node({ id: "active" })]);
    let archived = workspace([
      node({
        id: "archived-first",
        sortKey: 1,
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-first"
      }),
      node({
        id: "archived-second",
        sortKey: 2,
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-second"
      })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async (_vault, scope) =>
        scope.kind === "archive" ? archived : active
      ),
      softDeleteNode: vi.fn().mockImplementation(async () => {
        archived = workspace(
          archived.nodes.filter((current) => current.id !== "archived-first")
        );
        return active;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("archive"));
    await act(async () => result.current.actions.zoomTo("archived-first"));

    await act(async () => result.current.actions.deleteNode("archived-first"));

    expect(store.softDeleteNode).toHaveBeenCalledWith(
      "/vault",
      "archived-first",
      historyContext("trash")
    );
    expect(result.current.state).toMatchObject({
      rootIds: ["archived-second"],
      selectedId: "archived-second",
      zoomRootId: "archived-second",
      editingNoteId: "archived-second",
      pendingFocusId: "archived-second"
    });
  });
});
