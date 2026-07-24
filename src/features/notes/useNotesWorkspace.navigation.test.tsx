import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isNotesMutationResult, type NoteAttachment, type NoteNode, type ImageAtomMutationResult, type NotesHistoryContext, type NotesHistoryReplayOutcome, type NotesHistoryState, type NotesMutationResponse, type NotesMutationResult, type NotesStore, type NotesWorkspace, type NotesWorkspaceScope } from "../../domain/notes";
import { useNotesWorkspace, type NotesWorkspaceActions } from "./useNotesWorkspace";
import { notesWorkspaceCoordinatorRegistry, type NotesWorkspaceCommandOutcome, type NotesWorkspaceCoordinatorSession } from "./notesWorkspaceCoordinator";
import { imageAtomPostconditionDigest } from "./notesCommands";
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
    ...overrides,
    markerKind: overrides.markerKind ?? "bullet",
    markdownImageWidth: overrides.markdownImageWidth ?? null
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

async function imageAtomMutationResult(
  resultWorkspace: NotesWorkspace,
  context: NotesHistoryContext,
  nodeId: string,
  kind: "edit" | "paste" = "edit",
  postconditionDigest?: string
): Promise<ImageAtomMutationResult> {
  const digest =
    postconditionDigest ??
    (await imageAtomPostconditionDigest(resultWorkspace, [nodeId], kind));
  if (!digest) throw new Error("Test image-atom digest is unavailable.");
  return {
    ...mutationResult(resultWorkspace, context),
    operation: {
      operationId: context.entryId,
      historyEpoch: context.historyEpoch,
      postconditionDigest: digest,
      affectedRootIds: [nodeId],
      focus: { nodeId, anchorUtf16: 0, focusUtf16: 0 }
    }
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

function historyContext(commandKind: string) {
  return expect.objectContaining({
    sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    historyEpoch: "epoch-a",
    entryId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    commandKind
  });
}

describe("Task 6 undoable navigation boundary", () => {
  it("records zoom navigation only after status preflight and prepare guard", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "child", parentId: "root", title: "Child page" })
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
        after: {
          selectedId: "child",
          zoomRootId: "child",
          focus: {
            nodeId: "child",
            field: "title",
            primarySelection: { anchorUtf16: 10, focusUtf16: 10 }
          }
        }
      });
      expect(rendered.result.current.state.zoomRootId).toBe("child");
      expect(rendered.result.current.pendingPrimarySelection).toMatchObject({
        nodeId: "child",
        field: "title",
        selection: { anchorUtf16: 10, focusUtf16: 10 }
      });
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it("replaces acknowledged logical focus with the zoom destination title", async () => {
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
        selectedId: "other",
        editingNoteId: "other",
        pendingFocusId: "other",
        pendingFocusField: "title",
        zoomRootId: "other"
      });
      expect(sessions.at(-1)!.history.next("undo")).toMatchObject({
        kind: "navigation",
        after: {
          focus: { nodeId: "other", field: "title" }
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
        , imageOffsetUtf16: 0});
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

  it("exposes a workspace-scoped image editor flush registrar that persists its exact draft triple", async () => {
    const updateNode = vi.fn().mockResolvedValue(
      workspace([node({ id: "root", title: "beforeafter", imageOffsetUtf16: 6 })])
    );
    const store = repository({ updateNode });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-registrar", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    type ImageAdapter = {
      nodeId: string;
      flush(): Promise<"flushed">;
    };
    const adapter: ImageAdapter = {
      nodeId: "root",
      flush: vi.fn(async () => {
        result.current.actions.updateNodeDraft("root", {
          title: "beforeafter",
          note: "support",
          imageOffsetUtf16: 6
        });
        return "flushed" as const;
      })
    };
    const register = (result.current.actions as unknown as {
      registerImageAtomFlushAdapter?: (adapter: ImageAdapter) => () => void;
    }).registerImageAtomFlushAdapter;

    expect(register).toEqual(expect.any(Function));
    const unregister = register!(adapter);
    await act(async () =>
      expect(await result.current.actions.flushNodeDraft("root")).toBe(true)
    );
    expect(adapter.flush).toHaveBeenCalledOnce();
    expect(updateNode).toHaveBeenCalledWith(
      "/image-atom-registrar",
      expect.objectContaining({
        id: "root",
        title: "beforeafter",
        note: "support",
        imageOffsetUtf16: 6
      }),
      expect.any(Object)
    );

    unregister();
    await act(async () =>
      expect(await result.current.actions.flushNodeDraft("root")).toBe(true)
    );
    expect(adapter.flush).toHaveBeenCalledOnce();
  });

  it("reports a cancelled image composition through the distinct bottom-bar feedback path", async () => {
    const publishFeedback = vi.fn();
    const store = repository();
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/image-atom-cancelled",
        repository: store,
        publishFeedback
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const register = (result.current.actions as unknown as {
      registerImageAtomFlushAdapter?: (adapter: {
        nodeId: string;
        flush(): Promise<"cancelled">;
      }) => () => void;
    }).registerImageAtomFlushAdapter;

    register!({ nodeId: "root", flush: async () => "cancelled" });
    await act(async () =>
      expect(await result.current.actions.flushNodeDraft("root")).toBe(false)
    );

    expect(publishFeedback).toHaveBeenCalledWith({
      kind: "error",
      message: "Text composition was interrupted. Try the action again."
    });
    expect(store.updateNode).not.toHaveBeenCalled();
  });

  it("does not let a previous-session adapter cleanup remove a current-session registration", async () => {
    const store = repository();
    const rendered = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/image-atom-session-a" } }
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    const oldRegister = (rendered.result.current.actions as unknown as {
      registerImageAtomFlushAdapter?: (adapter: {
        nodeId: string;
        flush(): Promise<"flushed">;
      }) => () => void;
    }).registerImageAtomFlushAdapter;
    const unregisterOld = oldRegister!({
      nodeId: "root",
      flush: async () => "flushed"
    });

    rendered.rerender({ vaultRoot: "/image-atom-session-b" });
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    const currentRegister = (rendered.result.current.actions as unknown as {
      registerImageAtomFlushAdapter?: (adapter: {
        nodeId: string;
        flush(): Promise<"flushed">;
      }) => () => void;
    }).registerImageAtomFlushAdapter;
    const current = { nodeId: "root", flush: vi.fn().mockResolvedValue("flushed" as const) };
    const unregisterCurrent = currentRegister!(current);

    unregisterOld();
    await act(async () =>
      expect(await rendered.result.current.actions.flushNodeDraft("root")).toBe(true)
    );
    expect(current.flush).toHaveBeenCalledOnce();
    unregisterCurrent();
  });

  it("starts an active image adapter flush before hook teardown disposes the session", async () => {
    const pending = deferred<"cancelled">();
    const flush = vi.fn().mockReturnValue(pending.promise);
    const store = repository();
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-unmount", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    rendered.result.current.actions.registerImageAtomFlushAdapter!({
      nodeId: "root",
      flush
    });

    rendered.unmount();

    expect(flush).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve("cancelled");
      await pending.promise;
    });
    expect(store.updateNode).not.toHaveBeenCalled();
  });

  it("cancels a deferred old-vault image adapter without writing into the new session", async () => {
    const pending = deferred<"cancelled">();
    const oldFlush = vi.fn().mockReturnValue(pending.promise);
    const store = repository({
      loadWorkspace: vi.fn((vaultRoot) =>
        Promise.resolve(
          workspace([node({ id: vaultRoot === "/old-image" ? "old-root" : "new-root" })])
        )
      )
    });
    const rendered = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old-image" } }
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    rendered.result.current.actions.registerImageAtomFlushAdapter!({
      nodeId: "old-root",
      flush: oldFlush
    });

    rendered.rerender({ vaultRoot: "/new-image" });

    expect(oldFlush).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve("cancelled");
      await pending.promise;
    });
    await waitFor(() =>
      expect(rendered.result.current.state.nodesById["new-root"]).toBeDefined()
    );
    expect(store.updateNode).not.toHaveBeenCalled();
    expect(rendered.result.current.draftsByNodeId).toEqual({});
  });

  it("delegates an image-atom edit through the structural command boundary", async () => {
    const imageNodeId = "99000000-0000-4000-8000-000000000001";
    const attachmentId = "99000000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const settled = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const settledDigest = await imageAtomPostconditionDigest(
      settled,
      [imageNodeId],
      "edit"
    );
    expect(settledDigest).toMatch(/^[0-9a-f]{64}$/);
    let settleAuthoritativePresentation:
      | ReturnType<typeof vi.fn>
      | undefined;
    const originalOpenSession = notesWorkspaceCoordinatorRegistry.openSession.bind(
      notesWorkspaceCoordinatorRegistry
    );
    const openSessionSpy = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = originalOpenSession(options);
        const settle = session.settleAuthoritativePresentation.bind(session);
        const presentationSpy = vi.fn(settle);
        settleAuthoritativePresentation = presentationSpy;
        (session as { settleAuthoritativePresentation: typeof settle }).settleAuthoritativePresentation =
          presentationSpy as unknown as typeof settle;
        return session;
      });
    const applyImageAtomEdit = vi.fn(
      async (
        _vaultRoot: string,
        _input: unknown,
        context: NotesHistoryContext
      ): Promise<ImageAtomMutationResult> =>
        imageAtomMutationResult(settled, context, imageNodeId)
    );
    const undo = vi.fn(async (_vaultRoot, input) =>
      appliedReplay(initial, input.expectedEntryId, "undo")
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit,
      undo,
      ackImageAtomOperation: vi.fn(async () => {
        expect(notesHistorySpies.acceptMutationResult).toHaveBeenCalledOnce();
        expect(settleAuthoritativePresentation).toHaveBeenCalledOnce();
      })
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-command-delegate", repository: store })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    await act(async () => {
      await rendered.result.current.actions.focusNode(imageNodeId);
      await rendered.result.current.actions.acknowledgeFocus(imageNodeId);
    });

    let outcome: Awaited<ReturnType<NotesWorkspaceActions["applyImageAtomEdit"]>>;
    await act(async () => {
      outcome = await rendered.result.current.actions.applyImageAtomEdit(
        imageNodeId,
        { anchorUtf16: 6, focusUtf16: 7 },
        { kind: "remove", replacementText: "" }
      );
    });
    expect(outcome!).toBe("committed");

    expect(notesHistorySpies.beginStructural).toHaveBeenLastCalledWith(
      "imageAtomEdit",
      expect.objectContaining({
        focus: {
          nodeId: imageNodeId,
          field: "title",
          primarySelection: { anchorUtf16: 6, focusUtf16: 7 }
        }
      })
    );
    expect(applyImageAtomEdit).toHaveBeenCalledWith(
      "/image-atom-command-delegate",
      expect.objectContaining({
        target: expect.objectContaining({
          nodeId: imageNodeId,
          expectedPrimaryAttachmentId: attachmentId
        }),
        selection: { anchorUtf16: 6, focusUtf16: 7 },
        edit: { kind: "remove", replacementText: "" }
      }),
      historyContext("imageAtomEdit")
    );
    expect(store.ackImageAtomOperation).toHaveBeenCalledWith(
      "/image-atom-command-delegate",
      expect.any(String),
      "epoch-a",
      expect.any(String)
    );
    expect(store.loadWorkspace).toHaveBeenCalledOnce();
    expect(notesHistorySpies.acceptMutationResult.mock.calls.at(-1)?.[1]).toMatchObject({
      focus: {
        nodeId: imageNodeId,
        field: "title",
        primarySelection: { anchorUtf16: 0, focusUtf16: 0 }
      }
    });
    await act(async () =>
      rendered.result.current.actions.acknowledgeFocus(imageNodeId)
    );
    await act(async () => rendered.result.current.actions.undo!());
    expect(
      (
        rendered.result.current as typeof rendered.result.current & {
          pendingPrimarySelection?: {
            requestId: number;
            nodeId: string;
            selection: { anchorUtf16: number; focusUtf16: number };
          } | null;
        }
      ).pendingPrimarySelection
    ).toMatchObject({
      nodeId: imageNodeId,
      selection: { anchorUtf16: 6, focusUtf16: 7 }
    });
    await act(async () =>
      rendered.result.current.actions.applyImageAtomEdit(
        imageNodeId,
        { anchorUtf16: 10, focusUtf16: 2 },
        { kind: "remove", replacementText: "" }
      )
    );
    expect(notesHistorySpies.beginStructural).toHaveBeenLastCalledWith(
      "imageAtomEdit",
      expect.objectContaining({
        focus: {
          nodeId: imageNodeId,
          field: "title",
          primarySelection: { anchorUtf16: 10, focusUtf16: 2 }
        }
      })
    );
    } finally {
      rendered.unmount();
      openSessionSpy.mockRestore();
    }
  });

  it("projects image removal before acknowledgement finishes", async () => {
    const imageNodeId = "99000500-0000-4000-8000-000000000001";
    const attachmentId = "99000500-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "",
          note: "support",
          imageOffsetUtf16: 0
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const settled = workspace([
      node({
        id: imageNodeId,
        nodeKind: "text",
        title: "",
        note: "support",
        imageOffsetUtf16: 0
      })
    ]);
    const acknowledgement = deferred<void>();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit: vi.fn(async (_vaultRoot, _input, context) =>
        imageAtomMutationResult(settled, context, imageNodeId)
      ),
      ackImageAtomOperation: vi.fn(() => acknowledgement.promise)
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/image-removal-before-ack",
        repository: store
      })
    );
    let removal:
      | ReturnType<NotesWorkspaceActions["applyImageAtomEdit"]>
      | undefined;

    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

      act(() => {
        removal = rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 0, focusUtf16: 1 },
          { kind: "remove", replacementText: "" }
        );
      });
      await waitFor(() =>
        expect(store.ackImageAtomOperation).toHaveBeenCalledOnce()
      );

      expect(
        rendered.result.current.state.nodesById[imageNodeId]?.nodeKind
      ).toBe("text");
      expect(
        rendered.result.current.state.attachmentsByNodeId[imageNodeId] ?? []
      ).toEqual([]);
      expect(rendered.result.current.state.nodesById[imageNodeId]?.note).toBe(
        "support"
      );
      expect(store.loadWorkspace).toHaveBeenCalledOnce();
    } finally {
      acknowledgement.resolve();
      if (removal) {
        await act(async () => {
          await removal;
        });
      }
      rendered.unmount();
    }
  });

  it("records Enter source selection and the receipt-selected result sibling", async () => {
    const imageNodeId = "99001000-0000-4000-8000-000000000001";
    const siblingId = "99001000-0000-4000-8000-000000000002";
    const attachmentId = "99001000-0000-4000-8000-000000000003";
    const initial: NotesWorkspace = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    };
    const result: NotesWorkspace = {
      nodes: [
        node({ id: imageNodeId, title: "be", imageOffsetUtf16: 0 }),
        node({
          id: siblingId,
          nodeKind: "image",
          sortKey: 2048,
          title: "foreafter",
          imageOffsetUtf16: 4
        })
      ],
      attachmentsByNodeId: {
        [siblingId]: [attachment({ id: attachmentId, nodeId: siblingId })]
      }
    };
    const applyImageAtomEdit = vi.fn<NotesStore["applyImageAtomEdit"]>(
      async (_vaultRoot, _input, context) => {
        const postconditionDigest = await imageAtomPostconditionDigest(
          result,
          [imageNodeId, siblingId],
          "edit"
        );
        return {
          ...mutationResult(result, context),
          operation: {
            operationId: context.entryId,
            historyEpoch: context.historyEpoch,
            postconditionDigest: postconditionDigest!,
            affectedRootIds: [imageNodeId, siblingId],
            focus: { nodeId: siblingId, anchorUtf16: 4, focusUtf16: 4 }
          }
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/image-atom-enter-selection",
        repository: store
      })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 2, focusUtf16: 2 },
          { kind: "enter", siblingId }
        )
      ).resolves.toBe("committed")
    );

    expect(notesHistorySpies.beginStructural).toHaveBeenLastCalledWith(
      "imageAtomEdit",
      expect.objectContaining({
        focus: {
          nodeId: imageNodeId,
          field: "title",
          primarySelection: { anchorUtf16: 2, focusUtf16: 2 }
        }
      })
    );
    expect(notesHistorySpies.acceptMutationResult).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        focus: {
          nodeId: siblingId,
          field: "title",
          primarySelection: { anchorUtf16: 4, focusUtf16: 4 }
        }
      }),
      expect.anything()
    );
  });

  it("records old and receipt-selected new atoms for an in-place image replacement", async () => {
    const imageNodeId = "99002000-0000-4000-8000-000000000001";
    const oldAttachmentId = "99002000-0000-4000-8000-000000000002";
    const newAttachmentId = "99002000-0000-4000-8000-000000000003";
    const generatedNodeId = "99002000-0000-4000-8000-000000000004";
    createNoteIdMock
      .mockReturnValueOnce(generatedNodeId)
      .mockReturnValueOnce(newAttachmentId);
    const initial: NotesWorkspace = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: oldAttachmentId, nodeId: imageNodeId })]
      }
    };
    const result: NotesWorkspace = {
      nodes: initial.nodes,
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: newAttachmentId, nodeId: imageNodeId })]
      }
    };
    const applyImageAtomPaste = vi.fn<NotesStore["applyImageAtomPaste"]>(
      async (_vaultRoot, _input, context) => {
        const postconditionDigest = await imageAtomPostconditionDigest(
          result,
          [imageNodeId],
          "paste"
        );
        return {
          ...mutationResult(result, context),
          operation: {
            operationId: context.entryId,
            historyEpoch: context.historyEpoch,
            postconditionDigest: postconditionDigest!,
            affectedRootIds: [imageNodeId],
            focus: { nodeId: imageNodeId, anchorUtf16: 6, focusUtf16: 7 }
          }
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomPaste
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/image-atom-replacement-selection",
        repository: store
      })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    rendered.result.current.actions.setImageImportMaxDisplayWidth(480);

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomPaste(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          {
            version: 1,
            fragment: [
              {
                kind: "image",
                source: {
                  originalName: "replacement.png",
                  mimeType: "image/png",
                  blob: new Blob([new Uint8Array([1])], { type: "image/png" })
                }
              }
            ]
          }
        )
      ).resolves.toBe("committed")
    );

    expect(notesHistorySpies.beginStructural).toHaveBeenLastCalledWith(
      "imageAtomPaste",
      expect.objectContaining({
        focus: {
          nodeId: imageNodeId,
          field: "title",
          primarySelection: { anchorUtf16: 6, focusUtf16: 7 }
        }
      })
    );
    expect(notesHistorySpies.acceptMutationResult).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        focus: {
          nodeId: imageNodeId,
          field: "title",
          primarySelection: { anchorUtf16: 6, focusUtf16: 7 }
        }
      }),
      expect.anything()
    );
  });

  it("rejects a direct image result whose receipt digest does not match before acknowledging", async () => {
    const imageNodeId = "99010000-0000-4000-8000-000000000001";
    const attachmentId = "99010000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const settled = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const feedback = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit: vi.fn(async (_vaultRoot, _input, context) =>
        imageAtomMutationResult(settled, context, imageNodeId, "edit", "f".repeat(64))
      )
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/image-atom-direct-receipt-mismatch",
        repository: store,
        publishFeedback: feedback
      })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("failed")
    );

    expect(store.ackImageAtomOperation).not.toHaveBeenCalled();
    expect(store.lookupImageAtomOperation).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenLastCalledWith({
      kind: "error",
      message: "Notes image operation could not be acknowledged. Close and reopen this Vault."
    });
  });

  it("rejects a direct image receipt with an out-of-range focus before acknowledging", async () => {
    const imageNodeId = "99020000-0000-4000-8000-000000000001";
    const attachmentId = "99020000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const settled = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit: vi.fn(async (_vaultRoot, _input, context) => {
        const result = await imageAtomMutationResult(settled, context, imageNodeId);
        return {
          ...result,
          operation: {
            ...result.operation,
            focus: { nodeId: imageNodeId, anchorUtf16: 99, focusUtf16: 99 }
          }
        };
      })
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-direct-focus-mismatch", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("failed")
    );

    expect(store.ackImageAtomOperation).not.toHaveBeenCalled();
  });

  it("settles a lost image-atom response from its found receipt before acknowledging", async () => {
    const imageNodeId = "99100000-0000-4000-8000-000000000001";
    const attachmentId = "99100000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const committed = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const postconditionDigest = await imageAtomPostconditionDigest(
      committed,
      [imageNodeId],
      "edit"
    );
    expect(postconditionDigest).toBe(
      "2db0f51101d80492a0b37d31a2dd50ae956c52f57dc916971c1a7b5ceea57bb8"
    );
    let foundOperationId = "";
    const lookupImageAtomOperation = vi.fn<NotesStore["lookupImageAtomOperation"]>(
      async (_vaultRoot, _sessionId, historyEpoch, operationId) => {
        foundOperationId = operationId;
        return {
          kind: "found" as const,
          receipt: {
            operationId,
            historyEpoch,
            postconditionDigest: "2db0f51101d80492a0b37d31a2dd50ae956c52f57dc916971c1a7b5ceea57bb8",
            affectedRootIds: [imageNodeId],
            focus: { nodeId: imageNodeId, anchorUtf16: 6, focusUtf16: 6 }
          }
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(committed),
      applyImageAtomEdit: vi.fn().mockRejectedValue(new Error("response lost")),
      lookupImageAtomOperation,
      historyStatus: vi.fn(async () => ({
        ...historyState(),
        canUndo: true,
        nextUndoEntryId: foundOperationId
      }))
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-found-receipt", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    let outcome!: NotesWorkspaceCommandOutcome;
    await act(async () => {
      outcome = await rendered.result.current.actions.applyImageAtomEdit(
        imageNodeId,
        { anchorUtf16: 6, focusUtf16: 7 },
        { kind: "remove", replacementText: "" }
      );
    });

    expect(outcome).toBe("committed");
    expect(lookupImageAtomOperation).toHaveBeenCalledOnce();
    expect(store.ackImageAtomOperation).toHaveBeenCalledWith(
      "/image-atom-found-receipt",
      expect.any(String),
      "epoch-a",
      expect.any(String)
    );
    expect(rendered.result.current.state.nodesById[imageNodeId]?.nodeKind).toBe("text");
  });

  it("reports an unresolved lost send when receipt lookup fails without retrying", async () => {
    const imageNodeId = "99025000-0000-4000-8000-000000000001";
    const attachmentId = "99025000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const feedback = vi.fn();
    const applyImageAtomEdit = vi
      .fn<NotesStore["applyImageAtomEdit"]>()
      .mockRejectedValue(new Error("send response lost"));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit,
      lookupImageAtomOperation: vi.fn().mockRejectedValue(new Error("lookup unavailable"))
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/image-atom-lookup-unavailable",
        repository: store,
        publishFeedback: feedback
      })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    let outcome!: Promise<NotesWorkspaceCommandOutcome>;
    act(() => {
      outcome = rendered.result.current.actions.applyImageAtomEdit(
        imageNodeId,
        { anchorUtf16: 6, focusUtf16: 7 },
        { kind: "remove", replacementText: "" }
      );
    });
    await act(async () => expect(outcome).resolves.toBe("failed"));

    expect(applyImageAtomEdit).toHaveBeenCalledOnce();
    expect(store.lookupImageAtomOperation).toHaveBeenCalledOnce();
    expect(store.ackImageAtomOperation).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenLastCalledWith({
      kind: "error",
      message: "Notes image operation could not be acknowledged. Close and reopen this Vault."
    });
  });

  it("matches the fixed Rust-compatible image postcondition digest fixture", async () => {
    const rootId = "99110000-0000-4000-8000-000000000001";
    const childLaterId = "99110000-0000-4000-8000-000000000002";
    const childFirstId = "99110000-0000-4000-8000-000000000003";
    const workspaceFixture = {
      nodes: [
        node({
          id: rootId,
          nodeKind: "image",
          title: "beforeafter",
          note: "root note",
          imageOffsetUtf16: 6,
          sortKey: 2048,
          isCollapsed: true,
          isStarred: true,
          completedAt: null
        }),
        node({
          id: childLaterId,
          parentId: rootId,
          title: "later",
          sortKey: 2048,
          completedAt: null
        }),
        node({
          id: childFirstId,
          parentId: rootId,
          title: "first",
          sortKey: 1024,
          completedAt: null
        })
      ],
      attachmentsByNodeId: {
        [rootId]: [
          attachment({
            id: "99110000-0000-4000-8000-000000000005",
            nodeId: rootId,
            sortKey: 1024,
            originalName: "z.png",
            contentHash: "b".repeat(64)
          }),
          attachment({
            id: "99110000-0000-4000-8000-000000000004",
            nodeId: rootId,
            sortKey: 1024,
            originalName: "a.png",
            contentHash: "a".repeat(64)
          })
        ]
      }
    } satisfies NotesWorkspace;

    await expect(
      imageAtomPostconditionDigest(workspaceFixture, [rootId], "edit")
    ).resolves.toBe("6090399564442bcfdb79b03af944a21b5778ffcfdbd61dc173ec69eefcfa7864");
  });

  it("rejects a found receipt whose postcondition digest does not match active rows", async () => {
    const imageNodeId = "99500000-0000-4000-8000-000000000001";
    const attachmentId = "99500000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const committed = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const postconditionDigest = await imageAtomPostconditionDigest(
      committed,
      [imageNodeId],
      "edit"
    );
    expect(postconditionDigest).toMatch(/^[0-9a-f]{64}$/);
    let operationId = "";
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(committed),
      applyImageAtomEdit: vi.fn().mockRejectedValue(new Error("response lost")),
      lookupImageAtomOperation: vi.fn(async (_vaultRoot, _sessionId, historyEpoch, entryId) => {
        operationId = entryId;
        return {
          kind: "found" as const,
          receipt: {
            operationId: entryId,
            historyEpoch,
            postconditionDigest: "b".repeat(64),
            affectedRootIds: [imageNodeId],
            focus: { nodeId: imageNodeId, anchorUtf16: 6, focusUtf16: 6 }
          }
        };
      }),
      historyStatus: vi.fn(async () => ({
        ...historyState(),
        canUndo: true,
        nextUndoEntryId: operationId
      }))
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-digest-mismatch", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("failed")
    );

    expect(store.ackImageAtomOperation).not.toHaveBeenCalled();
  });

  it("does not acknowledge a found receipt until committed mixed history is available", async () => {
    const imageNodeId = "99600000-0000-4000-8000-000000000001";
    const attachmentId = "99600000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const feedback = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit: vi.fn().mockRejectedValue(new Error("response lost")),
      lookupImageAtomOperation: vi.fn(async (_vaultRoot, _sessionId, historyEpoch, operationId) => ({
        kind: "found" as const,
        receipt: {
          operationId,
          historyEpoch,
          postconditionDigest: "a".repeat(64),
          affectedRootIds: [imageNodeId],
          focus: { nodeId: imageNodeId, anchorUtf16: 6, focusUtf16: 6 }
        }
      })),
      historyStatus: undefined
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/image-atom-history-unavailable",
        repository: store,
        publishFeedback: feedback
      })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("failed")
    );

    expect(store.ackImageAtomOperation).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenLastCalledWith({
      kind: "error",
      message: "Notes image operation could not be acknowledged. Close and reopen this Vault."
    });
  });

  it("resends one exact image paste input and Blob after a same-epoch missing receipt", async () => {
    const nodeId = "99200000-0000-4000-8000-000000000001";
    const pastedNodeId = "99200000-0000-4000-8000-000000000002";
    const pastedAttachmentId = "99200000-0000-4000-8000-000000000003";
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    createNoteIdMock
      .mockReturnValueOnce(pastedNodeId)
      .mockReturnValueOnce(pastedAttachmentId);
    const applyImageAtomPaste = vi.fn<NotesStore["applyImageAtomPaste"]>();
    applyImageAtomPaste
      .mockRejectedValueOnce(new Error("response lost"))
      .mockImplementationOnce(async (_vaultRoot, _input, context) =>
        imageAtomMutationResult(
          workspace([node({ id: nodeId })]),
          context,
          nodeId,
          "paste"
        )
      );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: nodeId })])),
      applyImageAtomPaste
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-resend", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    rendered.result.current.actions.setImageImportMaxDisplayWidth(480);

    let outcome!: NotesWorkspaceCommandOutcome;
    await act(async () => {
      outcome = await rendered.result.current.actions.applyImageAtomPaste(
        nodeId,
        { anchorUtf16: 0, focusUtf16: 0 },
        {
          version: 1,
          fragment: [
            { kind: "text", text: "before" },
            {
              kind: "image",
              source: { originalName: "kept-name.png", mimeType: "image/png", blob }
            },
            { kind: "text", text: "after" }
          ]
        }
      );
    });

    expect(outcome).toBe("committed");
    expect(store.lookupImageAtomOperation).toHaveBeenCalledOnce();
    expect(applyImageAtomPaste).toHaveBeenCalledTimes(2);
    expect(applyImageAtomPaste.mock.calls[1]?.[1]).toBe(
      applyImageAtomPaste.mock.calls[0]?.[1]
    );
    expect(applyImageAtomPaste.mock.calls[0]?.[1]).toMatchObject({
      fragment: [
        { kind: "text", text: "before" },
        {
          kind: "image",
          nodeId,
          attachmentId: pastedAttachmentId,
          originalName: "kept-name.png",
          mimeType: "image/png",
          blob
        },
        { kind: "text", text: "after" }
      ]
    });
    expect((applyImageAtomPaste.mock.calls[0]?.[1].fragment[1] as { blob: Blob }).blob).toBe(blob);
  });

  it("records the raw text range before text-to-image paste and its receipt atom after", async () => {
    const nodeId = "99201000-0000-4000-8000-000000000001";
    const generatedNodeId = "99201000-0000-4000-8000-000000000002";
    const attachmentId = "99201000-0000-4000-8000-000000000003";
    createNoteIdMock
      .mockReturnValueOnce(generatedNodeId)
      .mockReturnValueOnce(attachmentId);
    const initial = workspace([node({ id: nodeId, title: "abcdef" })]);
    const result: NotesWorkspace = {
      nodes: [
        node({
          id: nodeId,
          nodeKind: "image",
          title: "af",
          imageOffsetUtf16: 1
        })
      ],
      attachmentsByNodeId: {
        [nodeId]: [attachment({ id: attachmentId, nodeId })]
      }
    };
    const applyImageAtomPaste = vi.fn<NotesStore["applyImageAtomPaste"]>(
      async (_vaultRoot, _input, context) => {
        const response = await imageAtomMutationResult(
          result,
          context,
          nodeId,
          "paste"
        );
        return {
          ...response,
          operation: {
            ...response.operation,
            focus: { nodeId, anchorUtf16: 1, focusUtf16: 2 }
          }
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomPaste
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/text-to-image-selection",
        repository: store
      })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    rendered.result.current.actions.setImageImportMaxDisplayWidth(480);

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomPaste(
          nodeId,
          { anchorUtf16: 1, focusUtf16: 5 },
          {
            version: 1,
            fragment: [
              {
                kind: "image",
                source: {
                  originalName: "inserted.png",
                  mimeType: "image/png",
                  blob: new Blob([new Uint8Array([1])], { type: "image/png" })
                }
              }
            ]
          }
        )
      ).resolves.toBe("committed")
    );

    expect(notesHistorySpies.beginStructural).toHaveBeenLastCalledWith(
      "imageAtomPaste",
      expect.objectContaining({
        focus: {
          nodeId,
          field: "title",
          primarySelection: { anchorUtf16: 1, focusUtf16: 5 }
        }
      })
    );
    expect(notesHistorySpies.acceptMutationResult).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        focus: {
          nodeId,
          field: "title",
          primarySelection: { anchorUtf16: 1, focusUtf16: 2 }
        }
      }),
      expect.anything()
    );
  });

  it("discards an image operation after its exact resend remains missing and gives the next offer a fresh entry", async () => {
    const imageNodeId = "99205000-0000-4000-8000-000000000001";
    const attachmentId = "99205000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const committed = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const contexts: NotesHistoryContext[] = [];
    const feedback = vi.fn();
    const applyImageAtomEdit = vi.fn<NotesStore["applyImageAtomEdit"]>(
      async (_vaultRoot, _input, context) => {
        contexts.push(context);
        if (contexts.length <= 2) throw new Error("response lost");
        return imageAtomMutationResult(committed, context, imageNodeId);
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit,
      lookupImageAtomOperation: vi.fn(async (_vaultRoot, _sessionId, historyEpoch) => ({
        kind: "missing" as const,
        historyEpoch
      }))
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/image-atom-retry-missing",
        repository: store,
        publishFeedback: feedback
      })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("failed")
    );

    expect(applyImageAtomEdit).toHaveBeenCalledTimes(2);
    expect(store.lookupImageAtomOperation).toHaveBeenCalledTimes(2);
    expect(store.ackImageAtomOperation).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("committed")
    );

    expect(contexts).toHaveLength(3);
    expect(contexts[1]?.entryId).toBe(contexts[0]?.entryId);
    expect(contexts[2]?.entryId).not.toBe(contexts[0]?.entryId);
  });

  it("fails closed without throwing or calling the store for malformed image paste fragments", async () => {
    const applyImageAtomPaste = vi.fn<NotesStore["applyImageAtomPaste"]>();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "paste-target" })])),
      applyImageAtomPaste
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-malformed-paste", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    let zeroImagePaste!: Promise<NotesWorkspaceCommandOutcome>;
    act(() => {
      expect(() => {
        zeroImagePaste = rendered.result.current.actions.applyImageAtomPaste(
          "paste-target",
          { anchorUtf16: 0, focusUtf16: 0 },
          { version: 1, fragment: [{ kind: "text", text: "not an image" }] }
        );
      }).not.toThrow();
    });
    await act(async () => expect(zeroImagePaste).resolves.toBe("failed"));

    let unsupportedMimePaste!: Promise<NotesWorkspaceCommandOutcome>;
    act(() => {
      expect(() => {
        unsupportedMimePaste = rendered.result.current.actions.applyImageAtomPaste(
          "paste-target",
          { anchorUtf16: 0, focusUtf16: 0 },
          {
            version: 1,
            fragment: [
              {
                kind: "image",
                source: {
                  originalName: "unsupported.heic",
                  mimeType: "image/heic",
                  blob: new Blob([new Uint8Array([1])], { type: "image/heic" })
                }
              }
            ]
          }
        );
      }).not.toThrow();
    });
    await act(async () => expect(unsupportedMimePaste).resolves.toBe("failed"));

    expect(applyImageAtomPaste).not.toHaveBeenCalled();
  });

  it("fails a mismatched receipt without retrying or acknowledging", async () => {
    const imageNodeId = "99300000-0000-4000-8000-000000000001";
    const attachmentId = "99300000-0000-4000-8000-000000000002";
    const otherOperationId = "99300000-0000-4000-8000-000000000003";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const lookupImageAtomOperation = vi.fn<NotesStore["lookupImageAtomOperation"]>(
      async (_vaultRoot, _sessionId, historyEpoch) => ({
        kind: "found" as const,
        receipt: {
          operationId: otherOperationId,
          historyEpoch,
          postconditionDigest: "a".repeat(64),
          affectedRootIds: [imageNodeId],
          focus: { nodeId: imageNodeId, anchorUtf16: 6, focusUtf16: 6 }
        }
      })
    );
    const applyImageAtomEdit = vi.fn<NotesStore["applyImageAtomEdit"]>().mockRejectedValue(
      new Error("response lost")
    );
    const feedback = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit,
      lookupImageAtomOperation
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/image-atom-mismatched-receipt",
        repository: store,
        publishFeedback: feedback
      })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("failed")
    );

    expect(lookupImageAtomOperation).toHaveBeenCalledOnce();
    expect(applyImageAtomEdit).toHaveBeenCalledOnce();
    expect(store.ackImageAtomOperation).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenLastCalledWith({
      kind: "error",
      message: "Notes image operation could not be acknowledged. Close and reopen this Vault."
    });
  });

  it("rejects a found receipt with the right operation but unrelated affected roots", async () => {
    const imageNodeId = "99310000-0000-4000-8000-000000000001";
    const attachmentId = "99310000-0000-4000-8000-000000000002";
    const unrelatedNodeId = "99310000-0000-4000-8000-000000000003";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        }),
        node({ id: unrelatedNodeId, title: "unrelated" })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit: vi.fn().mockRejectedValue(new Error("response lost")),
      lookupImageAtomOperation: vi.fn(async (_vaultRoot, _sessionId, historyEpoch, operationId) => ({
        kind: "found" as const,
        receipt: {
          operationId,
          historyEpoch,
          postconditionDigest: "a".repeat(64),
          affectedRootIds: [unrelatedNodeId],
          focus: { nodeId: unrelatedNodeId, anchorUtf16: 0, focusUtf16: 0 }
        }
      }))
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-found-unrelated", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("failed")
    );

    expect(store.applyImageAtomEdit).toHaveBeenCalledOnce();
    expect(store.lookupImageAtomOperation).toHaveBeenCalledOnce();
    expect(store.ackImageAtomOperation).not.toHaveBeenCalled();
  });

  it("reports acknowledgement failure while keeping the post-state ahead of the next queue item", async () => {
    const imageNodeId = "99400000-0000-4000-8000-000000000001";
    const attachmentId = "99400000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const committed = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const postconditionDigest = await imageAtomPostconditionDigest(
      committed,
      [imageNodeId],
      "edit"
    );
    expect(postconditionDigest).toMatch(/^[0-9a-f]{64}$/);
    const firstAcknowledgement = deferred<void>();
    const retryAcknowledgement = deferred<void>();
    const feedback = vi.fn();
    const lookupImageAtomOperation = vi.fn<NotesStore["lookupImageAtomOperation"]>(
      async (_vaultRoot, _sessionId, historyEpoch, operationId) => ({
        kind: "found" as const,
        receipt: {
          operationId,
          historyEpoch,
          postconditionDigest: postconditionDigest!,
          affectedRootIds: [imageNodeId],
          focus: { nodeId: imageNodeId, anchorUtf16: 0, focusUtf16: 0 }
        }
      })
    );
    const applyImageAtomEdit = vi.fn<NotesStore["applyImageAtomEdit"]>(
      async (_vaultRoot, _input, context) =>
        imageAtomMutationResult(committed, context, imageNodeId)
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit,
      lookupImageAtomOperation,
      ackImageAtomOperation: vi
        .fn()
        .mockReturnValueOnce(firstAcknowledgement.promise)
        .mockReturnValueOnce(retryAcknowledgement.promise)
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/image-atom-ack-order",
        repository: store,
        publishFeedback: feedback
      })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    const first = rendered.result.current.actions.applyImageAtomEdit(
      imageNodeId,
      { anchorUtf16: 6, focusUtf16: 7 },
      { kind: "remove", replacementText: "" }
    );
    await waitFor(() => expect(store.ackImageAtomOperation).toHaveBeenCalledOnce());
    const next = rendered.result.current.actions.applyImageAtomEdit(
      imageNodeId,
      { anchorUtf16: 0, focusUtf16: 0 },
      { kind: "remove", replacementText: "" }
    );
    await Promise.resolve();
    expect(applyImageAtomEdit).toHaveBeenCalledOnce();

    await act(async () => {
      firstAcknowledgement.reject(new Error("ack lost"));
      await waitFor(() => expect(store.ackImageAtomOperation).toHaveBeenCalledTimes(2));
      expect(applyImageAtomEdit).toHaveBeenCalledOnce();
      retryAcknowledgement.reject(new Error("ack retry lost"));
      await expect(first).resolves.toBe("failed");
      await expect(next).resolves.toBe("skipped");
    });

    expect(lookupImageAtomOperation).toHaveBeenCalledTimes(2);
    expect(applyImageAtomEdit).toHaveBeenCalledOnce();
    expect(feedback).toHaveBeenLastCalledWith({
      kind: "error",
      message: "Notes image operation could not be acknowledged. Close and reopen this Vault."
    });
  });

  it("does one lookup but no acknowledgement retry after its owner closes", async () => {
    const imageNodeId = "99410000-0000-4000-8000-000000000001";
    const attachmentId = "99410000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const committed = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const postconditionDigest = await imageAtomPostconditionDigest(
      committed,
      [imageNodeId],
      "edit"
    );
    const acknowledgement = deferred<void>();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit: vi.fn(async (_vaultRoot, _input, context) =>
        imageAtomMutationResult(committed, context, imageNodeId)
      ),
      ackImageAtomOperation: vi.fn().mockReturnValue(acknowledgement.promise),
      lookupImageAtomOperation: vi.fn(async (_vaultRoot, _sessionId, historyEpoch, operationId) => ({
        kind: "found" as const,
        receipt: {
          operationId,
          historyEpoch,
          postconditionDigest: postconditionDigest!,
          affectedRootIds: [imageNodeId],
          focus: { nodeId: imageNodeId, anchorUtf16: 0, focusUtf16: 0 }
        }
      }))
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-closed-ack", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    const outcome = rendered.result.current.actions.applyImageAtomEdit(
      imageNodeId,
      { anchorUtf16: 6, focusUtf16: 7 },
      { kind: "remove", replacementText: "" }
    );
    await waitFor(() => expect(store.ackImageAtomOperation).toHaveBeenCalledOnce());
    rendered.unmount();
    acknowledgement.reject(new Error("ack disconnected"));

    await expect(outcome).resolves.toBe("skipped");
    expect(store.ackImageAtomOperation).toHaveBeenCalledOnce();
    expect(store.lookupImageAtomOperation).toHaveBeenCalledOnce();
  });

  it("commits when the first acknowledgement lookup finds the validated receipt already missing", async () => {
    const imageNodeId = "99415000-0000-4000-8000-000000000001";
    const attachmentId = "99415000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const committed = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit: vi.fn(async (_vaultRoot, _input, context) =>
        imageAtomMutationResult(committed, context, imageNodeId)
      ),
      ackImageAtomOperation: vi.fn().mockRejectedValue(new Error("ack response lost")),
      lookupImageAtomOperation: vi.fn(async (_vaultRoot, _sessionId, historyEpoch) => ({
        kind: "missing" as const,
        historyEpoch
      }))
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-ack-missing", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("committed")
    );

    expect(store.ackImageAtomOperation).toHaveBeenCalledOnce();
    expect(store.lookupImageAtomOperation).toHaveBeenCalledOnce();
  });

  it("retries one exact acknowledgement after a found receipt and commits when it succeeds", async () => {
    const imageNodeId = "99416000-0000-4000-8000-000000000001";
    const attachmentId = "99416000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const committed = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const postconditionDigest = await imageAtomPostconditionDigest(
      committed,
      [imageNodeId],
      "edit"
    );
    const ackImageAtomOperation = vi
      .fn<NotesStore["ackImageAtomOperation"]>()
      .mockRejectedValueOnce(new Error("ack response lost"))
      .mockResolvedValueOnce(undefined);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit: vi.fn(async (_vaultRoot, _input, context) =>
        imageAtomMutationResult(committed, context, imageNodeId)
      ),
      ackImageAtomOperation,
      lookupImageAtomOperation: vi.fn(async (_vaultRoot, _sessionId, historyEpoch, operationId) => ({
        kind: "found" as const,
        receipt: {
          operationId,
          historyEpoch,
          postconditionDigest: postconditionDigest!,
          affectedRootIds: [imageNodeId],
          focus: { nodeId: imageNodeId, anchorUtf16: 0, focusUtf16: 0 }
        }
      }))
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-ack-retry", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("committed")
    );

    expect(ackImageAtomOperation).toHaveBeenCalledTimes(2);
    expect(ackImageAtomOperation.mock.calls[1]).toEqual(
      ackImageAtomOperation.mock.calls[0]
    );
    expect(store.lookupImageAtomOperation).toHaveBeenCalledOnce();
  });

  it("does not let deferred acknowledgement be overtaken by undo replay or zoom navigation", async () => {
    const imageNodeId = "99417000-0000-4000-8000-000000000001";
    const attachmentId = "99417000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [node({ id: imageNodeId, nodeKind: "image", title: "beforeafter", imageOffsetUtf16: 6 })],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const committed = workspace([node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })]);
    const acknowledgement = deferred<void>();
    const undo = vi.fn<NotesStore["undo"]>(async (_vaultRoot, input) => ({
      kind: "applied" as const,
      workspace: initial,
      replayedEntryId: input.expectedEntryId,
      ...historyState(input.historyEpoch),
      canRedo: true,
      nextRedoEntryId: input.expectedEntryId
    }));
    const prepareNavigation = vi.fn<NonNullable<NotesStore["prepareNavigation"]>>(
      async (_vaultRoot, input) => historyState(input.historyEpoch)
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit: vi.fn(async (_vaultRoot, _input, context) =>
        imageAtomMutationResult(committed, context, imageNodeId)
      ),
      ackImageAtomOperation: vi.fn().mockReturnValue(acknowledgement.promise),
      undo,
      prepareNavigation
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-ack-replay-navigation", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    prepareNavigation.mockClear();

    const edit = rendered.result.current.actions.applyImageAtomEdit(
      imageNodeId,
      { anchorUtf16: 6, focusUtf16: 7 },
      { kind: "remove", replacementText: "" }
    );
    await waitFor(() => expect(store.ackImageAtomOperation).toHaveBeenCalledOnce());
    const replay = rendered.result.current.actions.undo!();
    const navigation = rendered.result.current.actions.zoomTo(imageNodeId);
    await Promise.resolve();
    expect(undo).not.toHaveBeenCalled();
    expect(prepareNavigation).not.toHaveBeenCalled();

    acknowledgement.resolve(undefined);
    await act(async () => {
      await edit;
      await replay;
      await navigation;
    });
    expect(undo).toHaveBeenCalledOnce();
    expect(prepareNavigation).toHaveBeenCalledOnce();
  });

  it("does not resend a lost image operation after its owner closes", async () => {
    const imageNodeId = "99420000-0000-4000-8000-000000000001";
    const attachmentId = "99420000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const response = deferred<ImageAtomMutationResult>();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit: vi.fn().mockReturnValue(response.promise),
      lookupImageAtomOperation: vi.fn(async (_vaultRoot, _sessionId, historyEpoch) => ({
        kind: "missing" as const,
        historyEpoch
      }))
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-closed-send", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    const outcome = rendered.result.current.actions.applyImageAtomEdit(
      imageNodeId,
      { anchorUtf16: 6, focusUtf16: 7 },
      { kind: "remove", replacementText: "" }
    );
    await waitFor(() => expect(store.applyImageAtomEdit).toHaveBeenCalledOnce());
    rendered.unmount();
    response.reject(new Error("response disconnected"));

    await expect(outcome).resolves.toBe("skipped");
    expect(store.lookupImageAtomOperation).toHaveBeenCalledOnce();
    expect(store.applyImageAtomEdit).toHaveBeenCalledOnce();
  });

  it("does not reconcile a second time when a stale owner materializes a found receipt and its acknowledgement fails", async () => {
    const imageNodeId = "99425000-0000-4000-8000-000000000001";
    const attachmentId = "99425000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const committed = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const postconditionDigest = await imageAtomPostconditionDigest(
      committed,
      [imageNodeId],
      "edit"
    );
    expect(postconditionDigest).toMatch(/^[0-9a-f]{64}$/);
    const response = deferred<ImageAtomMutationResult>();
    let operationId = "";
    let lookupFound = false;
    let closeOwner: (() => void) | null = null;
    const feedback = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn(async (vaultRoot: string) =>
        vaultRoot === "/image-atom-stale-found-ack" && lookupFound
          ? committed
          : initial
      ),
      applyImageAtomEdit: vi.fn().mockReturnValue(response.promise),
      lookupImageAtomOperation: vi.fn(async (_vaultRoot, _sessionId, historyEpoch, entryId) => {
        operationId = entryId;
        lookupFound = true;
        return {
          kind: "found" as const,
          receipt: {
            operationId: entryId,
            historyEpoch,
            postconditionDigest: postconditionDigest!,
            affectedRootIds: [imageNodeId],
            focus: { nodeId: imageNodeId, anchorUtf16: 0, focusUtf16: 0 }
          }
        };
      }),
      historyStatus: vi.fn(async () => ({
        ...historyState(),
        canUndo: true,
        nextUndoEntryId: operationId
      })),
      ackImageAtomOperation: vi.fn(async () => {
        closeOwner?.();
        throw new Error("ack disconnected");
      })
    });
    const rendered = renderHook(
      ({ vaultRoot }) =>
        useNotesWorkspace({
          vaultRoot,
          repository: store,
          publishFeedback: feedback
        }),
      { initialProps: { vaultRoot: "/image-atom-stale-found-ack" } }
    );
    const keeper = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/image-atom-stale-found-ack",
        repository: store,
        publishFeedback: feedback
      })
    );
    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      await waitFor(() => expect(keeper.result.current.status).toBe("ready"));
      closeOwner = () => keeper.unmount();

      let outcome!: Promise<NotesWorkspaceCommandOutcome>;
      act(() => {
        outcome = keeper.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        );
      });
      await waitFor(() => expect(store.applyImageAtomEdit).toHaveBeenCalledOnce());
      await act(async () => {
        response.reject(new Error("send disconnected"));
        await expect(outcome).resolves.toBe("skipped");
      });

      expect(store.applyImageAtomEdit).toHaveBeenCalledOnce();
      expect(store.lookupImageAtomOperation).toHaveBeenCalledOnce();
      expect(store.ackImageAtomOperation).toHaveBeenCalledOnce();
      expect(feedback).not.toHaveBeenCalled();
      expect(rendered.result.current.state.nodesById[imageNodeId]?.nodeKind).toBe("text");
      expect(rendered.result.current.canUndo).toBe(true);
      expect(notesHistorySpies.acceptMutationResult).toHaveBeenCalledWith(
        operationId,
        expect.anything(),
        expect.objectContaining({ nextUndoEntryId: operationId })
      );
    } finally {
      rendered.unmount();
      keeper.unmount();
    }
  });

  it("reconciles an acknowledgement epoch loss to the known exact post-state after resetting history", async () => {
    const imageNodeId = "99700000-0000-4000-8000-000000000001";
    const attachmentId = "99700000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const committed = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const postconditionDigest = await imageAtomPostconditionDigest(
      committed,
      [imageNodeId],
      "edit"
    );
    expect(postconditionDigest).toMatch(/^[0-9a-f]{64}$/);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(committed),
      applyImageAtomEdit: vi.fn(async (_vaultRoot, _input, context) =>
        imageAtomMutationResult(
          committed,
          context,
          imageNodeId,
          "edit",
          postconditionDigest!
        )
      ),
      ackImageAtomOperation: vi.fn().mockRejectedValue(new Error("ack epoch lost")),
      lookupImageAtomOperation: vi.fn().mockResolvedValue({
        kind: "epochMismatch",
        historyEpoch: "epoch-b"
      }),
      historyStatus: vi.fn().mockResolvedValue(historyState("epoch-b")),
      clearHistory: vi.fn().mockResolvedValue({
        ...historyState("epoch-b"),
        historyReset: true
      })
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-ack-epoch-post", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("committed")
    );

    expect(store.lookupImageAtomOperation).toHaveBeenCalledOnce();
    expect(store.clearHistory).toHaveBeenCalledOnce();
    expect(store.applyImageAtomEdit).toHaveBeenCalledOnce();
    expect(rendered.result.current.state.nodesById[imageNodeId]?.nodeKind).toBe("text");
  });

  it("does not retry an acknowledgement epoch loss with the exact pre-state, and gives the next offer a new operation", async () => {
    const imageNodeId = "99800000-0000-4000-8000-000000000001";
    const attachmentId = "99800000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const directPost = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const contexts: NotesHistoryContext[] = [];
    const feedback = vi.fn();
    const applyImageAtomEdit = vi.fn<NotesStore["applyImageAtomEdit"]>(
      async (_vaultRoot, _input, context) => {
        contexts.push(context);
        return imageAtomMutationResult(directPost, context, imageNodeId);
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit,
      ackImageAtomOperation: vi
        .fn()
        .mockRejectedValueOnce(new Error("ack epoch lost"))
        .mockResolvedValueOnce(undefined),
      lookupImageAtomOperation: vi.fn().mockResolvedValue({
        kind: "epochMismatch",
        historyEpoch: "epoch-b"
      }),
      historyStatus: vi.fn().mockImplementation(() =>
        historyState(applyImageAtomEdit.mock.calls.length === 0 ? "epoch-a" : "epoch-b")
      ),
      clearHistory: vi.fn().mockResolvedValue({
        ...historyState("epoch-b"),
        historyReset: true
      })
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/image-atom-ack-epoch-pre",
        repository: store,
        publishFeedback: feedback
      })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("failed")
    );

    expect(store.lookupImageAtomOperation).toHaveBeenCalledOnce();
    expect(store.clearHistory).toHaveBeenCalledOnce();
    expect(applyImageAtomEdit).toHaveBeenCalledOnce();
    expect(feedback).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "error", message: expect.stringContaining("exact pre-state") })
    );

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("committed")
    );
    expect(applyImageAtomEdit).toHaveBeenCalledTimes(2);
    expect(contexts[1]?.entryId).not.toBe(contexts[0]?.entryId);
    expect(contexts[1]?.historyEpoch).toBe("epoch-b");
  });

  it("uses the full Active pre-authority when a scoped image operation loses its epoch", async () => {
    const imageNodeId = "99805000-0000-4000-8000-000000000001";
    const attachmentId = "99805000-0000-4000-8000-000000000002";
    const childId = "99805000-0000-4000-8000-000000000003";
    const source = node({
      id: imageNodeId,
      nodeKind: "image",
      title: "beforeafter",
      imageOffsetUtf16: 6,
      isStarred: true
    });
    const initial = {
      nodes: [source, node({ id: childId, parentId: imageNodeId, title: "child" })],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const starred = {
      nodes: [source],
      attachmentsByNodeId: initial.attachmentsByNodeId
    } satisfies NotesWorkspace;
    const directPost = workspace([
      node({
        id: imageNodeId,
        title: "beforeafter",
        imageOffsetUtf16: 0,
        isStarred: true
      }),
      node({ id: childId, parentId: imageNodeId, title: "child" })
    ]);
    const contexts: NotesHistoryContext[] = [];
    const feedback = vi.fn();
    let activeLoads = 0;
    const loadWorkspace = vi.fn(async (_vaultRoot: string, scope: NotesWorkspaceScope) => {
      if (scope.kind === "starred") return starred;
      activeLoads += 1;
      return initial;
    });
    const applyImageAtomEdit = vi.fn<NotesStore["applyImageAtomEdit"]>(
      async (_vaultRoot, _input, context) => {
        contexts.push(context);
        return imageAtomMutationResult(directPost, context, imageNodeId);
      }
    );
    const store = repository({
      loadWorkspace,
      applyImageAtomEdit,
      ackImageAtomOperation: vi
        .fn()
        .mockRejectedValueOnce(new Error("ack epoch lost"))
        .mockResolvedValueOnce(undefined),
      lookupImageAtomOperation: vi.fn().mockResolvedValue({
        kind: "epochMismatch",
        historyEpoch: "epoch-b"
      }),
      historyStatus: vi.fn().mockImplementation(() =>
        historyState(applyImageAtomEdit.mock.calls.length === 0 ? "epoch-a" : "epoch-b")
      ),
      clearHistory: vi.fn().mockResolvedValue({
        ...historyState("epoch-b"),
        historyReset: true
      })
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/image-atom-scoped-epoch-pre",
        repository: store,
        publishFeedback: feedback
      })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    await act(async () => rendered.result.current.actions.selectLibraryView("starred"));
    expect(rendered.result.current.libraryView).toBe("starred");
    feedback.mockClear();

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("failed")
    );

    expect(activeLoads).toBe(3);
    expect(rendered.result.current.state.nodesById[imageNodeId]?.nodeKind).toBe("image");
    expect(feedback).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "error",
        message: expect.stringContaining("exact pre-state")
      })
    );
    expect(feedback.mock.calls.at(-1)?.[0].message).not.toContain("ambiguous");

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("committed")
    );

    expect(applyImageAtomEdit).toHaveBeenCalledTimes(2);
    expect(contexts[1]?.entryId).not.toBe(contexts[0]?.entryId);
    expect(contexts[1]?.historyEpoch).toBe("epoch-b");
    expect(activeLoads).toBe(4);
  });

  it("fails closed when a scoped image target no longer matches Active authority", async () => {
    const imageNodeId = "99807500-0000-4000-8000-000000000001";
    const attachmentId = "99807500-0000-4000-8000-000000000002";
    const scopedSource = node({
      id: imageNodeId,
      nodeKind: "image",
      title: "beforeafter",
      imageOffsetUtf16: 6,
      isStarred: true
    });
    const initial = {
      nodes: [scopedSource],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const staleActive = {
      nodes: [{ ...scopedSource, title: "changed remotely" }],
      attachmentsByNodeId: initial.attachmentsByNodeId
    } satisfies NotesWorkspace;
    const starred = {
      nodes: [scopedSource],
      attachmentsByNodeId: initial.attachmentsByNodeId
    } satisfies NotesWorkspace;
    let activeLoads = 0;
    const applyImageAtomEdit = vi.fn<NotesStore["applyImageAtomEdit"]>();
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot: string, scope: NotesWorkspaceScope) => {
        if (scope.kind === "starred") return starred;
        activeLoads += 1;
        return activeLoads === 1 ? initial : staleActive;
      }),
      applyImageAtomEdit
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-scoped-authority", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    await act(async () => rendered.result.current.actions.selectLibraryView("starred"));

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("failed")
    );

    expect(activeLoads).toBe(2);
    expect(applyImageAtomEdit).not.toHaveBeenCalled();
  });

  it("reports a distinct ambiguous acknowledgement epoch loss without retrying", async () => {
    const imageNodeId = "99810000-0000-4000-8000-000000000001";
    const attachmentId = "99810000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const directPost = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const ambiguous = workspace([
      node({ id: imageNodeId, title: "different", note: "changed", imageOffsetUtf16: 0 })
    ]);
    const feedback = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(ambiguous),
      applyImageAtomEdit: vi.fn(async (_vaultRoot, _input, context) =>
        imageAtomMutationResult(directPost, context, imageNodeId)
      ),
      ackImageAtomOperation: vi.fn().mockRejectedValue(new Error("ack epoch lost")),
      lookupImageAtomOperation: vi.fn().mockResolvedValue({
        kind: "epochMismatch",
        historyEpoch: "epoch-b"
      }),
      historyStatus: vi.fn().mockResolvedValue(historyState("epoch-b")),
      clearHistory: vi.fn().mockResolvedValue({
        ...historyState("epoch-b"),
        historyReset: true
      })
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/image-atom-ack-epoch-ambiguous",
        repository: store,
        publishFeedback: feedback
      })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("failed")
    );

    expect(store.lookupImageAtomOperation).toHaveBeenCalledOnce();
    expect(store.clearHistory).toHaveBeenCalledOnce();
    expect(store.applyImageAtomEdit).toHaveBeenCalledOnce();
    expect(feedback).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "error", message: expect.stringContaining("ambiguous") })
    );
  });

  it("never classifies an unknown-send epoch loss as post-state without a learned receipt digest", async () => {
    const imageNodeId = "99820000-0000-4000-8000-000000000001";
    const attachmentId = "99820000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [node({ id: imageNodeId, nodeKind: "image", title: "beforeafter", imageOffsetUtf16: 6 })],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    // This reload looks exactly like the mutation's would-be post-state, but
    // the rejected send never yielded a receipt/digest to prove that link.
    const wouldBePost = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const feedback = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(wouldBePost),
      applyImageAtomEdit: vi.fn().mockRejectedValue(new Error("response lost")),
      lookupImageAtomOperation: vi.fn().mockResolvedValue({
        kind: "epochMismatch",
        historyEpoch: "epoch-b"
      }),
      historyStatus: vi.fn().mockResolvedValue(historyState("epoch-b")),
      clearHistory: vi.fn().mockResolvedValue({ ...historyState("epoch-b"), historyReset: true })
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-unknown-epoch-post", repository: store, publishFeedback: feedback })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    await act(async () =>
      expect(
        rendered.result.current.actions.applyImageAtomEdit(
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          { kind: "remove", replacementText: "" }
        )
      ).resolves.toBe("failed")
    );

    expect(store.applyImageAtomEdit).toHaveBeenCalledOnce();
    expect(store.lookupImageAtomOperation).toHaveBeenCalledOnce();
    expect(store.ackImageAtomOperation).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "error", message: expect.stringContaining("ambiguous") })
    );
  });

  it("makes an exact-pre unknown-send epoch loss eligible only for a fresh offer", async () => {
    const imageNodeId = "99830000-0000-4000-8000-000000000001";
    const attachmentId = "99830000-0000-4000-8000-000000000002";
    const initial = {
      nodes: [node({ id: imageNodeId, nodeKind: "image", title: "beforeafter", imageOffsetUtf16: 6 })],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    } satisfies NotesWorkspace;
    const committed = workspace([
      node({ id: imageNodeId, title: "beforeafter", imageOffsetUtf16: 0 })
    ]);
    const contexts: NotesHistoryContext[] = [];
    const applyImageAtomEdit = vi.fn<NotesStore["applyImageAtomEdit"]>(
      async (_vaultRoot, _input, context) => {
        contexts.push(context);
        if (contexts.length === 1) throw new Error("response lost");
        return imageAtomMutationResult(committed, context, imageNodeId);
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit,
      lookupImageAtomOperation: vi.fn().mockResolvedValue({
        kind: "epochMismatch",
        historyEpoch: "epoch-b"
      }),
      historyStatus: vi.fn().mockResolvedValue(historyState("epoch-b")),
      clearHistory: vi.fn().mockResolvedValue({ ...historyState("epoch-b"), historyReset: true })
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/image-atom-unknown-epoch-pre", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    const offer = () =>
      rendered.result.current.actions.applyImageAtomEdit(
        imageNodeId,
        { anchorUtf16: 6, focusUtf16: 7 },
        { kind: "remove", replacementText: "" }
      );
    await act(async () => expect(offer()).resolves.toBe("failed"));
    expect(applyImageAtomEdit).toHaveBeenCalledOnce();

    await act(async () => expect(offer()).resolves.toBe("committed"));
    expect(applyImageAtomEdit).toHaveBeenCalledTimes(2);
    expect(contexts[1]?.entryId).not.toBe(contexts[0]?.entryId);
  });
});
