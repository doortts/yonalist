import { act, render, renderHook, waitFor } from "@testing-library/react";
import {
  StrictMode,
  Suspense,
  useEffect,
  useLayoutEffect,
  type PropsWithChildren
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isNotesMutationResult,
  MAX_NOTE_ATTACHMENT_BATCH_BYTES,
  MAX_NOTE_ATTACHMENT_BYTES,
  MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS,
  type ImportImageNodeBytesInput,
  type NoteAttachment,
  type NoteNode,
  type NotesHistoryContext,
  type NotesHistoryReplayOutcome,
  type NotesHistoryState,
  type NotesMutationResponse,
  type NotesMutationResult,
  type NotesStore,
  type NotesWorkspace,
  type NotesWorkspaceScope,
  type PendingImageNodeByteItem
} from "../../domain/notes";
import {
  focusedUiUpdate,
  isNotesDraftsFlushFailedError,
  NOTES_DRAFTS_FLUSH_FAILED_CODE,
  resetImageImportRecoveryForTests,
  scopedActiveDelta,
  unwrapNotesMutation,
  useNotesWorkspace,
  type NotesDeleteAllResult,
  type NotesWorkspaceActions,
  type UseNotesWorkspaceResult
} from "./useNotesWorkspace";
import { setNotesDeltaVerificationEnabled } from "./notesWorkspaceReducer";
import type { NotesAttachmentUiBoundary } from "./notesAttachmentController";
import { deriveNotesSelectionActionSnapshot } from "./notesSelectionActions";
import {
  notesWorkspaceCoordinatorRegistry,
  type NotesWorkspaceCoordinatorSession
} from "./notesWorkspaceCoordinator";
import { createNotesSelectionCommandRouter } from "./useNotesSelectionCommandRouter";
import {
  notesExpansionSnapshotPool,
  type NotesHistorySession,
  type NotesHistorySnapshot
} from "./notesHistory";

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
    moveNode: empty,
    applyBatch: empty,
    importSubtree: empty,
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
  it("opens a writable presentation session with a complete ref-backed location", async () => {
    const store = repository();
    const realOpenSession =
      notesWorkspaceCoordinatorRegistry.openSession.bind(
        notesWorkspaceCoordinatorRegistry
      );
    let openedOptions: Parameters<
      typeof notesWorkspaceCoordinatorRegistry.openSession
    >[0] | null = null;
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        openedOptions = options;
        return realOpenSession(options);
      });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/presentation-options", repository: store })
    );

    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      expect(openedOptions).toEqual(
        expect.objectContaining({
          presentation: "writable",
          captureHistoryLocation: expect.any(Function),
          applyHistoryLocation: expect.any(Function)
        })
      );
      const captured = openedOptions!.captureHistoryLocation!();
      expect(captured).toMatchObject({
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        expansion: { nodeIds: [] },
        tagFilterOrigin: null
      });
      expect("locallyExpandedNodeIds" in captured).toBe(false);
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

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

  it("imports picker paths in order with all IDs allocated in one repository call", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const firstNodeId = "10000000-0000-4000-8000-000000000001";
    const firstAttachmentId = "10000000-0000-4000-8000-000000000002";
    const secondNodeId = "10000000-0000-4000-8000-000000000003";
    const secondAttachmentId = "10000000-0000-4000-8000-000000000004";
    createNoteIdMock
      .mockReturnValueOnce(firstNodeId)
      .mockReturnValueOnce(firstAttachmentId)
      .mockReturnValueOnce(secondNodeId)
      .mockReturnValueOnce(secondAttachmentId);
    const firstImage = node({
      id: firstNodeId,
      nodeKind: "image",
      sortKey: 2048,
      title: "one.png"
    });
    const secondImage = node({
      id: secondNodeId,
      nodeKind: "image",
      sortKey: 3072,
      title: "two.webp"
    });
    const importedAttachments = {
      [firstNodeId]: [
        attachment({
          id: firstAttachmentId,
          nodeId: firstNodeId,
          originalName: "one.png"
        })
      ],
      [secondNodeId]: [
        attachment({
          id: secondAttachmentId,
          nodeId: secondNodeId,
          originalName: "two.webp",
          contentHash: "b".repeat(64),
          relativePath: `notes-assets/${"b".repeat(64)}.webp`,
          mimeType: "image/webp"
        })
      ]
    };
    const openImageFiles = vi
      .fn()
      .mockResolvedValue(["/incoming/one.png", "/incoming/two.webp"]);
    const importImageNodePaths = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => {
        expect(createNoteIdMock).toHaveBeenCalledTimes(4);
        return {
          workspace: {
            nodes: [root, firstImage, secondImage],
            attachmentsByNodeId: importedAttachments
          },
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [firstNodeId, secondNodeId]
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue({
        nodes: [root],
        attachmentsByNodeId: {}
      }),
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
    await act(async () => result.current.actions.uploadImage!(root.id));

    expect(openImageFiles).toHaveBeenCalledOnce();
    expect(importImageNodePaths).toHaveBeenCalledWith(
      "/vault",
      {
        parentId: null,
        afterId: root.id,
        items: [
          {
            nodeId: firstNodeId,
            attachmentId: firstAttachmentId,
            sourcePath: "/incoming/one.png"
          },
          {
            nodeId: secondNodeId,
            attachmentId: secondAttachmentId,
            sourcePath: "/incoming/two.webp"
          }
        ],
        initialMaxDisplayWidth: 480
      },
      historyContext("attachment-import")
    );
    expect(importImageNodePaths).toHaveBeenCalledTimes(1);
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
    expect(result.current.state.attachmentsByNodeId[firstNodeId]).toEqual(
      importedAttachments[firstNodeId]
    );
    expect(result.current.state.selectedId).toBe(firstNodeId);
    expect(result.current.state.pendingFocusId).toBe(firstNodeId);
  });

  it("undoes and redoes a two-image-node import as one ordered history entry", async () => {
    const root = node({ id: "root" });
    const firstNodeId = "11000000-0000-4000-8000-000000000001";
    const firstAttachmentId = "11000000-0000-4000-8000-000000000002";
    const secondNodeId = "11000000-0000-4000-8000-000000000003";
    const secondAttachmentId = "11000000-0000-4000-8000-000000000004";
    createNoteIdMock
      .mockReturnValueOnce(firstNodeId)
      .mockReturnValueOnce(firstAttachmentId)
      .mockReturnValueOnce(secondNodeId)
      .mockReturnValueOnce(secondAttachmentId);
    const firstImage = node({
      id: firstNodeId,
      nodeKind: "image",
      sortKey: 2048,
      title: "one.png"
    });
    const secondImage = node({
      id: secondNodeId,
      nodeKind: "image",
      sortKey: 3072,
      title: "two.webp"
    });
    const firstImageAttachment = attachment({
      id: firstAttachmentId,
      nodeId: firstNodeId,
      originalName: "one.png"
    });
    const secondImageAttachment = attachment({
      id: secondAttachmentId,
      nodeId: secondNodeId,
      originalName: "two.webp",
      contentHash: "b".repeat(64),
      relativePath: `notes-assets/${"b".repeat(64)}.webp`,
      mimeType: "image/webp"
    });
    const initialWorkspace: NotesWorkspace = {
      nodes: [root],
      attachmentsByNodeId: {}
    };
    const importedWorkspace: NotesWorkspace = {
      nodes: [root, firstImage, secondImage],
      attachmentsByNodeId: {
        [firstNodeId]: [firstImageAttachment],
        [secondNodeId]: [secondImageAttachment]
      }
    };
    let importedEntryId: string | null = null;
    const importImageNodePaths = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => {
        importedEntryId = context?.entryId ?? null;
        return {
          workspace: importedWorkspace,
          historyEntryId: importedEntryId,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [firstNodeId, secondNodeId]
        };
      }
    );
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initialWorkspace,
      replayedEntryId: importedEntryId,
      ...historyState(),
      kind: "applied" as const,
      canUndo: false,
      canRedo: true
    }));
    const redo = vi.fn().mockImplementation(async () => ({
      workspace: importedWorkspace,
      replayedEntryId: importedEntryId,
      ...historyState(),
      kind: "applied" as const,
      canUndo: true,
      canRedo: false
    }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initialWorkspace),
      importImageNodePaths,
      undo,
      redo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    await act(async () =>
      result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/one.png",
        "/incoming/two.webp"
      ])
    );

    const importContext = importImageNodePaths.mock.calls[0]?.[2];
    expect(importImageNodePaths).toHaveBeenCalledOnce();
    expect(importImageNodePaths).toHaveBeenCalledWith(
      "/vault",
      {
        parentId: null,
        afterId: root.id,
        items: [
          {
            nodeId: firstNodeId,
            attachmentId: firstAttachmentId,
            sourcePath: "/incoming/one.png"
          },
          {
            nodeId: secondNodeId,
            attachmentId: secondAttachmentId,
            sourcePath: "/incoming/two.webp"
          }
        ],
        initialMaxDisplayWidth: 480
      },
      importContext
    );
    expect(importContext).toEqual(historyContext("attachment-import"));
    expect(importedEntryId).toBe(importContext?.entryId);
    expect(notesHistorySpies.acceptMutationResult).toHaveBeenCalledOnce();
    expect(notesHistorySpies.acceptMutationResult).toHaveBeenCalledWith(
      importContext?.entryId,
      expect.objectContaining({
        selectedId: firstNodeId,
        focus: { nodeId: firstNodeId, field: "title" }
      }),
      expect.objectContaining({ nextUndoEntryId: importContext?.entryId })
    );
    expect(result.current.state.rootIds).toEqual([
      root.id,
      firstNodeId,
      secondNodeId
    ]);
    expect(result.current.state).toMatchObject({
      selectedId: firstNodeId,
      editingNoteId: firstNodeId,
      pendingFocusId: firstNodeId,
      pendingFocusField: "title"
    });

    await act(async () => result.current.actions.undo!());

    expect(undo).toHaveBeenCalledOnce();
    expect(undo).toHaveBeenCalledWith(
      "/vault", {
      sessionId:
      importContext?.sessionId,
      historyEpoch: "epoch-a",
      expectedEntryId: importContext?.entryId,
      scope:
      { kind: "active" } }
    );
    expect(result.current.state.rootIds).toEqual([root.id]);
    expect(result.current.state.nodesById[firstNodeId]).toBeUndefined();
    expect(result.current.state.nodesById[secondNodeId]).toBeUndefined();
    expect(result.current.state).toMatchObject({
      selectedId: null,
      editingNoteId: null,
      pendingFocusId: null,
      pendingFocusField: null
    });

    await act(async () => result.current.actions.redo!());

    expect(redo).toHaveBeenCalledOnce();
    expect(redo).toHaveBeenCalledWith(
      "/vault", {
      sessionId:
      importContext?.sessionId,
      historyEpoch: "epoch-a",
      expectedEntryId: importContext?.entryId,
      scope:
      { kind: "active" } }
    );
    expect(result.current.state.rootIds).toEqual([
      root.id,
      firstNodeId,
      secondNodeId
    ]);
    expect(result.current.state.attachmentsByNodeId[firstNodeId]).toEqual([
      firstImageAttachment
    ]);
    expect(result.current.state.attachmentsByNodeId[secondNodeId]).toEqual([
      secondImageAttachment
    ]);
    expect(result.current.state).toMatchObject({
      selectedId: firstNodeId,
      editingNoteId: firstNodeId,
      pendingFocusId: firstNodeId,
      pendingFocusField: "title"
    });
  });

  it("preserves direct drop path order and delegates unsupported paths to the repository", async () => {
    const ids = [
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      "20000000-0000-4000-8000-000000000003",
      "20000000-0000-4000-8000-000000000004"
    ];
    createNoteIdMock
      .mockReturnValueOnce(ids[0])
      .mockReturnValueOnce(ids[1])
      .mockReturnValueOnce(ids[2])
      .mockReturnValueOnce(ids[3]);
    const importImageNodePaths = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => ({
        workspace: workspace([node({ id: "root" })]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [ids[0], ids[2]]
      })
    );
    const store = repository({ importImageNodePaths });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(360));
    await act(async () =>
      result.current.actions.importDroppedImagePaths!("root", [
        "/incoming/vector.svg",
        "/incoming/no-extension"
      ])
    );

    expect(importImageNodePaths).toHaveBeenCalledWith(
      "/vault",
      {
        parentId: null,
        afterId: "root",
        items: [
          {
            nodeId: ids[0],
            attachmentId: ids[1],
            sourcePath: "/incoming/vector.svg"
          },
          {
            nodeId: ids[2],
            attachmentId: ids[3],
            sourcePath: "/incoming/no-extension"
          }
        ],
        initialMaxDisplayWidth: 360
      },
      historyContext("attachment-import")
    );
    expect(importImageNodePaths).toHaveBeenCalledTimes(1);
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
  });

  it("uses the zoomed page header target as a first-child image-node anchor", async () => {
    const root = node({ id: "root" });
    createNoteIdMock
      .mockReturnValueOnce("21000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("21000000-0000-4000-8000-000000000002");
    const importImageNodePaths = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => ({
        workspace: workspace([root]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: ["21000000-0000-4000-8000-000000000001"]
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([root])),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.zoomTo(root.id));
    await waitFor(() => expect(result.current.state.zoomRootId).toBe(root.id));
    act(() => result.current.actions.setImageImportMaxDisplayWidth(360));
    await act(async () =>
      result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/header.png"
      ])
    );

    expect(importImageNodePaths).toHaveBeenCalledWith(
      "/vault",
      expect.objectContaining({
        parentId: root.id,
        afterId: null,
        items: [
          expect.objectContaining({
            nodeId: "21000000-0000-4000-8000-000000000001",
            attachmentId: "21000000-0000-4000-8000-000000000002",
            sourcePath: "/incoming/header.png"
          })
        ]
      }),
      historyContext("attachment-import")
    );
  });

  it("rejects a stale image target before allocating IDs or calling either import API", async () => {
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(360));
    await act(async () =>
      result.current.actions.importDroppedImagePaths!("missing", [
        "/incoming/missing.png"
      ])
    );

    expect(createNoteIdMock).not.toHaveBeenCalled();
    expect(store.importImageNodePaths).not.toHaveBeenCalled();
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
  });

  it("does not retarget a picker import when the target moves while the picker is open", async () => {
    const parentA = node({ id: "parent-a", sortKey: 1 });
    const parentB = node({ id: "parent-b", sortKey: 2 });
    const target = node({ id: "target", parentId: parentA.id, sortKey: 1 });
    const movedTarget = { ...target, parentId: parentB.id };
    const picker = deferred<readonly string[] | null>();
    const importImageNodePaths = vi.fn().mockResolvedValue(
      workspace([parentA, parentB, movedTarget])
    );
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([parentA, parentB, target])),
      moveNode: vi
        .fn()
        .mockResolvedValue(workspace([parentA, parentB, movedTarget])),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: mockAttachmentUi(vi.fn().mockReturnValue(picker.promise))
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(360));
    const upload = result.current.actions.uploadImage!(target.id);
    await waitFor(() =>
      expect(
        result.current.actionsSlice?.actions.uploadImage
      ).toBeTypeOf("function")
    );
    await act(async () => {
      await result.current.actions.moveNode({
        id: target.id,
        parentId: parentB.id,
        afterId: null
      });
    });
    await waitFor(() =>
      expect(result.current.state.nodesById[target.id]?.parentId).toBe(
        parentB.id
      )
    );

    await act(async () => {
      picker.resolve(["/incoming/race.png"]);
      await upload;
    });

    expect(importImageNodePaths).not.toHaveBeenCalled();
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
    expect(createNoteIdMock).not.toHaveBeenCalled();
  });

  it("discards provisional history when a queued image-node attempt finds a stale anchor", async () => {
    const parentA = node({ id: "parent-a", sortKey: 1 });
    const parentB = node({ id: "parent-b", sortKey: 2 });
    const target = node({ id: "target", parentId: parentA.id, sortKey: 1 });
    const movedTarget = { ...target, parentId: parentB.id };
    const move = deferred<NotesMutationResult>();
    createNoteIdMock
      .mockReturnValueOnce("22000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("22000000-0000-4000-8000-000000000002");
    const importImageNodePaths = vi.fn().mockResolvedValue(
      workspace([parentA, parentB, movedTarget])
    );
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([parentA, parentB, target])),
      moveNode: vi.fn().mockReturnValue(move.promise),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(360));
    const moveCompletion = result.current.actions.moveNode({
      id: target.id,
      parentId: parentB.id,
      afterId: null
    });
    await waitFor(() => expect(store.moveNode).toHaveBeenCalledOnce());
    const dropCompletion = result.current.actions.importDroppedImagePaths!(
      target.id,
      ["/incoming/stale.png"]
    );

    move.resolve({
      workspace: workspace([parentA, parentB, movedTarget]),
      historyEntryId: vi.mocked(store.moveNode).mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    await act(async () => {
      await moveCompletion;
      await dropCompletion;
    });

    expect(importImageNodePaths).not.toHaveBeenCalled();
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
    expect(createNoteIdMock).toHaveBeenCalledTimes(2);
    expect(notesHistorySpies.discard).toHaveBeenCalledTimes(1);
    expect(notesHistorySpies.acceptMutationResult).toHaveBeenCalledTimes(1);
  });

  it("cleans an initial image attempt when the draft barrier skips before import work", async () => {
    createNoteIdMock
      .mockReturnValueOnce("23000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("23000000-0000-4000-8000-000000000002");
    const importImageNodePaths = vi.fn();
    const updateNode = vi.fn().mockRejectedValue(new Error("save failed"));
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "root", title: "Root" })])),
      updateNode,
      importImageNodePaths
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    act(() => {
      rendered.result.current.actions.setImageImportMaxDisplayWidth(360);
      rendered.result.current.actions.updateNodeDraft("root", {
        title: "Unsaved root",
        note: ""
      });
    });
    await act(async () =>
      rendered.result.current.actions.importDroppedImagePaths!("root", [
        "/incoming/skipped.png"
      ])
    );

    expect(updateNode).toHaveBeenCalledOnce();
    expect(importImageNodePaths).not.toHaveBeenCalled();
    expect(
      rendered.result.current.attachmentUploadErrorsByNodeId?.root
    ).toBeUndefined();
    expect(
      rendered.result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
    ).toBeUndefined();
    const discardedEntryIds = notesHistorySpies.discard.mock.calls.map(
      ([entryId]) => entryId
    );
    expect(discardedEntryIds).toHaveLength(2);
    expect(new Set(discardedEntryIds).size).toBe(2);

    rendered.unmount();
    await act(async () => Promise.resolve());
    for (const entryId of discardedEntryIds) {
      expect(
        notesHistorySpies.discard.mock.calls.filter(
          ([discardedEntryId]) => discardedEntryId === entryId
        )
      ).toHaveLength(1);
    }
  });

  it("keeps an unknown retry when the draft barrier skips before native retry work", async () => {
    createNoteIdMock
      .mockReturnValueOnce("24000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("24000000-0000-4000-8000-000000000002");
    const importImageNodePaths = vi
      .fn()
      .mockRejectedValue(new Error("disk full"));
    const updateNode = vi.fn().mockRejectedValue(new Error("save failed"));
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "root", title: "Root" })])),
      updateNode,
      importImageNodePaths
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    act(() =>
      rendered.result.current.actions.setImageImportMaxDisplayWidth(360)
    );
    await act(async () =>
      rendered.result.current.actions.importDroppedImagePaths!("root", [
        "/incoming/retry.png"
      ])
    );
    const retryAttemptId =
      rendered.result.current.attachmentUploadRetryAttemptIdsByNodeId?.root;
    const importHistoryEntryId = importImageNodePaths.mock.calls[0]?.[2]?.entryId;
    expect(retryAttemptId).toBeDefined();
    expect(importHistoryEntryId).toBeDefined();
    expect(notesHistorySpies.discard).not.toHaveBeenCalledWith(
      importHistoryEntryId
    );

    act(() =>
      rendered.result.current.actions.updateNodeDraft("root", {
        title: "Unsaved before retry",
        note: ""
      })
    );
    await act(async () =>
      rendered.result.current.actions.retryImageUpload!(
        "root",
        retryAttemptId
      )
    );

    expect(updateNode).toHaveBeenCalledOnce();
    expect(importImageNodePaths).toHaveBeenCalledTimes(1);
    expect(
      rendered.result.current.attachmentUploadErrorsByNodeId?.root
    ).toBe("Image upload failed: disk full");
    expect(
      rendered.result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
    ).toBe(retryAttemptId);
    expect(
      notesHistorySpies.discard.mock.calls.filter(
        ([entryId]) => entryId === importHistoryEntryId
      )
    ).toHaveLength(0);

    rendered.unmount();
    await act(async () => Promise.resolve());
    expect(
      notesHistorySpies.discard.mock.calls.filter(
        ([entryId]) => entryId === importHistoryEntryId
      )
    ).toHaveLength(0);
  });

  it("cleans an image attempt when the coordinator rejects before running work", async () => {
    createNoteIdMock
      .mockReturnValueOnce("25000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("25000000-0000-4000-8000-000000000002");
    const importImageNodePaths = vi.fn();
    const store = repository({ importImageNodePaths });
    const realOpenSession =
      notesWorkspaceCoordinatorRegistry.openSession.bind(
        notesWorkspaceCoordinatorRegistry
      );
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        return {
          ...session,
          enqueueStructural: vi
            .fn()
            .mockRejectedValue(new Error("coordinator aborted"))
        };
      });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );

    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      act(() =>
        rendered.result.current.actions.setImageImportMaxDisplayWidth(360)
      );

      await act(async () =>
        rendered.result.current.actions.importDroppedImagePaths!("root", [
          "/incoming/aborted.png"
        ])
      );

      expect(importImageNodePaths).not.toHaveBeenCalled();
      expect(
        rendered.result.current.attachmentUploadErrorsByNodeId?.root
      ).toBeUndefined();
      expect(
        rendered.result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
      ).toBeUndefined();
      expect(notesHistorySpies.discard).toHaveBeenCalledTimes(1);
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it.each([
    ["unsupported-only", ["/incoming/vector.svg"]],
    ["mixed", ["/incoming/photo.png", "/incoming/vector.svg"]]
  ] as const)(
    "keeps an atomic %s native path failure to one repository call and one UI error",
    async (_name, paths) => {
      const root = node({
        id: "root",
        nodeKind: "image",
        title: "target.png",
        isCollapsed: true
      });
      createNoteIdMock.mockImplementation(
        () => `drop-${createNoteIdMock.mock.calls.length}`
      );
      const importImageNodePaths = vi
        .fn()
        .mockRejectedValue(new Error("vector.svg is unsupported"));
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(workspace([root])),
        importImageNodePaths
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({ vaultRoot: "/vault", repository: store })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
      const input = document.createElement("textarea");
      input.value = "abcdef";
      document.body.append(input);
      input.focus();
      input.setSelectionRange(2, 5);

      await act(async () =>
        result.current.actions.importDroppedImagePaths!(root.id, paths)
      );

      expect(importImageNodePaths).toHaveBeenCalledTimes(1);
      expect(store.importAttachmentPaths).not.toHaveBeenCalled();
      expect(result.current.attachmentUploadErrorsByNodeId).toEqual({
        [root.id]: "Image upload failed: vector.svg is unsupported"
      });
      expect(result.current.state.attachmentsByNodeId[root.id] ?? []).toEqual([]);
      expect(result.current.state.nodesById[root.id].isCollapsed).toBe(true);
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(2);
      expect(input.selectionEnd).toBe(5);
      input.remove();
    }
  );

  it("imports clipboard blobs in order through one byte batch call", async () => {
    const ids = [
      "30000000-0000-4000-8000-000000000001",
      "30000000-0000-4000-8000-000000000002",
      "30000000-0000-4000-8000-000000000003",
      "30000000-0000-4000-8000-000000000004"
    ];
    createNoteIdMock
      .mockReturnValueOnce(ids[0])
      .mockReturnValueOnce(ids[1])
      .mockReturnValueOnce(ids[2])
      .mockReturnValueOnce(ids[3]);
    const firstBlob = new Blob([new Uint8Array([1, 2])], { type: "image/png" });
    const secondBlob = new Blob([new Uint8Array([3])], { type: "image/webp" });
    const items: readonly PendingImageNodeByteItem[] = [
      { originalName: "one.png", mimeType: "image/png", blob: firstBlob },
      { originalName: "two.webp", mimeType: "image/webp", blob: secondBlob }
    ];
    const importImageNodeBytes = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => ({
        workspace: workspace([node({ id: "root" })]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [ids[0], ids[2]]
      })
    );
    const store = repository({ importImageNodeBytes });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(420));
    await act(async () =>
      result.current.actions.importClipboardImages!("root", items)
    );

    expect(importImageNodeBytes).toHaveBeenCalledWith(
      "/vault",
      {
        parentId: null,
        afterId: "root",
        items: [
          { nodeId: ids[0], attachmentId: ids[1], ...items[0] },
          { nodeId: ids[2], attachmentId: ids[3], ...items[1] }
        ],
        initialMaxDisplayWidth: 420
      },
      historyContext("attachment-import")
    );
    expect(importImageNodeBytes).toHaveBeenCalledTimes(1);
    expect(store.importAttachmentBytes).not.toHaveBeenCalled();
  });

  it.each([
    [
      "item count",
      () =>
        pendingImageBatch(
          "count",
          Array.from(
            { length: MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS + 1 },
            () => 1
          )
        )
    ],
    [
      "per-file bytes",
      () => pendingImageBatch("file", [MAX_NOTE_ATTACHMENT_BYTES + 1])
    ],
    [
      "aggregate bytes",
      () =>
        pendingImageBatch(
          "aggregate",
          Array.from(
            { length: 4 },
            () => MAX_NOTE_ATTACHMENT_BATCH_BYTES / 4 + 1
          )
        )
    ]
  ] as const)(
    "rejects a clipboard batch with invalid %s before allocating IDs or retaining a retry",
    async (_case, createItems) => {
      createNoteIdMock.mockImplementation(
        () => `invalid-${createNoteIdMock.mock.calls.length}`
      );
      const importImageNodeBytes = vi
        .fn()
        .mockRejectedValue(new Error("invalid batch reached repository"));
      const store = repository({ importImageNodeBytes });
      const { result } = renderHook(() =>
        useNotesWorkspace({ vaultRoot: "/vault", repository: store })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      act(() => result.current.actions.setImageImportMaxDisplayWidth(320));

      await act(async () =>
        result.current.actions.importClipboardImages!("root", createItems())
      );

      expect(createNoteIdMock).not.toHaveBeenCalled();
      expect(importImageNodeBytes).not.toHaveBeenCalled();
      expect(store.importAttachmentBytes).not.toHaveBeenCalled();
      expect(
        result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
      ).toBeUndefined();
    }
  );

  it("rejects cap pressure without evicting unknown clipboard outcomes", async () => {
    const pathTarget = node({ id: "path-target" });
    const oldestByteTarget = node({
      id: "oldest-byte-target",
      sortKey: 2048
    });
    const retainedByteTarget = node({
      id: "retained-byte-target",
      sortKey: 3072
    });
    const newestByteTarget = node({
      id: "newest-byte-target",
      sortKey: 4096
    });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `52000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const importImageNodePaths = vi
      .fn()
      .mockRejectedValue(new Error("path failure"));
    const importImageNodeBytes = vi
      .fn()
      .mockRejectedValue(new Error("byte failure"));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(
        workspace([
          pathTarget,
          oldestByteTarget,
          retainedByteTarget,
          newestByteTarget
        ])
      ),
      importImageNodePaths,
      importImageNodeBytes
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.actions.setImageImportMaxDisplayWidth(320));

    await act(async () =>
      result.current.actions.importDroppedImagePaths!(pathTarget.id, [
        "/incoming/path.png"
      ])
    );
    const pathAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[pathTarget.id];
    await act(async () =>
      result.current.actions.importClipboardImages!(
        oldestByteTarget.id,
        pendingImageBatch("oldest", [
          MAX_NOTE_ATTACHMENT_BYTES,
          MAX_NOTE_ATTACHMENT_BYTES
        ])
      )
    );
    const oldestByteAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        oldestByteTarget.id
      ];
    await act(async () =>
      result.current.actions.importClipboardImages!(
        retainedByteTarget.id,
        pendingImageBatch("retained", [MAX_NOTE_ATTACHMENT_BYTES])
      )
    );
    const retainedByteAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        retainedByteTarget.id
      ];
    await act(async () =>
      result.current.actions.importClipboardImages!(
        newestByteTarget.id,
        pendingImageBatch("newest", [MAX_NOTE_ATTACHMENT_BYTES])
      )
    );

    expect(pathAttemptId).toBeDefined();
    expect(oldestByteAttemptId).toBeDefined();
    expect(retainedByteAttemptId).toBeDefined();
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[pathTarget.id]
    ).toBe(pathAttemptId);
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        oldestByteTarget.id
      ]
    ).toBe(oldestByteAttemptId);
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        retainedByteTarget.id
      ]
    ).toBe(retainedByteAttemptId);
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        newestByteTarget.id
      ]
    ).toBeUndefined();

    await act(async () =>
      result.current.actions.retryImageUpload!(
        oldestByteTarget.id,
        oldestByteAttemptId
      )
    );
    expect(importImageNodeBytes).toHaveBeenCalledTimes(3);
  });

  it("does not retain Blob retries when byte import is unavailable across hooks", async () => {
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `52500000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const store = repository({ importImageNodeBytes: undefined });
    const first = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/unsupported", repository: store })
    );
    const second = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/unsupported", repository: store })
    );
    await waitFor(() => {
      expect(first.result.current.status).toBe("ready");
      expect(second.result.current.status).toBe("ready");
    });
    act(() => {
      first.result.current.actions.setImageImportMaxDisplayWidth(320);
      second.result.current.actions.setImageImportMaxDisplayWidth(320);
    });
    const fullBatchSizes: number[] = [];
    for (
      let remaining = MAX_NOTE_ATTACHMENT_BATCH_BYTES;
      remaining > 0;
      remaining -= MAX_NOTE_ATTACHMENT_BYTES
    ) {
      fullBatchSizes.push(Math.min(remaining, MAX_NOTE_ATTACHMENT_BYTES));
    }

    await act(async () =>
      first.result.current.actions.importClipboardImages!(
        "root",
        pendingImageBatch("unsupported-first", fullBatchSizes)
      )
    );
    await act(async () =>
      second.result.current.actions.importClipboardImages!(
        "root",
        pendingImageBatch("unsupported-second", fullBatchSizes)
      )
    );

    expect(createNoteIdMock).not.toHaveBeenCalled();
    expect(first.result.current.attachmentUploadErrorsByNodeId).toEqual({
      root: "Image upload failed: Image node byte import is unavailable."
    });
    expect(second.result.current.attachmentUploadErrorsByNodeId).toEqual({
      root: "Image upload failed: Image node byte import is unavailable."
    });
    expect(
      first.result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
    ).toBeUndefined();
    expect(
      second.result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
    ).toBeUndefined();

    const importImageNodeBytes = vi.fn(
      async (
        _vaultRoot: string,
        input: ImportImageNodeBytesInput,
        context?: NotesHistoryContext | null
      ): Promise<NotesMutationResult> => ({
        workspace: workspace([
          node({ id: "root" }),
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
    Object.assign(store, { importImageNodeBytes });

    await act(async () =>
      second.result.current.actions.importClipboardImages!(
        "root",
        pendingImageBatch("supported-afterward", fullBatchSizes)
      )
    );

    expect(importImageNodeBytes).toHaveBeenCalledOnce();
  });

  it("keeps pending clipboard bytes and rejects a new cross-node attempt at the global byte budget", async () => {
    const failedTarget = node({ id: "failed-target" });
    const pendingTarget = node({ id: "pending-target" });
    const rejectedTarget = node({ id: "rejected-target", sortKey: 3072 });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `53000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const pendingImport = deferred<NotesMutationResult>();
    const importImageNodeBytes = vi
      .fn()
      .mockRejectedValueOnce(new Error("retained failure"))
      .mockReturnValueOnce(pendingImport.promise)
      .mockRejectedValue(new Error("new attempt was retained"));
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(
          workspace([failedTarget, pendingTarget, rejectedTarget])
        ),
      importImageNodeBytes
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.actions.setImageImportMaxDisplayWidth(320));

    await act(async () =>
      result.current.actions.importClipboardImages!(
        failedTarget.id,
        pendingImageBatch("failed", [
          MAX_NOTE_ATTACHMENT_BATCH_BYTES -
            MAX_NOTE_ATTACHMENT_BYTES * 3
        ])
      )
    );
    const failedAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[failedTarget.id];
    expect(failedAttemptId).toBeDefined();

    let pendingCompletion!: Promise<void>;
    let rejectedCompletion!: Promise<void>;
    act(() => {
      pendingCompletion = result.current.actions.importClipboardImages!(
        pendingTarget.id,
        pendingImageBatch(
          "pending",
          Array.from(
            { length: 3 },
            () => MAX_NOTE_ATTACHMENT_BYTES
          )
        )
      );
    });
    await waitFor(() =>
      expect(importImageNodeBytes).toHaveBeenCalledTimes(2)
    );
    const allocatedForPending = createNoteIdMock.mock.calls.length;
    act(() => {
      rejectedCompletion = result.current.actions.importClipboardImages!(
        rejectedTarget.id,
        pendingImageBatch("rejected", [
          MAX_NOTE_ATTACHMENT_BATCH_BYTES -
            MAX_NOTE_ATTACHMENT_BYTES * 3 +
            1
        ])
      );
    });

    expect(createNoteIdMock).toHaveBeenCalledTimes(allocatedForPending);
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[failedTarget.id]
    ).toBe(failedAttemptId);
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        rejectedTarget.id
      ]
    ).toBeUndefined();

    pendingImport.reject(new Error("pending failure"));
    await act(async () =>
      Promise.all([pendingCompletion, rejectedCompletion])
    );

    expect(importImageNodeBytes).toHaveBeenCalledTimes(2);
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[failedTarget.id]
    ).toBe(failedAttemptId);
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        pendingTarget.id
      ]
    ).toBeDefined();
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        rejectedTarget.id
      ]
    ).toBeUndefined();
  });

  it("counts a started clipboard batch across repeated vault switches until it settles", async () => {
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `54000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    let retainImports = true;
    const pendingImports: ReturnType<typeof deferred<NotesMutationResult>>[] = [];
    const importImageNodeBytes = vi.fn(
      (
        _vaultRoot: string,
        _input: unknown,
        context?: { entryId?: string } | null
      ) => {
        if (retainImports) {
          const pendingImport = deferred<NotesMutationResult>();
          pendingImports.push(pendingImport);
          return pendingImport.promise;
        }
        return Promise.resolve({
          workspace: workspace([node({ id: "root" })]),
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false
        });
      }
    );
    const store = repository({ importImageNodeBytes });
    const rendered = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/vault-a" } }
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    act(() =>
      rendered.result.current.actions.setImageImportMaxDisplayWidth(320)
    );
    const fullBatchSizes: number[] = [];
    for (
      let remaining = MAX_NOTE_ATTACHMENT_BATCH_BYTES;
      remaining > 0;
      remaining -= MAX_NOTE_ATTACHMENT_BYTES
    ) {
      fullBatchSizes.push(Math.min(remaining, MAX_NOTE_ATTACHMENT_BYTES));
    }
    const fullBatch = (prefix: string) =>
      pendingImageBatch(prefix, fullBatchSizes);
    const completions: Promise<void>[] = [];

    act(() => {
      completions.push(
        rendered.result.current.actions.importClipboardImages!(
          "root",
          fullBatch("vault-a")
        )
      );
    });
    await waitFor(() => expect(importImageNodeBytes).toHaveBeenCalledOnce());

    for (const vaultRoot of ["/vault-b", "/vault-c"]) {
      rendered.rerender({ vaultRoot });
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      act(() => {
        completions.push(
          rendered.result.current.actions.importClipboardImages!(
            "root",
            fullBatch(vaultRoot)
          )
        );
      });
    }

    const callsBeforeSettlement = importImageNodeBytes.mock.calls.length;
    const idsBeforeSettlement = createNoteIdMock.mock.calls.length;
    expect(rendered.result.current.attachmentUploadErrorsByNodeId).toEqual({
      root: "Clipboard image retry data exceeds the 64 MiB memory limit."
    });

    retainImports = false;
    for (const [index, pendingImport] of pendingImports.entries()) {
      const context = importImageNodeBytes.mock.calls[index]?.[2];
      pendingImport.resolve({
        workspace: workspace([node({ id: "root" })]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      });
    }
    await act(async () => Promise.all(completions));

    expect(callsBeforeSettlement).toBe(1);
    expect(idsBeforeSettlement).toBe(fullBatchSizes.length * 2);
    expect(rendered.result.current.attachmentUploadErrorsByNodeId).toEqual({
      root: "Clipboard image retry data exceeds the 64 MiB memory limit."
    });

    await act(async () =>
      rendered.result.current.actions.importClipboardImages!(
        "root",
        fullBatch("vault-c-after-settlement")
      )
    );

    expect(importImageNodeBytes).toHaveBeenCalledTimes(2);
    expect(importImageNodeBytes.mock.calls[1]?.[0]).toBe("/vault-c");
    expect(
      rendered.result.current.attachmentUploadErrorsByNodeId?.root
    ).toBeUndefined();
  });

  it("keeps an unstarted clipboard batch accounted until its old-vault structural intent finalizes", async () => {
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `54500000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const draftSave = deferred<NotesWorkspace>();
    const importImageNodeBytes = vi.fn(
      async (
        vaultRoot: string,
        _input: unknown,
        context?: { entryId?: string } | null
      ) => ({
        workspace: workspace([node({ id: "root" })]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [vaultRoot === "/vault-b" ? "imported-b" : "imported-a"]
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
      updateNode: vi.fn().mockReturnValue(draftSave.promise),
      importImageNodeBytes
    });
    const rendered = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/vault-a" } }
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    act(() => {
      rendered.result.current.actions.setImageImportMaxDisplayWidth(320);
      rendered.result.current.actions.updateNodeDraft("root", {
        title: "Unsaved in A",
        note: ""
      });
    });
    const fullBatchSizes: number[] = [];
    for (
      let remaining = MAX_NOTE_ATTACHMENT_BATCH_BYTES;
      remaining > 0;
      remaining -= MAX_NOTE_ATTACHMENT_BYTES
    ) {
      fullBatchSizes.push(Math.min(remaining, MAX_NOTE_ATTACHMENT_BYTES));
    }
    const fullBatch = (prefix: string) =>
      pendingImageBatch(prefix, fullBatchSizes);

    let vaultAImport!: Promise<void>;
    act(() => {
      vaultAImport = rendered.result.current.actions.importClipboardImages!(
        "root",
        fullBatch("vault-a")
      );
    });
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());
    expect(importImageNodeBytes).not.toHaveBeenCalled();

    rendered.rerender({ vaultRoot: "/vault-b" });
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    act(() =>
      rendered.result.current.actions.setImageImportMaxDisplayWidth(320)
    );
    await act(async () =>
      rendered.result.current.actions.importClipboardImages!(
        "root",
        fullBatch("vault-b-before-finalize")
      )
    );

    expect(importImageNodeBytes).not.toHaveBeenCalled();
    expect(rendered.result.current.attachmentUploadErrorsByNodeId).toEqual({
      root: "Clipboard image retry data exceeds the 64 MiB memory limit."
    });
    expect(createNoteIdMock).toHaveBeenCalledTimes(fullBatchSizes.length * 2);

    await act(async () => {
      draftSave.resolve(workspace([node({ id: "root", title: "Saved in A" })]));
      await vaultAImport;
    });
    await act(async () =>
      rendered.result.current.actions.importClipboardImages!(
        "root",
        fullBatch("vault-b-after-finalize")
      )
    );

    expect(importImageNodeBytes).toHaveBeenCalledOnce();
    expect(importImageNodeBytes.mock.calls[0]?.[0]).toBe("/vault-b");
    expect(
      rendered.result.current.attachmentUploadErrorsByNodeId?.root
    ).toBeUndefined();
  });

  it("keeps an unstarted clipboard batch accounted across hook unmount and fresh mount", async () => {
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `54700000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const draftSave = deferred<NotesWorkspace>();
    const importImageNodeBytes = vi.fn(
      async (
        _vaultRoot: string,
        _input: unknown,
        context?: { entryId?: string } | null
      ) => ({
        workspace: workspace([node({ id: "root" })]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
      updateNode: vi.fn().mockReturnValue(draftSave.promise),
      importImageNodeBytes
    });
    const fullBatchSizes: number[] = [];
    for (
      let remaining = MAX_NOTE_ATTACHMENT_BATCH_BYTES;
      remaining > 0;
      remaining -= MAX_NOTE_ATTACHMENT_BYTES
    ) {
      fullBatchSizes.push(Math.min(remaining, MAX_NOTE_ATTACHMENT_BYTES));
    }
    const fullBatch = (prefix: string) =>
      pendingImageBatch(prefix, fullBatchSizes);
    const vaultA = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault-a", repository: store })
    );
    await waitFor(() => expect(vaultA.result.current.status).toBe("ready"));
    act(() => {
      vaultA.result.current.actions.setImageImportMaxDisplayWidth(320);
      vaultA.result.current.actions.updateNodeDraft("root", {
        title: "Unsaved in A",
        note: ""
      });
    });

    let vaultAImport!: Promise<void>;
    act(() => {
      vaultAImport = vaultA.result.current.actions.importClipboardImages!(
        "root",
        fullBatch("vault-a")
      );
    });
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());
    expect(importImageNodeBytes).not.toHaveBeenCalled();

    vaultA.unmount();
    await act(async () => Promise.resolve());
    const vaultB = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault-b", repository: store })
    );
    await waitFor(() => expect(vaultB.result.current.status).toBe("ready"));
    act(() =>
      vaultB.result.current.actions.setImageImportMaxDisplayWidth(320)
    );
    await act(async () =>
      vaultB.result.current.actions.importClipboardImages!(
        "root",
        fullBatch("vault-b-before-finalize")
      )
    );
    const callsBeforeFinalization = importImageNodeBytes.mock.calls.length;
    const idsBeforeFinalization = createNoteIdMock.mock.calls.length;
    const errorBeforeFinalization =
      vaultB.result.current.attachmentUploadErrorsByNodeId?.root;

    await act(async () => {
      draftSave.resolve(workspace([node({ id: "root", title: "Saved in A" })]));
      await vaultAImport;
    });

    expect(callsBeforeFinalization).toBe(0);
    expect(idsBeforeFinalization).toBe(fullBatchSizes.length * 2);
    expect(errorBeforeFinalization).toBe(
      "Clipboard image retry data exceeds the 64 MiB memory limit."
    );

    await act(async () =>
      vaultB.result.current.actions.importClipboardImages!(
        "root",
        fullBatch("vault-b-after-finalize")
      )
    );
    expect(importImageNodeBytes).toHaveBeenCalledOnce();
    expect(importImageNodeBytes.mock.calls[0]?.[0]).toBe("/vault-b");
    expect(
      vaultB.result.current.attachmentUploadErrorsByNodeId?.root
    ).toBeUndefined();
  });

  it("counts queued clipboard batches across vault switches until their closures release", async () => {
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `55000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const firstImport = deferred<NotesMutationResult>();
    const importImageNodeBytes = vi.fn(
      (
        _vaultRoot: string,
        _input: unknown,
        context?: { entryId?: string } | null
      ) => {
        if (importImageNodeBytes.mock.calls.length === 1) {
          return firstImport.promise;
        }
        return Promise.resolve({
          workspace: workspace([node({ id: "root" })]),
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false
        });
      }
    );
    const store = repository({ importImageNodeBytes });
    const rendered = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/vault-a" } }
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    act(() =>
      rendered.result.current.actions.setImageImportMaxDisplayWidth(320)
    );
    const halfBatchSizes: number[] = [];
    for (
      let remaining = MAX_NOTE_ATTACHMENT_BATCH_BYTES / 2;
      remaining > 0;
      remaining -= MAX_NOTE_ATTACHMENT_BYTES
    ) {
      halfBatchSizes.push(Math.min(remaining, MAX_NOTE_ATTACHMENT_BYTES));
    }
    const halfBatch = (prefix: string) =>
      pendingImageBatch(prefix, halfBatchSizes);
    const completions: Promise<void>[] = [];

    act(() => {
      completions.push(
        rendered.result.current.actions.importClipboardImages!(
          "root",
          halfBatch("vault-a-running")
        ),
        rendered.result.current.actions.importClipboardImages!(
          "root",
          halfBatch("vault-a-queued")
        )
      );
    });
    await waitFor(() => expect(importImageNodeBytes).toHaveBeenCalledOnce());
    expect(createNoteIdMock).toHaveBeenCalledTimes(halfBatchSizes.length * 4);

    for (const vaultRoot of ["/vault-b", "/vault-c"]) {
      rendered.rerender({ vaultRoot });
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      act(() => {
        completions.push(
          rendered.result.current.actions.importClipboardImages!(
            "root",
            halfBatch(vaultRoot)
          )
        );
      });
    }

    const idsWhilePending = createNoteIdMock.mock.calls.length;
    const repositoryCallsWhilePending = importImageNodeBytes.mock.calls.length;
    const errorWhilePending =
      rendered.result.current.attachmentUploadErrorsByNodeId?.root;

    const firstContext = importImageNodeBytes.mock.calls[0]?.[2];
    firstImport.resolve({
      workspace: workspace([node({ id: "root" })]),
      historyEntryId: firstContext?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    await act(async () => {
      await Promise.allSettled([firstImport.promise]);
      await Promise.all(completions);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () =>
      rendered.result.current.actions.importClipboardImages!(
        "root",
        halfBatch("vault-c-after-release")
      )
    );
    expect(importImageNodeBytes).toHaveBeenCalledTimes(2);
    expect(importImageNodeBytes.mock.calls[1]?.[0]).toBe("/vault-c");
    expect(createNoteIdMock).toHaveBeenCalledTimes(halfBatchSizes.length * 6);
    expect(idsWhilePending).toBe(halfBatchSizes.length * 4);
    expect(repositoryCallsWhilePending).toBe(1);
    expect(errorWhilePending).toBe(
      "Clipboard image retry data exceeds the 64 MiB memory limit."
    );
  });

  it("retries a lost committed response with the same IDs, context, order, and sources", async () => {
    const root = node({ id: "87384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const ids = [
      "40000000-0000-4000-8000-000000000001",
      "40000000-0000-4000-8000-000000000002",
      "40000000-0000-4000-8000-000000000003",
      "40000000-0000-4000-8000-000000000004"
    ];
    createNoteIdMock
      .mockReturnValueOnce(ids[0])
      .mockReturnValueOnce(ids[1])
      .mockReturnValueOnce(ids[2])
      .mockReturnValueOnce(ids[3]);
    const importedNodes = [
      root,
      node({ id: ids[0], nodeKind: "image", sortKey: 2048 }),
      node({ id: ids[2], nodeKind: "image", sortKey: 3072 })
    ];
    const imported = [ids[1], ids[3]].map((id, index) =>
      attachment({
        id,
        nodeId: importedNodes[index + 1]!.id,
        sortKey: 1024,
        contentHash: String.fromCharCode(97 + index).repeat(64),
        relativePath: `notes-assets/${String.fromCharCode(97 + index).repeat(64)}.png`
      })
    );
    const importImageNodePaths = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost after commit"))
      .mockImplementation(async (_vaultRoot, _input, context) => ({
        workspace: {
          nodes: importedNodes,
          attachmentsByNodeId: {
            [ids[0]]: [imported[0]!],
            [ids[2]]: [imported[1]!]
          }
        },
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [ids[0], ids[2]]
      }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([root])),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    await act(async () =>
      result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/one.png",
        "/incoming/two.webp"
      ])
    );
    const retryAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(retryAttemptId).toBeDefined();

    await act(async () =>
      result.current.actions.retryImageUpload!(root.id, retryAttemptId)
    );

    expect(importImageNodePaths).toHaveBeenCalledTimes(2);
    expect(importImageNodePaths.mock.calls[1]?.[1]).toEqual(
      importImageNodePaths.mock.calls[0]?.[1]
    );
    expect(importImageNodePaths.mock.calls[1]?.[2]).toBe(
      importImageNodePaths.mock.calls[0]?.[2]
    );
    expect(result.current.state.attachmentsByNodeId[ids[0]]).toEqual([
      imported[0]
    ]);
    expect(result.current.attachmentUploadErrorsByNodeId?.[root.id]).toBeUndefined();
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id]
    ).toBeUndefined();
  });

  it("holds a same-anchor byte batch behind an unknown commit until retry reconciles its tail", async () => {
    const root = node({ id: "unknown-root" });
    const capacityTarget = node({
      id: "capacity-target",
      sortKey: 4096
    });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `74100000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const lostResponse = deferred<NotesMutationResult>();
    let firstCalls = 0;
    let committedFirstIds: string[] = [];
    let committedSecondIds: string[] = [];
    let backendWorkspace: NotesWorkspace = workspace([root, capacityTarget]);
    const importImageNodeBytes = vi.fn(
      async (
        _vaultRoot: string,
        input: ImportImageNodeBytesInput,
        context?: NotesHistoryContext | null
      ) => {
        const importedIds = input.items.map((item) => item.nodeId);
        const originalName = input.items[0]?.originalName;
        const result = (importedRootIds: string[]): NotesMutationResult => ({
          workspace: backendWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds
        });

        if (originalName === "unknown-a-0.png") {
          firstCalls += 1;
          committedFirstIds = importedIds;
          backendWorkspace = {
            nodes: [
              root,
              ...importedIds.map((id, index) =>
                node({
                  id,
                  nodeKind: "image",
                  sortKey: 2048 + index * 1024
                })
              ),
              capacityTarget
            ]
          };
          if (firstCalls === 1) {
            return lostResponse.promise;
          }
          return result(importedIds);
        }

        if (originalName === "unknown-b-0.png") {
          committedSecondIds = importedIds;
          backendWorkspace = {
            nodes: [
              root,
              ...committedFirstIds.map((id, index) =>
                node({
                  id,
                  nodeKind: "image",
                  sortKey: 2048 + index * 1024
                })
              ),
              ...importedIds.map((id, index) =>
                node({
                  id,
                  nodeKind: "image",
                  sortKey: 3072 + index * 1024
                })
              ),
              capacityTarget
            ]
          };
          return result(importedIds);
        }

        backendWorkspace = {
          nodes: [
            root,
            ...committedFirstIds.map((id, index) =>
              node({
                id,
                nodeKind: "image",
                sortKey: 2048 + index * 1024
              })
            ),
            ...committedSecondIds.map((id, index) =>
              node({
                id,
                nodeKind: "image",
                sortKey: 3072 + index * 1024
              })
            ),
            capacityTarget,
            ...importedIds.map((id, index) =>
              node({
                id,
                nodeKind: "image",
                sortKey: 5120 + index * 1024
              })
            )
          ]
        };
        return result(importedIds);
      }
    );
    const store = repository({
      loadWorkspace: vi.fn(async () => backendWorkspace),
      importImageNodeBytes
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/unknown-outcome", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.actions.setImageImportMaxDisplayWidth(320));

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("unknown-a", [1])
      );
    });
    await waitFor(() => expect(importImageNodeBytes).toHaveBeenCalledOnce());
    act(() => {
      secondCompletion = result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("unknown-b", [1])
      );
    });
    await act(async () => Promise.resolve());
    expect(importImageNodeBytes).toHaveBeenCalledOnce();

    let secondSettled = false;
    void secondCompletion.then(() => {
      secondSettled = true;
    });
    lostResponse.reject(new Error("response lost after commit"));
    await act(async () => firstCompletion);
    await act(async () => Promise.resolve());

    expect(importImageNodeBytes).toHaveBeenCalledOnce();
    expect(secondSettled).toBe(false);
    const retryAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(retryAttemptId).toBeDefined();

    const fullBatchSizes: number[] = [];
    for (
      let remaining = MAX_NOTE_ATTACHMENT_BATCH_BYTES;
      remaining > 0;
      remaining -= MAX_NOTE_ATTACHMENT_BYTES
    ) {
      fullBatchSizes.push(Math.min(remaining, MAX_NOTE_ATTACHMENT_BYTES));
    }
    const allocatedBeforeCapacityCheck = createNoteIdMock.mock.calls.length;
    await act(async () =>
      result.current.actions.importClipboardImages!(
        capacityTarget.id,
        pendingImageBatch("capacity", fullBatchSizes)
      )
    );
    expect(importImageNodeBytes).toHaveBeenCalledOnce();
    expect(createNoteIdMock).toHaveBeenCalledTimes(
      allocatedBeforeCapacityCheck
    );
    expect(
      result.current.attachmentUploadErrorsByNodeId?.[capacityTarget.id]
    ).toBe("Clipboard image retry data exceeds the 64 MiB memory limit.");

    await act(async () =>
      result.current.actions.retryImageUpload!(root.id, retryAttemptId)
    );
    await act(async () => secondCompletion);

    expect(importImageNodeBytes).toHaveBeenCalledTimes(3);
    expect(importImageNodeBytes.mock.calls[1]?.[1]).toEqual(
      importImageNodeBytes.mock.calls[0]?.[1]
    );
    expect(importImageNodeBytes.mock.calls[1]?.[2]).toBe(
      importImageNodeBytes.mock.calls[0]?.[2]
    );
    expect(importImageNodeBytes.mock.calls[2]?.[1].afterId).toBe(
      committedFirstIds.at(-1)
    );
    expect(result.current.state.rootIds).toEqual([
      root.id,
      ...committedFirstIds,
      ...committedSecondIds,
      capacityTarget.id
    ]);

    await act(async () =>
      result.current.actions.importClipboardImages!(
        capacityTarget.id,
        pendingImageBatch("capacity", fullBatchSizes)
      )
    );
    expect(importImageNodeBytes).toHaveBeenCalledTimes(4);
    expect(
      result.current.attachmentUploadErrorsByNodeId?.[capacityTarget.id]
    ).toBeUndefined();
  });

  it("keeps a canceled same-anchor turn behind an unknown predecessor across remount", async () => {
    const root = node({ id: "canceled-turn-root" });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `74150000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    let backendWorkspace: NotesWorkspace = workspace([root]);
    let unknownCalls = 0;
    let unknownIds: string[] = [];
    const importImageNodeBytes = vi.fn(
      async (
        _vaultRoot: string,
        input: ImportImageNodeBytesInput,
        context?: NotesHistoryContext | null
      ): Promise<NotesMutationResult> => {
        const originalName = input.items[0]?.originalName;
        const importedIds = input.items.map((item) => item.nodeId);
        if (originalName === "canceled-b-0.png") {
          throw new Error("a canceled batch must never reach the repository");
        }
        if (originalName === "unknown-a-0.png") {
          unknownCalls += 1;
          unknownIds = importedIds;
          backendWorkspace = workspace([
            root,
            ...unknownIds.map((id, index) =>
              node({ id, nodeKind: "image", sortKey: 2048 + index * 1024 })
            )
          ]);
          if (unknownCalls === 1) {
            throw new Error("response lost after commit");
          }
        } else {
          backendWorkspace = workspace([
            root,
            ...unknownIds.map((id, index) =>
              node({ id, nodeKind: "image", sortKey: 2048 + index * 1024 })
            ),
            ...importedIds.map((id, index) =>
              node({ id, nodeKind: "image", sortKey: 4096 + index * 1024 })
            )
          ]);
        }
        return {
          workspace: backendWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: importedIds
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn(async () => backendWorkspace),
      importImageNodeBytes
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/canceled-turn", repository: store })
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    act(() => owner.result.current.actions.setImageImportMaxDisplayWidth(320));

    await act(async () =>
      owner.result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("unknown-a", [1])
      )
    );
    const retryAttemptId =
      owner.result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(retryAttemptId).toBeDefined();

    let canceledCompletion!: Promise<void>;
    act(() => {
      canceledCompletion = owner.result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("canceled-b", [1])
      );
    });
    await act(async () => Promise.resolve());
    expect(importImageNodeBytes).toHaveBeenCalledOnce();

    owner.unmount();
    await act(async () => Promise.resolve());

    const fresh = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/canceled-turn", repository: store })
    );
    await waitFor(() => expect(fresh.result.current.status).toBe("ready"));
    act(() => fresh.result.current.actions.setImageImportMaxDisplayWidth(320));
    await waitFor(() =>
      expect(
        fresh.result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id]
      ).toBe(retryAttemptId)
    );

    let freshCompletion!: Promise<void>;
    act(() => {
      freshCompletion = fresh.result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("fresh-c", [1])
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(importImageNodeBytes).toHaveBeenCalledOnce();

    await act(async () =>
      fresh.result.current.actions.retryImageUpload!(root.id, retryAttemptId)
    );
    await act(async () => Promise.all([canceledCompletion, freshCompletion]));

    expect(
      importImageNodeBytes.mock.calls.map(([_, input]) => input.items[0]?.originalName)
    ).toEqual(["unknown-a-0.png", "unknown-a-0.png", "fresh-c-0.png"]);
    expect(importImageNodeBytes.mock.calls[2]?.[1].afterId).toBe(unknownIds.at(-1));
  });

  it("reconciles an unknown commit after vault switch and remount before releasing its anchor turn", async () => {
    const root = node({ id: "teardown-root" });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `74200000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const rejectedImport = deferred<NotesMutationResult>();
    let backendWorkspace: NotesWorkspace = workspace([root]);
    let firstImportedIds: string[] = [];
    let secondImportedIds: string[] = [];
    let firstCalls = 0;
    const importImageNodeBytes = vi.fn(
      (
        vaultRoot: string,
        input: ImportImageNodeBytesInput,
        context?: NotesHistoryContext | null
      ) => {
        const importedIds = input.items.map((item) => item.nodeId);
        if (vaultRoot !== "/teardown-race") {
          throw new Error(`unexpected import for ${vaultRoot}`);
        }
        if (input.items[0]?.originalName === "teardown-a-0.png") {
          firstCalls += 1;
          firstImportedIds = importedIds;
          backendWorkspace = workspace([
            root,
            ...firstImportedIds.map((id, index) =>
              node({
                id,
                nodeKind: "image",
                sortKey: 2048 + index * 1024
              })
            )
          ]);
          if (firstCalls === 1) {
            return rejectedImport.promise;
          }
        } else {
          secondImportedIds = importedIds;
          backendWorkspace = workspace([
            root,
            ...firstImportedIds.map((id, index) =>
              node({
                id,
                nodeKind: "image",
                sortKey: 2048 + index * 1024
              })
            ),
            ...secondImportedIds.map((id, index) =>
              node({
                id,
                nodeKind: "image",
                sortKey: 4096 + index * 1024
              })
            )
          ]);
        }
        return Promise.resolve({
          workspace: backendWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: importedIds
        });
      }
    );
    const store = repository({
      loadWorkspace: vi.fn(async (vaultRoot: string) =>
        vaultRoot === "/teardown-race"
          ? backendWorkspace
          : workspace([root])
      ),
      importImageNodeBytes
    });
    const owner = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/teardown-race" } }
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    act(() => owner.result.current.actions.setImageImportMaxDisplayWidth(320));

    let firstCompletion!: Promise<void>;
    act(() => {
      firstCompletion = owner.result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("teardown-a", [1, 1])
      );
    });
    await waitFor(() => expect(importImageNodeBytes).toHaveBeenCalledOnce());
    const originalInput = importImageNodeBytes.mock.calls[0]?.[1];
    const originalContext = importImageNodeBytes.mock.calls[0]?.[2];

    owner.rerender({ vaultRoot: "/other-vault" });
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    rejectedImport.reject(new Error("response lost during teardown"));
    await act(async () => firstCompletion);
    owner.unmount();
    await act(async () => Promise.resolve());
    expect(importImageNodeBytes).toHaveBeenCalledOnce();

    const fresh = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/teardown-race", repository: store })
    );
    await waitFor(() => expect(fresh.result.current.status).toBe("ready"));
    act(() => fresh.result.current.actions.setImageImportMaxDisplayWidth(320));
    await waitFor(() =>
      expect(
        fresh.result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id]
      ).toBeDefined()
    );
    const retryAttemptId =
      fresh.result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    const fullBatchSizes: number[] = [];
    for (
      let remaining = MAX_NOTE_ATTACHMENT_BATCH_BYTES;
      remaining > 0;
      remaining -= MAX_NOTE_ATTACHMENT_BYTES
    ) {
      fullBatchSizes.push(Math.min(remaining, MAX_NOTE_ATTACHMENT_BYTES));
    }

    const allocatedBeforeCapacityCheck = createNoteIdMock.mock.calls.length;
    await act(async () =>
      fresh.result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("teardown-capacity", fullBatchSizes)
      )
    );
    expect(importImageNodeBytes).toHaveBeenCalledOnce();
    expect(createNoteIdMock).toHaveBeenCalledTimes(
      allocatedBeforeCapacityCheck
    );
    expect(
      fresh.result.current.attachmentUploadErrorsByNodeId?.[root.id]
    ).toBe("Clipboard image retry data exceeds the 64 MiB memory limit.");

    let secondCompletion!: Promise<void>;
    act(() => {
      secondCompletion = fresh.result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("teardown-b", [1])
      );
    });
    await act(async () => Promise.resolve());
    expect(importImageNodeBytes).toHaveBeenCalledOnce();

    await act(async () =>
      fresh.result.current.actions.retryImageUpload!(root.id, retryAttemptId)
    );
    await act(async () => secondCompletion);

    expect(importImageNodeBytes).toHaveBeenCalledTimes(3);
    expect(importImageNodeBytes.mock.calls[1]?.[1]).toEqual(originalInput);
    expect(importImageNodeBytes.mock.calls[1]?.[2]).toBe(originalContext);
    expect(importImageNodeBytes.mock.calls[2]?.[1].afterId).toBe(
      firstImportedIds.at(-1)
    );
    expect(fresh.result.current.state.rootIds).toEqual([
      root.id,
      ...firstImportedIds,
      ...secondImportedIds
    ]);
  });

  it("retains failed clipboard blobs for retry and releases the retry target after success", async () => {
    const nodeId = "50000000-0000-4000-8000-000000000001";
    const attachmentId = "50000000-0000-4000-8000-000000000002";
    createNoteIdMock
      .mockReturnValueOnce(nodeId)
      .mockReturnValueOnce(attachmentId);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const importImageNodeBytes = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary byte failure"))
      .mockImplementation(async (_vaultRoot, _input, context) => ({
        workspace: workspace([node({ id: "root" })]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [nodeId]
      }));
    const store = repository({ importImageNodeBytes });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(320));
    await act(async () =>
      result.current.actions.importClipboardImages!("root", [
        { originalName: "clip.png", mimeType: "image/png", blob }
      ])
    );
    const retryAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.root;
    expect(retryAttemptId).toBeDefined();

    await act(async () =>
      result.current.actions.retryImageUpload!("root", retryAttemptId)
    );

    expect(importImageNodeBytes.mock.calls[0]?.[1].items).toEqual([
      expect.objectContaining({ nodeId, attachmentId, blob })
    ]);
    expect(importImageNodeBytes.mock.calls[1]?.[1]).toEqual(
      importImageNodeBytes.mock.calls[0]?.[1]
    );
    expect(importImageNodeBytes.mock.calls[1]?.[1].items[0].blob).toBe(blob);
    expect(importImageNodeBytes.mock.calls[1]?.[2]).toBe(
      importImageNodeBytes.mock.calls[0]?.[2]
    );
    expect(result.current.attachmentUploadRetryAttemptIdsByNodeId?.root).toBeUndefined();
    await act(async () =>
      result.current.actions.retryImageUpload!("root", retryAttemptId)
    );
    expect(importImageNodeBytes).toHaveBeenCalledTimes(2);
    expect(store.importAttachmentBytes).not.toHaveBeenCalled();
  });

  it("cancels quietly and rejects an invalid measured width before allocating IDs", async () => {
    const openImageFiles = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(["/incoming/one.png"]);
    const importImageNodePaths = vi.fn();
    const store = repository({ importImageNodePaths });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: mockAttachmentUi(openImageFiles)
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.uploadImage!("root"));
    expect(result.current.attachmentUploadErrorsByNodeId?.root).toBeUndefined();
    expect(createNoteIdMock).not.toHaveBeenCalled();

    await act(async () => result.current.actions.uploadImage!("root"));
    expect(result.current.attachmentUploadErrorsByNodeId?.root).toBe(
      "Image area is not ready."
    );
    expect(createNoteIdMock).not.toHaveBeenCalled();
    expect(importImageNodePaths).not.toHaveBeenCalled();
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
  });

  it("does not open the image picker when the vault root is blank", async () => {
    const openImageFiles = vi.fn().mockResolvedValue(["/incoming/one.png"]);
    const importImageNodePaths = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "   ",
        repository: store,
        attachmentUi: mockAttachmentUi(openImageFiles)
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(360));
    await act(async () => result.current.actions.uploadImage!("root"));

    expect(openImageFiles).not.toHaveBeenCalled();
    expect(createNoteIdMock).not.toHaveBeenCalled();
    expect(importImageNodePaths).not.toHaveBeenCalled();
    expect(result.current.attachmentUploadErrorsByNodeId?.root).toBeUndefined();
  });

  it("drops a repository result that resolves after the workspace generation changes", async () => {
    const oldRoot = node({ id: "old-root" });
    const newRoot = node({ id: "new-root" });
    const oldImport = deferred<NotesMutationResult>();
    createNoteIdMock.mockReturnValue(
      "60000000-0000-4000-8000-000000000001"
    );
    const importImageNodePaths = vi.fn().mockReturnValue(oldImport.promise);
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async (vaultRoot) =>
        workspace([vaultRoot === "/old" ? oldRoot : newRoot])
      ),
      importImageNodePaths
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() => expect(result.current.state.nodesById[oldRoot.id]).toBeDefined());

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    const pending = result.current.actions.importDroppedImagePaths!(oldRoot.id, [
      "/incoming/old.png"
    ]);
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());
    rerender({ vaultRoot: "/new" });
    await waitFor(() => expect(result.current.state.nodesById[newRoot.id]).toBeDefined());

    oldImport.resolve({
      workspace: {
        nodes: [
          oldRoot,
          node({
            id: "60000000-0000-4000-8000-000000000001",
            nodeKind: "image"
          })
        ],
        attachmentsByNodeId: {
          "60000000-0000-4000-8000-000000000001": [
            attachment({
              id: "stale",
              nodeId: "60000000-0000-4000-8000-000000000001"
            })
          ]
        }
      },
      historyEntryId: importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false,
      importedRootIds: ["60000000-0000-4000-8000-000000000001"]
    });
    await act(async () => pending);

    expect(result.current.state.nodesById[newRoot.id]).toBeDefined();
    expect(result.current.state.nodesById[oldRoot.id]).toBeUndefined();
    expect(result.current.state.attachmentsByNodeId[oldRoot.id]).toBeUndefined();
  });

  it.each(["picker", "drop", "clipboard"] as const)(
    "preserves focus, caret, selection, selectedId, and collapse after a %s failure",
    async (source) => {
      const root = node({ id: "root", isCollapsed: true });
      createNoteIdMock.mockReturnValue(
        "70000000-0000-4000-8000-000000000001"
      );
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(workspace([root])),
        importImageNodePaths: vi.fn().mockRejectedValue(new Error("path failed")),
        importImageNodeBytes: vi.fn().mockRejectedValue(new Error("bytes failed"))
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({
          vaultRoot: "/vault",
          repository: store,
          attachmentUi: mockAttachmentUi(
            source === "picker"
              ? vi.fn().mockRejectedValue(new Error("picker failed"))
              : vi.fn().mockResolvedValue(null)
          )
        })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
      const input = document.createElement("textarea");
      input.value = "abcdef";
      document.body.append(input);
      input.focus();
      input.setSelectionRange(2, 5);
      const selectedId = result.current.state.selectedId;
      const collapsed = result.current.state.nodesById[root.id].isCollapsed;

      await act(async () => {
        if (source === "picker") {
          await result.current.actions.uploadImage!(root.id);
        } else if (source === "drop") {
          await result.current.actions.importDroppedImagePaths!(root.id, [
            "/incoming/one.png"
          ]);
        } else {
          await result.current.actions.importClipboardImages!(root.id, [
            {
              originalName: "clip.png",
              mimeType: "image/png",
              blob: new Blob(["image"], { type: "image/png" })
            }
          ]);
        }
      });

      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(2);
      expect(input.selectionEnd).toBe(5);
      expect(result.current.state.selectedId).toBe(selectedId);
      expect(result.current.state.nodesById[root.id].isCollapsed).toBe(collapsed);
      input.remove();
    }
  );

  it("imports a selected image atomically through the injected UI boundary", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const imageNodeId = "8f257d31-d255-4fc8-89dc-4e3b30f24a6e";
    const attachmentId = "8f257d31-d255-4fc8-89dc-4e3b30f24a6f";
    const imported = attachment({
      id: attachmentId,
      nodeId: imageNodeId
    });
    createNoteIdMock
      .mockReturnValueOnce(imageNodeId)
      .mockReturnValueOnce(attachmentId);
    const attachmentUi = {
      openImageFiles: vi.fn().mockResolvedValue(["/incoming/diagram.png"]),
      saveImageFile: vi.fn().mockResolvedValue(null),
      subscribeToImageDrop: vi.fn().mockResolvedValue(vi.fn())
    };
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue({
        nodes: [root],
        attachmentsByNodeId: {}
      }),
      importImageNodePaths: vi.fn().mockImplementation(
        async (_vaultRoot, _input, context) => ({
          workspace: {
            nodes: [
              root,
              node({
                id: imageNodeId,
                nodeKind: "image",
                sortKey: 2048,
                title: "diagram.png"
              })
            ],
            attachmentsByNodeId: { [imageNodeId]: [imported] }
          },
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [imageNodeId]
        })
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.actions.uploadImage).toBeTypeOf("function");
    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    await act(async () => result.current.actions.uploadImage!(root.id));

    expect(attachmentUi.openImageFiles).toHaveBeenCalledOnce();
    expect(store.importImageNodePaths).toHaveBeenCalledWith(
      "/vault",
      {
        parentId: null,
        afterId: root.id,
        items: [
          {
            nodeId: imageNodeId,
            attachmentId,
            sourcePath: "/incoming/diagram.png"
          }
        ],
        initialMaxDisplayWidth: 480
      },
      historyContext("attachment-import")
    );
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
    expect(result.current.state.attachmentsByNodeId[imageNodeId]).toEqual([
      imported
    ]);
    expect(result.current.state.selectedId).toBe(imageNodeId);
    expect(result.current.attachmentUploadErrorsByNodeId?.[root.id]).toBeUndefined();
  });

  it("keeps the measured 480px import width stable while the picker is open", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const picker = deferred<string | null>();
    const imageNodeId = "1c17ba74-a617-45e7-9e21-74068b63befe";
    const attachmentId = "1c17ba74-a617-45e7-9e21-74068b63beff";
    const imported = attachment({
      id: attachmentId,
      nodeId: imageNodeId,
      intrinsicWidth: 1200,
      displayWidth: 480
    });
    createNoteIdMock
      .mockReturnValueOnce(imageNodeId)
      .mockReturnValueOnce(attachmentId);
    const importImageNodePaths = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => ({
        workspace: {
          nodes: [root, node({ id: imageNodeId, nodeKind: "image" })],
          attachmentsByNodeId: { [imageNodeId]: [imported] }
        },
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [imageNodeId]
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue({
        nodes: [root],
        attachmentsByNodeId: {}
      }),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: mockAttachmentUi(
          vi.fn().mockReturnValue(
            picker.promise.then((path) => (path === null ? null : [path]))
          )
        )
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    const upload = result.current.actions.uploadImage!(root.id);
    act(() => result.current.actions.setImageImportMaxDisplayWidth(700));
    await act(async () => picker.resolve("/incoming/wide.png"));
    await act(async () => upload);

    expect(importImageNodePaths).toHaveBeenCalledWith(
      "/vault",
      expect.objectContaining({ initialMaxDisplayWidth: 480 }),
      historyContext("attachment-import")
    );
  });

  it("serializes same-node batches before retrying the failed next path", async () => {
    const root = node({ id: "root" });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
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
    const second = result.current.actions.uploadImage!(root.id);
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());
    expect(importImageNodePaths).toHaveBeenCalledTimes(1);
    firstImport.resolve({
      workspace: { nodes: [root], attachmentsByNodeId: {} },
      historyEntryId: null,
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(2));
    expect(importImageNodePaths.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({ sourcePath: "/incoming/second.png" })
        ]
      })
    );
    secondImport.reject(new Error("second failed"));
    await act(async () => Promise.all([first, second]));

    const visibleAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(visibleAttemptId).toBeDefined();
    await act(async () =>
      result.current.actions.retryImageUpload!(root.id, visibleAttemptId)
    );

    expect(importImageNodePaths).toHaveBeenCalledTimes(3);
    expect(importImageNodePaths.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({ sourcePath: "/incoming/second.png" })
        ]
      })
    );
    expect(importImageNodePaths.mock.calls[2]?.[2]).toBe(
      importImageNodePaths.mock.calls[1]?.[2]
    );
  });

  it("rebases queued same-marker image batches after the prior imported tail and retries that exact request", async () => {
    const root = node({ id: "root" });
    const ids = [
      "71000000-0000-4000-8000-000000000001",
      "71000000-0000-4000-8000-000000000002",
      "71000000-0000-4000-8000-000000000003",
      "71000000-0000-4000-8000-000000000004"
    ];
    createNoteIdMock
      .mockReturnValueOnce(ids[0])
      .mockReturnValueOnce(ids[1])
      .mockReturnValueOnce(ids[2])
      .mockReturnValueOnce(ids[3]);
    const firstImage = node({
      id: ids[0],
      nodeKind: "image",
      sortKey: 2048,
      title: "first.png"
    });
    const secondImage = node({
      id: ids[2],
      nodeKind: "image",
      sortKey: 3072,
      title: "second.png"
    });
    const firstAttachment = attachment({
      id: ids[1],
      nodeId: ids[0],
      originalName: "first.png"
    });
    const secondAttachment = attachment({
      id: ids[3],
      nodeId: ids[2],
      originalName: "second.png",
      contentHash: "b".repeat(64),
      relativePath: `notes-assets/${"b".repeat(64)}.png`
    });
    const firstImport = deferred<NotesMutationResult>();
    const secondImport = deferred<NotesMutationResult>();
    const importImageNodePaths = vi
      .fn()
      .mockReturnValueOnce(firstImport.promise)
      .mockReturnValueOnce(secondImport.promise)
      .mockImplementation(async (_vaultRoot, _input, context) => ({
        workspace: {
          nodes: [root, firstImage, secondImage],
          attachmentsByNodeId: {
            [ids[0]]: [firstAttachment],
            [ids[2]]: [secondAttachment]
          }
        },
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [ids[2]]
      }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([root])),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    const first = result.current.actions.importDroppedImagePaths!(root.id, [
      "/incoming/first.png"
    ]);
    const second = result.current.actions.importDroppedImagePaths!(root.id, [
      "/incoming/second.png"
    ]);
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(1));

    firstImport.resolve({
      workspace: {
        nodes: [root, firstImage],
        attachmentsByNodeId: { [ids[0]]: [firstAttachment] }
      },
      historyEntryId: importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false,
      importedRootIds: [ids[0]]
    });
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(2));

    expect(importImageNodePaths.mock.calls[0]?.[1]).toEqual({
      parentId: null,
      afterId: root.id,
      items: [
        {
          nodeId: ids[0],
          attachmentId: ids[1],
          sourcePath: "/incoming/first.png"
        }
      ],
      initialMaxDisplayWidth: 480
    });
    expect(importImageNodePaths.mock.calls[1]?.[1]).toEqual({
      parentId: null,
      afterId: ids[0],
      items: [
        {
          nodeId: ids[2],
          attachmentId: ids[3],
          sourcePath: "/incoming/second.png"
        }
      ],
      initialMaxDisplayWidth: 480
    });

    secondImport.reject(new Error("second failed after rebase"));
    await act(async () => Promise.all([first, second]));
    const failedAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(failedAttemptId).toBeDefined();

    await act(async () =>
      result.current.actions.retryImageUpload!(root.id, failedAttemptId)
    );

    expect(importImageNodePaths).toHaveBeenCalledTimes(3);
    expect(importImageNodePaths.mock.calls[2]?.[1]).toEqual(
      importImageNodePaths.mock.calls[1]?.[1]
    );
    expect(importImageNodePaths.mock.calls[2]?.[2]).toBe(
      importImageNodePaths.mock.calls[1]?.[2]
    );
  });

  it("retains a running owner's insertion reservation until queued sibling imports settle", async () => {
    const root = node({ id: "root" });
    const ids = [
      "71100000-0000-4000-8000-000000000001",
      "71100000-0000-4000-8000-000000000002",
      "71100000-0000-4000-8000-000000000003",
      "71100000-0000-4000-8000-000000000004",
      "71100000-0000-4000-8000-000000000005",
      "71100000-0000-4000-8000-000000000006"
    ];
    for (const id of ids) {
      createNoteIdMock.mockReturnValueOnce(id);
    }
    const firstImage = node({
      id: ids[0]!,
      nodeKind: "image",
      sortKey: 2048,
      title: "first.png"
    });
    const secondImage = node({
      id: ids[2]!,
      nodeKind: "image",
      sortKey: 3072,
      title: "second.png"
    });
    const thirdImage = node({
      id: ids[4]!,
      nodeKind: "image",
      sortKey: 1536,
      title: "third.png"
    });
    const firstAttachment = attachment({
      id: ids[1]!,
      nodeId: ids[0]!,
      originalName: "first.png"
    });
    const secondAttachment = attachment({
      id: ids[3]!,
      nodeId: ids[2]!,
      originalName: "second.png"
    });
    const thirdAttachment = attachment({
      id: ids[5]!,
      nodeId: ids[4]!,
      originalName: "third.png"
    });
    const firstImport = deferred<NotesMutationResult>();
    const secondImport = deferred<NotesMutationResult>();
    let activeWorkspace: NotesWorkspace = workspace([root]);
    const importImageNodePaths = vi
      .fn()
      .mockReturnValueOnce(firstImport.promise)
      .mockReturnValueOnce(secondImport.promise)
      .mockImplementationOnce(async (_vaultRoot, _input, context) => {
        activeWorkspace = {
          nodes: [root, firstImage, secondImage],
          attachmentsByNodeId: {
            [ids[0]!]: [firstAttachment],
            [ids[2]!]: [secondAttachment]
          }
        };
        return {
          workspace: activeWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [ids[2]!]
        };
      })
      .mockImplementationOnce(async (_vaultRoot, _input, context) => {
        activeWorkspace = {
          nodes: [root, thirdImage, firstImage, secondImage],
          attachmentsByNodeId: {
            [ids[4]!]: [thirdAttachment],
            [ids[0]!]: [firstAttachment],
            [ids[2]!]: [secondAttachment]
          }
        };
        return {
          workspace: activeWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [ids[4]!]
        };
      });
    const store = repository({
      loadWorkspace: vi.fn(async () => activeWorkspace),
      importImageNodePaths
    });
    const openedSessions: ReturnType<
      typeof notesWorkspaceCoordinatorRegistry.openSession
    >[] = [];
    const realOpenSession =
      notesWorkspaceCoordinatorRegistry.openSession.bind(
        notesWorkspaceCoordinatorRegistry
      );
    const openSessionSpy = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        openedSessions.push(session);
        return session;
      });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/reservation-owner", repository: store })
    );
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/reservation-owner", repository: store })
    );
    openSessionSpy.mockRestore();
    await waitFor(() => {
      expect(owner.result.current.status).toBe("ready");
      expect(sibling.result.current.status).toBe("ready");
    });

    act(() => {
      owner.result.current.actions.setImageImportMaxDisplayWidth(480);
      sibling.result.current.actions.setImageImportMaxDisplayWidth(480);
    });
    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = owner.result.current.actions.importDroppedImagePaths!(
        root.id,
        ["/incoming/first.png"]
      );
      secondCompletion = sibling.result.current.actions.importDroppedImagePaths!(
        root.id,
        ["/incoming/second.png"]
      );
    });
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());

    let ownerCallerSettled = false;
    void firstCompletion.then(() => {
      ownerCallerSettled = true;
    });
    act(() => openedSessions[1]!.close());
    await act(async () => Promise.resolve());
    expect(ownerCallerSettled).toBe(false);

    activeWorkspace = {
      nodes: [root, firstImage],
      attachmentsByNodeId: { [ids[0]!]: [firstAttachment] }
    };
    await act(async () => {
      firstImport.resolve({
        workspace: activeWorkspace,
        historyEntryId:
          importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [ids[0]!]
      });
      await firstCompletion;
    });
    expect(ownerCallerSettled).toBe(true);
    owner.unmount();
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(2));
    const firstSecondInput = importImageNodePaths.mock.calls[1]?.[1];
    const secondHistory = importImageNodePaths.mock.calls[1]?.[2];

    secondImport.reject(new Error("second import failed"));
    await act(async () => secondCompletion);
    const retryAttemptId =
      sibling.result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(retryAttemptId).toBeDefined();

    await act(async () =>
      sibling.result.current.actions.retryImageUpload!(root.id, retryAttemptId)
    );
    const retriedSecondInput = importImageNodePaths.mock.calls[2]?.[1];
    expect(importImageNodePaths.mock.calls[2]?.[2]).toBe(secondHistory);
    expect(retriedSecondInput).toEqual(firstSecondInput);
    expect(createNoteIdMock).toHaveBeenCalledTimes(4);

    await act(async () =>
      sibling.result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/third.png"
      ])
    );

    expect(firstSecondInput).toEqual({
      parentId: null,
      afterId: ids[0],
      items: [
        {
          nodeId: ids[2],
          attachmentId: ids[3],
          sourcePath: "/incoming/second.png"
        }
      ],
      initialMaxDisplayWidth: 480
    });
    expect(importImageNodePaths.mock.calls[3]?.[1]).toEqual({
      parentId: null,
      afterId: root.id,
      items: [
        {
          nodeId: ids[4],
          attachmentId: ids[5],
          sourcePath: "/incoming/third.png"
        }
      ],
      initialMaxDisplayWidth: 480
    });
    expect(createNoteIdMock).toHaveBeenCalledTimes(6);
    expect(sibling.result.current.state.rootIds).toEqual([
      root.id,
      ids[4],
      ids[0],
      ids[2]
    ]);

    sibling.unmount();
    await act(async () => Promise.resolve());
    expect(
      notesWorkspaceCoordinatorRegistry.hasCoordinator(
        store,
        "/reservation-owner"
      )
    ).toBe(false);
  });

  it.each(["success", "failure"] as const)(
    "retains A's committed tail when B reserves during A's pending projection %s",
    async (projectionOutcome) => {
      const root = node({ id: "root", isStarred: true });
      const outside = node({ id: "outside", sortKey: 4096 });
      const ids = [
        "71200000-0000-4000-8000-000000000001",
        "71200000-0000-4000-8000-000000000002",
        "71200000-0000-4000-8000-000000000003",
        "71200000-0000-4000-8000-000000000004",
        "71200000-0000-4000-8000-000000000005",
        "71200000-0000-4000-8000-000000000006"
      ];
      for (const id of ids) {
        createNoteIdMock.mockReturnValueOnce(id);
      }
      const firstImage = node({
        id: ids[0]!,
        nodeKind: "image",
        sortKey: 2048,
        title: "first.png"
      });
      const secondImage = node({
        id: ids[2]!,
        nodeKind: "image",
        sortKey: 3072,
        title: "second.png"
      });
      const thirdImage = node({
        id: ids[4]!,
        nodeKind: "image",
        sortKey: 1536,
        title: "third.png"
      });
      const firstAttachment = attachment({
        id: ids[1]!,
        nodeId: ids[0]!,
        originalName: "first.png"
      });
      const secondAttachment = attachment({
        id: ids[3]!,
        nodeId: ids[2]!,
        originalName: "second.png"
      });
      const thirdAttachment = attachment({
        id: ids[5]!,
        nodeId: ids[4]!,
        originalName: "third.png"
      });
      const firstNative = deferred<NotesMutationResult>();
      const secondNative = deferred<NotesMutationResult>();
      const firstProjection = deferred<NotesWorkspace>();
      const projectionRequested = vi.fn();
      let deferNextStarredProjection = false;
      let activeWorkspace: NotesWorkspace = workspace([root, outside]);
      let filteredWorkspace: NotesWorkspace = workspace([root]);
      const loadWorkspace = vi.fn((_vaultRoot, scope) => {
        if (scope.kind === "starred" && deferNextStarredProjection) {
          deferNextStarredProjection = false;
          projectionRequested();
          return firstProjection.promise;
        }
        return Promise.resolve(
          scope.kind === "starred" ? filteredWorkspace : activeWorkspace
        );
      });
      const importImageNodePaths = vi
        .fn()
        .mockReturnValueOnce(firstNative.promise)
        .mockReturnValueOnce(secondNative.promise)
        .mockImplementationOnce(async (_vaultRoot, _input, context) => {
          activeWorkspace = {
            nodes: [root, firstImage, secondImage, outside],
            attachmentsByNodeId: {
              [ids[0]!]: [firstAttachment],
              [ids[2]!]: [secondAttachment]
            }
          };
          filteredWorkspace = {
            nodes: [root, firstImage, secondImage],
            attachmentsByNodeId: {
              [ids[0]!]: [firstAttachment],
              [ids[2]!]: [secondAttachment]
            }
          };
          return {
            workspace: activeWorkspace,
            historyEntryId: context?.entryId ?? null,
            ...historyState(),
            canUndo: true,
            canRedo: false,
            importedRootIds: [ids[2]!]
          };
        })
        .mockImplementationOnce(async (_vaultRoot, _input, context) => {
          activeWorkspace = {
            nodes: [root, thirdImage, firstImage, secondImage, outside],
            attachmentsByNodeId: {
              [ids[4]!]: [thirdAttachment],
              [ids[0]!]: [firstAttachment],
              [ids[2]!]: [secondAttachment]
            }
          };
          filteredWorkspace = {
            nodes: [root, thirdImage, firstImage, secondImage],
            attachmentsByNodeId: {
              [ids[4]!]: [thirdAttachment],
              [ids[0]!]: [firstAttachment],
              [ids[2]!]: [secondAttachment]
            }
          };
          return {
            workspace: activeWorkspace,
            historyEntryId: context?.entryId ?? null,
            ...historyState(),
            canUndo: true,
            canRedo: false,
            importedRootIds: [ids[4]!]
          };
        });
      const store = repository({ loadWorkspace, importImageNodePaths });
      const secondPane = renderHook(() =>
        useNotesWorkspace({ vaultRoot: "/projection-reservation", repository: store })
      );
      const firstPane = renderHook(() =>
        useNotesWorkspace({ vaultRoot: "/projection-reservation", repository: store })
      );
      await waitFor(() => {
        expect(firstPane.result.current.status).toBe("ready");
        expect(secondPane.result.current.status).toBe("ready");
      });
      await act(async () => {
        await firstPane.result.current.actions.selectLibraryView("starred");
        await secondPane.result.current.actions.selectLibraryView("starred");
      });
      act(() => {
        firstPane.result.current.actions.setImageImportMaxDisplayWidth(480);
        secondPane.result.current.actions.setImageImportMaxDisplayWidth(480);
      });

      let firstCompletion!: Promise<void>;
      act(() => {
        firstCompletion =
          firstPane.result.current.actions.importDroppedImagePaths!(root.id, [
            "/incoming/first.png"
          ]);
      });
      await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());

      activeWorkspace = {
        nodes: [root, firstImage, outside],
        attachmentsByNodeId: { [ids[0]!]: [firstAttachment] }
      };
      filteredWorkspace = {
        nodes: [root, firstImage],
        attachmentsByNodeId: { [ids[0]!]: [firstAttachment] }
      };
      deferNextStarredProjection = true;
      firstNative.resolve({
        workspace: activeWorkspace,
        historyEntryId:
          importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [ids[0]!]
      });
      await waitFor(() => expect(projectionRequested).toHaveBeenCalledOnce());

      let secondCompletion!: Promise<void>;
      act(() => {
        secondCompletion =
          firstPane.result.current.actions.importDroppedImagePaths!(root.id, [
            "/incoming/second.png"
          ]);
      });
      await act(async () => Promise.resolve());
      expect(importImageNodePaths).toHaveBeenCalledTimes(1);

      if (projectionOutcome === "success") {
        firstProjection.resolve(filteredWorkspace);
      } else {
        firstProjection.reject(new Error("starred projection failed"));
      }
      await act(async () => firstCompletion);
      await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(2));
      const secondInput = importImageNodePaths.mock.calls[1]?.[1];
      const secondHistory = importImageNodePaths.mock.calls[1]?.[2];

      secondNative.reject(new Error("second native import failed"));
      await act(async () => secondCompletion);
      const retryAttemptId =
        firstPane.result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
          root.id
        ];
      expect(retryAttemptId).toBeDefined();

      await act(async () =>
        firstPane.result.current.actions.retryImageUpload!(
          root.id,
          retryAttemptId
        )
      );
      expect(importImageNodePaths.mock.calls[2]?.[1]).toEqual(secondInput);
      expect(importImageNodePaths.mock.calls[2]?.[2]).toBe(secondHistory);
      expect(createNoteIdMock).toHaveBeenCalledTimes(4);

      await act(async () =>
        firstPane.result.current.actions.importDroppedImagePaths!(root.id, [
          "/incoming/third.png"
        ])
      );

      expect(secondInput).toEqual({
        parentId: null,
        afterId: ids[0],
        items: [
          {
            nodeId: ids[2],
            attachmentId: ids[3],
            sourcePath: "/incoming/second.png"
          }
        ],
        initialMaxDisplayWidth: 480
      });
      expect(importImageNodePaths.mock.calls[3]?.[1]).toEqual({
        parentId: null,
        afterId: root.id,
        items: [
          {
            nodeId: ids[4],
            attachmentId: ids[5],
            sourcePath: "/incoming/third.png"
          }
        ],
        initialMaxDisplayWidth: 480
      });
      expect(createNoteIdMock).toHaveBeenCalledTimes(6);
      expect(firstPane.result.current.state.rootIds).toEqual([
        root.id,
        ids[4],
        ids[0],
        ids[2]
      ]);

      firstPane.unmount();
      secondPane.unmount();
      await act(async () => Promise.resolve());
      expect(
        notesWorkspaceCoordinatorRegistry.hasCoordinator(
          store,
          "/projection-reservation"
        )
      ).toBe(false);
    }
  );

  it("shares same-marker import order across panes when a filtered projection omits the prior tail", async () => {
    const root = node({ id: "root", isStarred: true });
    const ids = [
      "73000000-0000-4000-8000-000000000001",
      "73000000-0000-4000-8000-000000000002",
      "73000000-0000-4000-8000-000000000003",
      "73000000-0000-4000-8000-000000000004",
      "73000000-0000-4000-8000-000000000005",
      "73000000-0000-4000-8000-000000000006"
    ];
    createNoteIdMock
      .mockReturnValueOnce(ids[0])
      .mockReturnValueOnce(ids[1])
      .mockReturnValueOnce(ids[2])
      .mockReturnValueOnce(ids[3])
      .mockReturnValueOnce(ids[4])
      .mockReturnValueOnce(ids[5]);
    const firstImage = node({
      id: ids[0],
      nodeKind: "image",
      sortKey: 2048,
      title: "first.png"
    });
    const secondImage = node({
      id: ids[2],
      nodeKind: "image",
      sortKey: 3072,
      title: "second.png"
    });
    const laterImage = node({
      id: ids[4],
      nodeKind: "image",
      sortKey: 1536,
      title: "later.png"
    });
    const firstAttachment = attachment({
      id: ids[1],
      nodeId: ids[0],
      originalName: "first.png"
    });
    const secondAttachment = attachment({
      id: ids[3],
      nodeId: ids[2],
      originalName: "second.png",
      contentHash: "b".repeat(64),
      relativePath: `notes-assets/${"b".repeat(64)}.png`
    });
    const laterAttachment = attachment({
      id: ids[5],
      nodeId: ids[4],
      originalName: "later.png",
      contentHash: "c".repeat(64),
      relativePath: `notes-assets/${"c".repeat(64)}.png`
    });
    const firstImport = deferred<NotesMutationResult>();
    let activeWorkspace: NotesWorkspace = workspace([root]);
    const importImageNodePaths = vi
      .fn()
      .mockReturnValueOnce(firstImport.promise)
      .mockImplementationOnce(async (_vaultRoot, _input, context) => {
        activeWorkspace = {
          nodes: [root, firstImage, secondImage],
          attachmentsByNodeId: {
            [ids[0]]: [firstAttachment],
            [ids[2]]: [secondAttachment]
          }
        };
        return {
          workspace: activeWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [ids[2]]
        };
      })
      .mockImplementationOnce(async (_vaultRoot, _input, context) => {
        activeWorkspace = {
          nodes: [root, laterImage, firstImage, secondImage],
          attachmentsByNodeId: {
            [ids[4]]: [laterAttachment],
            [ids[0]]: [firstAttachment],
            [ids[2]]: [secondAttachment]
          }
        };
        return {
          workspace: activeWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [ids[4]]
        };
      });
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "starred" ? workspace([root]) : activeWorkspace
      ),
      importImageNodePaths
    });
    const filteredPane = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(filteredPane.result.current.status).toBe("ready"));
    await act(async () =>
      filteredPane.result.current.actions.selectLibraryView("starred")
    );
    const activePane = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(activePane.result.current.status).toBe("ready"));
    expect(activePane.result.current.libraryView).toBe("starred");
    await act(async () =>
      activePane.result.current.actions.selectLibraryView("all")
    );

    act(() => {
      activePane.result.current.actions.setImageImportMaxDisplayWidth(480);
      filteredPane.result.current.actions.setImageImportMaxDisplayWidth(480);
    });
    const first = activePane.result.current.actions.importDroppedImagePaths!(
      root.id,
      ["/incoming/first.png"]
    );
    const second = activePane.result.current.actions.importDroppedImagePaths!(
      root.id,
      ["/incoming/second.png"]
    );
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(1));

    activeWorkspace = {
      nodes: [root, firstImage],
      attachmentsByNodeId: { [ids[0]]: [firstAttachment] }
    };
    firstImport.resolve({
      workspace: activeWorkspace,
      historyEntryId: importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false,
      importedRootIds: [ids[0]]
    });
    await act(async () => Promise.all([first, second]));

    expect(filteredPane.result.current.state.nodesById[ids[0]]).toBeUndefined();
    expect(importImageNodePaths.mock.calls[1]?.[1]).toMatchObject({
      parentId: null,
      afterId: ids[0],
      items: [
        expect.objectContaining({
          nodeId: ids[2],
          sourcePath: "/incoming/second.png"
        })
      ]
    });

    await waitFor(() =>
      expect(activePane.result.current.state.nodesById[ids[2]]).toBeDefined()
    );
    await act(async () =>
      activePane.result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/later.png"
      ])
    );
    expect(importImageNodePaths.mock.calls[2]?.[1]).toMatchObject({
      parentId: null,
      afterId: root.id,
      items: [
        expect.objectContaining({
          nodeId: ids[4],
          sourcePath: "/incoming/later.png"
        })
      ]
    });

    activePane.unmount();
    filteredPane.unmount();
  });

  it("broadcasts committed image import authority when the originating pane unmounts before the response settles", async () => {
    const root = node({ id: "root" });
    const imageNodeId = "72000000-0000-4000-8000-000000000001";
    const attachmentId = "72000000-0000-4000-8000-000000000002";
    createNoteIdMock
      .mockReturnValueOnce(imageNodeId)
      .mockReturnValueOnce(attachmentId);
    const importedImage = node({
      id: imageNodeId,
      nodeKind: "image",
      sortKey: 2048,
      title: "committed.png"
    });
    const importedAttachment = attachment({
      id: attachmentId,
      nodeId: imageNodeId,
      originalName: "committed.png"
    });
    const importResponse = deferred<NotesMutationResult>();
    const importImageNodePaths = vi.fn().mockReturnValue(importResponse.promise);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([root])),
      importImageNodePaths
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));

    act(() =>
      owner.result.current.actions.setImageImportMaxDisplayWidth(480)
    );
    const completion =
      owner.result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/committed.png"
      ]);
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());
    owner.unmount();

    importResponse.resolve({
      workspace: {
        nodes: [root, importedImage],
        attachmentsByNodeId: { [imageNodeId]: [importedAttachment] }
      },
      historyEntryId: importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false,
      importedRootIds: [imageNodeId]
    });
    await act(async () => completion);

    await waitFor(() =>
      expect(sibling.result.current.state.nodesById[imageNodeId]).toMatchObject({
        id: imageNodeId,
        nodeKind: "image"
      })
    );
    expect(sibling.result.current.state.attachmentsByNodeId[imageNodeId]).toEqual(
      [importedAttachment]
    );
    expect(sibling.result.current.canUndo).toBe(true);
    const committedEntryId = importImageNodePaths.mock.calls[0]?.[2]?.entryId;
    expect(notesHistorySpies.discard).not.toHaveBeenCalledWith(committedEntryId);
    expect(notesHistorySpies.acceptMutationResult).toHaveBeenCalledWith(
      committedEntryId,
      expect.anything(),
      expect.anything()
    );
    sibling.unmount();
  });

  it.each(["starred", "tags"] as const)(
    "projects an ownerless image import through its captured %s scope",
    async (scopeKind) => {
      const root = node({
        id: "root",
        title: scopeKind === "tags" ? "#Work root" : "Root",
        isStarred: scopeKind === "starred"
      });
      const outside = node({ id: "outside", sortKey: 2048 });
      const imageNodeId = "72100000-0000-4000-8000-000000000001";
      const attachmentId = "72100000-0000-4000-8000-000000000002";
      createNoteIdMock
        .mockReturnValueOnce(imageNodeId)
        .mockReturnValueOnce(attachmentId);
      const importResponse = deferred<NotesMutationResult>();
      const importImageNodePaths = vi.fn().mockReturnValue(importResponse.promise);
      const activeWorkspace = workspace([root, outside]);
      let scopedWorkspace = workspace([root]);
      const expectedScope =
        scopeKind === "tags"
          ? {
              kind: "tags" as const,
              tags: [{ prefix: "#" as const, normalizedTag: "work" }]
            }
          : { kind: "starred" as const };
      const isExpectedScope = (scope: unknown): boolean =>
        typeof scope === "object" &&
        scope !== null &&
        "kind" in scope &&
        (scope as { kind?: unknown }).kind === scopeKind;
      const loadWorkspace = vi.fn(async (_vaultRoot, scope) =>
        isExpectedScope(scope) ? scopedWorkspace : activeWorkspace
      );
      const store = repository({
        loadWorkspace,
        importImageNodePaths,
        listTagsWithCounts: vi.fn().mockResolvedValue([
          {
            prefix: "#",
            normalizedTag: "work",
            displayTag: "Work",
            count: 1
          }
        ])
      });
      const owner = renderHook(() =>
        useNotesWorkspace({ vaultRoot: "/ownerless-import", repository: store })
      );
      await waitFor(() => expect(owner.result.current.status).toBe("ready"));
      if (scopeKind === "tags") {
        await act(async () =>
          owner.result.current.actions.toggleTagFilter({
            prefix: "#",
            normalizedTag: "work"
          })
        );
      } else {
        await act(async () =>
          owner.result.current.actions.selectLibraryView("starred")
        );
      }
      expect(
        loadWorkspace.mock.calls.filter(([, scope]) => isExpectedScope(scope))
      ).toHaveLength(1);

      act(() =>
        owner.result.current.actions.setImageImportMaxDisplayWidth(480)
      );
      const completion =
        owner.result.current.actions.importDroppedImagePaths!(root.id, [
          "/incoming/captured.png"
        ]);
      await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());
      owner.unmount();
      scopedWorkspace = workspace([
        root,
        node({
          id: "projected-filtered-image",
          nodeKind: "image",
          sortKey: 2048,
          title: "captured.png",
          isStarred: scopeKind === "starred"
        })
      ]);
      importResponse.resolve({
        workspace: {
          nodes: [
            root,
            outside,
            node({
              id: imageNodeId,
              nodeKind: "image",
              sortKey: 3072,
              title: "captured.png"
            })
          ]
        },
        historyEntryId: importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [imageNodeId]
      });
      await act(async () => completion);

      const scopedCalls = loadWorkspace.mock.calls.filter(([, scope]) =>
        isExpectedScope(scope)
      );
      expect(scopedCalls).toHaveLength(2);
      expect(scopedCalls[1]?.[1]).toEqual(expectedScope);
      expect(notesHistorySpies.discard).not.toHaveBeenCalledWith(
        importImageNodePaths.mock.calls[0]?.[2]?.entryId
      );
      expect(notesHistorySpies.acceptMutationResult).toHaveBeenCalledWith(
        importImageNodePaths.mock.calls[0]?.[2]?.entryId,
        expect.anything(),
        expect.anything()
      );
    }
  );

  it("keeps a dirty-barrier image projection in its captured tag scope across a vault reset", async () => {
    const root = node({ id: "root", title: "#Work root" });
    const outside = node({ id: "outside", sortKey: 2048 });
    const imageNodeId = "72400000-0000-4000-8000-000000000001";
    const attachmentId = "72400000-0000-4000-8000-000000000002";
    createNoteIdMock
      .mockReturnValueOnce(imageNodeId)
      .mockReturnValueOnce(attachmentId);
    const rawImage = node({
      id: imageNodeId,
      nodeKind: "image",
      sortKey: 3072,
      title: "raw-active.png"
    });
    const projectedImage = node({
      id: imageNodeId,
      nodeKind: "image",
      sortKey: 2048,
      title: "#Work projected.png"
    });
    const importedAttachment = attachment({
      id: attachmentId,
      nodeId: imageNodeId,
      originalName: "projected.png"
    });
    const activeWorkspace = workspace([root, outside]);
    const staleFilteredWorkspace = workspace([root]);
    const projectedFilteredWorkspace: NotesWorkspace = {
      nodes: [root, projectedImage],
      attachmentsByNodeId: { [imageNodeId]: [importedAttachment] }
    };
    const draftWrite = deferred<NotesWorkspace>();
    const importResponse = deferred<NotesMutationResult>();
    let nextTagProjection: NotesWorkspace | null = null;
    const loadWorkspace = vi.fn(async (loadedVaultRoot, scope) => {
      if (loadedVaultRoot === "/scope-new") {
        return workspace([node({ id: "new-root" })]);
      }
      if (scope.kind === "tags") {
        if (nextTagProjection) {
          const projection = nextTagProjection;
          nextTagProjection = null;
          return projection;
        }
        return staleFilteredWorkspace;
      }
      return activeWorkspace;
    });
    const importImageNodePaths = vi.fn().mockReturnValue(importResponse.promise);
    const store = repository({
      loadWorkspace,
      updateNode: vi.fn().mockReturnValue(draftWrite.promise),
      importImageNodePaths,
      listTagsWithCounts: vi.fn().mockResolvedValue([
        {
          prefix: "#",
          normalizedTag: "work",
          displayTag: "Work",
          count: 1
        }
      ])
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/scope-old", repository: store })
    );
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));
    await act(async () =>
      sibling.result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    const owner = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/scope-old" } }
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    expect(owner.result.current.activeTagFilters).toEqual([
      { prefix: "#", normalizedTag: "work" }
    ]);

    act(() => {
      owner.result.current.actions.setImageImportMaxDisplayWidth(480);
      owner.result.current.actions.updateNodeDraft(root.id, {
        title: "#Work edited",
        note: ""
      });
    });
    let importCompletion!: Promise<void>;
    act(() => {
      importCompletion =
        owner.result.current.actions.importDroppedImagePaths!(root.id, [
          "/incoming/projected.png"
        ]);
    });
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());
    expect(importImageNodePaths).not.toHaveBeenCalled();

    draftWrite.resolve(activeWorkspace);
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());
    const exposedFilters = owner.result.current.activeTagFilters as Array<{
      prefix: "#" | "@";
      normalizedTag: string;
    }>;
    exposedFilters[0]!.normalizedTag = "changed-by-alias";
    owner.rerender({ vaultRoot: "/scope-new" });
    await waitFor(() =>
      expect(owner.result.current.state.nodesById["new-root"]).toBeDefined()
    );

    const oldTagLoadsBeforeProjection = loadWorkspace.mock.calls.filter(
      ([loadedVaultRoot, scope]) =>
        loadedVaultRoot === "/scope-old" && scope.kind === "tags"
    ).length;
    nextTagProjection = projectedFilteredWorkspace;
    importResponse.resolve({
      workspace: {
        nodes: [root, outside, rawImage],
        attachmentsByNodeId: { [imageNodeId]: [importedAttachment] }
      },
      historyEntryId: importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false,
      importedRootIds: [imageNodeId]
    });
    await act(async () => importCompletion);

    await waitFor(() =>
      expect(sibling.result.current.state.nodesById[imageNodeId]?.title).toBe(
        projectedImage.title
      )
    );
    expect(
      loadWorkspace.mock.calls.filter(
        ([loadedVaultRoot, scope]) =>
          loadedVaultRoot === "/scope-old" && scope.kind === "tags"
      )
    ).toHaveLength(oldTagLoadsBeforeProjection + 1);
    expect(sibling.result.current.state.nodesById.outside).toBeUndefined();

    owner.unmount();
    sibling.unmount();
  });

  it.each(["starred", "tags"] as const)(
    "refreshes a failed Active image retry to the current %s scope before owner unmount",
    async (scopeKind) => {
      const target = node({
        id: "root",
        title: scopeKind === "tags" ? "#Work target" : "Target",
        isStarred: scopeKind === "starred"
      });
      const outside = node({ id: "outside", sortKey: 2048 });
      const imageNodeId = "72300000-0000-4000-8000-000000000001";
      const attachmentId = "72300000-0000-4000-8000-000000000002";
      createNoteIdMock
        .mockReturnValueOnce(imageNodeId)
        .mockReturnValueOnce(attachmentId);
      const importedAttachment = attachment({
        id: attachmentId,
        nodeId: imageNodeId,
        originalName: "retried.png"
      });
      const rawImportedImage = node({
        id: imageNodeId,
        nodeKind: "image",
        sortKey: 3072,
        title: "raw-active.png"
      });
      const filteredImportedImage = node({
        id: imageNodeId,
        nodeKind: "image",
        sortKey: 3072,
        title: scopeKind === "tags" ? "#Work retried.png" : "retried.png",
        isStarred: scopeKind === "starred"
      });
      const activeWorkspace = workspace([target, outside]);
      let scopedWorkspace: NotesWorkspace = workspace([target]);
      const retryResponse = deferred<NotesMutationResult>();
      const importImageNodePaths = vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary import failure"))
        .mockReturnValueOnce(retryResponse.promise);
      const expectedScope =
        scopeKind === "tags"
          ? {
              kind: "tags" as const,
              tags: [{ prefix: "#" as const, normalizedTag: "work" }]
            }
          : { kind: "starred" as const };
      const loadWorkspace = vi.fn(async (_vaultRoot, scope) =>
        scope.kind === scopeKind ? scopedWorkspace : activeWorkspace
      );
      const store = repository({
        loadWorkspace,
        importImageNodePaths,
        listTagsWithCounts: vi.fn().mockResolvedValue([
          {
            prefix: "#",
            normalizedTag: "work",
            displayTag: "Work",
            count: 1
          }
        ])
      });
      const vaultRoot = `/retry-current-${scopeKind}`;
      const sibling = renderHook(() =>
        useNotesWorkspace({ vaultRoot, repository: store })
      );
      const owner = renderHook(() =>
        useNotesWorkspace({ vaultRoot, repository: store })
      );
      await waitFor(() => {
        expect(owner.result.current.status).toBe("ready");
        expect(sibling.result.current.status).toBe("ready");
      });

      act(() =>
        owner.result.current.actions.setImageImportMaxDisplayWidth(480)
      );
      await act(async () =>
        owner.result.current.actions.importDroppedImagePaths!(target.id, [
          "/incoming/retried.png"
        ])
      );
      const retryAttemptId =
        owner.result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
          target.id
        ];
      expect(retryAttemptId).toBeDefined();

      if (scopeKind === "tags") {
        await act(async () => {
          await owner.result.current.actions.toggleTagFilter({
            prefix: "#",
            normalizedTag: "work"
          });
        });
      } else {
        await act(async () => {
          await owner.result.current.actions.selectLibraryView("starred");
        });
      }
      expect(owner.result.current.state.nodesById[target.id]).toBeDefined();
      expect(sibling.result.current.state.nodesById[target.id]).toBeDefined();
      loadWorkspace.mockClear();
      scopedWorkspace = {
        nodes: [target, filteredImportedImage],
        attachmentsByNodeId: { [imageNodeId]: [importedAttachment] }
      };

      let retryCompletion!: Promise<void>;
      act(() => {
        retryCompletion = owner.result.current.actions.retryImageUpload!(
          target.id,
          retryAttemptId
        );
      });
      await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(2));
      expect(importImageNodePaths.mock.calls[1]?.[1]).toEqual(
        importImageNodePaths.mock.calls[0]?.[1]
      );
      expect(importImageNodePaths.mock.calls[1]?.[2]).toBe(
        importImageNodePaths.mock.calls[0]?.[2]
      );
      expect(createNoteIdMock).toHaveBeenCalledTimes(2);
      owner.unmount();
      await act(async () => {
        retryResponse.resolve({
          workspace: {
            nodes: [target, outside, rawImportedImage],
            attachmentsByNodeId: { [imageNodeId]: [importedAttachment] }
          },
          historyEntryId:
            importImageNodePaths.mock.calls[1]?.[2]?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [imageNodeId]
        });
        await retryCompletion;
      });

      expect(loadWorkspace).toHaveBeenCalledOnce();
      expect(loadWorkspace).toHaveBeenCalledWith(vaultRoot, expectedScope);
      await waitFor(() =>
        expect(sibling.result.current.state.rootIds).toEqual([
          target.id,
          imageNodeId
        ])
      );
      expect(sibling.result.current.state.nodesById.outside).toBeUndefined();
      expect(sibling.result.current.state.nodesById[imageNodeId]?.title).toBe(
        filteredImportedImage.title
      );
      sibling.unmount();
    }
  );

  it("invalidates and reloads a filtered sibling when an ownerless image import projection fails", async () => {
    const root = node({ id: "root", isStarred: true });
    const outside = node({ id: "outside", sortKey: 2048 });
    const imageNodeId = "72200000-0000-4000-8000-000000000001";
    const attachmentId = "72200000-0000-4000-8000-000000000002";
    createNoteIdMock
      .mockReturnValueOnce(imageNodeId)
      .mockReturnValueOnce(attachmentId);
    const importResponse = deferred<NotesMutationResult>();
    const importImageNodePaths = vi.fn().mockReturnValue(importResponse.promise);
    const activeWorkspace = workspace([root, outside]);
    const initialStarred = workspace([root]);
    const safeReload = workspace([node({ id: "safe-starred", isStarred: true })]);
    let starredLoads = 0;
    const loadWorkspace = vi.fn(async (_vaultRoot, scope) => {
      if (scope?.kind !== "starred") {
        return activeWorkspace;
      }
      starredLoads += 1;
      if (starredLoads === 3) {
        throw new Error("projection failed");
      }
      return starredLoads >= 4 ? safeReload : initialStarred;
    });
    const store = repository({
      loadWorkspace,
      importImageNodePaths
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/ownerless-projection-failure", repository: store })
    );
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));
    await act(async () =>
      sibling.result.current.actions.selectLibraryView("starred")
    );
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/ownerless-projection-failure", repository: store })
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    await act(async () => owner.result.current.actions.selectLibraryView("starred"));

    act(() =>
      owner.result.current.actions.setImageImportMaxDisplayWidth(480)
    );
    const completion =
      owner.result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/failing-projection.png"
      ]);
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());
    owner.unmount();
    importResponse.resolve({
      workspace: {
        nodes: [
          root,
          outside,
          node({
            id: imageNodeId,
            nodeKind: "image",
            sortKey: 3072,
            title: "failing-projection.png"
          })
        ]
      },
      historyEntryId: importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false,
      importedRootIds: [imageNodeId]
    });
    await act(async () => completion);

    await waitFor(() =>
      expect(sibling.result.current.state.rootIds).toEqual(["safe-starred"])
    );
    expect(starredLoads).toBe(4);
    expect(sibling.result.current.state.nodesById.outside).toBeUndefined();
    expect(sibling.result.current.state.nodesById[imageNodeId]).toBeUndefined();
    sibling.unmount();
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
        { draft: { title: "prefixsuffix", note: "saved note" } }
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
        { draft: { title: "prefixsuffix", note: "saved note" } }
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
            { draft: { title: "edited", note: "" } }
          );
        } else if (operation === "move") {
          await result.current.actions.moveNode(
            { id: "source", parentId: "target", afterId: null },
            "source",
            { draft: { title: "edited", note: "" } }
          );
        } else {
          await result.current.actions.removeEmptyNode("source", "target", {
            draft: { title: "", note: "" }
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
        { draft: { title: "prefixsuffix", note: "saved note" } }
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
    createNoteIdMock.mockReturnValueOnce("new-root").mockReturnValueOnce("new-child");
    const store = repository({
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
    });
    const { result } = renderHook(() => useNotesWorkspace({ vaultRoot: "/vault", repository: store }));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    await act(async () => result.current.actions.createRoot());
    expect(store.createNode).toHaveBeenNthCalledWith(
      1,
      "/vault",
      {
        id: "new-root",
        parentId: null,
        afterId: "parent",
        title: "",
        note: ""
      },
      historyContext("create")
    );
    expect(result.current.state.nodesById["new-root"]).toBeDefined();
    expect(result.current.state).toMatchObject({
      selectedId: "new-root",
      editingNoteId: "new-root",
      pendingFocusId: "new-root"
    });

    await act(async () => result.current.actions.createChild("parent"));
    expect(store.createNode).toHaveBeenNthCalledWith(
      2,
      "/vault",
      {
        id: "new-child",
        parentId: "parent",
        afterId: "existing-child",
        title: "",
        note: ""
      },
      historyContext("create")
    );
    expect(result.current.state.childIdsByParent.parent).toEqual(["new-child"]);
    expect(result.current.state).toMatchObject({
      selectedId: "new-child",
      editingNoteId: "new-child",
      pendingFocusId: "new-child"
    });
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
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "initial", sortKey: 1 })])),
      createNode: vi
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
      firstCompletion = result.current.actions.createRoot();
      secondCompletion = result.current.actions.createRoot();
    });

    await waitFor(() => expect(createNoteIdMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(store.createNode).toHaveBeenCalledOnce());
    expect(store.createNode).toHaveBeenNthCalledWith(
      1,
      "/vault",
      {
        id: "new-root-1",
        parentId: null,
        afterId: "initial",
        title: "",
        note: ""
      },
      historyContext("create")
    );

    await act(async () =>
      first.resolve(workspace([
        node({ id: "initial", sortKey: 1 }),
        node({ id: "new-root-1", sortKey: 2 })
      ]))
    );
    expect(createNoteIdMock).toHaveBeenCalledTimes(2);
    expect(store.createNode).toHaveBeenCalledTimes(2);
    expect(store.createNode).toHaveBeenNthCalledWith(
      2,
      "/vault",
      {
        id: "new-root-2",
        parentId: null,
        afterId: "new-root-1",
        title: "",
        note: ""
      },
      historyContext("create")
    );

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
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
      createNode: vi
        .fn()
        .mockReturnValueOnce(parentCreation.promise)
        .mockReturnValueOnce(childCreation.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let parentCompletion!: Promise<unknown>;
    let childCompletion!: Promise<unknown>;
    act(() => {
      parentCompletion = result.current.actions.createRoot();
      childCompletion = result.current.actions.createChild("new-parent");
    });

    await waitFor(() => expect(store.createNode).toHaveBeenCalledOnce());
    await act(async () =>
      parentCreation.resolve(workspace([node({ id: "new-parent" })]))
    );
    expect(store.createNode).toHaveBeenNthCalledWith(
      2,
      "/vault",
      {
        id: "new-child",
        parentId: "new-parent",
        afterId: null,
        title: "",
        note: ""
      },
      historyContext("create")
    );

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
      });
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
      });
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
      });
    });
    await act(async () => result.current.actions.flushNodeDraft("root"));
    await waitFor(() => expect(listTagsWithCounts).toHaveBeenCalledOnce());

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "No tag",
        note: ""
      });
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
      });
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
      });
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
      });
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
      });
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
      });
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
      });
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
      });
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
      });
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
      });
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
      });
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
    const store = repository({
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
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft(
        "source",
        { title: "source e", note: "" },
        "title"
      );
      result.current.actions.updateNodeDraft(
        "source",
        { title: "source edited", note: "" },
        "title"
      );
    });
    await act(async () =>
      result.current.actions.splitNode("source", "split", "source", " edited")
    );

    const textContext = vi.mocked(store.updateNode).mock.calls[0]?.[2];
    const splitContext = vi.mocked(store.splitNode).mock.calls[0]?.[2];
    expect(textContext).toMatchObject({ commandKind: "text" });
    expect(splitContext).toMatchObject({ commandKind: "split" });
    expect(textContext?.sessionId).toBe(splitContext?.sessionId);
    expect(textContext?.entryId).not.toBe(splitContext?.entryId);
    expect(textContext?.entryId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(textContext?.entryId).not.toBe("source");
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
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      splitNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft(
        "draft",
        { title: "first", note: "" },
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
        { title: "second", note: "" },
        "title"
      );
    });
    await act(async () => firstWrite.resolve(initial));
    await act(async () => structural);
    await act(async () => result.current.actions.flushAllDrafts());

    expect(updateNode).toHaveBeenCalledTimes(2);
    expect(splitNode.mock.invocationCallOrder[0]).toBeLessThan(
      updateNode.mock.invocationCallOrder[1]!
    );
    expect(updateNode.mock.calls[0]?.[2]?.entryId).not.toBe(
      updateNode.mock.calls[1]?.[2]?.entryId
    );
    expect(updateNode.mock.calls[1]?.[2]?.entryId).not.toBe(
      splitNode.mock.calls[0]?.[2]?.entryId
    );
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
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      toggleStar
    });
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

    act(() => {
      first.result.current.actions.updateNodeDraft(
        "draft",
        { title: "first", note: "" },
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
        { title: "second", note: "" },
        "title"
      );
    });
    await act(async () => firstWrite.resolve(initial));
    await act(async () => structural);
    await act(async () => first.result.current.actions.flushAllDrafts());

    expect(updateNode).toHaveBeenCalledTimes(2);
    expect(toggleStar.mock.invocationCallOrder[0]).toBeLessThan(
      updateNode.mock.invocationCallOrder[1]!
    );
    expect(updateNode.mock.calls[0]?.[2]?.entryId).not.toBe(
      updateNode.mock.calls[1]?.[2]?.entryId
    );

    act(() => {
      first.result.current.actions.updateNodeDraft(
        "draft",
        { title: "after", note: "" },
        "title"
      );
    });
    await act(async () => first.result.current.actions.flushAllDrafts());
    expect(toggleStar.mock.invocationCallOrder[0]).toBeLessThan(
      updateNode.mock.invocationCallOrder[2]!
    );
    expect(updateNode.mock.calls[2]?.[2]?.entryId).not.toBe(
      updateNode.mock.calls[1]?.[2]?.entryId
    );
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
      });
      second.result.current.actions.updateNodeDraft("draft-b", {
        title: "blocked",
        note: ""
      });
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
      });
      first.result.current.actions.updateNodeDraft("draft-a", {
        title: "third",
        note: ""
      });
      first.result.current.actions.updateNodeDraft("draft-a", {
        title: "latest",
        note: ""
      });
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
        { title: "blocking", note: "" },
        "title"
      );
      blockerFlush = result.current.actions.flushNodeDraft("blocker");
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
    act(() => {
      result.current.actions.updateNodeDraft(
        "root",
        { title: "pre-cutoff", note: "before note" },
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
        { title: "title edit", note: "before note" },
        "title"
      );
      result.current.actions.updateNodeDraft(
        "root",
        { title: "title edit", note: "note edit" },
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
        });
        blockerFlush = result.current.actions.flushNodeDraft("blocker");
      });
      await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
      act(() => {
        result.current.actions.updateNodeDraft(
          "root",
          { title: "", note: "" },
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
          { title: "title edit", note: "" },
          "title"
        );
        result.current.actions.updateNodeDraft(
          "root",
          { title: "title edit", note: "note edit" },
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
      });
    });
    await act(async () => editor.result.current.actions.flushNodeDraft("root"));
    act(() => {
      blocker.result.current.actions.updateNodeDraft("blocker", {
        title: "blocking",
        note: ""
      });
    });
    const structural = requester.result.current.actions.toggleStar("target");
    await waitFor(() =>
      expect(order.at(-1)).toBe("update:blocker:blocking")
    );
    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "after click",
        note: "after note"
      });
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
      });
    });
    await act(async () => editor.result.current.actions.flushNodeDraft("root"));
    act(() => {
      blocker.result.current.actions.updateNodeDraft("blocker", {
        title: "blocking",
        note: ""
      });
    });
    const structural = requester.result.current.actions.toggleStar("target");
    await waitFor(() =>
      expect(order.at(-1)).toBe("update:blocker:blocking")
    );
    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "new value",
        note: "new note"
      });
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
      });
    });
    await act(async () => editor.result.current.actions.flushNodeDraft("root"));
    act(() => {
      blocker.result.current.actions.updateNodeDraft("blocker", {
        title: "blocking",
        note: ""
      });
    });
    const structural = requester.result.current.actions.toggleStar("target");
    await waitFor(() =>
      expect(order.at(-1)).toBe("update:blocker:blocking")
    );
    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "post-click value",
        note: "post-click note"
      });
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
      });
    });
    await act(async () => editor.result.current.actions.flushNodeDraft("root"));
    act(() => {
      editor.result.current.actions.updateNodeDraft("blocker", {
        title: "blocking",
        note: ""
      });
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
    const updateNode = vi.fn(async (_vaultRoot, _input, context) =>
      mutationResult(updated, context)
    );
    const undo = vi.fn().mockImplementation(async () =>
      appliedReplay(
        initial,
        updateNode.mock.calls[0]?.[2]?.entryId ?? null,
        "undo"
      )
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.actions.focusNode("root");
      await result.current.actions.zoomTo("root");
    });
    act(() => {
      result.current.actions.updateNodeDraft(
        "root",
        { title: "before", note: "supporting" },
        "note"
      );
    });
    let replay!: Promise<unknown>;
    act(() => {
      replay = result.current.actions.undo!();
    });
    await act(async () => replay);

    expect(updateNode.mock.invocationCallOrder[0]).toBeLessThan(
      undo.mock.invocationCallOrder[0]!
    );
    expect(undo).toHaveBeenCalledWith("/vault", {
      sessionId: updateNode.mock.calls[0]?.[2]?.sessionId,
      historyEpoch: "epoch-a",
      expectedEntryId: updateNode.mock.calls[0]?.[2]?.entryId,
      scope: { kind: "active" }
    });
    expect(result.current.state).toMatchObject({
      selectedId: "root",
      zoomRootId: "root",
      pendingFocusId: "root",
      pendingFocusField: "note"
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
        { title: "title edit", note: "before note" },
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
        { title: "title edit", note: "note edit" },
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
      });
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
      });
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
      });
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
    const store = repository({
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
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() =>
      expect(result.current.state.nodesById["old-root"]).toBeDefined()
    );

    act(() => {
      result.current.actions.updateNodeDraft("old-root", {
        title: "Recovered old draft",
        note: ""
      });
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

    expect(vi.mocked(store.updateNode).mock.calls[1]?.[2]?.entryId).not.toBe(
      vi.mocked(store.updateNode).mock.calls[0]?.[2]?.entryId
    );

    expect(store.updateNode).toHaveBeenNthCalledWith(
      2,
      "/old",
      {
        id: "old-root",
        title: "Recovered old draft",
        note: "",
        imageOffsetUtf16: 0
      },
      historyContext("text")
    );
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
      });
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
    const store = repository({
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
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());

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

    expect(store.loadWorkspace).toHaveBeenCalledOnce();
    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(secondMount.result.current.state.rootIds).toEqual([]);

    await act(async () => {
      running.resolve(workspace([node({ id: "a1-response" })]));
      await firstCompletion;
    });
    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledTimes(2));
    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(secondMount.result.current.state.rootIds).toEqual(["a1-response"]);

    await act(async () =>
      refresh.resolve(workspace([node({ id: "after-a1" })]))
    );
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledTimes(2));
    await act(async () => {
      await newCompletion;
      await oldQueuedCompletion;
    });

    expect(store.updateNode).toHaveBeenNthCalledWith(
      1,
      "/vault-a",
      { id: "before-a1", title: "A1", note: "", imageOffsetUtf16: 0 },
      historyContext("update")
    );
    expect(store.updateNode).toHaveBeenNthCalledWith(
      2,
      "/vault-a",
      { id: "a1-response", title: "A3", note: "", imageOffsetUtf16: 0 },
      historyContext("update")
    );
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
    const store = repository({
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
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());

    rerender({ vaultRoot: "/vault-b" });
    await waitFor(() => expect(result.current.state.nodesById["b-root"]).toBeDefined());
    await act(async () =>
      result.current.actions.updateNode("b-root", { title: "B1", note: "" })
    );
    expect(store.updateNode).toHaveBeenNthCalledWith(
      2,
      "/vault-b",
      { id: "b-root", title: "B1", note: "", imageOffsetUtf16: 0 },
      historyContext("update")
    );

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
    expect(store.updateNode).toHaveBeenCalledTimes(2);

    await act(async () =>
      refreshedA.resolve(workspace([node({ id: "after-a1" })]))
    );
    await act(async () => a3Completion);

    expect(store.updateNode).toHaveBeenNthCalledWith(
      3,
      "/vault-a",
      { id: "a1-response", title: "A3", note: "", imageOffsetUtf16: 0 },
      historyContext("update")
    );
    expect(result.current.state.nodesById["a3-updated"]).toBeDefined();
    expect(result.current.state.nodesById["a-before"]).toBeUndefined();
  });

  it("keeps the committed identity active when a different render is abandoned", async () => {
    const firstCommand = deferred<NotesWorkspace>();
    const suspended = deferred<void>();
    const store = repository({
      updateNode: vi
        .fn()
        .mockReturnValueOnce(firstCommand.promise)
        .mockResolvedValueOnce(workspace([node({ id: "second-a-result" })]))
    });
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
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());

    rerender({ vaultRoot: "/vault-b", shouldSuspend: true });
    expect(store.initialize).toHaveBeenCalledOnce();

    await act(async () => {
      firstCommand.resolve(workspace([
        node({ id: "root" }),
        node({ id: "first-a-result" })
      ]));
      await Promise.all([firstCompletion, secondCompletion]);
    });

    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(store.updateNode).toHaveBeenNthCalledWith(
      2,
      "/vault-a",
      { id: "root", title: "committed-A2", note: "", imageOffsetUtf16: 0 },
      historyContext("update")
    );
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
    const store = repository({
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
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.rootIds).toEqual([
      "first",
      "second",
      "third"
    ]));

    act(() => {
      void result.current.actions.zoomTo("second");
      result.current.actions.updateNodeDraft("second-child", {
        title: "Saved before archive",
        note: ""
      });
    });
    await act(async () => result.current.actions.archiveNode("second"));

    expect(store.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "second-child",
        title: "Saved before archive",
        note: "",
        imageOffsetUtf16: 0
      },
      historyContext("text")
    );
    expect(store.archiveNode).toHaveBeenCalledWith(
      "/vault",
      "second",
      historyContext("archive")
    );
    expect(
      vi.mocked(store.updateNode).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(store.archiveNode).mock.invocationCallOrder[0]);
    expect(store.listTagsWithCounts).toHaveBeenCalledWith("/vault");
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
      selectedId: "third",
      zoomRootId: "first",
      editingNoteId: "third",
      pendingFocusId: "third"
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
      selectedId: "third",
      zoomRootId: "first",
      editingNoteId: "third",
      pendingFocusId: "third"
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

