import { act, render, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, useLayoutEffect, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isNotesMutationResult, type NoteAttachment, type NoteNode, type NotesHistoryContext, type NotesHistoryReplayOutcome, type NotesHistoryState, type NotesMutationResponse, type NotesMutationResult, type NotesStore, type NotesWorkspace } from "../../domain/notes";
import { resetImageImportRecoveryForTests, useNotesWorkspace, type NotesWorkspaceActions, type UseNotesWorkspaceResult } from "./useNotesWorkspace";
import type { NotesAttachmentUiBoundary } from "./notesAttachmentController";
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

function mockAttachmentUi(
  openImageFiles = vi.fn().mockResolvedValue(null)
): NotesAttachmentUiBoundary {
  return {
    openImageFiles,
    saveImageFile: vi.fn().mockResolvedValue(null),
    subscribeToImageDrop: vi.fn().mockResolvedValue(vi.fn())
  };
}

function strictMode({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>;
}

function repository(overrides: Partial<NotesStore> = {}): NotesStore {
  const empty = vi.fn().mockResolvedValue(workspace([]));
  const store: NotesStore = {
    initialize: vi.fn().mockResolvedValue(historyState()),
    loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
    createNode: empty,
    updateNode: empty,
    setReadonly: vi.fn<NonNullable<NotesStore["setReadonly"]>>(),
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
    setReadonly: store.setReadonly
      ? withEpochAwareMutation(store.setReadonly)
      : undefined,
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

interface StartupCommandProps {
  actions: NotesWorkspaceActions;
  identity: string;
  onCompletion(completion: Promise<unknown>): void;
}

function LayoutStartupCommand({
  actions,
  identity,
  onCompletion
}: StartupCommandProps) {
  useLayoutEffect(() => {
    onCompletion(actions.createRoot());
  }, [actions, identity, onCompletion]);
  return null;
}

function PassiveStartupCommand({
  actions,
  identity,
  onCompletion
}: StartupCommandProps) {
  useEffect(() => {
    onCompletion(actions.createRoot());
  }, [actions, identity, onCompletion]);
  return null;
}

interface StartupHarnessProps {
  effect: "layout" | "passive";
  repository: NotesStore;
  vaultRoot: string;
  onCompletion(completion: Promise<unknown>): void;
  onWorkspace(workspace: UseNotesWorkspaceResult): void;
}

function StartupHarness({
  effect,
  repository: store,
  vaultRoot,
  onCompletion,
  onWorkspace
}: StartupHarnessProps) {
  const current = useNotesWorkspace({ vaultRoot, repository: store });
  onWorkspace(current);
  const Command = effect === "layout" ? LayoutStartupCommand : PassiveStartupCommand;
  return (
    <Command
      actions={current.actions}
      identity={vaultRoot}
      onCompletion={onCompletion}
    />
  );
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

  it("reconciles a failed batch before the exactly-next same-node batch runs", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const secondAttachment = attachment({
      id: "8f257d31-d255-4fc8-89dc-4e3b30f24a6e",
      nodeId: root.id
    });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `10000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const firstImport = deferred<NotesMutationResult>();
    const secondImport = deferred<NotesMutationResult>();
    const openImageFiles = vi
      .fn()
      .mockResolvedValueOnce(["/incoming/first.png"])
      .mockResolvedValueOnce(["/incoming/second.png"])
      .mockResolvedValue(null);
    const importImageNodePaths = vi
      .fn()
      .mockReturnValueOnce(firstImport.promise)
      .mockImplementationOnce(async (_vaultRoot, input, context) => ({
        workspace: workspace([
          root,
          node({
            id: input.items[0]!.nodeId,
            nodeKind: "image",
            sortKey: 2048
          })
        ]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [input.items[0]!.nodeId]
      }))
      .mockReturnValueOnce(secondImport.promise)
      .mockImplementation(async (_vaultRoot, _input, context) => ({
        workspace: workspace([root]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: []
      }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([root])),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: mockAttachmentUi(openImageFiles)
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    const first = result.current.actions.uploadImage!(root.id);
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());
    expect(importImageNodePaths).toHaveBeenCalledTimes(1);
    firstImport.reject(new Error("first failed"));
    await act(async () => first);
    const failedAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(failedAttemptId).toBeDefined();
    expect(result.current.attachmentUploadErrorsByNodeId?.[root.id]).toBe(
      "Image upload failed: first failed"
    );

    const second = result.current.actions.uploadImage!(root.id);
    await act(async () => Promise.resolve());
    expect(importImageNodePaths).toHaveBeenCalledOnce();

    await act(async () =>
      result.current.actions.retryImageUpload!(root.id, failedAttemptId)
    );
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(3));
    expect(importImageNodePaths.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({ sourcePath: "/incoming/second.png" })
        ]
      })
    );
    secondImport.resolve({
      workspace: {
        nodes: [root],
        attachmentsByNodeId: { [root.id]: [secondAttachment] }
      },
      historyEntryId:
        importImageNodePaths.mock.calls[2]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false,
      importedRootIds: []
    });
    await act(async () => second);
    await waitFor(() =>
      expect(result.current.state.attachmentsByNodeId[root.id]).toEqual([
        secondAttachment
      ])
    );

    expect(result.current.attachmentUploadErrorsByNodeId?.[root.id]).toBeUndefined();
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id]
    ).toBeUndefined();
    const failedHistoryEntryId =
      importImageNodePaths.mock.calls[0]?.[2]?.entryId;
    const successfulHistoryEntryId =
      importImageNodePaths.mock.calls[2]?.[2]?.entryId;
    expect(
      notesHistorySpies.discard.mock.calls.filter(
        ([entryId]) => entryId === failedHistoryEntryId
      )
    ).toHaveLength(0);
    expect(
      notesHistorySpies.discard.mock.calls.filter(
        ([entryId]) => entryId === successfulHistoryEntryId
      )
    ).toHaveLength(0);
    expect(
      notesHistorySpies.acceptMutationResult.mock.calls.filter(
        ([entryId]) => entryId === failedHistoryEntryId
      )
    ).toHaveLength(1);
    expect(
      notesHistorySpies.acceptMutationResult.mock.calls.filter(
        ([entryId]) => entryId === successfulHistoryEntryId
      )
    ).toHaveLength(1);

    await act(async () =>
      result.current.actions.retryImageUpload!(root.id, failedAttemptId)
    );

    expect(importImageNodePaths).toHaveBeenCalledTimes(3);
  });

  it("preserves other-node and newer pending failures around same-node success", async () => {
    const root = node({ id: "62000000-0000-4000-8000-000000000001" });
    const other = node({
      id: "62000000-0000-4000-8000-000000000002",
      sortKey: 2048
    });
    const imported = attachment({
      id: "61000000-0000-4000-8000-000000000003",
      nodeId: root.id
    });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `61000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const successfulImport = deferred<NotesMutationResult>();
    const newestFailure = deferred<NotesMutationResult>();
    const importImageNodePaths = vi
      .fn()
      .mockRejectedValueOnce(new Error("old root failure"))
      .mockRejectedValueOnce(new Error("other failure"))
      .mockImplementationOnce(async (_vaultRoot, input, context) => ({
        workspace: workspace([
          root,
          other,
          node({
            id: input.items[0]!.nodeId,
            nodeKind: "image",
            sortKey: 3072
          })
        ]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [input.items[0]!.nodeId]
      }))
      .mockReturnValueOnce(successfulImport.promise)
      .mockReturnValueOnce(newestFailure.promise)
      .mockImplementationOnce(async (_vaultRoot, _input, context) => ({
        workspace: {
          nodes: [root, other],
          attachmentsByNodeId: { [root.id]: [imported] }
        },
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: []
      }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([root, other])),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));

    let oldRoot!: Promise<void>;
    let otherFailure!: Promise<void>;
    let successfulRoot!: Promise<void>;
    let pendingRoot!: Promise<void>;
    act(() => {
      oldRoot = result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/old-root.png"
      ]);
      otherFailure = result.current.actions.importDroppedImagePaths!(other.id, [
        "/incoming/other.png"
      ]);
    });
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(2));
    await act(async () => Promise.all([oldRoot, otherFailure]));
    const oldRootRetryAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    const otherRetryAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[other.id];
    expect(oldRootRetryAttemptId).toBeDefined();
    expect(otherRetryAttemptId).toBeDefined();

    act(() => {
      successfulRoot = result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/success.png"
      ]);
    });
    await act(async () => Promise.resolve());
    expect(importImageNodePaths).toHaveBeenCalledTimes(2);

    await act(async () =>
      result.current.actions.retryImageUpload!(root.id, oldRootRetryAttemptId)
    );
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(4));
    act(() => {
      pendingRoot = result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/newest.png"
      ]);
    });
    await act(async () => Promise.resolve());
    expect(importImageNodePaths).toHaveBeenCalledTimes(4);

    successfulImport.resolve({
      workspace: {
        nodes: [root, other],
        attachmentsByNodeId: { [root.id]: [imported] }
      },
      historyEntryId: importImageNodePaths.mock.calls[3]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false,
      importedRootIds: []
    });
    await act(async () => successfulRoot);
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(5));

    await waitFor(() =>
      expect(result.current.state.attachmentsByNodeId[root.id]).toEqual([imported])
    );
    expect(result.current.attachmentUploadErrorsByNodeId?.[root.id]).toBeUndefined();
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id]
    ).toBeUndefined();
    expect(result.current.attachmentUploadErrorsByNodeId?.[other.id]).toBe(
      "Image upload failed: other failure"
    );
    const oldRootHistoryEntryId =
      importImageNodePaths.mock.calls[0]?.[2]?.entryId;
    const otherHistoryEntryId =
      importImageNodePaths.mock.calls[1]?.[2]?.entryId;
    const successfulHistoryEntryId =
      importImageNodePaths.mock.calls[3]?.[2]?.entryId;
    const pendingHistoryEntryId =
      importImageNodePaths.mock.calls[4]?.[2]?.entryId;
    expect(
      notesHistorySpies.discard.mock.calls.filter(
        ([entryId]) => entryId === oldRootHistoryEntryId
      )
    ).toHaveLength(0);
    expect(
      notesHistorySpies.discard.mock.calls.filter(
        ([entryId]) => entryId === otherHistoryEntryId
      )
    ).toHaveLength(0);
    expect(
      notesHistorySpies.discard.mock.calls.filter(
        ([entryId]) => entryId === pendingHistoryEntryId
      )
    ).toHaveLength(0);
    expect(
      notesHistorySpies.acceptMutationResult.mock.calls.filter(
        ([entryId]) => entryId === oldRootHistoryEntryId
      )
    ).toHaveLength(1);
    expect(
      notesHistorySpies.acceptMutationResult.mock.calls.filter(
        ([entryId]) => entryId === successfulHistoryEntryId
      )
    ).toHaveLength(1);

    newestFailure.reject(new Error("newest root failure"));
    await act(async () => pendingRoot);

    expect(result.current.attachmentUploadErrorsByNodeId?.[root.id]).toBe(
      "Image upload failed: newest root failure"
    );
    expect(result.current.attachmentUploadErrorsByNodeId?.[other.id]).toBe(
      "Image upload failed: other failure"
    );
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[other.id]
    ).toBe(otherRetryAttemptId);
    const newestRetryAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(newestRetryAttemptId).toBeDefined();

    await act(async () =>
      result.current.actions.retryImageUpload!(root.id, newestRetryAttemptId)
    );

    expect(importImageNodePaths).toHaveBeenCalledTimes(6);
    expect(importImageNodePaths.mock.calls[5]?.[1]).toEqual(
      importImageNodePaths.mock.calls[4]?.[1]
    );
    expect(importImageNodePaths.mock.calls[5]?.[2]).toBe(
      importImageNodePaths.mock.calls[4]?.[2]
    );
    expect(result.current.attachmentUploadErrorsByNodeId?.[root.id]).toBeUndefined();
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id]
    ).toBeUndefined();
    expect(result.current.attachmentUploadErrorsByNodeId?.[other.id]).toBe(
      "Image upload failed: other failure"
    );
  });

  it("reopens the picker without exposing a stale retry target after dialog failure", async () => {
    const openImageFiles = vi
      .fn()
      .mockRejectedValueOnce(new Error("dialog failed"))
      .mockResolvedValueOnce(null);
    const store = repository();
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: mockAttachmentUi(openImageFiles)
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.uploadImage!("root"));

    expect(result.current.attachmentUploadErrorsByNodeId?.root).toContain(
      "dialog failed"
    );
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
    ).toBeUndefined();
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();

    await act(async () =>
      result.current.actions.retryImageUpload!("root", undefined)
    );

    expect(openImageFiles).toHaveBeenCalledTimes(2);
    expect(openImageFiles.mock.calls).toEqual([[], []]);
    expect(store.importImageNodePaths).not.toHaveBeenCalled();
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
  });

  it("loads attachment bytes on demand without publishing them into workspace state", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const readAttachmentBytes = vi.fn().mockResolvedValue(bytes);
    const store = repository({ readAttachmentBytes });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.actions.loadAttachmentBytes).toBeTypeOf("function");
    let loaded: Uint8Array | undefined;
    await act(async () => {
      loaded = await result.current.actions.loadAttachmentBytes!("attachment-id");
    });

    expect(loaded).toBe(bytes);
    expect(readAttachmentBytes).toHaveBeenCalledWith(
      "/vault",
      "attachment-id"
    );
    expect(result.current.state).not.toHaveProperty("attachmentBytes");
  });

  it("persists one attachment resize as one atomic history command", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const original = attachment({
      id: "1c17ba74-a617-45e7-9e21-74068b63befe",
      nodeId: root.id
    });
    const resized = { ...original, displayWidth: 480 };
    const resizeAttachment = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => ({
        workspace: {
          nodes: [root],
          attachmentsByNodeId: { [root.id]: [resized] }
        },
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue({
        nodes: [root],
        attachmentsByNodeId: { [root.id]: [original] }
      }),
      resizeAttachment
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.actions.resizeImage).toBeTypeOf("function");
    await act(async () =>
      result.current.actions.resizeImage!(original.id, 480)
    );

    expect(resizeAttachment).toHaveBeenCalledOnce();
    expect(resizeAttachment).toHaveBeenCalledWith(
      "/vault",
      { id: original.id, displayWidth: 480 },
      historyContext("attachment-resize")
    );
    expect(result.current.state.attachmentsByNodeId[root.id][0].displayWidth).toBe(
      480
    );
  });

  it("removes an attachment atomically and restores its metadata through Undo and Redo", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const original = attachment({
      id: "1c17ba74-a617-45e7-9e21-74068b63befe",
      nodeId: root.id
    });
    let historyEntryId: string | null = null;
    const withoutImage: NotesWorkspace = {
      nodes: [root],
      attachmentsByNodeId: { [root.id]: [] }
    };
    const withImage: NotesWorkspace = {
      nodes: [root],
      attachmentsByNodeId: { [root.id]: [original] }
    };
    const removeAttachment = vi.fn().mockImplementation(
      async (_vaultRoot, _attachmentId, context) => {
        historyEntryId = context?.entryId ?? null;
        return {
          workspace: withoutImage,
          historyEntryId,
          ...historyState(),
          canUndo: true,
          canRedo: false
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(withImage),
      removeAttachment,
      undo: vi.fn().mockImplementation(async () => ({
        workspace: withImage,
        replayedEntryId: historyEntryId,
        ...historyState(),
        kind: "applied" as const,
        canUndo: false,
        canRedo: true
      })),
      redo: vi.fn().mockImplementation(async () => ({
        workspace: withoutImage,
        replayedEntryId: historyEntryId,
        ...historyState(),
        kind: "applied" as const,
        canUndo: true,
        canRedo: false
      }))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.actions.removeImage).toBeTypeOf("function");
    await act(async () => result.current.actions.removeImage!(original.id));
    expect(removeAttachment).toHaveBeenCalledWith(
      "/vault",
      original.id,
      historyContext("attachment-remove")
    );
    expect(result.current.state.attachmentsByNodeId[root.id]).toEqual([]);

    await act(async () => result.current.actions.undo?.());
    expect(result.current.state.attachmentsByNodeId[root.id]).toEqual([
      original
    ]);

    await act(async () => result.current.actions.redo?.());
    expect(result.current.state.attachmentsByNodeId[root.id]).toEqual([]);
  });

  it("opens an attachment original through the repository action", async () => {
    const testedAttachmentId = "1c17ba74-a617-45e7-9e21-74068b63befe";
    const openAttachmentOriginal = vi.fn().mockResolvedValue(undefined);
    const store = repository({ openAttachmentOriginal });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.actions.viewImageOriginal).toBeTypeOf("function");
    await act(async () =>
      result.current.actions.viewImageOriginal!(testedAttachmentId)
    );

    expect(openAttachmentOriginal).toHaveBeenCalledOnce();
    expect(openAttachmentOriginal).toHaveBeenCalledWith(
      "/vault",
      testedAttachmentId
    );
  });

  it("ignores a stale view-original handler after a vault switch", async () => {
    const testedAttachmentId = "1c17ba74-a617-45e7-9e21-74068b63befe";
    const openAttachmentOriginal = vi.fn().mockResolvedValue(undefined);
    const store = repository({ openAttachmentOriginal });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const staleViewOriginal = result.current.actions.viewImageOriginal!;

    rerender({ vaultRoot: "/new" });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => staleViewOriginal(testedAttachmentId));
    expect(openAttachmentOriginal).not.toHaveBeenCalled();

    await act(async () =>
      result.current.actions.viewImageOriginal!(testedAttachmentId)
    );
    expect(openAttachmentOriginal).toHaveBeenCalledOnce();
    expect(openAttachmentOriginal).toHaveBeenCalledWith(
      "/new",
      testedAttachmentId
    );
  });

  it("reports when opening image originals is unavailable", async () => {
    const store = repository();
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await expect(
      result.current.actions.viewImageOriginal!("attachment-id")
    ).rejects.toThrow("Opening image originals is unavailable.");
  });

  it("requires exact session identity for attachment handlers across A-B-A", async () => {
    const testedAttachmentId = "1c17ba74-a617-45e7-9e21-74068b63befe";
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const readAttachmentBytes = vi.fn().mockResolvedValue(bytes);
    const openAttachmentOriginal = vi.fn().mockResolvedValue(undefined);
    const downloadAttachment = vi.fn().mockResolvedValue(undefined);
    const store = repository({
      readAttachmentBytes,
      openAttachmentOriginal,
      downloadAttachment
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/vault-a" } }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const a1Load = result.current.actions.loadAttachmentBytes!;
    const a1View = result.current.actions.viewImageOriginal!;
    const a1Download = result.current.actions.downloadImage!;

    rerender({ vaultRoot: "/vault-b" });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ vaultRoot: "/vault-a" });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let staleLoadError: unknown;
    await act(async () => {
      await a1View(testedAttachmentId);
      await a1Download(testedAttachmentId, "collision.png", "image/png");
      try {
        await a1Load(testedAttachmentId);
      } catch (cause) {
        staleLoadError = cause;
      }
    });

    expect(readAttachmentBytes).not.toHaveBeenCalled();
    expect(openAttachmentOriginal).not.toHaveBeenCalled();
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(staleLoadError).toBeInstanceOf(Error);
    expect((staleLoadError as Error).message).toBe(
      "Image loading is unavailable."
    );

    let loaded: Uint8Array | undefined;
    await act(async () => {
      loaded = await result.current.actions.loadAttachmentBytes!(
        testedAttachmentId
      );
      await result.current.actions.viewImageOriginal!(testedAttachmentId);
      await result.current.actions.downloadImage!(
        testedAttachmentId,
        "collision.png",
        "image/png"
      );
    });

    expect(loaded).toBe(bytes);
    expect(readAttachmentBytes).toHaveBeenCalledWith(
      "/vault-a",
      testedAttachmentId
    );
    expect(openAttachmentOriginal).toHaveBeenCalledWith(
      "/vault-a",
      testedAttachmentId
    );
    expect(downloadAttachment).toHaveBeenCalledWith(
      "/vault-a",
      testedAttachmentId
    );
  });

  it("delegates the trusted save dialog and attachment download to native code", async () => {
    const testedAttachmentId = "1c17ba74-a617-45e7-9e21-74068b63befe";
    const saveImageFile = vi.fn().mockResolvedValue("/must-not-be-used.png");
    const downloadAttachment = vi.fn().mockResolvedValue(undefined);
    const store = repository({ downloadAttachment });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: {
          openImageFiles: vi.fn().mockResolvedValue(null),
          saveImageFile,
          subscribeToImageDrop: vi.fn().mockResolvedValue(vi.fn())
        }
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.actions.downloadImage).toBeTypeOf("function");
    const download = result.current.actions.downloadImage!(
      testedAttachmentId,
      "diagram.png",
      "image/png"
    );

    await act(async () => download);

    expect(downloadAttachment).toHaveBeenCalledOnce();
    expect(downloadAttachment).toHaveBeenCalledWith("/vault", testedAttachmentId);
    expect(saveImageFile).not.toHaveBeenCalled();
  });

  it("captures the active vault when a native download starts", async () => {
    const testedAttachmentId = "1c17ba74-a617-45e7-9e21-74068b63befe";
    const pendingDownload = deferred<void>();
    const downloadAttachment = vi.fn().mockReturnValue(pendingDownload.promise);
    const store = repository({ downloadAttachment });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) =>
        useNotesWorkspace({
          vaultRoot,
          repository: store,
          attachmentUi: {
            openImageFiles: vi.fn().mockResolvedValue(null),
            saveImageFile: vi.fn().mockResolvedValue(null),
            subscribeToImageDrop: vi.fn().mockResolvedValue(vi.fn())
          }
        }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const download = result.current.actions.downloadImage!(
      testedAttachmentId,
      "diagram.png",
      "image/png"
    );
    rerender({ vaultRoot: "/new" });
    await waitFor(() =>
      expect(store.loadWorkspace).toHaveBeenCalledWith("/new", {
        kind: "active"
      })
    );

    expect(downloadAttachment).toHaveBeenCalledOnce();
    expect(downloadAttachment).toHaveBeenCalledWith("/old", testedAttachmentId);
    pendingDownload.resolve();
    await act(async () => download);
  });

  it("synchronizes the complete attachment map to a sibling workspace hook", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const imageNodeId = "1c17ba74-a617-45e7-9e21-74068b63bef0";
    const attachmentId = "1c17ba74-a617-45e7-9e21-74068b63befe";
    const imported = attachment({
      id: attachmentId,
      nodeId: imageNodeId
    });
    createNoteIdMock
      .mockReturnValueOnce(imageNodeId)
      .mockReturnValueOnce(attachmentId);
    const initial: NotesWorkspace = {
      nodes: [root],
      attachmentsByNodeId: {}
    };
    const updated: NotesWorkspace = {
      nodes: [root, node({ id: imageNodeId, nodeKind: "image" })],
      attachmentsByNodeId: { [imageNodeId]: [imported] }
    };
    const attachmentUi = {
      openImageFiles: vi.fn().mockResolvedValue(["/incoming/diagram.png"]),
      saveImageFile: vi.fn().mockResolvedValue(null),
      subscribeToImageDrop: vi.fn().mockResolvedValue(vi.fn())
    };
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      importImageNodePaths: vi.fn().mockImplementation(
        async (_vaultRoot, _input, context) => ({
          workspace: updated,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [imageNodeId]
        })
      )
    });
    const first = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/shared-vault",
        repository: store,
        attachmentUi
      })
    );
    const sibling = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/shared-vault",
        repository: store,
        attachmentUi
      })
    );
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));

    act(() => sibling.result.current.actions.setImageImportMaxDisplayWidth(480));
    await act(async () => sibling.result.current.actions.uploadImage!(root.id));

    await waitFor(() =>
      expect(
        first.result.current.state.attachmentsByNodeId[imageNodeId]
      ).toEqual([imported])
    );
    expect(sibling.result.current.state.attachmentsByNodeId[imageNodeId]).toEqual([
      imported
    ]);
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
  });

  it("discards a picker result that resolves after switching vaults", async () => {
    const oldSelection = deferred<string | null>();
    const openImageFiles = vi
      .fn()
      .mockReturnValueOnce(
        oldSelection.promise.then((path) => (path === null ? null : [path]))
      )
      .mockResolvedValueOnce(["/new/fresh.png"]);
    createNoteIdMock.mockReturnValue("1c17ba74-a617-45e7-9e21-74068b63befe");
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
      importImageNodePaths: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "root" })]))
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) =>
        useNotesWorkspace({
          vaultRoot,
          repository: store,
          attachmentUi: mockAttachmentUi(openImageFiles)
        }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    const staleUpload = result.current.actions.uploadImage!("root");
    rerender({ vaultRoot: "/new" });
    await waitFor(() =>
      expect(store.loadWorkspace).toHaveBeenCalledWith("/new", { kind: "active" })
    );
    await act(async () => {
      oldSelection.resolve("/old/stale.png");
      await staleUpload;
    });
    expect(store.importImageNodePaths).not.toHaveBeenCalled();
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();

    await act(async () => result.current.actions.retryImageUpload!("root"));

    expect(openImageFiles).toHaveBeenCalledTimes(2);
    expect(store.importImageNodePaths).toHaveBeenCalledWith(
      "/new",
      expect.objectContaining({
        items: [
          expect.objectContaining({ sourcePath: "/new/fresh.png" })
        ]
      }),
      expect.anything()
    );
  });

  it("exposes loading on the first render before the workspace effect runs", async () => {
    const initialization = deferred<ReturnType<typeof historyState>>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise)
    });
    const renderedStatuses: string[] = [];
    const { result } = renderHook(() => {
      const workspace = useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store
      });
      renderedStatuses.push(workspace.status);
      return workspace;
    });

    expect(renderedStatuses[0]).toBe("loading");

    await act(async () => initialization.resolve(historyState()));
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it.each(["layout", "passive"] as const)(
    "flushes a child %s-effect command through the session after loading",
    async (effect) => {
      const initialization = deferred<ReturnType<typeof historyState>>();
      createNoteIdMock.mockReturnValue("pre-session-root");
      const store = repository({
        initialize: vi.fn().mockReturnValue(initialization.promise),
        loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
        createNode: vi
          .fn()
          .mockResolvedValue(workspace([node({ id: "pre-session-root" })]))
      });
      const completions: Promise<unknown>[] = [];
      let latestWorkspace: UseNotesWorkspaceResult | undefined;
      render(
        <StartupHarness
          effect={effect}
          repository={store}
          vaultRoot="/vault"
          onCompletion={(completion) => completions.push(completion)}
          onWorkspace={(current) => {
            latestWorkspace = current;
          }}
        />
      );

      expect(store.createNode).not.toHaveBeenCalled();

      await act(async () => initialization.resolve(historyState()));
      await waitFor(() => expect(store.createNode).toHaveBeenCalledOnce());
      await act(async () => Promise.all(completions));

      expect(store.createNode).toHaveBeenCalledWith(
        "/vault",
        {
          id: "pre-session-root",
          parentId: null,
          afterId: null,
          title: "",
          note: ""
        },
        historyContext("create")
      );
      expect(
        latestWorkspace?.state.nodesById["pre-session-root"]
      ).toBeDefined();
      expect(latestWorkspace?.status).toBe("ready");
    }
  );

  it("does not duplicate a buffered child command during StrictMode replay", async () => {
    const initialization = deferred<ReturnType<typeof historyState>>();
    createNoteIdMock.mockReturnValue("strict-root");
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise),
      loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "strict-root" })]))
    });
    const completions: Promise<unknown>[] = [];

    render(
      <StrictMode>
        <StartupHarness
          effect="layout"
          repository={store}
          vaultRoot="/vault"
          onCompletion={(completion) => completions.push(completion)}
          onWorkspace={() => undefined}
        />
      </StrictMode>
    );

    expect(store.initialize).toHaveBeenCalledOnce();
    await act(async () => initialization.resolve(historyState()));
    await waitFor(() => expect(store.createNode).toHaveBeenCalledOnce());
    await act(async () => Promise.all(completions));

    expect(completions).toHaveLength(2);
    expect(store.createNode).toHaveBeenCalledOnce();
  });

  it("routes a child layout-effect command after a vault change only to the new vault", async () => {
    const oldInitialization = deferred<ReturnType<typeof historyState>>();
    createNoteIdMock.mockReturnValue("new-vault-root");
    const store = repository({
      initialize: vi.fn((vaultRoot) =>
        vaultRoot === "/old" ? oldInitialization.promise : Promise.resolve(historyState())
      ),
      loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "new-vault-root" })]))
    });
    const completions: Promise<unknown>[] = [];
    const view = render(
      <StartupHarness
        effect="layout"
        repository={store}
        vaultRoot="/old"
        onCompletion={(completion) => completions.push(completion)}
        onWorkspace={() => undefined}
      />
    );

    view.rerender(
      <StartupHarness
        effect="layout"
        repository={store}
        vaultRoot="/new"
        onCompletion={(completion) => completions.push(completion)}
        onWorkspace={() => undefined}
      />
    );

    await waitFor(() => expect(store.createNode).toHaveBeenCalledOnce());
    expect(store.createNode).toHaveBeenCalledWith(
      "/new",
      expect.objectContaining({ id: "new-vault-root" }),
      historyContext("create")
    );

    await act(async () => oldInitialization.resolve(historyState()));
    await act(async () => Promise.all(completions));
    expect(store.createNode).toHaveBeenCalledOnce();
  });

  it("initializes and loads once for each vault and repository identity", async () => {
    const store = repository();
    const { rerender } = renderHook(
      ({ vaultRoot, repository: current }) => useNotesWorkspace({ vaultRoot, repository: current }),
      { initialProps: { vaultRoot: "/vault-a", repository: store } }
    );

    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledOnce());
    expect(store.initialize).toHaveBeenCalledWith("/vault-a",
      expect.objectContaining({ sessionId: expect.any(String) }));
    expect(store.loadWorkspace).toHaveBeenCalledWith("/vault-a", { kind: "active" });

    rerender({ vaultRoot: "/vault-a", repository: store });
    expect(store.loadWorkspace).toHaveBeenCalledOnce();

    rerender({ vaultRoot: "/vault-b", repository: store });
    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledTimes(2));
    expect(store.initialize).toHaveBeenLastCalledWith("/vault-b",
      expect.objectContaining({ sessionId: expect.any(String) }));
  });

  it("deduplicates initialization and loading during StrictMode effect replay", async () => {
    const initialization = deferred<ReturnType<typeof historyState>>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise)
    });

    const { result } = renderHook(
      () => useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
      { wrapper: strictMode }
    );

    expect(store.initialize).toHaveBeenCalledOnce();
    await act(async () => initialization.resolve(historyState()));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(store.loadWorkspace).toHaveBeenCalledOnce();
  });

  it("handles a synchronous initialization throw without loading or an unhandled rejection", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const store = repository({
      initialize: vi.fn(() => {
        throw new Error("initialize exploded");
      })
    });

    try {
      const { result } = renderHook(
        () => useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
        { wrapper: strictMode }
      );

      await waitFor(() => expect(result.current.error).toBe("initialize exploded"));
      await act(async () => Promise.resolve());

      expect(store.initialize).toHaveBeenCalledOnce();
      expect(store.loadWorkspace).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });

  it("runs a command only after initialization and loading, then retains the loaded tree on failure", async () => {
    const initialization = deferred<ReturnType<typeof historyState>>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise),
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "loaded" })])),
      updateNode: vi.fn().mockRejectedValue(new Error("write failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );

    expect(store.initialize).toHaveBeenCalledOnce();
    expect(store.loadWorkspace).not.toHaveBeenCalled();

    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.actions.updateNode("loaded", {
        title: "new",
        note: ""
      });
    });

    expect(result.current).toMatchObject({ status: "loading", error: null });
    expect(store.updateNode).not.toHaveBeenCalled();
    expect(store.loadWorkspace).not.toHaveBeenCalled();

    await act(async () => initialization.resolve(historyState()));
    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledOnce());
    await act(async () => {
      await completion;
    });

    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());
    expect(result.current.state.nodesById.loaded).toBeDefined();
    expect(result.current).toMatchObject({
      status: "error",
      error: "write failed"
    });
  });

  it("invokes initialization, loading, and commands in FIFO order", async () => {
    const initialization = deferred<ReturnType<typeof historyState>>();
    const initialLoad = deferred<NotesWorkspace>();
    const firstCommand = deferred<NotesWorkspace>();
    const secondCommand = deferred<NotesWorkspace>();
    const invocations: string[] = [];
    const store = repository({
      initialize: vi.fn(() => {
        invocations.push("initialize");
        return initialization.promise;
      }),
      loadWorkspace: vi.fn(() => {
        invocations.push("load");
        return initialLoad.promise;
      }),
      updateNode: vi
        .fn((_vaultRoot, input) => {
          invocations.push(`update:${input.title}`);
          return input.title === "first"
            ? firstCommand.promise
            : secondCommand.promise;
        })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );

    let firstCompletion!: Promise<unknown>;
    let secondCompletion!: Promise<unknown>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("initial", {
        title: "first",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("initial", {
        title: "second",
        note: ""
      });
    });

    expect(invocations).toEqual(["initialize"]);

    await act(async () => initialization.resolve(historyState()));
    expect(invocations).toEqual(["initialize", "load"]);

    await act(async () =>
      initialLoad.resolve(workspace([node({ id: "initial" })]))
    );
    expect(invocations).toEqual(["initialize", "load", "update:first"]);
    expect(result.current.state.nodesById.initial).toBeDefined();
    expect(result.current.status).toBe("loading");

    await act(async () =>
      firstCommand.resolve(workspace([
        node({ id: "initial" }),
        node({ id: "first" })
      ]))
    );
    expect(invocations).toEqual([
      "initialize",
      "load",
      "update:first",
      "update:second"
    ]);
    expect(result.current.state.nodesById.first).toBeDefined();
    expect(result.current.state.nodesById.initial).toBeDefined();
    expect(result.current.status).toBe("loading");

    await act(async () => {
      secondCommand.resolve(workspace([node({ id: "second" })]));
      await Promise.all([firstCompletion, secondCompletion]);
    });
    expect(result.current.state.nodesById.second).toBeDefined();
    expect(result.current.state.nodesById.first).toBeUndefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("keeps the first confirmed command workspace when the next command fails", async () => {
    const firstCommand = deferred<NotesWorkspace>();
    const secondCommand = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "initial" })])),
      updateNode: vi
        .fn()
        .mockReturnValueOnce(firstCommand.promise)
        .mockReturnValueOnce(secondCommand.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<unknown>;
    let secondCompletion!: Promise<unknown>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("initial", {
        title: "first",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("initial", {
        title: "second",
        note: ""
      });
    });

    await act(async () =>
      firstCommand.resolve(workspace([
        node({ id: "initial" }),
        node({ id: "first-confirmed" })
      ]))
    );
    await act(async () => {
      secondCommand.reject(new Error("second failed"));
      await Promise.all([firstCompletion, secondCompletion]);
    });

    expect(result.current.state.nodesById["first-confirmed"]).toBeDefined();
    expect(result.current.state.nodesById.initial).toBeDefined();
    expect(result.current).toMatchObject({
      status: "error",
      error: "second failed"
    });
  });

  it("blocks a compound split when its draft save fails", async () => {
    const store = repository({
      updateNode: vi.fn().mockRejectedValue(new Error("save failed")),
      splitNode: vi.fn().mockResolvedValue(workspace([]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.actions.splitNode(
        "root",
        "split-child",
        "prefix",
        "suffix",
        { draft: { title: "prefixsuffix", note: "saved note" , imageOffsetUtf16: 0} }
      );
    });
    await act(async () => {
      await expect(completion).resolves.toBe("failed");
    });

    expect(store.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "root",
        title: "prefixsuffix",
        note: "saved note",
        imageOffsetUtf16: 0
      },
      historyContext("text")
    );
    expect(store.splitNode).not.toHaveBeenCalled();
    expect(result.current.state.nodesById.root.title).toBe("root");
    expect(result.current).toMatchObject({
      status: "error",
      error: "save failed"
    });
  });

  it("retains an authoritative draft when the later compound split fails", async () => {
    const saved = workspace([
      node({ id: "root", title: "prefixsuffix", note: "saved note" })
    ]);
    const updateNode = vi.fn((_vaultRoot, _input, context) =>
      Promise.resolve({
        workspace: saved,
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      })
    );
    const historyStatus = vi
      .fn()
      .mockResolvedValue({ canUndo: false, canRedo: false });
    const store = repository({
      updateNode,
      splitNode: vi.fn().mockRejectedValue(new Error("split failed")),
      historyStatus
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.splitNode(
        "root",
        "split-child",
        "prefix",
        "suffix",
        { draft: { title: "prefixsuffix", note: "saved note" , imageOffsetUtf16: 0} }
      )
    );

    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(historyStatus).not.toHaveBeenCalled();
    expect(store.splitNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "root",
        newNodeId: "split-child",
        prefix: "prefix",
        suffix: "suffix"
      },
      historyContext("split")
    );
    expect(result.current.state.nodesById.root).toMatchObject({
      title: "prefixsuffix",
      note: "saved note"
    });
    expect(result.current.state.pendingFocusId).toBeNull();
    expect(result.current).toMatchObject({
      status: "error",
      error: "split failed",
      canUndo: true,
      canRedo: false
    });
  });

  it("consumes successful atomic mutation status without a redundant status query", async () => {
    const initial = workspace([node({ id: "root" })]);
    const updated = workspace([node({ id: "root", title: "Updated" })]);
    const historyStatus = vi
      .fn()
      .mockResolvedValue({ canUndo: false, canRedo: false });
    const updateNode = vi.fn((_vaultRoot, _input, context) =>
      Promise.resolve({
        workspace: updated,
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      historyStatus
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/atomic-result", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(historyStatus).not.toHaveBeenCalled();

    await act(async () =>
      result.current.actions.updateNode("root", { title: "Updated", note: "" })
    );

    expect(historyStatus).not.toHaveBeenCalled();
    expect(result.current.state.nodesById.root.title).toBe("Updated");
    expect(result.current).toMatchObject({ canUndo: true, canRedo: false });
  });

  it.each(["split", "move", "remove"] as const)(
    "discards a %s inline snapshot when its atomic history entry is null",
    async (operation) => {
      const initial = workspace([
        node({ id: "source", title: operation === "remove" ? "" : "before" }),
        node({ id: "target", sortKey: 2048 }),
        node({ id: "other", sortKey: 3072 })
      ]);
      const inlineWorkspace = workspace([
        node({ id: "source", title: operation === "remove" ? "" : "edited" }),
        node({ id: "target", sortKey: 2048 }),
        node({ id: "other", sortKey: 3072 })
      ]);
      const finalWorkspace = workspace([
        ...(operation === "remove"
          ? []
          : [
              node({
                id: "source",
                title: "edited",
                parentId: operation === "move" ? "target" : null
              })
            ]),
        node({ id: "target", sortKey: 2048 }),
        node({ id: "other", sortKey: 3072 }),
        ...(operation === "split"
          ? [node({ id: "split", sortKey: 4096 })]
          : [])
      ]);
      const updateNode = vi.fn().mockResolvedValue({
        workspace: inlineWorkspace,
        historyEntryId: null,
        ...historyState(),
        canUndo: false,
        canRedo: false
      });
      const structuralMutation = vi.fn((_vaultRoot, _input, context) =>
        Promise.resolve({
          workspace: finalWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false
        })
      );
      const undo = vi.fn(async () => ({
        workspace: finalWorkspace,
        replayedEntryId: updateNode.mock.calls[0]?.[2]?.entryId ?? null,
        ...historyState(),
        kind: "applied" as const,
        canUndo: false,
        canRedo: true
      }));
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(initial),
        updateNode,
        ...(operation === "split" ? { splitNode: structuralMutation } : {}),
        ...(operation === "move" ? { moveNode: structuralMutation } : {}),
        ...(operation === "remove"
          ? { removeEmptyNode: structuralMutation }
          : {}),
        undo
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({
          vaultRoot: `/null-inline-${operation}`,
          repository: store
        })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () => result.current.actions.focusNode("source"));

      await act(async () => {
        if (operation === "split") {
          await result.current.actions.splitNode(
            "source",
            "split",
            "edited",
            "",
            { draft: { title: "edited", note: "" , imageOffsetUtf16: 0} }
          );
        } else if (operation === "move") {
          await result.current.actions.moveNode(
            { id: "source", parentId: "target", afterId: null },
            "source",
            { draft: { title: "edited", note: "" , imageOffsetUtf16: 0} }
          );
        } else {
          await result.current.actions.removeEmptyNode("source", "target", {
            draft: { title: "", note: "" , imageOffsetUtf16: 0}
          });
        }
      });

      const inlineEntryId = updateNode.mock.calls[0]?.[2]?.entryId;
      expect(inlineEntryId).toEqual(expect.any(String));
      expect(structuralMutation.mock.calls[0]?.[2]?.entryId).not.toBe(
        inlineEntryId
      );

      await act(async () => result.current.actions.focusNode("other"));
      await act(async () => result.current.actions.undo!());
      expect(result.current.state).toMatchObject({
        selectedId: "other",
        pendingFocusId: "other"
      });
    }
  );

  it("keeps the committed text snapshot when a later split step fails", async () => {
    const active = workspace([node({ id: "other" })]);
    const archived = workspace([
      node({
        id: "root",
        title: "prefixsuffix",
        archivedAt: "2026-07-11T00:00:00Z"
      })
    ]);
    const saved = workspace([
      node({
        id: "root",
        title: "prefixsuffix",
        note: "saved note",
        archivedAt: "2026-07-11T00:00:00Z"
      })
    ]);
    const updateNode = vi.fn(async (_vaultRoot, _input, context) =>
      mutationResult(saved, context)
    );
    const loadWorkspace = vi.fn((_vaultRoot, scope) =>
      Promise.resolve(scope?.kind === "archive" ? archived : active)
    );
    const undo = vi.fn().mockImplementation(async () =>
      appliedReplay(
        archived,
        updateNode.mock.calls[0]?.[2]?.entryId ?? null,
        "undo"
      )
    );
    const store = repository({
      loadWorkspace,
      updateNode,
      splitNode: vi.fn().mockRejectedValue(new Error("split failed")),
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/partial-split", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () =>
      result.current.actions.selectLibraryView("archive")
    );
    await act(async () => {
      await result.current.actions.zoomTo("root");
      await result.current.actions.focusNode("root");
    });

    await act(async () =>
      result.current.actions.splitNode(
        "root",
        "split-child",
        "prefix",
        "suffix",
        { draft: { title: "prefixsuffix", note: "saved note" , imageOffsetUtf16: 0} }
      )
    );
    await act(async () => result.current.actions.selectLibraryView("all"));
    await act(async () => {
      await result.current.actions.focusNode("other");
      await result.current.actions.zoomTo("other");
    });
    await act(async () => result.current.actions.undo!());
    await act(async () => result.current.actions.undo!());
    await act(async () => result.current.actions.undo!());

    expect(result.current.libraryView).toBe("archive");
    expect(result.current.state.nodesById.root).toBeDefined();
    expect(result.current.state).toMatchObject({
      selectedId: "root",
      zoomRootId: "root",
      pendingFocusId: "root",
      pendingFocusField: "title"
    });
  });

  it("expands a move target before moving and publishing focus", async () => {
    const expanded = deferred<NotesWorkspace>();
    const moved = deferred<NotesWorkspace>();
    const initial = workspace([
      node({ id: "first", sortKey: 1, isCollapsed: true }),
      node({ id: "hidden", parentId: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleCollapsed: vi.fn().mockReturnValue(expanded.promise),
      moveNode: vi.fn().mockReturnValue(moved.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.actions.moveNode(
        { id: "second", parentId: "first", afterId: "hidden" },
        "second",
        { expandNodeId: "first" }
      );
    });
    await waitFor(() => expect(store.toggleCollapsed).toHaveBeenCalledOnce());
    expect(store.moveNode).not.toHaveBeenCalled();
    expect(result.current.state.pendingFocusId).toBeNull();

    await act(async () =>
      expanded.resolve(
        workspace([
          node({ id: "first", sortKey: 1, isCollapsed: false }),
          node({ id: "hidden", parentId: "first", sortKey: 1 }),
          node({ id: "second", sortKey: 2 })
        ])
      )
    );
    await waitFor(() => expect(store.moveNode).toHaveBeenCalledOnce());
    expect(result.current.state.pendingFocusId).toBeNull();

    await act(async () => {
      moved.resolve(
        workspace([
          node({ id: "first", sortKey: 1, isCollapsed: false }),
          node({ id: "hidden", parentId: "first", sortKey: 1 }),
          node({ id: "second", parentId: "first", sortKey: 2 })
        ])
      );
      await completion;
    });
    expect(result.current.state).toMatchObject({
      selectedId: "second",
      editingNoteId: "second",
      pendingFocusId: "second"
    });
  });

  it("skips a queued move when its before sibling is missing", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "child", parentId: "root" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      moveNode: vi.fn().mockResolvedValue(initial)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.moveNode({
        id: "child",
        parentId: null,
        afterId: null,
        beforeId: "missing"
      })
    );

    expect(store.moveNode).not.toHaveBeenCalled();
  });

  it("does not launch loading or queued commands after unmount during initialization", async () => {
    const initialization = deferred<ReturnType<typeof historyState>>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise)
    });
    const { result, unmount } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );

    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.actions.updateNode("root", {
        title: "late",
        note: ""
      });
    });
    unmount();
    await act(async () => {
      initialization.resolve(historyState());
      await completion;
    });

    expect(store.loadWorkspace).not.toHaveBeenCalled();
    expect(store.updateNode).not.toHaveBeenCalled();
  });

  it("replaces state with each authoritative command response and derives creation placement", async () => {
    createNoteIdMock
      .mockReturnValueOnce("new-root")
      .mockReturnValueOnce("new-child")
      .mockReturnValueOnce("first-child");
    const base = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([
        node({ id: "first", sortKey: 1 }),
        node({ id: "last", sortKey: 2 }),
        node({ id: "parent", sortKey: 3 }),
        node({ id: "existing-child", parentId: "parent" })
      ])),
      createNode: vi
        .fn()
        .mockResolvedValueOnce(workspace([
          node({ id: "first", sortKey: 1 }),
          node({ id: "last", sortKey: 2 }),
          node({ id: "parent", sortKey: 3 }),
          node({ id: "existing-child", parentId: "parent" }),
          node({ id: "new-root", sortKey: 4 })
        ]))
        .mockResolvedValueOnce(workspace([
          node({ id: "parent" }),
          node({ id: "new-child", parentId: "parent" })
        ]))
        .mockResolvedValueOnce(workspace([
          node({ id: "parent" }),
          node({ id: "first-child", parentId: "parent", sortKey: 512 }),
          node({ id: "new-child", parentId: "parent", sortKey: 1024 })
        ]))
    });
    const { repository: store, events } = journalNotesRepository(base);
    const { result } = renderHook(() => useNotesWorkspace({ vaultRoot: "/vault", repository: store }));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    events.clear();
    await act(async () => result.current.actions.createRoot());
    expect(events.for("createNode")[0]).toMatchObject({
      vaultRoot: "/vault",
      commandKind: "create",
      input: {
        id: "new-root",
        parentId: null,
        afterId: "parent",
        title: "",
        note: ""
      }
    });
    expect(result.current.state.nodesById["new-root"]).toBeDefined();
    expect(result.current.state).toMatchObject({
      selectedId: "new-root",
      editingNoteId: "new-root",
      pendingFocusId: "new-root"
    });

    await act(async () => result.current.actions.createChild("parent"));
    expect(events.for("createNode")[1]).toMatchObject({
      vaultRoot: "/vault",
      commandKind: "create",
      input: {
        id: "new-child",
        parentId: "parent",
        afterId: "existing-child",
        title: "",
        note: ""
      }
    });
    expect(result.current.state.childIdsByParent.parent).toEqual(["new-child"]);
    expect(result.current.state).toMatchObject({
      selectedId: "new-child",
      editingNoteId: "new-child",
      pendingFocusId: "new-child"
    });

    await act(async () => result.current.actions.createChild("parent", "first"));
    expect(events.for("createNode")[2]).toMatchObject({
      vaultRoot: "/vault",
      commandKind: "create",
      input: {
        id: "first-child",
        parentId: "parent",
        afterId: null,
        beforeId: "new-child",
        title: "",
        note: ""
      }
    });
    expect(result.current.state.childIdsByParent.parent).toEqual([
      "first-child",
      "new-child"
    ]);
    expect(result.current.state).toMatchObject({
      selectedId: "first-child",
      editingNoteId: "first-child",
      pendingFocusId: "first-child"
    });
  });

  it("creates before the real first child and leaves a filtered scope visible", async () => {
    createNoteIdMock.mockReturnValue("created-child");
    const parent = node({ id: "parent", isStarred: true });
    const hiddenFirst = node({
      id: "hidden-first",
      parentId: parent.id,
      sortKey: 1024
    });
    const visibleSecond = node({
      id: "visible-second",
      parentId: parent.id,
      sortKey: 2048,
      isStarred: true
    });
    const active = workspace([parent, hiddenFirst, visibleSecond]);
    const starred = workspace([parent, visibleSecond]);
    const created = workspace([
      parent,
      node({ id: "created-child", parentId: parent.id, sortKey: 512 }),
      hiddenFirst,
      visibleSecond
    ]);
    const createNode = vi.fn(async (_vaultRoot, _input, context) =>
      mutationResult(created, context)
    );
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "active" ? active : starred
      ),
      createNode
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/filtered-create-child", repository: store })
    );

    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    await act(async () =>
      rendered.result.current.actions.selectLibraryView("starred")
    );
    await act(async () => rendered.result.current.actions.zoomTo(parent.id));
    await act(async () =>
      rendered.result.current.actions.createChild(parent.id, "first")
    );

    expect(createNode).toHaveBeenCalledWith(
      "/filtered-create-child",
      {
        id: "created-child",
        parentId: parent.id,
        afterId: null,
        beforeId: hiddenFirst.id,
        title: "",
        note: ""
      },
      historyContext("create")
    );
    expect(rendered.result.current).toMatchObject({
      libraryView: "all",
      activeTagFilters: []
    });
    expect(rendered.result.current.state).toMatchObject({
      selectedId: "created-child",
      editingNoteId: "created-child",
      pendingFocusId: "created-child",
      zoomRootId: parent.id
    });
    expect(rendered.result.current.state.childIdsByParent[parent.id]).toEqual([
      "created-child",
      hiddenFirst.id,
      visibleSecond.id
    ]);
  });

  it("creates a text sibling after an image node and leaves the split command unused", async () => {
    createNoteIdMock.mockReturnValueOnce("new-text-sibling");
    const imageNode = node({
      id: "image-node",
      nodeKind: "image",
      title: "diagram.png"
    });
    const createdTextNode = node({
      id: "new-text-sibling",
      sortKey: 2048,
      title: ""
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([imageNode])),
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([imageNode, createdTextNode]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    await act(async () => result.current.actions.zoomTo("image-node"));
    expect(result.current.state.zoomRootId).toBe("image-node");

    await act(async () =>
      result.current.actions.createNextTextSibling("image-node")
    );

    expect(store.createNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "new-text-sibling",
        parentId: null,
        afterId: "image-node",
        title: "",
        note: ""
      },
      historyContext("create")
    );
    expect(store.splitNode).not.toHaveBeenCalled();
    expect(result.current.state.nodesById["new-text-sibling"]?.nodeKind).toBe(
      "text"
    );
    expect(result.current.state).toMatchObject({
      selectedId: "new-text-sibling",
      editingNoteId: "new-text-sibling",
      pendingFocusId: "new-text-sibling",
      pendingFocusField: "title",
      zoomRootId: null
    });
  });

  it("acknowledges matching pending focus through a command-neutral public promise", async () => {
    createNoteIdMock.mockReturnValue("created");
    const store = repository({
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "created", title: "" })]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.createRoot());
    expect(result.current.state.pendingFocusId).toBe("created");

    expect(result.current.actions.acknowledgeFocus).toEqual(
      expect.any(Function)
    );
    let acknowledgement!: Promise<unknown>;
    act(() => {
      acknowledgement = result.current.actions.acknowledgeFocus("created");
    });
    expect(acknowledgement).toBeInstanceOf(Promise);
    await act(async () => acknowledgement);

    expect(result.current.state.pendingFocusId).toBeNull();
    expect(store.createNode).toHaveBeenCalledOnce();
    expect(store.updateNode).not.toHaveBeenCalled();
  });

  it("focuses an existing node without enqueueing a repository command", async () => {
    const store = repository();
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.focusNode("root"));

    expect(result.current.state).toMatchObject({
      selectedId: "root",
      editingNoteId: "root",
      pendingFocusId: "root"
    });
    expect(store.loadWorkspace).toHaveBeenCalledOnce();
    expect(store.updateNode).not.toHaveBeenCalled();
    expect(store.moveNode).not.toHaveBeenCalled();
  });

  it("publishes a move focus target only after authoritative success", async () => {
    const moved = deferred<NotesWorkspace>();
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "child", parentId: "root" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      moveNode: vi.fn().mockReturnValue(moved.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.actions.moveNode(
        { id: "child", parentId: null, afterId: "root" },
        "child"
      );
    });
    await waitFor(() => expect(store.moveNode).toHaveBeenCalledOnce());
    expect(result.current.state.pendingFocusId).toBeNull();

    await act(async () => {
      moved.resolve(initial);
      await completion;
    });
    expect(result.current.state).toMatchObject({
      selectedId: "child",
      editingNoteId: "child",
      pendingFocusId: "child"
    });
  });

  it("does not publish a move focus target when the command fails", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "child", parentId: "root" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      moveNode: vi.fn().mockRejectedValue(new Error("move failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.moveNode(
        { id: "child", parentId: null, afterId: "root" },
        "child"
      )
    );

    expect(result.current.state.pendingFocusId).toBeNull();
    expect(result.current).toMatchObject({
      status: "error",
      error: "move failed"
    });
  });

  it("keeps a committed collapse snapshot when the later move step fails", async () => {
    const initial = workspace([
      node({ id: "target", isCollapsed: true }),
      node({ id: "moving", sortKey: 2048 }),
      node({ id: "other", sortKey: 3072 })
    ]);
    const expanded = workspace([
      node({ id: "target", isCollapsed: false }),
      node({ id: "moving", sortKey: 2048 }),
      node({ id: "other", sortKey: 3072 })
    ]);
    const toggleCollapsed = vi.fn(async (_vaultRoot, _nodeId, context) =>
      mutationResult(expanded, context)
    );
    const undo = vi.fn().mockImplementation(async () =>
      appliedReplay(
        initial,
        toggleCollapsed.mock.calls[0]?.[2]?.entryId ?? null,
        "undo"
      )
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleCollapsed,
      moveNode: vi.fn().mockRejectedValue(new Error("move failed")),
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/partial-move", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.actions.zoomTo("target");
      await result.current.actions.focusNode("moving");
    });

    await act(async () =>
      result.current.actions.moveNode(
        { id: "moving", parentId: "target", afterId: null },
        "moving",
        { expandNodeId: "target" }
      )
    );
    await act(async () => {
      await result.current.actions.focusNode("other");
      await result.current.actions.zoomTo("other");
      await result.current.actions.undo!();
      await result.current.actions.undo!();
    });

    expect(result.current.state).toMatchObject({
      selectedId: "moving",
      zoomRootId: "target",
      pendingFocusId: "moving",
      pendingFocusField: "title"
    });
  });

  it("publishes a remove focus target only after authoritative success", async () => {
    const removed = deferred<NotesWorkspace>();
    const initial = workspace([
      node({ id: "first" }),
      node({ id: "empty", sortKey: 2, title: "" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      removeEmptyNode: vi.fn().mockReturnValue(removed.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.actions.removeEmptyNode("empty", "first");
    });
    await waitFor(() => expect(store.removeEmptyNode).toHaveBeenCalledOnce());
    expect(result.current.state.pendingFocusId).toBeNull();

    await act(async () => {
      removed.resolve(workspace([node({ id: "first" })]));
      await completion;
    });
    expect(result.current.state).toMatchObject({
      selectedId: "first",
      editingNoteId: "first",
      pendingFocusId: "first"
    });
  });

  it("does not publish a remove focus target when the command fails", async () => {
    const initial = workspace([
      node({ id: "first" }),
      node({ id: "empty", sortKey: 2, title: "" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      removeEmptyNode: vi.fn().mockRejectedValue(new Error("remove failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.removeEmptyNode("empty", "first")
    );

    expect(result.current.state.pendingFocusId).toBeNull();
    expect(result.current).toMatchObject({
      status: "error",
      error: "remove failed"
    });
  });

  it("publishes two successful commands in invocation order", async () => {
    const first = deferred<NotesWorkspace>();
    const second = deferred<NotesWorkspace>();
    const store = repository({
      updateNode: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<unknown>;
    let secondCompletion!: Promise<unknown>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("root", {
        title: "first",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("root", {
        title: "second",
        note: ""
      });
    });

    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());
    await act(async () => {
      first.resolve(workspace([node({ id: "root" }), node({ id: "first" })]));
      await firstCompletion;
    });
    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(result.current.state.nodesById.first).toBeDefined();
    expect(result.current.status).toBe("loading");

    await act(async () => {
      second.resolve(workspace([node({ id: "second" })]));
      await secondCompletion;
    });

    expect(result.current.state.nodesById.second).toBeDefined();
    expect(result.current.state.nodesById.first).toBeUndefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("continues from a failed command to a later successful command", async () => {
    const first = deferred<NotesWorkspace>();
    const second = deferred<NotesWorkspace>();
    const store = repository({
      updateNode: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<unknown>;
    let secondCompletion!: Promise<unknown>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("root", {
        title: "first",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("root", {
        title: "second",
        note: ""
      });
    });

    await act(async () => {
      first.reject(new Error("first failed"));
      await firstCompletion;
    });
    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(result.current.state.nodesById.root).toBeDefined();
    expect(result.current).toMatchObject({
      status: "loading",
      error: "first failed"
    });

    await act(async () => {
      second.resolve(workspace([node({ id: "second" })]));
      await secondCompletion;
    });

    expect(result.current.state.nodesById.second).toBeDefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("derives rapid creation placement when each queued command starts", async () => {
    createNoteIdMock
      .mockReturnValueOnce("new-root-1")
      .mockReturnValueOnce("new-root-2");
    const first = deferred<NotesWorkspace>();
    const second = deferred<NotesWorkspace>();
    const base = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "initial", sortKey: 1 })])),
      createNode: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
    });
    const { repository: store, events } = journalNotesRepository(base);
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    events.clear();

    let firstCompletion!: Promise<unknown>;
    let secondCompletion!: Promise<unknown>;
    act(() => {
      firstCompletion = result.current.actions.createRoot();
      secondCompletion = result.current.actions.createRoot();
    });

    await waitFor(() => expect(createNoteIdMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(events.for("createNode")).toHaveLength(1));
    expect(events.for("createNode")[0]).toMatchObject({
      vaultRoot: "/vault",
      commandKind: "create",
      input: {
        id: "new-root-1",
        parentId: null,
        afterId: "initial",
        title: "",
        note: ""
      }
    });

    await act(async () =>
      first.resolve(workspace([
        node({ id: "initial", sortKey: 1 }),
        node({ id: "new-root-1", sortKey: 2 })
      ]))
    );
    expect(createNoteIdMock).toHaveBeenCalledTimes(2);
    expect(events.for("createNode")).toHaveLength(2);
    expect(events.for("createNode")[1]).toMatchObject({
      vaultRoot: "/vault",
      commandKind: "create",
      input: {
        id: "new-root-2",
        parentId: null,
        afterId: "new-root-1",
        title: "",
        note: ""
      }
    });

    await act(async () => {
      second.resolve(workspace([
        node({ id: "initial", sortKey: 1 }),
        node({ id: "new-root-1", sortKey: 2 }),
        node({ id: "new-root-2", sortKey: 3 })
      ]));
      await Promise.all([firstCompletion, secondCompletion]);
    });
  });

  it("materializes structural before snapshots before repository awaits", async () => {
    createNoteIdMock.mockReturnValue("created");
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const activeReload = deferred<NotesWorkspace>();
    let activeLoads = 0;
    const createdWorkspace = workspace([
      node({ id: "root" }),
      node({ id: "other", sortKey: 2048 }),
      node({ id: "created", sortKey: 3072 })
    ]);
    const createNode = vi.fn(async (_vaultRoot, _input, context) =>
      mutationResult(createdWorkspace, context)
    );
    const undo = vi.fn().mockImplementation(async () =>
      appliedReplay(
        initial,
        createNode.mock.calls[0]?.[2]?.entryId ?? null,
        "undo"
      )
    );
    const store = repository({
      loadWorkspace: vi.fn((_vaultRoot, scope) => {
        if (scope?.kind === "active") {
          activeLoads += 1;
          return activeLoads === 1
            ? Promise.resolve(initial)
            : activeReload.promise;
        }
        return Promise.resolve(initial);
      }),
      createNode,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("starred"));
    await act(async () => {
      await result.current.actions.focusNode("root");
      await result.current.actions.zoomTo("root");
    });

    const creation = result.current.actions.createRoot();
    await waitFor(() => expect(activeLoads).toBe(2));
    let navigation!: Promise<unknown>;
    act(() => {
      void result.current.actions.focusNode("other");
      navigation = result.current.actions.zoomTo("other");
    });
    expect(result.current.state.zoomRootId).toBe("root");
    activeReload.resolve(initial);
    await act(async () => Promise.all([creation, navigation]));
    await act(async () => result.current.actions.undo!());
    await act(async () => result.current.actions.undo!());

    expect(result.current.state).toMatchObject({
      selectedId: "root",
      zoomRootId: "root",
      editingNoteId: "root",
      pendingFocusId: "root",
      pendingFocusField: "title"
    });
  });

  it("derives a queued child creation from a parent created by prior work", async () => {
    createNoteIdMock
      .mockReturnValueOnce("new-parent")
      .mockReturnValueOnce("new-child");
    const parentCreation = deferred<NotesWorkspace>();
    const childCreation = deferred<NotesWorkspace>();
    const base = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
      createNode: vi
        .fn()
        .mockReturnValueOnce(parentCreation.promise)
        .mockReturnValueOnce(childCreation.promise)
    });
    const { repository: store, events } = journalNotesRepository(base);
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    events.clear();

    let parentCompletion!: Promise<unknown>;
    let childCompletion!: Promise<unknown>;
    act(() => {
      parentCompletion = result.current.actions.createRoot();
      childCompletion = result.current.actions.createChild("new-parent");
    });

    await waitFor(() => expect(events.for("createNode")).toHaveLength(1));
    await act(async () =>
      parentCreation.resolve(workspace([node({ id: "new-parent" })]))
    );
    expect(events.for("createNode")[1]).toMatchObject({
      vaultRoot: "/vault",
      commandKind: "create",
      input: {
        id: "new-child",
        parentId: "new-parent",
        afterId: null,
        title: "",
        note: ""
      }
    });

    await act(async () => {
      childCreation.resolve(workspace([
        node({ id: "new-parent" }),
        node({ id: "new-child", parentId: "new-parent" })
      ]));
      await Promise.all([parentCompletion, childCompletion]);
    });
  });

  it("detects a duplicate against the confirmed workspace at queue start", async () => {
    createNoteIdMock.mockReturnValue("new-root");
    const create = deferred<NotesWorkspace>();
    const duplicate = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "source", sortKey: 1 })])),
      createNode: vi.fn().mockReturnValue(create.promise),
      duplicateNode: vi.fn().mockReturnValue(duplicate.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let createCompletion!: Promise<unknown>;
    let duplicateCompletion!: Promise<unknown>;
    act(() => {
      createCompletion = result.current.actions.createRoot();
      duplicateCompletion = result.current.actions.duplicateNode("source");
    });

    expect(store.duplicateNode).not.toHaveBeenCalled();
    await act(async () =>
      create.resolve(workspace([
        node({ id: "source", sortKey: 1 }),
        node({ id: "new-root", sortKey: 2 })
      ]))
    );
    expect(store.duplicateNode).toHaveBeenCalledWith(
      "/vault",
      "source",
      historyContext("duplicate")
    );

    await act(async () => {
      duplicate.resolve(workspace([
        node({ id: "source", sortKey: 1 }),
        node({ id: "new-root", sortKey: 2 }),
        node({ id: "duplicate", sortKey: 3 })
      ]));
      await Promise.all([createCompletion, duplicateCompletion]);
    });

    expect(result.current.state).toMatchObject({
      selectedId: "duplicate",
      editingNoteId: "duplicate",
      pendingFocusId: "duplicate"
    });
  });

  it("continues after a synchronous command throw and resolves public promises", async () => {
    const updateNode = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("synchronous failure");
      })
      .mockImplementationOnce(async (_vaultRoot, _input, context) =>
        mutationResult(workspace([node({ id: "second" })]), context)
      );
    const store = repository({
      updateNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<unknown>;
    let secondCompletion!: Promise<unknown>;
    let zoomCompletion!: Promise<unknown>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("root", {
        title: "first",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("root", {
        title: "second",
        note: ""
      });
      zoomCompletion = result.current.actions.zoomTo("root");
    });

    expect(firstCompletion).toBeInstanceOf(Promise);
    expect(secondCompletion).toBeInstanceOf(Promise);
    expect(zoomCompletion).toBeInstanceOf(Promise);
    await act(async () => {
      // The first update's synchronous throw settles as "failed"; the second
      // commits; zoom is navigation-only and reports no settlement.
      expect(await firstCompletion).toBe("failed");
      expect(await secondCompletion).toBe("committed");
      expect(await zoomCompletion).toBeUndefined();
    });
    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(result.current.state.nodesById.second).toBeDefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("clears old placement state across an identity transition and failed load", async () => {
    createNoteIdMock.mockReturnValue("new-vault-root");
    const oldStore = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "old-root" })]))
    });
    const newStore = repository({
      loadWorkspace: vi.fn().mockRejectedValue(new Error("new vault failed")),
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "new-vault-root" })]))
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot, repository: current }) =>
        useNotesWorkspace({ vaultRoot, repository: current }),
      { initialProps: { vaultRoot: "/old", repository: oldStore } }
    );
    await waitFor(() => expect(result.current.state.nodesById["old-root"]).toBeDefined());

    rerender({ vaultRoot: "/new", repository: newStore });

    expect(result.current.status).toBe("loading");
    expect(result.current.state.rootIds).toEqual([]);
    expect(result.current.state.nodesById["old-root"]).toBeUndefined();
    await waitFor(() => expect(result.current.error).toBe("new vault failed"));
    expect(result.current.state.rootIds).toEqual([]);

    await act(async () => result.current.actions.createRoot());
    expect(newStore.createNode).not.toHaveBeenCalled();
    expect(result.current.state.rootIds).toEqual([]);
  });

  it("delegates every remaining action to NotesStore and preserves confirmed nodes on errors", async () => {
    const after = workspace([node({ id: "root" }), node({ id: "child", parentId: "root" })]);
    const updateNodeMock = vi.fn().mockResolvedValue(after);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(after),
      updateNode: updateNodeMock,
      setReadonly: vi.fn().mockResolvedValue(after),
      splitNode: vi.fn().mockResolvedValue(after),
      moveNode: vi.fn().mockResolvedValue(after),
      toggleComplete: vi.fn().mockResolvedValue(after),
      toggleCollapsed: vi.fn().mockResolvedValue(after),
      duplicateNode: vi.fn().mockResolvedValue(after),
      removeEmptyNode: vi.fn().mockResolvedValue(after),
      softDeleteNode: vi.fn().mockResolvedValue(after),
      restoreNode: vi.fn().mockResolvedValue(after)
    });
    const { result } = renderHook(() => useNotesWorkspace({ vaultRoot: "/vault", repository: store }));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    await act(async () => result.current.actions.updateNode("root", { title: "Title", note: "Note" }));
    await act(async () => result.current.actions.setReadonly?.("root", true));
    await act(async () => result.current.actions.splitNode("root", "split", "pre", "post"));
    await act(async () => result.current.actions.moveNode({ id: "child", parentId: null, afterId: "root" }));
    await act(async () => result.current.actions.toggleComplete("root"));
    await act(async () => result.current.actions.toggleCollapsed("root"));
    await act(async () => result.current.actions.duplicateNode("root"));
    await act(async () => result.current.actions.removeEmptyNode("child"));
    await act(async () => result.current.actions.deleteNode("root"));
    await act(async () => result.current.actions.restoreNode("root"));

    expect(store.updateNode).toHaveBeenCalledWith("/vault", {
      id: "root",
      title: "Title",
      note: "Note",
      imageOffsetUtf16: 0
    }, historyContext("update"));
    expect(store.setReadonly).toHaveBeenCalledWith(
      "/vault",
      { nodeId: "root", isReadonly: true },
      historyContext("set-readonly")
    );
    expect(store.splitNode).toHaveBeenCalledWith("/vault", { id: "root", newNodeId: "split", prefix: "pre", suffix: "post" }, historyContext("split"));
    expect(store.moveNode).toHaveBeenCalledWith("/vault", { id: "child", parentId: null, afterId: "root" }, historyContext("move"));
    expect(store.toggleComplete).toHaveBeenCalledWith("/vault", "root", historyContext("complete"));
    expect(store.toggleCollapsed).toHaveBeenCalledWith("/vault", "root", historyContext("collapse"));
    expect(store.duplicateNode).toHaveBeenCalledWith("/vault", "root", historyContext("duplicate"));
    expect(store.removeEmptyNode).toHaveBeenCalledWith("/vault", "child", historyContext("remove"));
    expect(store.softDeleteNode).toHaveBeenCalledWith("/vault", "root", historyContext("trash"));
    expect(store.restoreNode).toHaveBeenCalledWith("/vault", "root", historyContext("restore"));

    updateNodeMock.mockRejectedValueOnce(new Error("write failed"));
    await act(async () => result.current.actions.updateNode("root", { title: "Again", note: "" }));
    expect(result.current.error).toBe("write failed");
    expect(result.current.state.nodesById.root).toBeDefined();
  });

  it.each([
    ["expandAll", "expandAll", "expand-all"],
    ["collapseAll", "collapseAll", "collapse-all"],
    ["sortSubtreeAscending", "sortSubtreeAscending", "sort-ascending"],
    ["sortSubtreeDescending", "sortSubtreeDescending", "sort-descending"]
  ] as const)(
    "routes %s through atomic history and restores focus on Undo",
    async (actionName, repositoryMethod, commandKind) => {
      const rootId = "11111111-1111-4111-8111-111111111111";
      const rootAttachment = attachment({
        id: "22222222-2222-4222-8222-222222222222",
        nodeId: rootId
      });
      const before: NotesWorkspace = {
        nodes: [
          node({ id: rootId, title: "Root", isCollapsed: true }),
          node({ id: "child", parentId: rootId, title: "Zulu" }),
          node({ id: "other", sortKey: 2048 })
        ],
        attachmentsByNodeId: { [rootId]: [rootAttachment] }
      };
      const after: NotesWorkspace = {
        nodes: [
          node({ id: rootId, title: "Root", isCollapsed: false }),
          node({ id: "child", parentId: rootId, title: "Alpha" }),
          node({ id: "other", sortKey: 2048 })
        ],
        attachmentsByNodeId: { [rootId]: [rootAttachment] }
      };
      const atomic = vi.fn().mockImplementation(
        async (_vaultRoot, _nodeId, context) => ({
          workspace: after,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false
        })
      );
      const undo = vi.fn().mockImplementation(async () => ({
        workspace: before,
        replayedEntryId: atomic.mock.calls[0]?.[2]?.entryId ?? null,
        ...historyState(),
        kind: "applied" as const,
        canUndo: false,
        canRedo: true
      }));
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(before),
        [repositoryMethod]: atomic,
        undo
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({ vaultRoot: `/atomic-${actionName}`, repository: store })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () => result.current.actions.focusNode(rootId));

      await act(async () => result.current.actions[actionName](rootId));

      expect(atomic).toHaveBeenCalledWith(
        `/atomic-${actionName}`,
        rootId,
        historyContext(commandKind)
      );
      await waitFor(() =>
        expect(result.current).toMatchObject({ canUndo: true, canRedo: false })
      );
      expect(result.current.state.attachmentsByNodeId[rootId]).toEqual([
        rootAttachment
      ]);
      await act(async () => {
        await result.current.actions.focusNode("other");
        await result.current.actions.undo!();
      });
      expect(undo).toHaveBeenCalledOnce();
      expect(result.current.state).toMatchObject({
        selectedId: rootId,
        pendingFocusId: rootId,
        pendingFocusField: "title"
      });
    }
  );

  it.each([
    ["expandAll", "expandAll"],
    ["collapseAll", "collapseAll"],
    ["sortSubtreeAscending", "sortSubtreeAscending"],
    ["sortSubtreeDescending", "sortSubtreeDescending"]
  ] as const)("does not create Undo for a no-op %s mutation", async (
    actionName,
    repositoryMethod
  ) => {
    const initial = workspace([node({ id: "root" })]);
    const atomic = vi.fn().mockResolvedValue({
      workspace: initial,
      historyEntryId: null,
        ...historyState(),
      canUndo: false,
      canRedo: false
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      [repositoryMethod]: atomic
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: `/noop-${actionName}`, repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions[actionName]("root"));

    expect(atomic).toHaveBeenCalledOnce();
    expect(result.current).toMatchObject({ canUndo: false, canRedo: false });
  });

  it("commits one atomic Move To and restores its focus with one Undo", async () => {
    const initial = workspace([
      node({ id: "project" }),
      node({ id: "child", parentId: "project" }),
      node({ id: "inbox", sortKey: 2048 })
    ]);
    const moved = workspace([
      node({ id: "project" }),
      node({ id: "child", parentId: "inbox" }),
      node({ id: "inbox", sortKey: 2048 })
    ]);
    const moveNode = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => ({
        workspace: moved,
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      })
    );
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initial,
      replayedEntryId: moveNode.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      kind: "applied" as const,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      moveNode,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/move-to", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.focusNode("child"));

    await act(async () =>
      result.current.actions.moveNode(
        { id: "child", parentId: "inbox", afterId: null },
        "child"
      )
    );

    expect(moveNode).toHaveBeenCalledOnce();
    expect(moveNode).toHaveBeenCalledWith(
      "/move-to",
      { id: "child", parentId: "inbox", afterId: null },
      historyContext("move")
    );
    await act(async () => result.current.actions.undo!());
    expect(undo).toHaveBeenCalledOnce();
    expect(result.current.state).toMatchObject({
      selectedId: "child",
      pendingFocusId: "child",
      pendingFocusField: "title"
    });
    expect(result.current.state.nodesById.child.parentId).toBe("project");
  });

  it("prepares Move To from full active state and commits a root move with one Undo", async () => {
    const initial = workspace([
      node({ id: "project" }),
      node({ id: "child", parentId: "project" }),
      node({ id: "inbox", sortKey: 2048 })
    ]);
    const moved = workspace([
      node({ id: "project" }),
      node({ id: "inbox", sortKey: 2048 }),
      node({ id: "child", sortKey: 3072 })
    ]);
    let activeWorkspace = initial;
    const moveNode = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => {
        activeWorkspace = moved;
        return {
          workspace: moved,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false
        };
      }
    );
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initial,
      replayedEntryId: moveNode.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      kind: "applied" as const,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "starred"
          ? workspace([initial.nodes[0], initial.nodes[1]])
          : activeWorkspace
      ),
      moveNode,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/prepared-root", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () =>
      result.current.actions.selectLibraryView("starred")
    );

    const prepared = await result.current.prepareMoveNode!("child");
    expect(prepared.nodes.map((item) => item.id)).toEqual([
      "project",
      "child",
      "inbox"
    ]);

    let outcome: Awaited<
      ReturnType<NonNullable<typeof result.current.commitPreparedMove>>
    >;
    await act(async () => {
      outcome = await result.current.commitPreparedMove!(prepared, null);
    });

    expect(outcome!).toEqual({ ok: true });
    expect(moveNode).toHaveBeenCalledOnce();
    expect(moveNode).toHaveBeenCalledWith(
      "/prepared-root",
      { id: "child", parentId: null, afterId: "inbox" },
      historyContext("move")
    );
    await act(async () => result.current.actions.undo!());
    expect(undo).toHaveBeenCalledOnce();
  });

  it("rejects a target removed after Move To opens without closing authority", async () => {
    const source = node({ id: "source" });
    const target = node({ id: "target", sortKey: 2048 });
    let activeWorkspace = workspace([source, target]);
    const moveNode = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async () => activeWorkspace),
      moveNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/removed-target", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const prepared = await result.current.prepareMoveNode!("source");
    activeWorkspace = workspace([source]);

    let outcome!: Awaited<
      ReturnType<NonNullable<typeof result.current.commitPreparedMove>>
    >;
    await act(async () => {
      outcome = await result.current.commitPreparedMove!(prepared, "target");
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed")
    });
    expect(moveNode).not.toHaveBeenCalled();
  });

  it("rejects a prepared move after its scope or vault changes", async () => {
    const active = workspace([
      node({ id: "source" }),
      node({ id: "target", sortKey: 2048 })
    ]);
    const oldStore = repository({
      loadWorkspace: vi.fn().mockResolvedValue(active)
    });
    const newStore = repository({
      loadWorkspace: vi.fn().mockResolvedValue(active)
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot, store }) =>
        useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old-move", store: oldStore } }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const scopePrepared = await result.current.prepareMoveNode!("source");
    await act(async () =>
      result.current.actions.selectLibraryView("recent")
    );

    expect(
      await result.current.commitPreparedMove!(scopePrepared, "target")
    ).toMatchObject({ ok: false, error: expect.stringContaining("changed") });

    const vaultPrepared = await result.current.prepareMoveNode!("source");
    rerender({ vaultRoot: "/new-move", store: newStore });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(
      await result.current.commitPreparedMove!(vaultPrepared, "target")
    ).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
  });

  it("rejects a prepared move when an earlier queued move changes its source parent", async () => {
    const initial = workspace([
      node({ id: "first-parent" }),
      node({ id: "other-parent", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 }),
      node({ id: "source", parentId: "first-parent" })
    ]);
    const sourceMoved = workspace([
      node({ id: "first-parent" }),
      node({ id: "other-parent", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 }),
      node({ id: "source", parentId: "other-parent" })
    ]);
    let activeWorkspace = initial;
    const earlier = deferred<NotesMutationResult>();
    const moveNode = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => {
        if (moveNode.mock.calls.length === 1) {
          return earlier.promise;
        }
        return {
          workspace: activeWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async () => activeWorkspace),
      moveNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/queued-source", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const prepared = await result.current.prepareMoveNode!("source");

    let earlierCompletion!: Promise<unknown>;
    act(() => {
      earlierCompletion = result.current.actions.moveNode({
        id: "source",
        parentId: "other-parent",
        afterId: null
      });
    });
    await waitFor(() => expect(moveNode).toHaveBeenCalledOnce());
    const preparedCompletion = result.current.commitPreparedMove!(
      prepared,
      "target"
    );
    await act(async () => Promise.resolve());
    expect(moveNode).toHaveBeenCalledOnce();

    activeWorkspace = sourceMoved;
    const earlierContext = moveNode.mock.calls[0]?.[2];
    earlier.resolve({
      workspace: sourceMoved,
      historyEntryId: earlierContext?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    let outcome!: Awaited<typeof preparedCompletion>;
    await act(async () => {
      await earlierCompletion;
      outcome = await preparedCompletion;
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed")
    });
    expect(moveNode).toHaveBeenCalledOnce();
  });

  it("rejects a prepared move when an earlier queued move changes its target", async () => {
    const initial = workspace([
      node({ id: "source" }),
      node({ id: "target", sortKey: 2048 }),
      node({ id: "other-parent", sortKey: 3072 })
    ]);
    const targetMoved = workspace([
      node({ id: "source" }),
      node({ id: "other-parent", sortKey: 3072 }),
      node({ id: "target", parentId: "other-parent" })
    ]);
    let activeWorkspace = initial;
    const earlier = deferred<NotesMutationResult>();
    const moveNode = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => {
        if (moveNode.mock.calls.length === 1) {
          return earlier.promise;
        }
        return {
          workspace: activeWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async () => activeWorkspace),
      moveNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/queued-target", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const prepared = await result.current.prepareMoveNode!("source");

    let earlierCompletion!: Promise<unknown>;
    act(() => {
      earlierCompletion = result.current.actions.moveNode({
        id: "target",
        parentId: "other-parent",
        afterId: null
      });
    });
    await waitFor(() => expect(moveNode).toHaveBeenCalledOnce());
    const preparedCompletion = result.current.commitPreparedMove!(
      prepared,
      "target"
    );

    activeWorkspace = targetMoved;
    const earlierContext = moveNode.mock.calls[0]?.[2];
    earlier.resolve({
      workspace: targetMoved,
      historyEntryId: earlierContext?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    const outcome = await preparedCompletion;
    await earlierCompletion;

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed")
    });
    expect(moveNode).toHaveBeenCalledOnce();
  });

  it("rejects a prepared move when an earlier queued delete removes its target", async () => {
    const initial = workspace([
      node({ id: "source" }),
      node({ id: "target", sortKey: 2048 })
    ]);
    const targetRemoved = workspace([node({ id: "source" })]);
    let activeWorkspace = initial;
    const earlier = deferred<NotesMutationResult>();
    const softDeleteNode = vi.fn().mockReturnValue(earlier.promise);
    const moveNode = vi.fn().mockResolvedValue({
      workspace: targetRemoved,
      historyEntryId: null,
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async () => activeWorkspace),
      softDeleteNode,
      moveNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/queued-delete", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const prepared = await result.current.prepareMoveNode!("source");

    const earlierCompletion = result.current.actions.deleteNode("target");
    await waitFor(() => expect(softDeleteNode).toHaveBeenCalledOnce());
    const preparedCompletion = result.current.commitPreparedMove!(
      prepared,
      "target"
    );

    activeWorkspace = targetRemoved;
    const earlierContext = softDeleteNode.mock.calls[0]?.[2];
    earlier.resolve({
      workspace: targetRemoved,
      historyEntryId: earlierContext?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    const outcome = await preparedCompletion;
    await earlierCompletion;

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed")
    });
    expect(moveNode).not.toHaveBeenCalled();
  });

  it("rejects a prepared move when a queued scope generation settles first", async () => {
    const initial = workspace([
      node({ id: "blocker" }),
      node({ id: "source", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 })
    ]);
    let activeWorkspace = initial;
    const earlier = deferred<NotesMutationResult>();
    const moveNode = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => {
        if (moveNode.mock.calls.length === 1) {
          return earlier.promise;
        }
        return {
          workspace: activeWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async () => activeWorkspace),
      moveNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/queued-scope", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const prepared = await result.current.prepareMoveNode!("source");

    const earlierCompletion = result.current.actions.moveNode({
      id: "blocker",
      parentId: "target",
      afterId: null
    });
    await waitFor(() => expect(moveNode).toHaveBeenCalledOnce());
    const scopeCompletion = result.current.actions.selectLibraryView("recent");
    const preparedCompletion = result.current.commitPreparedMove!(
      prepared,
      "target"
    );

    const earlierContext = moveNode.mock.calls[0]?.[2];
    earlier.resolve({
      workspace: initial,
      historyEntryId: earlierContext?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    const outcome = await preparedCompletion;
    await earlierCompletion;
    await scopeCompletion;

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed")
    });
    expect(moveNode).toHaveBeenCalledOnce();
  });

  it("rejects a queued prepared move when its vault generation changes", async () => {
    const initial = workspace([
      node({ id: "blocker" }),
      node({ id: "source", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 })
    ]);
    const earlier = deferred<NotesMutationResult>();
    const oldMoveNode = vi.fn().mockReturnValue(earlier.promise);
    const oldStore = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      moveNode: oldMoveNode
    });
    const newStore = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial)
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot, store }) =>
        useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/queued-old", store: oldStore } }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const prepared = await result.current.prepareMoveNode!("source");

    const earlierCompletion = result.current.actions.moveNode({
      id: "blocker",
      parentId: "target",
      afterId: null
    });
    await waitFor(() => expect(oldMoveNode).toHaveBeenCalledOnce());
    const preparedCompletion = result.current.commitPreparedMove!(
      prepared,
      "target"
    );
    rerender({ vaultRoot: "/queued-new", store: newStore });

    const earlierContext = oldMoveNode.mock.calls[0]?.[2];
    earlier.resolve({
      workspace: initial,
      historyEntryId: earlierContext?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    const outcome = await preparedCompletion;
    await earlierCompletion;
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed")
    });
    expect(oldMoveNode).toHaveBeenCalledOnce();
  });

  it("commits one valid deferred prepared move and creates one Undo", async () => {
    const initial = workspace([
      node({ id: "source" }),
      node({ id: "target", sortKey: 2048 })
    ]);
    const moved = workspace([
      node({ id: "target", sortKey: 2048 }),
      node({ id: "source", parentId: "target" })
    ]);
    let activeWorkspace = initial;
    const pendingMove = deferred<NotesMutationResult>();
    const moveNode = vi.fn().mockReturnValue(pendingMove.promise);
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initial,
      replayedEntryId: moveNode.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      kind: "applied" as const,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async () => activeWorkspace),
      moveNode,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/queued-valid", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const prepared = await result.current.prepareMoveNode!("source");

    const completion = result.current.commitPreparedMove!(prepared, "target");
    await waitFor(() => expect(moveNode).toHaveBeenCalledOnce());
    activeWorkspace = moved;
    const context = moveNode.mock.calls[0]?.[2];
    pendingMove.resolve({
      workspace: moved,
      historyEntryId: context?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    await act(async () => {
      await expect(completion).resolves.toEqual({ ok: true });
    });

    await act(async () => result.current.actions.undo!());
    expect(moveNode).toHaveBeenCalledOnce();
    expect(undo).toHaveBeenCalledOnce();
  });

  it("broadcasts atomic subtree actions to sibling hooks without replacing navigation", async () => {
    const initial = workspace([
      node({ id: "root", isCollapsed: true }),
      node({ id: "child", parentId: "root", isCollapsed: true })
    ]);
    const expanded = workspace([
      node({ id: "root", isCollapsed: false }),
      node({ id: "child", parentId: "root", isCollapsed: false })
    ]);
    const expandAll = vi.fn().mockImplementation(
      async (_vaultRoot, _nodeId, context) => ({
        workspace: expanded,
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      expandAll
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-subtree", repository: store })
    );
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));
    await act(async () => sibling.result.current.actions.zoomTo("root"));
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-subtree", repository: store })
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));

    await act(async () => owner.result.current.actions.expandAll("root"));

    await waitFor(() =>
      expect(sibling.result.current.state.nodesById.child.isCollapsed).toBe(
        false
      )
    );
    expect(sibling.result.current.state.zoomRootId).toBe("root");
  });

  it("clears sibling search expansions for a no-op Collapse all", async () => {
    const collapsed = workspace([
      node({ id: "root", isCollapsed: true }),
      node({ id: "child", parentId: "root" })
    ]);
    const collapseAll = vi.fn().mockResolvedValue({
      workspace: collapsed,
      historyEntryId: null,
      ...historyState(),
      canUndo: false,
      canRedo: false
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(collapsed),
      collapseAll
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-collapse", repository: store })
    );
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));
    await act(async () =>
      sibling.result.current.actions.openSearchResult("child")
    );
    expect(sibling.result.current.locallyExpandedNodeIds).toEqual(
      new Set(["root"])
    );
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-collapse", repository: store })
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));

    await act(async () => owner.result.current.actions.collapseAll("root"));

    await waitFor(() =>
      expect(sibling.result.current.locallyExpandedNodeIds).toEqual(new Set())
    );
    expect(owner.result.current.canUndo).toBe(true);
  });

  it("retains the last scoped projection when reload fails after a mutation", async () => {
    const starred = node({ id: "starred", title: "Starred", isStarred: true });
    const outside = node({ id: "outside", title: "Outside" });
    const split = node({
      id: "split",
      parentId: null,
      sortKey: 1536,
      title: "Split"
    });
    let rejectScopedReload = false;
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) => {
        if (scope.kind === "starred") {
          if (rejectScopedReload) {
            throw new Error("Scoped reload failed");
          }
          return workspace([starred]);
        }
        return workspace([starred, outside]);
      }),
      splitNode: vi.fn().mockResolvedValue(workspace([starred, outside, split]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("starred"));
    expect(result.current.state.rootIds).toEqual(["starred"]);

    rejectScopedReload = true;
    await act(async () =>
      result.current.actions.splitNode(
        "starred",
        "split",
        "Star",
        "red"
      )
    );

    expect(result.current.error).toBe("Scoped reload failed");
    expect(result.current.libraryView).toBe("starred");
    expect(result.current.state.rootIds).toEqual(["starred"]);
    expect(result.current.state.nodesById.outside).toBeUndefined();
    expect(result.current.state.nodesById.split).toBeUndefined();
  });

  it.each(["update", "toggle", "duplicate", "restore"] as const)(
    "recovers atomic %s history without publishing a failed non-active projection",
    async (operation) => {
      const deletedAt = "2026-07-12T00:00:00Z";
      const root = node({
        id: "root",
        title: "Before",
        isStarred: true,
        deletedAt: operation === "restore" ? deletedAt : null
      });
      const activeBefore = workspace([
        operation === "restore" ? node({ ...root, deletedAt: null }) : root,
        node({ id: "outside", sortKey: 2048 })
      ]);
      const scopedBefore = workspace([
        root,
        ...(operation === "duplicate"
          ? [node({ id: "outside", sortKey: 2048 })]
          : [])
      ]);
      const atomicWorkspace = workspace([
        node({
          ...root,
          title: operation === "update" ? "After" : root.title,
          isCollapsed: operation === "toggle",
          deletedAt: null
        }),
        node({ id: "outside", sortKey: 2048 }),
        ...(operation === "duplicate"
          ? [node({ id: "copy", sortKey: 3072, isStarred: true })]
          : [])
      ]);
      const recoveredScoped =
        operation === "restore"
          ? workspace([])
          : workspace(
              atomicWorkspace.nodes.filter(
                (candidate) => candidate.id === "root" || candidate.id === "copy"
              )
            );
      let rejectProjection = false;
      let recoveryMayLoad = false;
      const loadWorkspace = vi.fn(async (_vaultRoot, scope) => {
        if (scope.kind !== "active") {
          if (rejectProjection && !recoveryMayLoad) {
            throw new Error("Projection reload failed");
          }
          return recoveryMayLoad ? recoveredScoped : scopedBefore;
        }
        return activeBefore;
      });
      const atomicMutation = vi.fn((_vaultRoot, _input, context) =>
        Promise.resolve({
          workspace: atomicWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false
        })
      );
      const historyStatus = vi
        .fn()
        .mockImplementation((_vaultRoot, sessionId) =>
          syntheticHistoryStatus(sessionId)
        );
      const undo = vi.fn(async () => ({
        workspace: scopedBefore,
        replayedEntryId: atomicMutation.mock.calls[0]?.[2]?.entryId ?? null,
        ...historyState(),
        kind: "applied" as const,
        canUndo: false,
        canRedo: true
      }));
      const clearHistory = vi.fn(async () => {
        recoveryMayLoad = true;
        return { ...historyState("epoch-b"), historyReset: true as const };
      });
      const store = repository({
        loadWorkspace,
        ...(operation === "update" ? { updateNode: atomicMutation } : {}),
        ...(operation === "toggle"
          ? { toggleComplete: atomicMutation }
          : {}),
        ...(operation === "duplicate"
          ? { duplicateNode: atomicMutation }
          : {}),
        ...(operation === "restore" ? { restoreNode: atomicMutation } : {}),
        historyStatus,
        undo,
        clearHistory
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({
          vaultRoot: `/projection-${operation}`,
          repository: store
        })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () =>
        result.current.actions.selectLibraryView(
          operation === "restore" ? "trash" : "starred"
        )
      );
      await act(async () => result.current.actions.focusNode("root"));
      rejectProjection = true;

      await act(async () => {
        if (operation === "update") {
          await result.current.actions.updateNode("root", {
            title: "After",
            note: ""
          });
        } else if (operation === "toggle") {
          await result.current.actions.toggleComplete("root");
        } else if (operation === "duplicate") {
          await result.current.actions.duplicateNode("root");
        } else {
          await result.current.actions.restoreNode("root");
        }
      });

      expect(clearHistory).toHaveBeenCalledOnce();
      expect(result.current.error).toBeNull();
      expect(result.current).toMatchObject({ canUndo: false, canRedo: false });
      expect(result.current.state.nodesById.outside).toBeUndefined();
      expect(result.current.state.rootIds).toEqual(recoveredScoped.nodes.map(({ id }) => id));
      if (operation === "duplicate") {
        expect(result.current.state).toMatchObject({
          selectedId: "root",
          editingNoteId: "root",
          pendingFocusId: "root",
          pendingFocusField: "title"
        });
      }
      expect(undo).not.toHaveBeenCalled();
    }
  );

  it("loads every active Move To node without replacing a filtered projection", async () => {
    const root = node({ id: "root", isStarred: true });
    const outside = node({ id: "outside", sortKey: 2048 });
    const loadWorkspace = vi.fn(async (_vaultRoot, scope) =>
      scope.kind === "starred" ? workspace([root]) : workspace([root, outside])
    );
    const store = repository({ loadWorkspace });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/move-targets", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () =>
      result.current.actions.selectLibraryView("starred")
    );
    expect(result.current.state.rootIds).toEqual(["root"]);

    const activeNodes = await result.current.loadActiveNodesForMove!();

    expect(activeNodes.map((item) => item.id)).toEqual(["root", "outside"]);
    expect(result.current.state.rootIds).toEqual(["root"]);
    expect(loadWorkspace).toHaveBeenLastCalledWith("/move-targets", {
      kind: "active"
    });
  });

  it("routes plain and validated structured search queries to their matching APIs", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const searchStructured = vi.fn().mockResolvedValue([]);
    const store = repository({ search, searchStructured });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.actions.searchNotes("  roadmap notes  ");
    });
    expect(search).toHaveBeenCalledWith("/vault", "roadmap notes");
    expect(searchStructured).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.actions.searchNotes(
        "roadmap #Work -@Alice #Soon OR @Bob"
      );
    });
    expect(searchStructured).toHaveBeenCalledWith("/vault", {
      text: "roadmap",
      requiredTags: [
        { prefix: "#", normalizedTag: "work", displayTag: "Work" }
      ],
      excludedTags: [
        { prefix: "@", normalizedTag: "alice", displayTag: "Alice" }
      ],
      orGroups: [
        [
          { prefix: "#", normalizedTag: "soon", displayTag: "Soon" },
          { prefix: "@", normalizedTag: "bob", displayTag: "Bob" }
        ]
      ]
    });
    expect(search).toHaveBeenCalledOnce();

    const invalid = Array.from({ length: 65 }, (_, index) => `#tag${index}`)
      .join(" ");
    await expect(result.current.actions.searchNotes(invalid)).rejects.toThrow(
      "Structured Notes search has more than 64 unique tag alternatives."
    );
    expect(search).toHaveBeenCalledOnce();
    expect(searchStructured).toHaveBeenCalledOnce();
  });

  it("canonicalizes AND tag filters and restores the captured live location after the last removal", async () => {
    const active = workspace([
      node({ id: "root", title: "Root", isCollapsed: true }),
      node({ id: "child", parentId: "root", title: "Child" }),
      node({ id: "other", sortKey: 2, title: "Other" })
    ]);
    const filtered = workspace([
      node({ id: "root", title: "Root", isCollapsed: true }),
      node({ id: "child", parentId: "root", title: "Child" })
    ]);
    const loadWorkspace = vi.fn(async (_vaultRoot, scope) =>
      scope.kind === "tags" ? filtered : active
    );
    const store = repository({
      loadWorkspace,
      listTagsWithCounts: vi.fn().mockResolvedValue([
        {
          prefix: "#",
          normalizedTag: "work",
          displayTag: "Work",
          count: 2
        },
        {
          prefix: "@",
          normalizedTag: "alice",
          displayTag: "Alice",
          count: 1
        }
      ])
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.openSearchResult("child"));
    expect(result.current.state).toMatchObject({
      selectedId: "child",
      zoomRootId: "root"
    });
    expect(result.current.locallyExpandedNodeIds).toEqual(new Set(["root"]));

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "@",
        normalizedTag: "alice"
      })
    );
    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );

    expect(result.current.activeTagFilters).toEqual([
      { prefix: "#", normalizedTag: "work" },
      { prefix: "@", normalizedTag: "alice" }
    ]);
    expect(result.current.tagSummaries).toEqual([
      {
        prefix: "#",
        normalizedTag: "work",
        displayTag: "Work",
        count: 2
      },
      {
        prefix: "@",
        normalizedTag: "alice",
        displayTag: "Alice",
        count: 1
      }
    ]);
    expect(loadWorkspace).toHaveBeenLastCalledWith("/vault", {
      kind: "tags",
      tags: [
        { prefix: "#", normalizedTag: "work" },
        { prefix: "@", normalizedTag: "alice" }
      ]
    });

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    expect(result.current.activeTagFilters).toEqual([
      { prefix: "@", normalizedTag: "alice" }
    ]);

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "@",
        normalizedTag: "alice"
      })
    );

    expect(result.current.activeTagFilters).toEqual([]);
    expect(result.current.libraryView).toBe("all");
    expect(result.current.state).toMatchObject({
      selectedId: "child",
      zoomRootId: "root"
    });
    expect(result.current.locallyExpandedNodeIds).toEqual(new Set(["root"]));
    expect(loadWorkspace).toHaveBeenLastCalledWith("/vault", { kind: "active" });
  });

  it("restores an unzoomed library location instead of treating null as a missing node", async () => {
    const active = workspace([
      node({ id: "root", title: "Root" }),
      node({ id: "other", sortKey: 2, title: "Other" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "tags" ? workspace([node({ id: "root" })]) : active
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.state).toMatchObject({
      selectedId: null,
      zoomRootId: null
    });

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );

    expect(result.current.state).toMatchObject({
      selectedId: null,
      zoomRootId: null
    });
  });

  it("keeps an active filtered Tags view stable when its selected library control is clicked", async () => {
    const filtered = workspace([node({ id: "tagged", title: "Tagged" })]);
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "tags" ? filtered : workspace([node({ id: "root" })])
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    await act(async () => result.current.actions.selectLibraryView("tags"));

    expect(result.current.activeTagFilters).toEqual([
      { prefix: "#", normalizedTag: "work" }
    ]);
    expect(result.current.state.nodesById.tagged).toBeDefined();
    expect(result.current.state.rootIds).toEqual(["tagged"]);
  });

  it("reports a failed first tag request only through bottom-bar feedback", async () => {
    const active = workspace([node({ id: "root" })]);
    const filtered = workspace([node({ id: "tagged" })]);
    const loadWorkspace = vi
      .fn()
      .mockResolvedValueOnce(active)
      .mockRejectedValueOnce(new Error("filter failed"))
      .mockResolvedValueOnce(filtered);
    const store = repository({ loadWorkspace });
    const publishFeedback = vi.fn();
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        publishFeedback
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    expect(result.current.activeTagFilters).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(publishFeedback).toHaveBeenCalledWith({
      kind: "error",
      message: "Notes navigation failed: filter failed"
    });

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );

    expect(result.current.activeTagFilters).toEqual([
      { prefix: "#", normalizedTag: "work" }
    ]);
    expect(result.current.state.nodesById.tagged).toBeDefined();
    expect(loadWorkspace).toHaveBeenLastCalledWith("/vault", {
      kind: "tags",
      tags: [{ prefix: "#", normalizedTag: "work" }]
    });
  });

  it("keeps a tag filter inactive when its counted summary refresh fails", async () => {
    const active = workspace([node({ id: "root" })]);
    const filtered = workspace([node({ id: "tagged" })]);
    const work = { prefix: "#" as const, normalizedTag: "work" };
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "tags" ? filtered : active
      ),
      listTagsWithCounts: vi
        .fn()
        .mockRejectedValueOnce(new Error("count failed"))
        .mockResolvedValueOnce([
          { ...work, displayTag: "Work", count: 1 }
        ])
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
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    try {
      await waitFor(() => expect(result.current.status).toBe("ready"));

      await act(async () => result.current.actions.toggleTagFilter(work));

      expect(result.current.activeTagFilters).toEqual([]);
      expect(result.current.libraryView).toBe("all");
      expect(result.current.state.nodesById.root).toBeDefined();
      expect(result.current.state.nodesById.tagged).toBeUndefined();
      expect(sessions.at(-1)!.history.next("undo")).toBeNull();

      await act(async () => result.current.actions.toggleTagFilter(work));
      expect(sessions.at(-1)!.history.next("undo")).toMatchObject({
        kind: "navigation",
        after: {
          tagFilterOrigin: {
            scope: { kind: "active" },
            libraryView: "all"
          }
        }
      });
    } finally {
      openSession.mockRestore();
    }
  });

  it("refreshes tag counts and the filtered result after a local title save removes the sole tag", async () => {
    let current = node({ id: "root", title: "#Work" });
    const countedTags = () =>
      current.title.includes("#Work")
        ? [
            {
              prefix: "#" as const,
              normalizedTag: "work",
              displayTag: "Work",
              count: 1
            }
          ]
        : [];
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "tags" && !current.title.includes("#Work")
          ? workspace([])
          : workspace([current])
      ),
      updateNode: vi.fn(async (_vaultRoot, input) => {
        current = { ...current, title: input.title, note: input.note };
        return workspace([current]);
      }),
      listTagsWithCounts: vi.fn(async () => countedTags())
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("tags"));
    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    expect(result.current.tagSummaries).toEqual(countedTags());

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "No tag",
        note: ""
      , imageOffsetUtf16: 0});
    });
    await act(async () => result.current.actions.flushNodeDraft("root"));

    await waitFor(() => expect(result.current.state.rootIds).toEqual([]));
    expect(result.current.tagSummaries).toEqual([]);
  });

  it("refreshes a filtered sibling's tag count and result after the editor removes the sole tag", async () => {
    let current = node({ id: "root", title: "#Work" });
    const countedTags = () =>
      current.title.includes("#Work")
        ? [
            {
              prefix: "#" as const,
              normalizedTag: "work",
              displayTag: "Work",
              count: 1
            }
          ]
        : [];
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "tags" && !current.title.includes("#Work")
          ? workspace([])
          : workspace([current])
      ),
      updateNode: vi.fn(async (_vaultRoot, input) => {
        current = { ...current, title: input.title, note: input.note };
        return workspace([current]);
      }),
      listTagsWithCounts: vi.fn(async () => countedTags())
    });
    const viewer = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-tags", repository: store })
    );
    await waitFor(() => expect(viewer.result.current.status).toBe("ready"));
    await act(async () =>
      viewer.result.current.actions.selectLibraryView("tags")
    );
    await act(async () =>
      viewer.result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    const editor = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-tags", repository: store })
    );
    await waitFor(() => expect(editor.result.current.status).toBe("ready"));

    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "No tag",
        note: ""
      , imageOffsetUtf16: 0});
    });
    await act(async () => editor.result.current.actions.flushNodeDraft("root"));

    await waitFor(() => expect(viewer.result.current.state.rootIds).toEqual([]));
    expect(viewer.result.current.tagSummaries).toEqual([]);
  });

  it("coalesces tag count invalidations and ignores a stale response", async () => {
    let current = node({ id: "root", title: "#Work" });
    const staleCounts = deferred<
      Array<{
        prefix: "#";
        normalizedTag: string;
        displayTag: string;
        count: number;
      }>
    >();
    const latestCounts = deferred<[]>();
    const listTagsWithCounts = vi.fn().mockResolvedValue([
      {
        prefix: "#",
        normalizedTag: "work",
        displayTag: "Work",
        count: 1
      }
    ]);
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "tags" && !current.title.includes("#Work")
          ? workspace([])
          : workspace([current])
      ),
      updateNode: vi.fn(async (_vaultRoot, input) => {
        current = { ...current, title: input.title, note: input.note };
        return workspace([current]);
      }),
      listTagsWithCounts
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("tags"));
    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    listTagsWithCounts.mockReset();
    listTagsWithCounts
      .mockReturnValueOnce(staleCounts.promise)
      .mockReturnValueOnce(latestCounts.promise);

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "Still #Work",
        note: ""
      , imageOffsetUtf16: 0});
    });
    await act(async () => result.current.actions.flushNodeDraft("root"));
    await waitFor(() => expect(listTagsWithCounts).toHaveBeenCalledOnce());

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "No tag",
        note: ""
      , imageOffsetUtf16: 0});
    });
    await act(async () => result.current.actions.flushNodeDraft("root"));
    await act(async () => staleCounts.resolve([
      {
        prefix: "#",
        normalizedTag: "work",
        displayTag: "Work stale",
        count: 99
      }
    ]));

    await waitFor(() => expect(listTagsWithCounts).toHaveBeenCalledTimes(2));
    expect(result.current.tagSummaries).toEqual([
      {
        prefix: "#",
        normalizedTag: "work",
        displayTag: "Work",
        count: 1
      }
    ]);

    await act(async () => latestCounts.resolve([]));
    await waitFor(() => expect(result.current.tagSummaries).toEqual([]));
  });

  it("restores tag filters and their prior live location through Undo snapshots", async () => {
    const active = workspace([
      node({ id: "root", title: "Root", isCollapsed: true }),
      node({ id: "child", parentId: "root", title: "Child" }),
      node({ id: "other", sortKey: 2, title: "Other" })
    ]);
    const filtered = workspace([
      node({ id: "root", title: "Root", isCollapsed: true }),
      node({ id: "child", parentId: "root", title: "Child" })
    ]);
    let replayedEntryId: string | null = null;
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) =>
      mutationResult(active, context)
    );
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "tags" ? filtered : active
      ),
      toggleStar,
      prepareNavigation: vi.fn(async (_vaultRoot, input) =>
        syntheticHistoryStatus(input.sessionId)
      ),
      undo: vi.fn().mockImplementation(async () =>
          appliedReplay(active, replayedEntryId, "undo")
        )
    });
    let openedSession: NotesWorkspaceCoordinatorSession | null = null;
    const realOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        openedSession = realOpenSession(options);
        return openedSession;
      });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    openSession.mockRestore();
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.actions.zoomTo("other");
      await result.current.actions.focusNode("other");
      await result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      });
      await result.current.actions.zoomTo("root");
      await result.current.actions.focusNode("child");
      await result.current.actions.toggleStar("child");
    });
    replayedEntryId = toggleStar.mock.calls[0]?.[2]?.entryId ?? null;
    expect(result.current.activeTagFilters).toEqual([
      { prefix: "#", normalizedTag: "work" }
    ]);
    expect(openedSession!.history.next("undo")).toMatchObject({
      kind: "mutation",
      after: {
        scope: { kind: "tags" },
        tagFilterOrigin: {
          selectedId: "other",
          zoomRootId: "other"
        }
      }
    });

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    expect(openedSession!.history.next("undo")).toMatchObject({
      kind: "navigation",
      after: {
        scope: { kind: "active" },
        selectedId: "other",
        zoomRootId: "other",
        tagFilterOrigin: null
      }
    });
    expect(result.current.state).toMatchObject({
      selectedId: "other",
      zoomRootId: "other"
    });

    await act(async () => result.current.actions.undo?.());
    expect(result.current.activeTagFilters).toEqual([
      { prefix: "#", normalizedTag: "work" }
    ]);
    expect(result.current.state).toMatchObject({
      selectedId: "child",
      zoomRootId: "root"
    });

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    expect(result.current.state).toMatchObject({
      selectedId: "other",
      zoomRootId: "other"
    });
  });
});
