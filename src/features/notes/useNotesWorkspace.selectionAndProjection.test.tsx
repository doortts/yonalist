import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isNotesMutationResult, type NoteAttachment, type NoteNode, type NotesHistoryContext, type NotesHistoryState, type NotesMutationResponse, type NotesMutationResult, type NotesStore, type NotesWorkspace } from "../../domain/notes";
import { focusedUiUpdate, scopedActiveDelta, unwrapNotesMutation, useNotesWorkspace, type UseNotesWorkspaceResult } from "./useNotesWorkspace";
import { setNotesDeltaVerificationEnabled } from "./notesWorkspaceReducer";
import { deriveNotesSelectionActionSnapshot } from "./notesSelectionActions";
import { createNotesSelectionCommandRouter } from "./useNotesSelectionCommandRouter";
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
    ...overrides,
    markerKind: overrides.markerKind ?? "bullet"
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
      , imageOffsetUtf16: 0})
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
      , imageOffsetUtf16: 0})
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
    const base = threeNodeStore({ applyBatch });
    const { repository: store, events } = journalNotesRepository(base);
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    events.clear();

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
    expect(
      events.for("applyBatch").map(({ vaultRoot, commandKind, input }) => ({
        vaultRoot,
        commandKind,
        input
      }))
    ).toEqual([
      {
        vaultRoot: "/vault",
        commandKind: "batch",
        input: { op: "duplicate", nodeIds: ["a", "b"] }
      },
      {
        vaultRoot: "/vault",
        commandKind: "batch",
        input: {
          op: "addTag",
          nodeIds: ["a", "b"],
          tag: {
            prefix: "#",
            normalizedTag: "launch",
            displayTag: "Launch"
          }
        }
      },
      {
        vaultRoot: "/vault",
        commandKind: "batch",
        input: {
          op: "removeTag",
          nodeIds: ["a", "b"],
          tag: { prefix: "@", normalizedTag: "owner" }
        }
      }
    ]);
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
      result.current.actions.updateNodeDraft("a", { title: "typed", note: "" , imageOffsetUtf16: 0})
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