describe("scopedActiveDelta", () => {
  it("passes through changes that remain in the active scope", () => {
    const kept = node({ id: "kept", title: "kept" });
    const attachmentChange = attachment({ id: "att", nodeId: "kept" });
    expect(
      scopedActiveDelta({
        changedNodes: [kept],
        removedNodeIds: ["gone"],
        changedAttachments: [attachmentChange]
      })
    ).toEqual({
      changedNodes: [kept],
      removedNodeIds: ["gone"],
      changedAttachments: [attachmentChange]
    });
  });

  it("reclassifies soft-deleted and archived nodes as removals", () => {
    const active = node({ id: "active" });
    const trashed = node({ id: "trashed", deletedAt: "2026-07-13T00:00:00Z" });
    const archived = node({ id: "archived", archivedAt: "2026-07-13T00:00:00Z" });
    expect(
      scopedActiveDelta({
        changedNodes: [active, trashed, archived],
        removedNodeIds: [],
        changedAttachments: []
      })
    ).toEqual({
      changedNodes: [active],
      removedNodeIds: ["trashed", "archived"],
      changedAttachments: []
    });
  });

  it("drops attachments whose node left the active scope", () => {
    const trashed = node({ id: "trashed", deletedAt: "2026-07-13T00:00:00Z" });
    const orphaned = attachment({ id: "att", nodeId: "trashed" });
    expect(
      scopedActiveDelta({
        changedNodes: [trashed],
        removedNodeIds: [],
        changedAttachments: [orphaned]
      })
    ).toEqual({
      changedNodes: [],
      removedNodeIds: ["trashed"],
      changedAttachments: []
    });
  });

  it("returns undefined for an empty delta (e.g. attachment removal)", () => {
    expect(
      scopedActiveDelta({
        changedNodes: [],
        removedNodeIds: [],
        changedAttachments: []
      })
    ).toBeUndefined();
  });

  it("returns undefined when there is no delta at all", () => {
    expect(scopedActiveDelta(null)).toBeUndefined();
  });
});

describe("useNotesWorkspace incremental delta wiring", () => {
  beforeEach(() => {
    createNoteIdMock.mockReset();
  });

  afterEach(() => {
    setNotesDeltaVerificationEnabled(false);
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("applies a delta-bearing mutation without diverging from the full payload", async () => {
    setNotesDeltaVerificationEnabled(true);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const before = node({ id: "root", completedAt: null });
    const after = node({ id: "root", completedAt: "2026-07-13T00:00:00Z" });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([before])),
      toggleComplete: vi.fn().mockImplementation((_vault, _id, context) =>
        Promise.resolve({
          workspace: workspace([after]),
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          changedNodes: [after],
          removedNodeIds: [],
          changedAttachments: []
        })
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(async () => result.current.actions.toggleComplete("root"));

    expect(result.current.state.nodesById.root.completedAt).toBe(
      "2026-07-13T00:00:00Z"
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("forwards the delta to the reducer, which verifies and falls back when it diverges", async () => {
    setNotesDeltaVerificationEnabled(true);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const before = node({ id: "root", completedAt: null });
    const authoritativeAfter = node({
      id: "root",
      completedAt: "2026-07-13T00:00:00Z"
    });
    const corruptAfter = node({ id: "root", completedAt: "1999-01-01T00:00:00Z" });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([before])),
      toggleComplete: vi.fn().mockImplementation((_vault, _id, context) =>
        Promise.resolve({
          workspace: workspace([authoritativeAfter]),
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          // A delta that disagrees with the authoritative workspace: only the
          // forwarded delta path runs verification, so a surfaced error proves
          // the delta reached the reducer.
          changedNodes: [corruptAfter],
          removedNodeIds: [],
          changedAttachments: []
        })
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(async () => result.current.actions.toggleComplete("root"));

    expect(consoleError).toHaveBeenCalled();
    expect(result.current.state.nodesById.root.completedAt).toBe(
      "2026-07-13T00:00:00Z"
    );
  });
});

describe("useNotesWorkspace multi-node selection", () => {
  it("resets a frozen survivor focus to the title field", () => {
    expect(focusedUiUpdate("survivor")).toEqual({
      selectedId: "survivor",
      editingNoteId: "survivor",
      pendingFocusId: "survivor",
      pendingFocusField: "title"
    });
  });

  beforeEach(() => {
    createNoteIdMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function twoNodeStore(overrides: Partial<NotesStore> = {}): NotesStore {
    return repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(
          workspace([
            node({ id: "root", sortKey: 1 }),
            node({ id: "second", sortKey: 2 })
          ])
        ),
      ...overrides
    });
  }

  function threeSiblings(completedAt: string | null = null): NoteNode[] {
    return [
      node({ id: "a", sortKey: 1, completedAt }),
      node({ id: "b", sortKey: 2, completedAt }),
      node({ id: "c", sortKey: 3, completedAt })
    ];
  }

  function threeNodeStore(overrides: Partial<NotesStore> = {}): NotesStore {
    return repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace(threeSiblings())),
      ...overrides
    });
  }

  async function withSelectedRange(store: NotesStore = twoNodeStore()) {
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => {
      result.current.actions.setSelectionAnchor("root");
      result.current.actions.extendSelectionTo("second");
    });
    expect(result.current.selection).toEqual({
      anchorId: "root",
      headId: "second"
    });
    return { result, store };
  }

  it("toggles explicit selection in visible order and advances its revision", async () => {
    const store = threeNodeStore();
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    const visible = ["a", "b", "c"];
    const initialRevision = result.current.selectionRevision!;
    const toggleSelectionNode = result.current.actions.toggleSelectionNode;

    act(() => toggleSelectionNode("c", visible));
    expect(result.current.selection).toEqual({
      anchorId: "c",
      headId: "c",
      explicitNodeIds: ["c"]
    });
    expect(result.current.selectionRevision).toBe(initialRevision + 1);
    expect(result.current.actions.toggleSelectionNode).toBe(
      toggleSelectionNode
    );

    act(() => toggleSelectionNode("a", visible));
    expect(result.current.selection).toEqual({
      anchorId: "a",
      headId: "a",
      explicitNodeIds: ["a", "c"]
    });
    expect(result.current.selectionRevision).toBe(initialRevision + 2);
    expect(result.current.actions.toggleSelectionNode).toBe(
      toggleSelectionNode
    );
  });

  it("clears the selection when the caret moves (focusNode)", async () => {
    const { result } = await withSelectedRange();
    await act(async () => result.current.actions.focusNode("second"));
    expect(result.current.selection).toBeNull();
  });

  it("clears the selection on zoom", async () => {
    const { result } = await withSelectedRange();
    await act(async () => result.current.actions.zoomTo("second"));
    expect(result.current.selection).toBeNull();
  });

  it("clears the selection on a structural mutation", async () => {
    const { result } = await withSelectedRange();
    await act(async () => result.current.actions.toggleComplete("root"));
    expect(result.current.selection).toBeNull();
  });

  it("clears the selection when typing into a node", async () => {
    const { result } = await withSelectedRange();
    act(() =>
      result.current.actions.updateNodeDraft("root", {
        title: "typed",
        note: ""
      })
    );
    expect(result.current.selection).toBeNull();
  });

  it("preserves the selection across a silent draft autosave", async () => {
    const store = twoNodeStore({
      updateNode: vi.fn().mockResolvedValue({
        workspace: workspace([
          node({ id: "root", sortKey: 1, title: "typed" }),
          node({ id: "second", sortKey: 2 })
        ]),
        historyEntryId: null,
        ...historyState(),
        canUndo: false,
        canRedo: false
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    // Typing schedules a draft AND collapses any prior selection; establish the
    // range only afterward so the pending autosave post-dates it.
    act(() =>
      result.current.actions.updateNodeDraft("root", {
        title: "typed",
        note: ""
      })
    );
    act(() => {
      result.current.actions.setSelectionAnchor("root");
      result.current.actions.extendSelectionTo("second");
    });
    expect(result.current.selection).not.toBeNull();

    // A silent draft flush settles the authoritative workspace but must not
    // disturb the selection reducer (no "pending" event, no clear).
    await act(async () => {
      await result.current.actions.flushNodeDraft("root");
    });
    expect(store.updateNode).toHaveBeenCalled();
    expect(result.current.selection).toEqual({
      anchorId: "root",
      headId: "second"
    });
  });

  it("applies a completion batch to the whole selection as a single history entry", async () => {
    const applyBatch = vi.fn((_vaultRoot, _input, context) =>
      Promise.resolve({
        workspace: workspace(threeSiblings("2026-07-10T01:00:00Z")),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      })
    );
    const store = threeNodeStore({ applyBatch });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => {
      result.current.actions.setSelectionAnchor("a");
      result.current.actions.extendSelectionTo("c");
    });

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.actions.applyBatch(["a", "b", "c"], {
        type: "complete",
        completed: true
      });
    });

    expect(outcome).toBe("committed");
    expect(applyBatch).toHaveBeenCalledTimes(1);
    expect(applyBatch).toHaveBeenCalledWith(
      "/vault",
      { op: "complete", nodeIds: ["a", "b", "c"], completed: true },
      historyContext("batch")
    );
    // One backend call carrying one history entry id: undo will revert it in one
    // step.
    expect(result.current).toMatchObject({ canUndo: true, canRedo: false });
    // The command's loading dispatch collapses the live selection.
    expect(result.current.selection).toBeNull();
  });

  it("forwards duplicate and exact tag batch operations without decomposing the selection", async () => {
    const applyBatch = vi.fn((_vaultRoot, _input, context) =>
      Promise.resolve({
        workspace: workspace(threeSiblings()),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      })
    );
    const store = threeNodeStore({ applyBatch });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(async () => {
      await result.current.actions.applyBatch(["a", "b"], {
        type: "duplicate"
      });
      await result.current.actions.applyBatch(["a", "b"], {
        type: "addTag",
        tag: {
          prefix: "#",
          normalizedTag: "launch",
          displayTag: "Launch"
        }
      });
      await result.current.actions.applyBatch(["a", "b"], {
        type: "removeTag",
        tag: { prefix: "@", normalizedTag: "owner" }
      });
    });

    expect(applyBatch).toHaveBeenCalledTimes(3);
    expect(applyBatch).toHaveBeenNthCalledWith(
      1,
      "/vault",
      { op: "duplicate", nodeIds: ["a", "b"] },
      historyContext("batch")
    );
    expect(applyBatch).toHaveBeenNthCalledWith(
      2,
      "/vault",
      {
        op: "addTag",
        nodeIds: ["a", "b"],
        tag: {
          prefix: "#",
          normalizedTag: "launch",
          displayTag: "Launch"
        }
      },
      historyContext("batch")
    );
    expect(applyBatch).toHaveBeenNthCalledWith(
      3,
      "/vault",
      {
        op: "removeTag",
        nodeIds: ["a", "b"],
        tag: { prefix: "@", normalizedTag: "owner" }
      },
      historyContext("batch")
    );
  });

  it("recomputes aggregate completion from the confirmed workspace at batch execution", async () => {
    const completedAt = "2026-07-10T01:00:00Z";
    const applyBatch = vi.fn((_vaultRoot, _input, context) =>
      Promise.resolve({
        workspace: workspace(threeSiblings()),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      })
    );
    const store = threeNodeStore({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace(threeSiblings(completedAt))),
      applyBatch
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(async () => {
      // The stale caller hint deliberately says "complete". All confirmed
      // targets are already complete, so queue-time aggregate resolution must
      // send completed:false instead.
      await result.current.actions.applyBatch(["a", "b", "c"], {
        type: "complete",
        completed: true
      });
    });

    expect(applyBatch).toHaveBeenCalledWith(
      "/vault",
      {
        op: "complete",
        nodeIds: ["a", "b", "c"],
        completed: false
      },
      historyContext("batch")
    );
  });

  it("recomputes completion after earlier queued work changes the confirmed workspace", async () => {
    const earlier = deferred<NotesMutationResult>();
    const updateNode = vi.fn((_vaultRoot, _input, _context) => earlier.promise);
    const applyBatch = vi.fn((_vaultRoot, _input, context) =>
      Promise.resolve({
        workspace: workspace(threeSiblings()),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      })
    );
    const store = threeNodeStore({ updateNode, applyBatch });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    let earlierCompletion!: Promise<unknown>;
    let batchCompletion!: Promise<unknown>;
    act(() => {
      earlierCompletion = result.current.actions.updateNode("a", {
        title: "updated",
        note: ""
      });
      batchCompletion = result.current.actions.applyBatch(["a", "b", "c"], {
        type: "complete",
        completed: true
      });
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledTimes(1));
    await act(async () => {
      earlier.resolve({
        workspace: workspace(threeSiblings("2026-07-10T01:00:00Z")),
        historyEntryId: updateNode.mock.calls[0]?.[2]?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      });
      await earlierCompletion;
      await batchCompletion;
    });

    expect(applyBatch).toHaveBeenCalledWith(
      "/vault",
      {
        op: "complete",
        nodeIds: ["a", "b", "c"],
        completed: false
      },
      historyContext("batch")
    );
  });

  it("skips the whole batch when any frozen target has vanished", async () => {
    const applyBatch = vi.fn();
    const store = threeNodeStore({ applyBatch });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.actions.applyBatch(["a", "missing"], {
        type: "delete"
      });
    });

    expect(outcome).toBe("skipped");
    expect(applyBatch).not.toHaveBeenCalled();
  });

  it("preserves duplicatedRootIds while unwrapping a batch mutation", () => {
    expect(
      unwrapNotesMutation({
        workspace: workspace(threeSiblings()),
        historyEntryId: "entry",
        ...historyState(),
        canUndo: true,
        canRedo: false,
        duplicatedRootIds: ["copy-a", "copy-b"]
      }).duplicatedRootIds
    ).toEqual(["copy-a", "copy-b"]);
  });

  it("prepares an immutable full Active selection authority including attachments", async () => {
    const selectedAttachment = attachment({ id: "image-a", nodeId: "a" });
    const activeWorkspace: NotesWorkspace = {
      nodes: threeSiblings(),
      attachmentsByNodeId: { a: [selectedAttachment] }
    };
    const store = threeNodeStore({
      loadWorkspace: vi.fn().mockResolvedValue(activeWorkspace)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => {
      result.current.actions.setSelectionAnchor("a");
      result.current.actions.extendSelectionTo("b");
    });

    const prepared = await act(async () =>
      result.current.prepareSelectionAuthority!(["a", "b"])
    );

    expect(prepared).toMatchObject({
      vaultRoot: "/vault",
      scope: { kind: "active" },
      selectedNodeIds: ["a", "b"]
    });
    expect(prepared.workspace.rootIds).toEqual(["a", "b", "c"]);
    expect(prepared.workspace.attachmentsByNodeId.a).toEqual([
      selectedAttachment
    ]);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.selectedNodeIds)).toBe(true);
    expect(Object.isFrozen(prepared.workspace)).toBe(true);
    expect(Object.isFrozen(prepared.workspace.nodesById.a)).toBe(true);
    expect(
      Object.isFrozen(prepared.workspace.attachmentsByNodeId.a)
    ).toBe(true);
    expect(result.current.isPreparedSelectionAuthorityCurrent!(prepared)).toBe(
      true
    );
  });

  it("prepares full Active authority while the visible workspace is filtered", async () => {
    const selectedAttachment = attachment({ id: "image-a", nodeId: "a" });
    const all: NotesWorkspace = {
      nodes: threeSiblings(),
      attachmentsByNodeId: { a: [selectedAttachment] }
    };
    const starred = workspace([
      node({ id: "a", sortKey: 1, isStarred: true })
    ]);
    const loadWorkspace = vi.fn(
      async (_vaultRoot: string, scope = { kind: "active" }) =>
        scope.kind === "starred" ? starred : all
    );
    const store = threeNodeStore({ loadWorkspace });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("starred"));
    act(() => result.current.actions.setSelectionAnchor("a"));

    const prepared = await act(async () =>
      result.current.prepareSelectionAuthority!(["a"])
    );

    expect(prepared.scope).toEqual({ kind: "starred" });
    expect(prepared.workspace.rootIds).toEqual(["a", "b", "c"]);
    expect(prepared.workspace.attachmentsByNodeId.a).toEqual([
      selectedAttachment
    ]);
    expect(loadWorkspace).toHaveBeenLastCalledWith("/vault", {
      kind: "active"
    });
  });

  it("revalidates every prepared target inside the queue and skips atomically when one vanished", async () => {
    const full = workspace(threeSiblings());
    const withoutB = workspace([
      node({ id: "a", sortKey: 1 }),
      node({ id: "c", sortKey: 3 })
    ]);
    const loadWorkspace = vi
      .fn()
      .mockResolvedValueOnce(full) // activation
      .mockResolvedValueOnce(full) // preparation
      .mockResolvedValueOnce(withoutB); // queue-time authority refresh
    const applyBatch = vi.fn();
    const store = threeNodeStore({ loadWorkspace, applyBatch });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => {
      result.current.actions.setSelectionAnchor("a");
      result.current.actions.extendSelectionTo("b");
    });
    const prepared = await act(async () =>
      result.current.prepareSelectionAuthority!(["a", "b"])
    );

    let settlement:
      | Awaited<
          ReturnType<
            NonNullable<
              typeof result.current.applyPreparedSelectionBatch
            >
          >
        >
      | undefined;
    await act(async () => {
      settlement = await result.current.applyPreparedSelectionBatch!(
        prepared,
        { type: "delete" }
      );
    });

    expect(settlement).toEqual({
      outcome: "skipped",
      mutationCommitted: false,
      navigationOwned: false
    });
    expect(applyBatch).not.toHaveBeenCalled();
  });

  it("skips a prepared mutation when full Active content changed outside the coordinator generation", async () => {
    const original = workspace([
      node({ id: "a", sortKey: 1, title: "before" }),
      node({ id: "b", sortKey: 2 })
    ]);
    const externallyChanged = workspace([
      node({ id: "a", sortKey: 1, title: "changed elsewhere" }),
      node({ id: "b", sortKey: 2 })
    ]);
    const loadWorkspace = vi
      .fn()
      .mockResolvedValueOnce(original) // activation
      .mockResolvedValueOnce(original) // preparation
      .mockResolvedValueOnce(externallyChanged); // queue-time refresh
    const applyBatch = vi.fn();
    const store = twoNodeStore({ loadWorkspace, applyBatch });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => {
      result.current.actions.setSelectionAnchor("a");
      result.current.actions.extendSelectionTo("b");
    });
    const prepared = await act(async () =>
      result.current.prepareSelectionAuthority!(["a", "b"])
    );

    await expect(
      result.current.applyPreparedSelectionBatch!(prepared, {
        type: "delete"
      })
    ).resolves.toEqual({
      outcome: "skipped",
      mutationCommitted: false,
      navigationOwned: false
    });
    expect(applyBatch).not.toHaveBeenCalled();
  });

  it("copies but performs zero delete calls when Active content changes externally after the clipboard write", async () => {
    const original = workspace([
      node({ id: "a", sortKey: 1, title: "Copy me" }),
      node({ id: "b", sortKey: 2, title: "Survivor" })
    ]);
    const externallyChanged = workspace([
      node({ id: "a", sortKey: 1, title: "Changed after copy" }),
      node({ id: "b", sortKey: 2, title: "Survivor" })
    ]);
    let active = original;
    const applyBatch = vi.fn();
    const writeClipboard = vi.fn(async () => {
      active = externallyChanged;
      return { kind: "success" as const, method: "plainText" as const };
    });
    const store = repository({
      loadWorkspace: vi.fn(async () => active),
      applyBatch
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => result.current.actions.setSelectionAnchor("a"));

    const router = createNotesSelectionCommandRouter({
      getSnapshot: () =>
        deriveNotesSelectionActionSnapshot({
          selection: result.current.selection ?? null,
          visibleNodeIds: result.current.state.rootIds,
          workspace: result.current.state,
          authoritativeWorkspace: result.current.state
        }),
      getSelectionRevision: () => result.current.selectionRevision!,
      getNavigationVersion: () =>
        result.current.actions.getNavigationVersion?.() ?? 0,
      getVisibleNodeIds: (projectedWorkspace) =>
        projectedWorkspace.rootIds,
      flushDrafts: () => result.current.actions.flushAllDrafts(),
      prepareAuthority: (nodeIds) =>
        result.current.prepareSelectionAuthority!(nodeIds),
      isAuthorityCurrent: (prepared) =>
        result.current.isPreparedSelectionAuthorityCurrent!(prepared),
      applyBatch: (prepared, op, options) =>
        result.current.applyPreparedSelectionBatch!(prepared, op, options),
      replaceSelection: (selection, expectedRevision) =>
        result.current.actions.replaceSelection!(
          selection,
          expectedRevision
        ),
      focusNode: (nodeId) => {
        void result.current.actions.focusNode(nodeId);
      },
      writeClipboard
    });

    let execution: Awaited<ReturnType<typeof router.execute>> | undefined;
    await act(async () => {
      execution = await router.execute({ type: "cut" });
    });

    expect(execution).toEqual({
      outcome: "skipped",
      mutationCommitted: false
    });
    expect(writeClipboard).toHaveBeenCalledWith("- Copy me");
    expect(applyBatch).not.toHaveBeenCalled();
    expect(result.current.selection).toEqual({
      anchorId: "a",
      headId: "a"
    });
  });

  it("rejects a prepared move whose destination is inside the selected forest", async () => {
    const tree = workspace([
      node({ id: "a", sortKey: 1 }),
      node({ id: "inside", parentId: "a", sortKey: 1 }),
      node({ id: "tail", sortKey: 2 })
    ]);
    const applyBatch = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(tree),
      applyBatch
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => result.current.actions.setSelectionAnchor("a"));
    const prepared = await act(async () =>
      result.current.prepareSelectionAuthority!(["a"])
    );

    let settlement: unknown;
    await act(async () => {
      settlement = await result.current.applyPreparedSelectionBatch!(
        prepared,
        {
          type: "move",
          parentId: "inside",
          afterId: null
        }
      );
    });

    expect(settlement).toEqual({
      outcome: "skipped",
      mutationCommitted: false,
      navigationOwned: false
    });
    expect(applyBatch).not.toHaveBeenCalled();
  });

  it("invalidates a prepared authority when the selection revision changes", async () => {
    const store = threeNodeStore();
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => {
      result.current.actions.setSelectionAnchor("a");
      result.current.actions.extendSelectionTo("b");
    });
    const prepared = await act(async () =>
      result.current.prepareSelectionAuthority!(["a", "b"])
    );

    act(() => result.current.actions.extendSelectionTo("c"));

    expect(result.current.isPreparedSelectionAuthorityCurrent!(prepared)).toBe(
      false
    );
    await expect(
      result.current.applyPreparedSelectionBatch!(prepared, {
        type: "delete"
      })
    ).resolves.toMatchObject({
      outcome: "skipped",
      mutationCommitted: false
    });
    expect(store.applyBatch).not.toHaveBeenCalled();
  });

  it("does not let concurrent selection preparation calls invalidate each other", async () => {
    const all = workspace(threeSiblings());
    const firstLoad = deferred<NotesWorkspace>();
    const loadWorkspace = vi
      .fn()
      .mockResolvedValueOnce(all) // activation
      .mockReturnValueOnce(firstLoad.promise)
      .mockResolvedValueOnce(all);
    const store = threeNodeStore({ loadWorkspace });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => {
      result.current.actions.setSelectionAnchor("a");
      result.current.actions.extendSelectionTo("b");
    });

    const first = result.current.prepareSelectionAuthority!(["a", "b"]);
    const second = result.current.prepareSelectionAuthority!(["a", "b"]);
    const secondPrepared = await second;
    firstLoad.resolve(all);
    const firstPrepared = await first;

    expect(firstPrepared.token).toBe(secondPrepared.token);
    expect(result.current.isPreparedSelectionAuthorityCurrent!(firstPrepared)).toBe(
      true
    );
    expect(
      result.current.isPreparedSelectionAuthorityCurrent!(secondPrepared)
    ).toBe(true);
  });

  it("reports a committed duplicate even when the scoped projection fails", async () => {
    const all = workspace(threeSiblings());
    let starredLoads = 0;
    const loadWorkspace = vi.fn(
      async (_vaultRoot: string, scope = { kind: "active" }) => {
        if (scope.kind === "starred") {
          starredLoads += 1;
          if (starredLoads > 1) {
            throw new Error("projection unavailable");
          }
        }
        return all;
      }
    );
    const applyBatch = vi.fn((_vaultRoot, _input, context) =>
      Promise.resolve({
        workspace: all,
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        duplicatedRootIds: ["copy-a", "copy-b"]
      })
    );
    const store = threeNodeStore({ loadWorkspace, applyBatch });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("starred"));
    act(() => {
      result.current.actions.setSelectionAnchor("a");
      result.current.actions.extendSelectionTo("b");
    });
    const prepared = await act(async () =>
      result.current.prepareSelectionAuthority!(["a", "b"])
    );

    let settlement:
      | Awaited<
          ReturnType<
            NonNullable<
              typeof result.current.applyPreparedSelectionBatch
            >
          >
        >
      | undefined;
    await act(async () => {
      settlement = await result.current.applyPreparedSelectionBatch!(
        prepared,
        { type: "duplicate" }
      );
    });

    expect(settlement).toEqual({
      outcome: "failed",
      mutationCommitted: true,
      navigationOwned: true,
      duplicatedRootIds: ["copy-a", "copy-b"]
    });
    expect(applyBatch).toHaveBeenCalledTimes(1);
  });

  it("returns the successful projected workspace with duplicate settlement", async () => {
    const before = workspace(threeSiblings());
    const after = workspace([
      ...threeSiblings(),
      node({ id: "copy-a", sortKey: 4 }),
      node({ id: "copy-b", sortKey: 5 })
    ]);
    const applyBatch = vi.fn((_vaultRoot, _input, context) =>
      Promise.resolve({
        workspace: after,
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        duplicatedRootIds: ["copy-a", "copy-b"]
      })
    );
    const store = threeNodeStore({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      applyBatch
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => {
      result.current.actions.setSelectionAnchor("a");
      result.current.actions.extendSelectionTo("b");
    });
    const prepared = await act(async () =>
      result.current.prepareSelectionAuthority!(["a", "b"])
    );

    let settlement:
      | Awaited<
          ReturnType<
            NonNullable<
              typeof result.current.applyPreparedSelectionBatch
            >
          >
        >
      | undefined;
    await act(async () => {
      settlement = await result.current.applyPreparedSelectionBatch!(
        prepared,
        { type: "duplicate" }
      );
    });

    expect(settlement).toMatchObject({
      outcome: "committed",
      mutationCommitted: true,
      duplicatedRootIds: ["copy-a", "copy-b"],
      projectedWorkspace: {
        rootIds: ["a", "b", "c", "copy-a", "copy-b"],
        status: "ready"
      }
    });
    expect(settlement?.projectedWorkspace?.nodesById["copy-b"]).toBeDefined();
  });

  it.each([
    ["complete", "root"],
    ["delete", null]
  ] as const)(
    "reconciles projected workspace UI state when %s keeps or removes the zoom root",
    async (operation, expectedZoomRootId) => {
      const before = workspace([
        node({ id: "root", sortKey: 1 }),
        node({ id: "child", parentId: "root", sortKey: 1 }),
        node({ id: "sibling", sortKey: 2 })
      ]);
      const after =
        operation === "complete"
          ? workspace([
              node({ id: "root", sortKey: 1 }),
              node({
                id: "child",
                parentId: "root",
                sortKey: 1,
                completedAt: "2026-07-15T01:00:00Z"
              }),
              node({ id: "sibling", sortKey: 2 })
            ])
          : workspace([node({ id: "sibling", sortKey: 2 })]);
      const applyBatch = vi.fn((_vaultRoot, _input, context) =>
        Promise.resolve({
          workspace: after,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false
        })
      );
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(before),
        applyBatch
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({ vaultRoot: "/vault", repository: store })
      );
      await waitFor(() => expect(result.current.state.status).toBe("ready"));
      await act(async () => result.current.actions.zoomTo("root"));
      act(() =>
        result.current.actions.setSelectionAnchor(
          operation === "complete" ? "child" : "root"
        )
      );
      const targetId = operation === "complete" ? "child" : "root";
      const prepared = await act(async () =>
        result.current.prepareSelectionAuthority!([targetId])
      );

      let settlement:
        | Awaited<
            ReturnType<
              NonNullable<
                typeof result.current.applyPreparedSelectionBatch
              >
            >
          >
        | undefined;
      await act(async () => {
        settlement = await result.current.applyPreparedSelectionBatch!(
          prepared,
          operation === "complete"
            ? { type: "complete" }
            : { type: "delete" }
        );
      });

      expect(settlement?.projectedWorkspace?.zoomRootId).toBe(
        expectedZoomRootId
      );
    }
  );

  it("locally expands a collapsed prepared reorder target only after success and records it in history", async () => {
    const before = workspace([
      node({ id: "moving", sortKey: 1 }),
      node({ id: "target", sortKey: 2, isCollapsed: true }),
      node({ id: "existing", parentId: "target", sortKey: 1 })
    ]);
    const after = workspace([
      node({ id: "target", sortKey: 2, isCollapsed: true }),
      node({ id: "existing", parentId: "target", sortKey: 1 }),
      node({ id: "moving", parentId: "target", sortKey: 2 })
    ]);
    let active = before;
    let batchEntryId: string | null = null;
    const applyBatch = vi.fn(async (_vaultRoot, _input, context) => {
      active = after;
      batchEntryId = context?.entryId ?? null;
      return {
        workspace: after,
        historyEntryId: batchEntryId,
        ...historyState(),
        canUndo: true,
        canRedo: false
      };
    });
    const undo = vi.fn(async () => {
      active = before;
      return {
        workspace: before,
        replayedEntryId: batchEntryId ?? "history-entry",
        ...historyState(),
        kind: "applied" as const,
        canUndo: false,
        canRedo: true
      };
    });
    const redo = vi.fn(async () => {
      active = after;
      return {
        workspace: after,
        replayedEntryId: batchEntryId ?? "history-entry",
        ...historyState(),
        kind: "applied" as const,
        canUndo: true,
        canRedo: false
      };
    });
    const toggleCollapsed = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn(async () => active),
      applyBatch,
      undo,
      redo,
      toggleCollapsed
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => result.current.actions.setSelectionAnchor("moving"));
    const prepared = await act(async () =>
      result.current.prepareSelectionAuthority!(["moving"])
    );

    await act(async () =>
      result.current.applyPreparedSelectionBatch!(
        prepared,
        {
          type: "move",
          parentId: "target",
          afterId: "existing"
        },
        { expandNodeId: "target" }
      )
    );

    expect(result.current.locallyExpandedNodeIds).toEqual(
      new Set(["target"])
    );
    expect(toggleCollapsed).not.toHaveBeenCalled();
    expect(applyBatch).toHaveBeenCalledTimes(1);

    await act(async () => result.current.actions.undo!());
    expect(result.current.locallyExpandedNodeIds).toEqual(new Set());
    await act(async () => result.current.actions.redo!());
    expect(result.current.locallyExpandedNodeIds).toEqual(
      new Set(["target"])
    );
  });

  it("does not expand a prepared reorder target after selection ownership becomes stale", async () => {
    const before = workspace([
      node({ id: "moving", sortKey: 1 }),
      node({ id: "target", sortKey: 2, isCollapsed: true })
    ]);
    const after = workspace([
      node({ id: "target", sortKey: 2, isCollapsed: true }),
      node({ id: "moving", parentId: "target", sortKey: 1 })
    ]);
    const pending = deferred<NotesMutationResult>();
    const applyBatch = vi.fn().mockReturnValue(pending.promise);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      applyBatch
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => result.current.actions.setSelectionAnchor("moving"));
    const prepared = await act(async () =>
      result.current.prepareSelectionAuthority!(["moving"])
    );

    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.applyPreparedSelectionBatch!(
        prepared,
        { type: "move", parentId: "target", afterId: null },
        { expandNodeId: "target" }
      );
    });
    await waitFor(() => expect(applyBatch).toHaveBeenCalledTimes(1));
    act(() => result.current.actions.clearSelection());
    pending.resolve({
      workspace: after,
      historyEntryId: "batch-entry",
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    await act(async () => completion);

    expect(result.current.locallyExpandedNodeIds).toEqual(new Set());
  });

  it("does not own survivor navigation after a newer editor focus without a selection change", async () => {
    const before = workspace([
      node({ id: "a", sortKey: 1 }),
      node({ id: "b", sortKey: 2 }),
      node({ id: "c", sortKey: 3 }),
      node({ id: "d", sortKey: 4 })
    ]);
    const after = workspace([
      node({ id: "c", sortKey: 3 }),
      node({ id: "d", sortKey: 4 })
    ]);
    let active = before;
    const pending = deferred<NotesMutationResult>();
    let batchEntryId: string | null = null;
    const applyBatch = vi.fn((_vaultRoot, _input, context) => {
      batchEntryId = context?.entryId ?? null;
      return pending.promise;
    });
    const undo = vi.fn(async () => {
      active = before;
      return {
        workspace: before,
        replayedEntryId: batchEntryId ?? "history-entry",
        ...historyState(),
        kind: "applied" as const,
        canUndo: false,
        canRedo: true
      };
    });
    const redo = vi.fn(async () => {
      active = after;
      return {
        workspace: after,
        replayedEntryId: batchEntryId ?? "history-entry",
        ...historyState(),
        kind: "applied" as const,
        canUndo: true,
        canRedo: false
      };
    });
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) => ({
      workspace: after,
      historyEntryId: context?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false
    }));
    const store = repository({
      loadWorkspace: vi.fn(async () => active),
      applyBatch,
      undo,
      redo,
      toggleStar
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    await act(async () => result.current.actions.focusNode("a"));
    expect(result.current.state).toMatchObject({
      selectedId: "a",
      editingNoteId: "a",
      pendingFocusId: "a",
      pendingFocusField: "title"
    });
    act(() => {
      result.current.actions.setSelectionAnchor("a");
      result.current.actions.extendSelectionTo("b");
    });
    const prepared = await act(async () =>
      result.current.prepareSelectionAuthority!(["a", "b"])
    );

    let completion!: ReturnType<
      NonNullable<UseNotesWorkspaceResult["applyPreparedSelectionBatch"]>
    >;
    act(() => {
      completion = result.current.applyPreparedSelectionBatch!(
        prepared,
        { type: "delete" },
        { focusNodeId: "c" }
      );
    });
    await waitFor(() => expect(applyBatch).toHaveBeenCalledTimes(1));

    expect(result.current.actions.markEditingFocus).toBeTypeOf("function");
    act(() => result.current.actions.markEditingFocus?.("d", "note"));
    expect(result.current.selectionRevision).toBe(prepared.selectionRevision);
    active = after;
    pending.resolve({
      workspace: after,
      historyEntryId: batchEntryId,
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    const settlement = await act(async () => completion);

    expect(settlement.navigationOwned).toBe(false);
    expect(result.current.state).toMatchObject({
      selectedId: "d",
      editingNoteId: "d",
      pendingFocusId: null,
      pendingFocusField: null
    });
    expect(notesHistorySpies.acceptMutationResult).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        selectedId: "d",
        focus: { nodeId: "d", field: "note" }
      }),
      expect.anything()
    );

    await act(async () => result.current.actions.undo!());
    expect(result.current.state).toMatchObject({
      selectedId: "a",
      editingNoteId: "a",
      pendingFocusId: "a",
      pendingFocusField: "title"
    });
    await act(async () => result.current.actions.redo!());
    expect(result.current.state).toMatchObject({
      selectedId: "d",
      editingNoteId: "d",
      pendingFocusId: "d",
      pendingFocusField: "note"
    });

    const beforeAcknowledge =
      result.current.actions.getNavigationVersion?.();
    await act(async () => result.current.actions.acknowledgeFocus("d"));
    expect(result.current.actions.getNavigationVersion?.()).toBe(
      beforeAcknowledge
    );
    expect(result.current.state).toMatchObject({
      selectedId: "d",
      editingNoteId: "d",
      pendingFocusId: null,
      pendingFocusField: null
    });
    const beforeNextCommand = notesHistorySpies.beginStructural.mock.calls.length;
    await act(async () => result.current.actions.toggleStar("d"));
    expect(notesHistorySpies.beginStructural.mock.calls[beforeNextCommand]).toEqual([
      "star",
      expect.objectContaining({
        selectedId: "d",
        focus: { nodeId: "d", field: "note" }
      })
    ]);
  });

  it("does not retain newer editor focus when that focused node was deleted", async () => {
    const before = workspace([
      node({ id: "a", sortKey: 1 }),
      node({ id: "b", sortKey: 2 }),
      node({ id: "c", sortKey: 3 })
    ]);
    const after = workspace([node({ id: "c", sortKey: 3 })]);
    let active = before;
    const pending = deferred<NotesMutationResult>();
    let batchEntryId: string | null = null;
    const applyBatch = vi.fn((_vaultRoot, _input, context) => {
      batchEntryId = context?.entryId ?? null;
      return pending.promise;
    });
    const toggleStar = vi.fn(async (_vaultRoot, _nodeId, context) => ({
      workspace: after,
      historyEntryId: context?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false
    }));
    const store = repository({
      loadWorkspace: vi.fn(async () => active),
      applyBatch,
      toggleStar
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store
      })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(result.current.state).toMatchObject({
      selectedId: null,
      editingNoteId: null,
      pendingFocusId: null,
      pendingFocusField: null
    });
    act(() => {
      result.current.actions.setSelectionAnchor("a");
      result.current.actions.extendSelectionTo("b");
    });
    const prepared = await act(async () =>
      result.current.prepareSelectionAuthority!(["a", "b"])
    );

    let completion!: ReturnType<
      NonNullable<UseNotesWorkspaceResult["applyPreparedSelectionBatch"]>
    >;
    act(() => {
      completion = result.current.applyPreparedSelectionBatch!(
        prepared,
        { type: "delete" },
        { focusNodeId: "c" }
      );
    });
    await waitFor(() => expect(applyBatch).toHaveBeenCalledTimes(1));
    act(() => result.current.actions.markEditingFocus?.("a", "note"));
    active = after;
    pending.resolve({
      workspace: after,
      historyEntryId: batchEntryId,
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    await act(async () => completion);

    expect(result.current.state).toMatchObject({
      selectedId: null,
      editingNoteId: null,
      pendingFocusId: null,
      pendingFocusField: null
    });
    expect(notesHistorySpies.acceptMutationResult).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        selectedId: null,
        focus: null
      }),
      expect.anything()
    );

    const beforeNextCommand = notesHistorySpies.beginStructural.mock.calls.length;
    await act(async () => result.current.actions.toggleStar("c"));
    expect(notesHistorySpies.beginStructural.mock.calls[beforeNextCommand]).toEqual([
      "star",
      expect.objectContaining({
        selectedId: null,
        focus: null
      })
    ]);
  });

  it("settles and replays prepared delete survivor navigation with history", async () => {
    const before = workspace([
      node({ id: "a", sortKey: 1 }),
      node({ id: "b", sortKey: 2 }),
      node({ id: "c", sortKey: 3 })
    ]);
    const after = workspace([node({ id: "c", sortKey: 3 })]);
    let active = before;
    let batchEntryId: string | null = null;
    const applyBatch = vi.fn(async (_vaultRoot, _input, context) => {
      active = after;
      batchEntryId = context?.entryId ?? null;
      return {
        workspace: after,
        historyEntryId: batchEntryId,
        ...historyState(),
        canUndo: true,
        canRedo: false
      };
    });
    const undo = vi.fn(async () => {
      active = before;
      return {
        workspace: before,
        replayedEntryId: batchEntryId ?? "history-entry",
        ...historyState(),
        kind: "applied" as const,
        canUndo: false,
        canRedo: true
      };
    });
    const redo = vi.fn(async () => {
      active = after;
      return {
        workspace: after,
        replayedEntryId: batchEntryId ?? "history-entry",
        ...historyState(),
        kind: "applied" as const,
        canUndo: true,
        canRedo: false
      };
    });
    const store = repository({
      loadWorkspace: vi.fn(async () => active),
      applyBatch,
      undo,
      redo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    await act(async () => result.current.actions.focusNode("a"));
    act(() => {
      result.current.actions.setSelectionAnchor("a");
      result.current.actions.extendSelectionTo("b");
    });
    const prepared = await act(async () =>
      result.current.prepareSelectionAuthority!(["a", "b"])
    );

    await act(async () =>
      result.current.applyPreparedSelectionBatch!(
        prepared,
        { type: "delete" },
        { focusNodeId: "c" }
      )
    );

    expect(result.current.state).toMatchObject({
      selectedId: "c",
      editingNoteId: "c",
      pendingFocusId: "c",
      pendingFocusField: "title"
    });
    await act(async () => result.current.actions.undo!());
    expect(result.current.state).toMatchObject({
      selectedId: "a",
      pendingFocusId: "a"
    });
    await act(async () => result.current.actions.redo!());
    expect(result.current.state).toMatchObject({
      selectedId: "c",
      pendingFocusId: "c",
      pendingFocusField: "title"
    });
  });

  it("keeps a prepared range selected while the batch is pending and after failure", async () => {
    const pending = deferred<NotesWorkspace>();
    const applyBatch = vi.fn().mockReturnValue(pending.promise);
    const store = threeNodeStore({ applyBatch });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => {
      result.current.actions.setSelectionAnchor("a");
      result.current.actions.extendSelectionTo("b");
    });
    const prepared = await act(async () =>
      result.current.prepareSelectionAuthority!(["a", "b"])
    );

    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.applyPreparedSelectionBatch!(prepared, {
        type: "delete"
      });
    });
    await waitFor(() => expect(applyBatch).toHaveBeenCalledTimes(1));
    expect(result.current.selection).toEqual({
      anchorId: "a",
      headId: "b"
    });

    await act(async () => pending.reject(new Error("batch rejected")));
    await expect(completion).resolves.toMatchObject({
      outcome: "failed",
      mutationCommitted: false
    });
    expect(result.current.selection).toEqual({
      anchorId: "a",
      headId: "b"
    });
  });

  it("applies an atomic selection replacement only at the frozen revision", async () => {
    const { result } = await withSelectedRange();
    const frozenRevision = result.current.selectionRevision!;

    act(() => result.current.actions.extendSelectionTo("root"));
    let staleApplied = true;
    act(() => {
      staleApplied = result.current.actions.replaceSelection!(
        { anchorId: "copy-a", headId: "copy-b" },
        frozenRevision
      );
    });

    expect(staleApplied).toBe(false);
    expect(result.current.selection).toEqual({
      anchorId: "root",
      headId: "root"
    });

    let currentApplied = false;
    act(() => {
      currentApplied = result.current.actions.replaceSelection!(
        { anchorId: "copy-a", headId: "copy-b" },
        result.current.selectionRevision
      );
    });
    expect(currentApplied).toBe(true);
    expect(result.current.selection).toEqual({
      anchorId: "copy-a",
      headId: "copy-b"
    });
  });

  it("does not advance the selection revision for a reducer identity no-op", async () => {
    const store = twoNodeStore();
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    const initialRevision = result.current.selectionRevision!;

    let applied = true;
    act(() => {
      applied = result.current.actions.replaceSelection!(
        null,
        initialRevision
      );
    });
    act(() => result.current.actions.setSelectionAnchor("root"));

    expect(applied).toBe(false);
    expect(result.current.selectionRevision).toBe(initialRevision + 1);
  });

  it("forwards a before-anchored batch move without rewriting its placement", async () => {
    const applyBatch = vi.fn((_vaultRoot, _input, context) =>
      Promise.resolve({
        workspace: workspace(threeSiblings()),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      })
    );
    const store = threeNodeStore({ applyBatch });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(async () => {
      await result.current.actions.applyBatch(["b", "c"], {
        type: "move",
        parentId: null,
        afterId: null,
        beforeId: "a"
      });
    });

    expect(applyBatch).toHaveBeenCalledWith(
      "/vault",
      {
        op: "move",
        nodeIds: ["b", "c"],
        parentId: null,
        afterId: null,
        beforeId: "a"
      },
      historyContext("batch")
    );
  });

  it("reverts an applied batch in a single undo step", async () => {
    const applyBatch = vi.fn((_vaultRoot, _input, context) =>
      Promise.resolve({
        workspace: workspace(threeSiblings("2026-07-10T01:00:00Z")),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      })
    );
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: workspace(threeSiblings()),
      replayedEntryId: applyBatch.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      kind: "applied" as const,
      canUndo: false,
      canRedo: true
    }));
    const store = threeNodeStore({ applyBatch, undo });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => {
      result.current.actions.setSelectionAnchor("a");
      result.current.actions.extendSelectionTo("c");
    });
    await act(async () => {
      await result.current.actions.applyBatch(["a", "b", "c"], {
        type: "complete",
        completed: true
      });
    });
    expect(result.current.state.nodesById.a.completedAt).not.toBeNull();

    await act(async () => result.current.actions.undo!());

    // A single undo replays the one batch entry, restoring every node at once.
    expect(undo).toHaveBeenCalledTimes(1);
    expect(result.current.state.nodesById.a.completedAt).toBeNull();
    expect(result.current.state.nodesById.b.completedAt).toBeNull();
    expect(result.current.state.nodesById.c.completedAt).toBeNull();
  });

  it("soft-deletes the whole selection and focuses a surviving neighbor", async () => {
    const applyBatch = vi.fn((_vaultRoot, _input, context) =>
      Promise.resolve({
        workspace: workspace([node({ id: "c", sortKey: 3 })]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      })
    );
    const store = threeNodeStore({ applyBatch });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    act(() => {
      result.current.actions.setSelectionAnchor("a");
      result.current.actions.extendSelectionTo("b");
    });

    await act(async () => {
      await result.current.actions.applyBatch(
        ["a", "b"],
        { type: "delete" },
        { focusNodeId: "c" }
      );
    });

    expect(applyBatch).toHaveBeenCalledWith(
      "/vault",
      { op: "delete", nodeIds: ["a", "b"] },
      historyContext("batch")
    );
    expect(result.current.state.rootIds).toEqual(["c"]);
    expect(result.current.state).toMatchObject({
      selectedId: "c",
      pendingFocusId: "c"
    });
  });

  it("skips the batch and reports it when the pre-structural draft flush fails", async () => {
    const store = threeNodeStore({
      updateNode: vi.fn().mockRejectedValue(new Error("save failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    // A dirty draft whose flush fails is the barrier the structural batch must
    // clear; establish the selection afterward (typing collapses it).
    act(() =>
      result.current.actions.updateNodeDraft("a", { title: "typed", note: "" })
    );
    act(() => {
      result.current.actions.setSelectionAnchor("a");
      result.current.actions.extendSelectionTo("c");
    });

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.actions.applyBatch(["a", "b", "c"], {
        type: "complete",
        completed: true
      });
    });

    // Phase 3.5: the caller learns the command was dropped (so the row surfaces
    // its "Command paused" notice) and the batch never reached the backend.
    expect(outcome).toBe("skipped");
    expect(store.applyBatch).not.toHaveBeenCalled();
  });
});

describe("importSubtree (plan Phase 4.4b, paste import)", () => {
  it("imports a forest under parentId after afterId as a single history entry and focuses the first root", async () => {
    const importedNodes = workspace([
      node({ id: "root", sortKey: 1 }),
      node({ id: "imported-a", parentId: "root", sortKey: 2, title: "Alpha" }),
      node({
        id: "imported-a-child",
        parentId: "imported-a",
        sortKey: 1,
        title: "Alpha child"
      }),
      node({ id: "imported-b", parentId: "root", sortKey: 3, title: "Beta" })
    ]);
    const importSubtree = vi.fn((_vaultRoot, _input, context) =>
      Promise.resolve({
        workspace: importedNodes,
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: ["imported-a", "imported-b"]
      })
    );
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "root" })])),
      importSubtree
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.actions.importSubtree("root", null, [
        {
          title: "Alpha",
          children: [{ title: "Alpha child", children: [] }]
        },
        { title: "Beta", children: [] }
      ]);
    });

    expect(outcome).toBe("committed");
    expect(importSubtree).toHaveBeenCalledTimes(1);
    expect(importSubtree).toHaveBeenCalledWith(
      "/vault",
      {
        parentId: "root",
        afterId: null,
        nodes: [
          {
            title: "Alpha",
            children: [{ title: "Alpha child", children: [] }]
          },
          { title: "Beta", children: [] }
        ]
      },
      historyContext("import")
    );
    // One backend call carrying one history entry id: undo reverts the whole
    // imported subtree in one step.
    expect(result.current).toMatchObject({ canUndo: true, canRedo: false });
    // Focuses the first imported root (importedRootIds[0]), not the second.
    expect(result.current.state).toMatchObject({
      selectedId: "imported-a",
      editingNoteId: "imported-a",
      pendingFocusId: "imported-a",
      pendingFocusField: "title"
    });
    expect(result.current.state.nodesById["imported-a-child"]).toBeDefined();
  });

  it("removes the imported subtree in one undo step", async () => {
    const importedNodes = workspace([
      node({ id: "root", sortKey: 1 }),
      node({ id: "imported-a", parentId: "root", sortKey: 2, title: "Alpha" })
    ]);
    const importSubtree = vi.fn((_vaultRoot, _input, context) =>
      Promise.resolve({
        workspace: importedNodes,
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: ["imported-a"]
      })
    );
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: workspace([node({ id: "root" })]),
      replayedEntryId: importSubtree.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      kind: "applied" as const,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "root" })])),
      importSubtree,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(async () => {
      await result.current.actions.importSubtree("root", null, [
        { title: "Alpha", children: [] }
      ]);
    });
    expect(result.current.state.nodesById["imported-a"]).toBeDefined();

    await act(async () => result.current.actions.undo!());

    expect(undo).toHaveBeenCalledTimes(1);
    expect(result.current.state.nodesById["imported-a"]).toBeUndefined();
    expect(result.current.state.rootIds).toEqual(["root"]);
  });

  it("skips the import when the target parent no longer exists", async () => {
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "root" })]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.actions.importSubtree(
        "missing-parent",
        null,
        [{ title: "Alpha", children: [] }]
      );
    });

    expect(outcome).toBe("skipped");
    expect(store.importSubtree).not.toHaveBeenCalled();
  });
});

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
        })
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
          draft: { title: "Root", note: "" }
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
        draft: { title: "stale draft", note: "" },
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
            { draft: { title: "stale draft", note: "" } }
          );
        } else {
          await result.current.actions.removeEmptyNode("root", null, {
            draft: { title: "stale draft", note: "" }
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

describe("Task 6 undoable navigation boundary", () => {
  it("records zoom navigation only after status preflight and prepare guard", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "child", parentId: "root" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial)
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
      useNotesWorkspace({ vaultRoot: "/task-6-zoom", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      const session = sessions.at(-1)!;
      vi.mocked(store.historyStatus!).mockClear();
      vi.mocked(store.prepareNavigation!).mockClear();

      await act(async () => rendered.result.current.actions.zoomTo("child"));

      expect(store.historyStatus).toHaveBeenCalledWith(
        "/task-6-zoom",
        session.history.sessionId
      );
      expect(store.prepareNavigation).toHaveBeenCalledWith(
        "/task-6-zoom",
        {
          sessionId: session.history.sessionId,
          historyEpoch: "epoch-a",
          unreachableRedoEntryIds: []
        }
      );
      expect(session.history.next("undo")).toMatchObject({
        kind: "navigation",
        before: { zoomRootId: null },
        after: { zoomRootId: "child" }
      });
      expect(rendered.result.current.state.zoomRootId).toBe("child");
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("keeps acknowledged logical focus without republishing pending focus during navigation", async () => {
    const initial = workspace([node({ id: "root" }), node({ id: "other" })]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial)
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
        vaultRoot: "/task-6-acknowledged-focus",
        repository: store
      })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      await act(async () => rendered.result.current.actions.focusNode("root"));
      await act(async () =>
        rendered.result.current.actions.acknowledgeFocus("root")
      );
      expect(rendered.result.current.state.pendingFocusId).toBeNull();

      await act(async () => rendered.result.current.actions.zoomTo("other"));

      expect(rendered.result.current.state).toMatchObject({
        selectedId: "root",
        editingNoteId: "root",
        pendingFocusId: null,
        pendingFocusField: null,
        zoomRootId: "other"
      });
      expect(sessions.at(-1)!.history.next("undo")).toMatchObject({
        kind: "navigation",
        after: {
          focus: { nodeId: "root", field: "title" }
        }
      });
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("routes a library scope change through status, load, and prepare in order", async () => {
    const initial = workspace([node({ id: "root", isStarred: true })]);
    const calls: string[] = [];
    const store = repository({
      loadWorkspace: vi.fn(async () => {
        calls.push("load");
        return initial;
      }),
      historyStatus: vi.fn(async (_vaultRoot, sessionId) => {
        calls.push("status");
        return syntheticHistoryStatus(sessionId);
      }),
      prepareNavigation: vi.fn(async (_vaultRoot, input) => {
        calls.push("prepare");
        return syntheticHistoryStatus(input.sessionId);
      })
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-6-library", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    calls.length = 0;

    await act(async () =>
      rendered.result.current.actions.selectLibraryView("starred")
    );

    expect(calls).toEqual(["status", "load", "prepare"]);
    expect(rendered.result.current).toMatchObject({
      libraryView: "starred",
      canUndo: true,
      canRedo: false
    });
  });

  it("routes a library search result through the navigation boundary", async () => {
    const initial = workspace([
      node({ id: "root", isCollapsed: true }),
      node({ id: "child", parentId: "root" })
    ]);
    const calls: string[] = [];
    const store = repository({
      loadWorkspace: vi.fn(async () => {
        calls.push("load");
        return initial;
      }),
      historyStatus: vi.fn(async (_vaultRoot, sessionId) => {
        calls.push("status");
        return syntheticHistoryStatus(sessionId);
      }),
      prepareNavigation: vi.fn(async (_vaultRoot, input) => {
        calls.push("prepare");
        return syntheticHistoryStatus(input.sessionId);
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
      useNotesWorkspace({ vaultRoot: "/task-6-search", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      calls.length = 0;

      await act(async () =>
        rendered.result.current.actions.openSearchResult("child")
      );

      expect(calls).toEqual(["status", "load", "prepare"]);
      expect(sessions.at(-1)!.history.next("undo")).toMatchObject({
        kind: "navigation",
        after: {
          scope: { kind: "active" },
          libraryView: "all",
          selectedId: "child",
          zoomRootId: "root",
          expansion: { nodeIds: ["root"] },
          focus: { nodeId: "child", field: "title" }
        }
      });
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("records a tag-filter navigation with its return origin", async () => {
    const active = workspace([node({ id: "root" })]);
    const tagged = workspace([node({ id: "tagged" })]);
    const calls: string[] = [];
    const work = { prefix: "#" as const, normalizedTag: "work" };
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) => {
        calls.push("load");
        return scope.kind === "tags" ? tagged : active;
      }),
      historyStatus: vi.fn(async (_vaultRoot, sessionId) => {
        calls.push("status");
        return syntheticHistoryStatus(sessionId);
      }),
      prepareNavigation: vi.fn(async (_vaultRoot, input) => {
        calls.push("prepare");
        return syntheticHistoryStatus(input.sessionId);
      }),
      listTagsWithCounts: vi.fn().mockResolvedValue([
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
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-6-tag", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      calls.length = 0;

      await act(async () => rendered.result.current.actions.toggleTagFilter(work));

      expect(calls).toEqual(["status", "load", "prepare"]);
      expect(sessions.at(-1)!.history.next("undo")).toMatchObject({
        kind: "navigation",
        after: {
          scope: { kind: "tags", tags: [work] },
          libraryView: "tags",
          activeTagFilters: [work],
          tagFilterOrigin: {
            scope: { kind: "active" },
            libraryView: "all"
          }
        }
      });
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("records the empty Tags chooser as an exact tag-scope navigation", async () => {
    const initial = workspace([node({ id: "root" })]);
    const calls: string[] = [];
    const store = repository({
      loadWorkspace: vi.fn(async () => {
        calls.push("load");
        return initial;
      }),
      historyStatus: vi.fn(async (_vaultRoot, sessionId) => {
        calls.push("status");
        return syntheticHistoryStatus(sessionId);
      }),
      prepareNavigation: vi.fn(async (_vaultRoot, input) => {
        calls.push("prepare");
        return syntheticHistoryStatus(input.sessionId);
      }),
      listTagsWithCounts: vi.fn().mockResolvedValue([])
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
      useNotesWorkspace({ vaultRoot: "/task-6-tags-chooser", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      calls.length = 0;

      await act(async () =>
        rendered.result.current.actions.selectLibraryView("tags")
      );

      expect(calls).toEqual(["status", "load", "prepare"]);
      expect(sessions.at(-1)!.history.next("undo")).toMatchObject({
        kind: "navigation",
        after: {
          scope: { kind: "tags", tags: [] },
          libraryView: "tags",
          activeTagFilters: [],
          selectedId: null,
          zoomRootId: null,
          tagFilterOrigin: {
            scope: { kind: "active" },
            libraryView: "all"
          }
        }
      });
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("serializes rapid tag clicks into one canonical multi-tag location", async () => {
    const initial = workspace([node({ id: "root" })]);
    const work = { prefix: "#" as const, normalizedTag: "work" };
    const home = { prefix: "@" as const, normalizedTag: "home" };
    const loadedScopes: NotesWorkspaceScope[] = [];
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) => {
        loadedScopes.push(scope);
        return initial;
      }),
      historyStatus: vi.fn(async (_vaultRoot, sessionId) =>
        syntheticHistoryStatus(sessionId)
      ),
      prepareNavigation: vi.fn(async (_vaultRoot, input) =>
        syntheticHistoryStatus(input.sessionId)
      ),
      listTagsWithCounts: vi.fn().mockResolvedValue([])
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
      useNotesWorkspace({ vaultRoot: "/task-6-rapid-tags", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      loadedScopes.length = 0;
      let first!: Promise<void>;
      let second!: Promise<void>;
      act(() => {
        first = rendered.result.current.actions.toggleTagFilter(work);
        second = rendered.result.current.actions.toggleTagFilter(home);
      });
      await act(async () => Promise.all([first, second]));

      expect(loadedScopes).toEqual([
        { kind: "tags", tags: [work] },
        { kind: "tags", tags: [work, home] }
      ]);
      expect(rendered.result.current.activeTagFilters).toEqual([work, home]);
      expect(sessions.at(-1)!.history.next("undo")).toMatchObject({
        kind: "navigation",
        after: {
          scope: { kind: "tags", tags: [home, work] },
          activeTagFilters: [home, work]
        }
      });
      await act(async () => rendered.result.current.actions.undo!());
      expect(rendered.result.current.activeTagFilters).toEqual([work]);
      await act(async () => rendered.result.current.actions.redo!());
      expect(rendered.result.current).toMatchObject({
        libraryView: "tags",
        activeTagFilters: [work, home]
      });
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("cancels a semantic same-location navigation before the prepare guard", async () => {
    const initial = workspace([node({ id: "root" })]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial)
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
      useNotesWorkspace({ vaultRoot: "/task-6-navigation-noop", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      vi.mocked(store.historyStatus!).mockClear();
      vi.mocked(store.prepareNavigation!).mockClear();

      await act(async () => rendered.result.current.actions.zoomTo(null));

      expect(store.historyStatus).toHaveBeenCalledOnce();
      expect(store.prepareNavigation).not.toHaveBeenCalled();
      expect(sessions.at(-1)!.history.next("undo")).toBeNull();
      expect(rendered.result.current.state.zoomRootId).toBeNull();
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("defers outline navigation during composition and replays only the latest", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "child", parentId: "root" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial)
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-6-composition", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    vi.mocked(store.historyStatus!).mockClear();
    vi.mocked(store.prepareNavigation!).mockClear();

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      rendered.result.current.actions.setOutlineCompositionActive?.(true);
      first = rendered.result.current.actions.zoomTo("root");
      second = rendered.result.current.actions.zoomTo("child");
    });
    await act(async () => Promise.all([first, second]));

    expect(store.historyStatus).not.toHaveBeenCalled();
    expect(store.prepareNavigation).not.toHaveBeenCalled();
    expect(rendered.result.current.state.zoomRootId).toBeNull();

    act(() => {
      rendered.result.current.actions.setOutlineCompositionActive?.(false);
    });
    await waitFor(() =>
      expect(rendered.result.current.state.zoomRootId).toBe("child")
    );
    expect(store.historyStatus).toHaveBeenCalledOnce();
    expect(store.prepareNavigation).toHaveBeenCalledOnce();
  });

  it("drops a navigation invoked by a stale non-owner before admission", async () => {
    const initial = workspace([node({ id: "root" })]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial)
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
      useNotesWorkspace({ vaultRoot: "/task-6-stale-owner", repository: store })
    );
    const second = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-6-stale-owner", repository: store })
    );
    try {
      await waitFor(() => expect(second.result.current.status).toBe("ready"));
      vi.mocked(store.historyStatus!).mockClear();
      vi.mocked(store.prepareNavigation!).mockClear();

      await act(async () => first.result.current.actions.zoomTo("root"));

      expect(store.historyStatus).not.toHaveBeenCalled();
      expect(store.prepareNavigation).not.toHaveBeenCalled();
      expect(sessions.at(-1)!.history.next("undo")).toBeNull();
    } finally {
      first.unmount();
      second.unmount();
      openSession.mockRestore();
    }
  });

  it("drops a composed pending navigation after ownership transfers", async () => {
    const initial = workspace([node({ id: "root" })]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial)
    });
    const first = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-6-composed-transfer", repository: store })
    );
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    act(() => {
      first.result.current.actions.setOutlineCompositionActive?.(true);
      void first.result.current.actions.zoomTo("root");
    });
    const second = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-6-composed-transfer", repository: store })
    );
    try {
      await waitFor(() => expect(second.result.current.status).toBe("ready"));
      vi.mocked(store.loadWorkspace).mockClear();
      vi.mocked(store.historyStatus!).mockClear();
      vi.mocked(store.prepareNavigation!).mockClear();

      act(() => {
        first.result.current.actions.setOutlineCompositionActive?.(false);
      });
      await act(async () => Promise.resolve());

      expect(store.historyStatus).not.toHaveBeenCalled();
      expect(store.loadWorkspace).not.toHaveBeenCalled();
      expect(store.prepareNavigation).not.toHaveBeenCalled();
    } finally {
      first.unmount();
      second.unmount();
    }
  });

  it("clears a composed pending navigation on repository replacement and teardown", async () => {
    const initial = workspace([node({ id: "root" })]);
    const firstStore = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial)
    });
    const secondStore = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial)
    });
    const rendered = renderHook(
      ({ store }) =>
        useNotesWorkspace({
          vaultRoot: "/task-6-composed-replacement",
          repository: store
        }),
      { initialProps: { store: firstStore } }
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    const oldActions = rendered.result.current.actions;
    act(() => {
      oldActions.setOutlineCompositionActive?.(true);
      void oldActions.selectLibraryView("starred");
    });

    rendered.rerender({ store: secondStore });
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    vi.mocked(firstStore.loadWorkspace).mockClear();
    vi.mocked(firstStore.historyStatus!).mockClear();
    vi.mocked(firstStore.prepareNavigation!).mockClear();
    vi.mocked(secondStore.loadWorkspace).mockClear();
    vi.mocked(secondStore.historyStatus!).mockClear();
    vi.mocked(secondStore.prepareNavigation!).mockClear();
    rendered.unmount();

    act(() => oldActions.setOutlineCompositionActive?.(false));
    await act(async () => Promise.resolve());

    for (const store of [firstStore, secondStore]) {
      expect(store.historyStatus).not.toHaveBeenCalled();
      expect(store.loadWorkspace).not.toHaveBeenCalled();
      expect(store.prepareNavigation).not.toHaveBeenCalled();
    }
  });

  it("stops before status and destination loading when any draft barrier fails", async () => {
    const initial = workspace([node({ id: "root", title: "Before" })]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode: vi.fn().mockRejectedValue(new Error("save failed"))
    });
    const first = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-6-all-barriers", repository: store })
    );
    const second = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-6-all-barriers", repository: store })
    );
    try {
      await waitFor(() => expect(second.result.current.status).toBe("ready"));
      act(() => {
        first.result.current.actions.updateNodeDraft("root", {
          title: "Dirty",
          note: ""
        });
      });
      vi.mocked(store.loadWorkspace).mockClear();
      vi.mocked(store.historyStatus!).mockClear();
      vi.mocked(store.prepareNavigation!).mockClear();

      await act(async () =>
        second.result.current.actions.selectLibraryView("starred")
      );

      expect(store.updateNode).toHaveBeenCalledOnce();
      expect(store.historyStatus).not.toHaveBeenCalled();
      expect(store.loadWorkspace).not.toHaveBeenCalled();
      expect(store.prepareNavigation).not.toHaveBeenCalled();
      expect(second.result.current).toMatchObject({
        libraryView: "all",
        canUndo: false,
        canRedo: false
      });
    } finally {
      first.unmount();
      second.unmount();
    }
  });

  it("routes navigation cleanup failure only to bottom feedback", async () => {
    const initial = workspace([node({ id: "root", isStarred: true })]);
    const publishFeedback = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      pruneHistoryEntries: vi.fn().mockRejectedValue(new Error("cleanup failed"))
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
        vaultRoot: "/task-6-navigation-cleanup-failure",
        repository: store,
        publishFeedback
      })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      const session = sessions.at(-1)!;
      session.queueHistoryCleanup(["stale-entry"]);
      vi.mocked(store.loadWorkspace).mockClear();
      vi.mocked(store.historyStatus!).mockClear();
      vi.mocked(store.prepareNavigation!).mockClear();

      await act(async () =>
        rendered.result.current.actions.selectLibraryView("starred")
      );

      expect(publishFeedback).toHaveBeenCalledTimes(1);
      expect(publishFeedback).toHaveBeenCalledWith({
        kind: "error",
        message: "Notes navigation failed: cleanup failed"
      });
      expect(rendered.result.current).toMatchObject({
        status: "ready",
        error: null,
        libraryView: "all",
        activeTagFilters: [],
        canUndo: false,
        canRedo: false
      });
      expect(rendered.result.current.state).toMatchObject({
        rootIds: ["root"],
        selectedId: null,
        zoomRootId: null
      });
      expect(session.history.next("undo")).toBeNull();
      expect(session.history.snapshotCount()).toBe(0);
      expect(store.pruneHistoryEntries).toHaveBeenCalledOnce();
      expect(store.historyStatus).not.toHaveBeenCalled();
      expect(store.loadWorkspace).not.toHaveBeenCalled();
      expect(store.prepareNavigation).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it.each(["status", "destination", "prepare"] as const)(
    "keeps the page and redo chain unchanged when navigation %s fails",
    async (failureStage) => {
      const initial = workspace([node({ id: "root" })]);
      let fail = false;
      const publishFeedback = vi.fn();
      const store = repository({
        loadWorkspace: vi.fn(async (_vaultRoot, scope) => {
          if (fail && failureStage === "destination" && scope.kind === "starred") {
            throw new Error("destination failed");
          }
          return initial;
        }),
        historyStatus: vi.fn(async (_vaultRoot, sessionId) => {
          if (fail && failureStage === "status") {
            throw new Error("status failed");
          }
          return syntheticHistoryStatus(sessionId);
        }),
        prepareNavigation: vi.fn(async (_vaultRoot, input) => {
          if (fail && failureStage === "prepare") {
            throw new Error("prepare failed");
          }
          return syntheticHistoryStatus(input.sessionId);
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
        useNotesWorkspace({
          vaultRoot: `/task-6-${failureStage}-failure`,
          repository: store,
          publishFeedback
        })
      );
      try {
        await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
        await act(async () => rendered.result.current.actions.zoomTo("root"));
        await act(async () => rendered.result.current.actions.undo!());
        expect(rendered.result.current.canRedo).toBe(true);
        publishFeedback.mockClear();
        fail = true;

        await act(async () =>
          rendered.result.current.actions.selectLibraryView("starred")
        );

        expect(rendered.result.current).toMatchObject({
          libraryView: "all",
          canUndo: false,
          canRedo: true,
          error: null
        });
        expect(rendered.result.current.state.zoomRootId).toBeNull();
        expect(sessions.at(-1)!.history.next("redo")).toMatchObject({
          kind: "navigation",
          after: { zoomRootId: "root" }
        });
        expect(publishFeedback).toHaveBeenCalledTimes(1);
        expect(publishFeedback).toHaveBeenCalledWith(
          expect.objectContaining({ kind: "error" })
        );
      } finally {
        rendered.unmount();
        openSession.mockRestore();
      }
    }
  );

  it.each(["chooser", "filter"] as const)(
    "keeps tag summaries atomic when navigation prepare fails for %s",
    async (kind) => {
      const active = workspace([node({ id: "active" })]);
      const tagged = workspace([node({ id: "tagged" })]);
      const work = { prefix: "#" as const, normalizedTag: "work" };
      const summaries = [{ ...work, displayTag: "Work", count: 1 }];
      const publishFeedback = vi.fn();
      const store = repository({
        loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
          scope.kind === "tags" ? tagged : active
        ),
        listTagsWithCounts: vi.fn().mockResolvedValue(summaries),
        prepareNavigation: vi.fn().mockRejectedValue(new Error("prepare failed"))
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
          vaultRoot: `/task-6-atomic-tag-summaries-${kind}`,
          repository: store,
          publishFeedback
        })
      );
      try {
        await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
        expect(rendered.result.current.tagSummaries).toEqual([]);
        vi.mocked(store.loadWorkspace).mockClear();
        vi.mocked(store.historyStatus!).mockClear();
        vi.mocked(store.prepareNavigation!).mockClear();

        await act(async () => {
          if (kind === "chooser") {
            await rendered.result.current.actions.selectLibraryView("tags");
          } else {
            await rendered.result.current.actions.toggleTagFilter(work);
          }
        });

        expect(rendered.result.current).toMatchObject({
          status: "ready",
          error: null,
          libraryView: "all",
          activeTagFilters: [],
          tagSummaries: [],
          canUndo: false,
          canRedo: false
        });
        expect(rendered.result.current.state).toMatchObject({
          rootIds: ["active"],
          selectedId: null,
          zoomRootId: null
        });
        expect(rendered.result.current.state.nodesById.tagged).toBeUndefined();
        expect(sessions.at(-1)!.history.next("undo")).toBeNull();
        expect(sessions.at(-1)!.history.snapshotCount()).toBe(0);
        expect(store.listTagsWithCounts).toHaveBeenCalledOnce();
        expect(store.historyStatus).toHaveBeenCalledOnce();
        expect(store.loadWorkspace).toHaveBeenCalledOnce();
        expect(store.prepareNavigation).toHaveBeenCalledOnce();
        expect(publishFeedback).toHaveBeenCalledTimes(1);
      } finally {
        rendered.unmount();
        openSession.mockRestore();
      }
    }
  );

  it("commits an admitted navigation once after ownership transfers during prepare", async () => {
    const active = workspace([node({ id: "active" })]);
    const starred = workspace([node({ id: "starred", isStarred: true })]);
    const guard = deferred<NotesHistoryState>();
    let blockPrepare = false;
    let guardSessionId = "";
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "starred" ? starred : active
      ),
      historyStatus: vi.fn(async (_vaultRoot, sessionId) =>
        syntheticHistoryStatus(sessionId)
      ),
      prepareNavigation: vi.fn(async (_vaultRoot, input) => {
        if (!blockPrepare) return syntheticHistoryStatus(input.sessionId);
        guardSessionId = input.sessionId;
        return guard.promise;
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
    const first = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-6-owner-transfer", repository: store })
    );
    const second = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-6-owner-transfer", repository: store })
    );
    try {
      await waitFor(() => expect(second.result.current.status).toBe("ready"));
      blockPrepare = true;
      vi.mocked(store.prepareNavigation!).mockClear();
      let navigation!: Promise<void>;
      act(() => {
        navigation = second.result.current.actions.selectLibraryView("starred");
      });
      await waitFor(() => expect(store.prepareNavigation).toHaveBeenCalledOnce());

      second.unmount();
      guard.resolve(syntheticHistoryStatus(guardSessionId));
      await act(async () => navigation);

      await waitFor(() =>
        expect(first.result.current.libraryView).toBe("starred")
      );
      expect(first.result.current.state.nodesById.starred).toBeDefined();
      expect(first.result.current.state.nodesById.active).toBeUndefined();
      expect(sessions.at(-1)!.history.next("undo")).toMatchObject({
        kind: "navigation",
        after: {
          scope: { kind: "starred" },
          libraryView: "starred"
        }
      });
      expect(store.prepareNavigation).toHaveBeenCalledOnce();
    } finally {
      first.unmount();
      second.unmount();
      openSession.mockRestore();
    }
  });

  it("settles an admitted navigation after its owner closes during history status", async () => {
    const active = workspace([node({ id: "active" })]);
    const starred = workspace([node({ id: "starred", isStarred: true })]);
    const pendingStatus = deferred<NotesHistoryState>();
    let deferStatus = false;
    let statusSessionId = "";
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "starred" ? starred : active
      ),
      historyStatus: vi.fn(async (_vaultRoot, sessionId) => {
        if (!deferStatus) return syntheticHistoryStatus(sessionId);
        statusSessionId = sessionId;
        return pendingStatus.promise;
      }),
      prepareNavigation: vi.fn(async (_vaultRoot, input) =>
        syntheticHistoryStatus(input.sessionId)
      )
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
      useNotesWorkspace({ vaultRoot: "/task-6-status-owner-close", repository: store })
    );
    await waitFor(() => expect(survivor.result.current.status).toBe("ready"));
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-6-status-owner-close", repository: store })
    );
    try {
      await waitFor(() => expect(owner.result.current.status).toBe("ready"));
      deferStatus = true;
      vi.mocked(store.historyStatus!).mockClear();
      vi.mocked(store.prepareNavigation!).mockClear();
      let navigation!: Promise<void>;
      act(() => {
        navigation = owner.result.current.actions.selectLibraryView("starred");
      });
      await waitFor(() => expect(store.historyStatus).toHaveBeenCalledOnce());

      await act(async () => owner.result.current.actions.focusNode("active"));
      expect(owner.result.current.state).toMatchObject({
        selectedId: "active",
        editingNoteId: "active"
      });
      owner.unmount();
      pendingStatus.resolve(syntheticHistoryStatus(statusSessionId));
      await act(async () => navigation);

      await waitFor(() => {
        expect(store.prepareNavigation).toHaveBeenCalledOnce();
        expect(survivor.result.current).toMatchObject({
          status: "ready",
          libraryView: "starred",
          canUndo: true,
          canRedo: false
        });
      });
      expect(survivor.result.current.state.nodesById.starred).toBeDefined();
      expect(survivor.result.current.state.nodesById.active).toBeUndefined();
      const history = sessions[0]!.history;
      expect(history.snapshotCount()).toBe(1);
      expect(history.next("undo")).toMatchObject({
        kind: "navigation",
        before: {
          scope: { kind: "active" },
          libraryView: "all",
          selectedId: "active",
          focus: { nodeId: "active", field: "title" }
        },
        after: {
          scope: { kind: "starred" },
          libraryView: "starred"
        }
      });
    } finally {
      owner.unmount();
      survivor.unmount();
      openSession.mockRestore();
    }
  });

  it("preserves an admitted destination through a background-only owner interval", async () => {
    const active = workspace([node({ id: "active" })]);
    const starred = workspace([node({ id: "starred", isStarred: true })]);
    const guard = deferred<NotesHistoryState>();
    let blockPrepare = false;
    let guardSessionId = "";
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "starred" ? starred : active
      ),
      historyStatus: vi.fn(async (_vaultRoot, sessionId) =>
        syntheticHistoryStatus(sessionId)
      ),
      prepareNavigation: vi.fn(async (_vaultRoot, input) => {
        if (!blockPrepare) return syntheticHistoryStatus(input.sessionId);
        guardSessionId = input.sessionId;
        return guard.promise;
      })
    });
    const background = notesWorkspaceCoordinatorRegistry.openSession({
      repository: store,
      vaultRoot: "/task-6-background-interval",
      presentation: "background",
      onEvent: vi.fn(),
      isCurrent: () => true,
      getScope: () => ({ kind: "active" })
    });
    await background.activation;
    const owner = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/task-6-background-interval",
        repository: store
      })
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    blockPrepare = true;
    let navigation!: Promise<void>;
    act(() => {
      navigation = owner.result.current.actions.selectLibraryView("starred");
    });
    await waitFor(() => expect(store.prepareNavigation).toHaveBeenCalledOnce());

    owner.unmount();
    guard.resolve(syntheticHistoryStatus(guardSessionId));
    await act(async () => navigation);
    expect(background.history.next("undo")).toMatchObject({
      kind: "navigation",
      after: {
        scope: { kind: "starred" },
        libraryView: "starred"
      }
    });

    const replacement = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/task-6-background-interval",
        repository: store
      })
    );
    try {
      await waitFor(() => expect(replacement.result.current.status).toBe("ready"));
      expect(replacement.result.current).toMatchObject({
        libraryView: "starred",
        canUndo: true
      });
      expect(replacement.result.current.state.nodesById.starred).toBeDefined();
      expect(replacement.result.current.state.nodesById.active).toBeUndefined();
    } finally {
      replacement.unmount();
      background.close();
    }
  });

  it("refreshes tag summaries after an admitted Tags navigation outlives its owner", async () => {
    const active = workspace([node({ id: "active" })]);
    const tagged = workspace([node({ id: "tagged" })]);
    const work = { prefix: "#" as const, normalizedTag: "work" };
    const summaries = [{ ...work, displayTag: "Work", count: 1 }];
    const guard = deferred<NotesHistoryState>();
    let blockPrepare = false;
    let guardSessionId = "";
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "tags" ? tagged : active
      ),
      listTagsWithCounts: vi.fn().mockResolvedValue(summaries),
      historyStatus: vi.fn(async (_vaultRoot, sessionId) =>
        syntheticHistoryStatus(sessionId)
      ),
      prepareNavigation: vi.fn(async (_vaultRoot, input) => {
        if (!blockPrepare) return syntheticHistoryStatus(input.sessionId);
        guardSessionId = input.sessionId;
        return guard.promise;
      })
    });
    const background = notesWorkspaceCoordinatorRegistry.openSession({
      repository: store,
      vaultRoot: "/task-6-background-tag-summaries",
      presentation: "background",
      onEvent: vi.fn(),
      isCurrent: () => true,
      getScope: () => ({ kind: "active" })
    });
    await background.activation;
    const owner = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/task-6-background-tag-summaries",
        repository: store
      })
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    blockPrepare = true;
    let navigation!: Promise<void>;
    act(() => {
      navigation = owner.result.current.actions.toggleTagFilter(work);
    });
    await waitFor(() => expect(store.prepareNavigation).toHaveBeenCalledOnce());
    expect(store.listTagsWithCounts).toHaveBeenCalledOnce();

    owner.unmount();
    guard.resolve(syntheticHistoryStatus(guardSessionId));
    await act(async () => navigation);
    await waitFor(() =>
      expect(background.history.next("undo")).toMatchObject({
        kind: "navigation",
        after: {
          scope: { kind: "tags", tags: [work] },
          libraryView: "tags",
          activeTagFilters: [work]
        }
      })
    );

    const replacement = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/task-6-background-tag-summaries",
        repository: store
      })
    );
    try {
      await waitFor(() => expect(replacement.result.current.status).toBe("ready"));
      expect(replacement.result.current).toMatchObject({
        libraryView: "tags",
        activeTagFilters: [work],
        canUndo: true
      });
      expect(replacement.result.current.state.nodesById.tagged).toBeDefined();
      expect(replacement.result.current.state.nodesById.active).toBeUndefined();
      await waitFor(() =>
        expect(replacement.result.current.tagSummaries).toEqual(summaries)
      );
      expect(store.listTagsWithCounts).toHaveBeenCalledTimes(2);
    } finally {
      replacement.unmount();
      background.close();
    }
  });

  it("releases committed and canceled nested-origin expansion ownership on cleanup", async () => {
    const initial = workspace([
      node({ id: "root", isCollapsed: true }),
      node({ id: "child", parentId: "root" })
    ]);
    const baselinePoolSize = notesExpansionSnapshotPool.size();
    let failPrepare = false;
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      prepareNavigation: vi.fn(async (_vaultRoot, input) => {
        if (failPrepare) throw new Error("guard failed");
        return syntheticHistoryStatus(input.sessionId);
      }),
      listTagsWithCounts: vi.fn().mockResolvedValue([])
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
      useNotesWorkspace({ vaultRoot: "/task-6-expansion-ownership", repository: store })
    );
    openSession.mockRestore();
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    await act(async () => rendered.result.current.actions.openSearchResult("child"));
    expect(rendered.result.current.locallyExpandedNodeIds).toEqual(
      new Set(["root"])
    );
    failPrepare = true;
    await act(async () =>
      rendered.result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    expect(sessions.at(-1)!.history.next("undo")).toMatchObject({
      kind: "navigation",
      after: {
        scope: { kind: "active" },
        expansion: { nodeIds: ["root"] },
        tagFilterOrigin: null
      }
    });

    rendered.unmount();
    await waitFor(() =>
      expect(
        notesWorkspaceCoordinatorRegistry.hasCoordinator(
          store,
          "/task-6-expansion-ownership"
        )
      ).toBe(false)
    );
    expect(notesExpansionSnapshotPool.size()).toBe(baselinePoolSize);
  });

  it("replays navigation locally with status preflight and no prepare or backend replay", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "child", parentId: "root" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial)
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-6-local-navigation-replay", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    await act(async () => rendered.result.current.actions.zoomTo("child"));
    vi.mocked(store.historyStatus!).mockClear();
    vi.mocked(store.prepareNavigation!).mockClear();
    vi.mocked(store.undo!).mockClear();
    vi.mocked(store.redo!).mockClear();

    await act(async () => rendered.result.current.actions.undo!());

    expect(store.historyStatus).toHaveBeenCalledOnce();
    expect(store.prepareNavigation).not.toHaveBeenCalled();
    expect(store.undo).not.toHaveBeenCalled();
    expect(store.redo).not.toHaveBeenCalled();
    expect(rendered.result.current.state.zoomRootId).toBeNull();

    vi.mocked(store.historyStatus!).mockClear();
    await act(async () => rendered.result.current.actions.redo!());
    expect(store.historyStatus).toHaveBeenCalledOnce();
    expect(store.prepareNavigation).not.toHaveBeenCalled();
    expect(store.undo).not.toHaveBeenCalled();
    expect(store.redo).not.toHaveBeenCalled();
    expect(rendered.result.current.state.zoomRootId).toBe("child");
  });

  it("prepares redo truncation once without queueing duplicate cleanup", async () => {
    const initial = workspace([node({ id: "root" })]);
    const order: string[] = [];
    let mutationId: string | null = null;
    let hasMutationRedo = true;
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      historyStatus: vi.fn(async () => {
        order.push("status");
        return hasMutationRedo
          ? {
              ...historyState(),
              canRedo: true,
              nextRedoEntryId: mutationId
            }
          : historyState();
      }),
      prepareNavigation: vi.fn(async () => {
        order.push("prepare");
        hasMutationRedo = false;
        return historyState();
      }),
      pruneHistoryEntries: vi.fn(async () => {
        order.push("cleanup");
        return historyState();
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
      useNotesWorkspace({ vaultRoot: "/task-6-redo-cleanup", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      const session = sessions.at(-1)!;
      const snapshot = (): NotesHistorySnapshot => ({
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        selectedId: null,
        zoomRootId: null,
        expansion: notesExpansionSnapshotPool.acquire([]),
        focus: null,
        tagFilterOrigin: null
      });
      const mutation = session.history.beginStructuralEntry("seed", snapshot());
      mutationId = mutation.entryId;
      expect(
        session.history.acceptMutationResult(mutation.entryId, snapshot(), {
          ...historyState(),
          canUndo: true,
          nextUndoEntryId: mutation.entryId
        }).accepted
      ).toBe(true);
      expect(
        session.history.acceptReplayResult(
          {
            ...historyState(),
            canRedo: true,
            nextRedoEntryId: mutation.entryId
          },
          "undo",
          mutation.entryId
        )
      ).toBe(true);
      session.history.commitReplay("undo");
      order.length = 0;

      await act(async () => rendered.result.current.actions.zoomTo("root"));

      expect(store.prepareNavigation).toHaveBeenCalledWith(
        "/task-6-redo-cleanup",
        expect.objectContaining({
          unreachableRedoEntryIds: [mutation.entryId]
        })
      );
      expect(order).toEqual(["status", "prepare"]);
      order.length = 0;

      await act(async () => rendered.result.current.actions.zoomTo(null));

      expect(order.slice(0, 2)).toEqual(["status", "prepare"]);
      expect(store.pruneHistoryEntries).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("queues a mutation evicted by the 101st mixed entry and drains it first", async () => {
    const initial = workspace([node({ id: "root" })]);
    const order: string[] = [];
    let nearestMutationId: string | null = null;
    const backendState = (): NotesHistoryState => ({
      ...historyState(),
      canUndo: nearestMutationId !== null,
      nextUndoEntryId: nearestMutationId
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      historyStatus: vi.fn(async () => {
        order.push("status");
        return backendState();
      }),
      prepareNavigation: vi.fn(async () => {
        order.push("prepare");
        return backendState();
      }),
      pruneHistoryEntries: vi.fn(async () => {
        order.push("cleanup");
        return backendState();
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
      useNotesWorkspace({ vaultRoot: "/task-6-cap-cleanup", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      const session = sessions.at(-1)!;
      const snapshot = (): NotesHistorySnapshot => ({
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        selectedId: null,
        zoomRootId: null,
        expansion: notesExpansionSnapshotPool.acquire([]),
        focus: null,
        tagFilterOrigin: null
      });
      const mutationIds: string[] = [];
      for (let index = 0; index < 100; index += 1) {
        const mutation = session.history.beginStructuralEntry(
          `seed-${index}`,
          snapshot()
        );
        mutationIds.push(mutation.entryId);
        session.history.rememberAfter(mutation.entryId, snapshot());
      }
      nearestMutationId = mutationIds.at(-1)!;
      expect(session.history.snapshotCount()).toBe(100);
      order.length = 0;

      await act(async () => rendered.result.current.actions.zoomTo("root"));

      expect(session.history.snapshotCount()).toBe(100);
      expect(store.pruneHistoryEntries).not.toHaveBeenCalled();
      order.length = 0;
      await act(async () => rendered.result.current.actions.zoomTo(null));

      expect(order.slice(0, 2)).toEqual(["cleanup", "status"]);
      expect(store.pruneHistoryEntries).toHaveBeenCalledWith(
        "/task-6-cap-cleanup",
        expect.objectContaining({ entryIds: [mutationIds[0]] })
      );
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("settles mutation fallback canonically without a navigation entry", async () => {
    const root = node({ id: "root", sortKey: 1 });
    const other = node({ id: "other", sortKey: 2 });
    const initial = workspace([root, other]);
    const afterArchive = workspace([other]);
    let archived = false;
    const store = repository({
      loadWorkspace: vi.fn(async () => (archived ? afterArchive : initial)),
      archiveNode: vi.fn(async (_vaultRoot, _nodeId, context) => {
        archived = true;
        return mutationResult(afterArchive, context);
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
    const first = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/task-6-automatic-fallback", repository: store })
    );
    try {
      await waitFor(() => expect(first.result.current.status).toBe("ready"));
      await act(async () => first.result.current.actions.zoomTo("root"));
      const session = sessions.at(-1)!;
      expect(session.history.snapshotCount()).toBe(1);

      await act(async () => first.result.current.actions.archiveNode("root"));

      expect(session.history.snapshotCount()).toBe(2);
      expect(session.history.next("undo")).toMatchObject({
        kind: "mutation",
        after: {
          selectedId: "other",
          zoomRootId: "other"
        }
      });
      expect(first.result.current.state).toMatchObject({
        selectedId: "other",
        zoomRootId: "other"
      });

      const second = renderHook(() =>
        useNotesWorkspace({
          vaultRoot: "/task-6-automatic-fallback",
          repository: store
        })
      );
      try {
        await waitFor(() => expect(second.result.current.status).toBe("ready"));
        expect(second.result.current.state).toMatchObject({
          selectedId: "other",
          zoomRootId: "other"
        });
        expect(second.result.current.state.nodesById.root).toBeUndefined();
      } finally {
        second.unmount();
      }
    } finally {
      first.unmount();
      openSession.mockRestore();
    }
  });
});
