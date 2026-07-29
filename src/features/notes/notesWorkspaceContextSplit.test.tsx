import {
  act,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { memo, Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import type {
  NoteNode,
  NotesHistoryContext,
  NotesMutationResponse,
  NotesStore,
  NotesWorkspace,
} from "../../domain/notes";
import {
  NotesActionsContext,
  NotesDraftsContext,
  NotesPaneRegistryContext,
  NotesStateContext,
  NotesWorkspaceContext,
  useNotesActions,
  useNotesDrafts,
  useNotesState,
} from "./NotesWorkspaceContext";
import { NotesDetailSplitHost } from "./NotesDetailSplitHost";
import { NotesPaneSliceScope } from "./NotesPaneScope";
import {
  defaultNotesSplitLayout,
  saveNotesSplitLayout,
} from "./notesSplitLayoutStore";
import {
  useNotesWorkspace,
  type UseNotesWorkspaceHookResult,
  type UseNotesWorkspaceResult,
} from "./useNotesWorkspace";
import type { NotesPaneRuntimeSlice } from "./notesWorkspaceTypes";

const createNoteIdMock = vi.hoisted(() => vi.fn());

vi.mock("../../domain/notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../domain/notes")>()),
  createNoteId: createNoteIdMock,
}));

vi.mock("./NotesOutlinePane", () => ({
  NotesOutlinePane: () => (
    <textarea
      aria-label="Provisional insertion"
      data-notes-provisional-insertion="true"
      defaultValue="x"
      onKeyDown={(event) => {
        if (
          event.key === "Backspace" &&
          event.currentTarget.selectionStart === 0 &&
          event.currentTarget.selectionEnd === 0
        ) {
          event.preventDefault();
        }
      }}
    />
  ),
}));

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
    markdownImageWidth: overrides.markdownImageWidth ?? null,
  };
}

function workspace(nodes: NoteNode[]): NotesWorkspace {
  return { nodes };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function repository(overrides: Partial<NotesStore> = {}): NotesStore {
  const empty = vi.fn().mockResolvedValue(workspace([]));
  const initialHistoryState = {
    canUndo: false,
    canRedo: false,
    historyEpoch: "history-epoch",
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: [],
  };
  return {
    initialize: vi.fn().mockResolvedValue(initialHistoryState),
    historyStatus: vi.fn().mockResolvedValue(initialHistoryState),
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
      workspace: workspace([]),
      replayedEntryId: null,
      canUndo: false,
      canRedo: false,
    }),
    redo: vi.fn().mockResolvedValue({
      workspace: workspace([]),
      replayedEntryId: null,
      canUndo: false,
      canRedo: false,
    }),
    lookupImageAtomOperation: vi.fn<NotesStore["lookupImageAtomOperation"]>(
      async (_vaultPath, _sessionId, historyEpoch) => ({
        kind: "missing",
        historyEpoch,
      }),
    ),
    ackImageAtomOperation: vi.fn<NotesStore["ackImageAtomOperation"]>(
      async () => undefined,
    ),
    clearHistory: vi.fn().mockResolvedValue({
      ...initialHistoryState,
      historyReset: true,
    }),
    pruneHistoryEntries: vi.fn().mockResolvedValue(initialHistoryState),
    prepareNavigation: vi.fn().mockResolvedValue(initialHistoryState),
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
    ...overrides,
  };
}

describe("notes workspace context split", () => {
  beforeEach(() => {
    createNoteIdMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the actions object referentially stable across a draft keystroke", async () => {
    const store = repository();
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const actionsBefore = result.current.actions;
    const actionsSliceBefore = result.current.actionsSlice;
    const draftsBefore = result.current.draftsByNodeId;

    await act(async () => {
      result.current.actions.updateNodeDraft("root", {
        title: "typed",
        note: "",
        imageOffsetUtf16: 0,
      });
    });

    // The keystroke must actually mutate the draft slice, otherwise the
    // stability assertion below would pass vacuously.
    expect(result.current.draftsByNodeId).not.toBe(draftsBefore);
    expect(result.current.draftsByNodeId.root?.title).toBe("typed");

    // ...yet the action callbacks retain their identity.
    expect(result.current.actions).toBe(actionsBefore);
    expect(result.current.actionsSlice).toBe(actionsSliceBefore);
  });

  it("does not re-render an actions-only consumer on a draft keystroke", async () => {
    const store = repository();
    let captured: UseNotesWorkspaceResult | null = null;
    let actionsRenders = 0;
    let draftsRenders = 0;

    // memo() so a probe only re-renders when a context it reads changes, not
    // merely because its parent (the harness) re-rendered.
    const ActionsProbe = memo(function ActionsProbe() {
      useNotesActions();
      actionsRenders += 1;
      return null;
    });
    const DraftsProbe = memo(function DraftsProbe() {
      useNotesDrafts();
      draftsRenders += 1;
      return null;
    });

    function Harness() {
      const value = useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
      });
      captured = value;
      return (
        <NotesActionsContext.Provider value={value.actionsSlice ?? value}>
          <NotesStateContext.Provider value={value.stateSlice ?? value}>
            <NotesDraftsContext.Provider value={value.draftsSlice ?? value}>
              <ActionsProbe />
              <DraftsProbe />
            </NotesDraftsContext.Provider>
          </NotesStateContext.Provider>
        </NotesActionsContext.Provider>
      );
    }

    render(<Harness />);
    await waitFor(() => expect(captured?.status).toBe("ready"));

    const actionsRendersBefore = actionsRenders;
    const draftsRendersBefore = draftsRenders;

    await act(async () => {
      captured!.actions.updateNodeDraft("root", {
        title: "typed",
        note: "",
        imageOffsetUtf16: 0,
      });
    });

    // The drafts consumer must re-render (proving the keystroke propagated)...
    expect(draftsRenders).toBeGreaterThan(draftsRendersBefore);
    // ...while the actions-only consumer must not.
    expect(actionsRenders).toBe(actionsRendersBefore);
  });

  it("keeps the actions slice stable while createRoot tracks the live library view", async () => {
    createNoteIdMock.mockReturnValue("created-root");
    const store = repository();
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const actionsBefore = result.current.actions;
    const actionsSliceBefore = result.current.actionsSlice;

    // 2.1 moved createRoot's libraryView dependency onto a ref, so switching the
    // view must no longer re-memoize the actions callbacks.
    await act(async () => result.current.actions.selectLibraryView("archive"));

    // The view change must actually land, otherwise the identity assertions
    // below would pass vacuously.
    expect(result.current.libraryView).toBe("archive");
    // ...yet the action callbacks retain their identity (an identity-churn
    // regression would fail here).
    expect(result.current.actions).toBe(actionsBefore);
    expect(result.current.actionsSlice).toBe(actionsSliceBefore);

    // createRoot reads the live view through the ref: invoked from "archive" it
    // observes the current view and transitions the library back to "all". A
    // stale captured "all" would skip that transition and leave "archive",
    // failing this assertion.
    await act(async () => result.current.actions.createRoot());
    expect(store.createNode).toHaveBeenCalled();
    expect(result.current.libraryView).toBe("all");
  });

  it("keeps pane navigation and selection independent over shared data", async () => {
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(
          workspace([
            node({ id: "root" }),
            node({ id: "other", sortKey: 2048 }),
          ]),
        ),
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const panes = () => result.current.paneRegistrySlice.panes;
    await act(async () => panes().primary.actionsSlice.actions.zoomTo("root"));
    await act(async () =>
      panes().secondary.actionsSlice.actions.zoomTo("other"),
    );
    act(() =>
      panes().secondary.actionsSlice.actions.setSelectionAnchor("other"),
    );

    expect(panes().primary.stateSlice.state.zoomRootId).toBe("root");
    expect(panes().secondary.stateSlice.state.zoomRootId).toBe("other");
    expect(panes().primary.draftsSlice.selection).toBeNull();
    expect(panes().secondary.draftsSlice.selection).toEqual({
      anchorId: "other",
      headId: "other",
    });
    expect(panes().primary.stateSlice.state.nodesById).toBe(
      panes().secondary.stateSlice.state.nodesById,
    );
  });

  it("routes a secondary split focus only to the secondary pane", async () => {
    const initial = workspace([
      node({ id: "root", title: "Root", sortKey: 1024 }),
      node({ id: "other", title: "Other", sortKey: 2048 }),
    ]);
    const settled = workspace([
      node({ id: "root", title: "Ro", sortKey: 1024 }),
      node({ id: "split", title: "ot", sortKey: 1536 }),
      node({ id: "other", title: "Other", sortKey: 2048 }),
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      splitNode: vi.fn(
        async (
          _vaultRoot: string,
          _input: unknown,
          context: NotesHistoryContext,
        ): Promise<NotesMutationResponse> => ({
          workspace: settled,
          historyEntryId: context.entryId,
          canUndo: true,
          canRedo: false,
          historyEpoch: context.historyEpoch,
          nextUndoEntryId: context.entryId,
          nextRedoEntryId: null,
          prunedEntryIds: [],
        }),
      ),
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/secondary-insertion-routing",
        repository: store,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const panes = () => result.current.paneRegistrySlice.panes;

    await act(async () => panes().primary.actionsSlice.actions.zoomTo("other"));
    await act(async () => {
      await panes().primary.actionsSlice.actions.acknowledgeFocus("other");
    });
    expect(panes().primary.stateSlice.state).toMatchObject({
      selectedId: "other",
      pendingFocusId: null,
    });
    result.current.actions.publishOutlinePaneState?.({
      paneId: "primary",
      scope: { kind: "active" },
      zoomedNodeId: "other",
      showCompleted: true,
      collapsedNodeIds: new Set(),
      locallyExpandedNodeIds: new Set(),
    });
    result.current.actions.publishOutlinePaneState?.({
      paneId: "secondary",
      scope: { kind: "active" },
      zoomedNodeId: null,
      showCompleted: true,
      collapsedNodeIds: new Set(),
      locallyExpandedNodeIds: new Set(),
    });
    let preparation: ReturnType<
      NonNullable<typeof result.current.actions.prepareKeyboardInsertion>
    > = null;
    act(() => {
      preparation =
        panes().secondary.actionsSlice.actions.prepareKeyboardInsertion?.({
          ownerPaneId: "secondary",
          intent: {
            token: 41,
            sourceId: "root",
            expectedNodeId: "split",
            postcondition: {
              kind: "split",
              expectedSourceTitle: "Ro",
              expectedInsertedTitle: "ot",
            },
          },
          optimistic: {
            sourceSelection: { anchorUtf16: 2, focusUtf16: 2 },
            sourceTitle: "Ro",
            insertedTitle: "ot",
          },
        }) ?? null;
    });
    expect(preparation).not.toBeNull();
    expect(panes().primary.draftsSlice.optimisticKeyboardInsertions).toEqual(
      [],
    );
    expect(
      panes().secondary.draftsSlice.optimisticKeyboardInsertions?.[0].pending
        .intent.expectedNodeId,
    ).toBe("split");
    expect(panes().primary.stateSlice.state.nodesById.split).toBeUndefined();
    expect(panes().secondary.stateSlice.state.nodesById.split).toBeUndefined();

    await act(async () => {
      await panes().secondary.actionsSlice.actions.splitNode(
        "root",
        "split",
        "Ro",
        "ot",
        { keyboardInsertion: preparation! },
      );
    });

    expect(panes().primary.stateSlice.state).toMatchObject({
      selectedId: "other",
      pendingFocusId: null,
    });
    expect(panes().secondary.stateSlice.state).toMatchObject({
      selectedId: "split",
      editingNoteId: "split",
      pendingFocusId: "split",
      pendingFocusField: "title",
    });
    await act(async () => {
      await panes().secondary.actionsSlice.actions.acknowledgeFocus("split");
    });
    expect(panes().secondary.stateSlice.state.pendingFocusId).toBeNull();
  });

  it.each(["primary", "secondary"] as const)(
    "keeps the previous %s editing lease when handled Backspace invalidates a deferred insertion focus claim",
    async (paneId) => {
      const initial = workspace([
        node({ id: "root", title: "Root", sortKey: 1024 }),
      ]);
      const settled = workspace([
        node({ id: "root", title: "Root", sortKey: 1024 }),
        node({ id: "split", title: "", sortKey: 2048 }),
      ]);
      const split = deferred<NotesMutationResponse>();
      const save = deferred<NotesWorkspace>();
      const updateNode = vi.fn().mockReturnValue(save.promise);
      const splitNode = vi.fn().mockReturnValue(split.promise);
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(initial),
        updateNode,
        splitNode,
      });
      const vaultRoot = `/deferred-${paneId}-focus-claim`;
      saveNotesSplitLayout(localStorage, vaultRoot, {
        ...defaultNotesSplitLayout(),
        splitOpen: true,
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({
          vaultRoot,
          repository: store,
        }),
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      render(
        <VaultRootContext.Provider value={vaultRoot}>
          <NotesWorkspaceContext.Provider value={result.current}>
            <NotesPaneRegistryContext.Provider
              value={result.current.paneRegistrySlice}
            >
              <NotesDetailSplitHost />
            </NotesPaneRegistryContext.Provider>
          </NotesWorkspaceContext.Provider>
        </VaultRootContext.Provider>,
      );
      await waitFor(() =>
        expect(
          document.querySelector('[data-notes-pane-id="secondary"]'),
        ).not.toBeNull(),
      );
      const panes = () => result.current.paneRegistrySlice.panes;
      const actions = () => panes()[paneId].actionsSlice.actions;

      result.current.actions.publishOutlinePaneState?.({
        paneId,
        scope: { kind: "active" },
        zoomedNodeId: null,
        showCompleted: true,
        collapsedNodeIds: new Set(),
        locallyExpandedNodeIds: new Set(),
      });
      await act(async () => {
        expect(await actions().claimEditingFocus?.("root", "title")).toBe(true);
      });
      let preparation: ReturnType<
        NonNullable<typeof result.current.actions.prepareKeyboardInsertion>
      > = null;
      act(() => {
        preparation =
          actions().prepareKeyboardInsertion?.({
            ownerPaneId: paneId,
            navigationVersionAtDispatch: actions().getNavigationVersion?.(),
            userInteractionRevisionAtDispatch:
              actions().getUserInteractionRevision?.(),
            intent: {
              token: 42,
              sourceId: "root",
              expectedNodeId: "split",
              postcondition: {
                kind: "split",
                expectedSourceTitle: "Root",
                expectedInsertedTitle: "",
              },
            },
            optimistic: {
              sourceSelection: { anchorUtf16: 4, focusUtf16: 4 },
              sourceTitle: "Root",
              insertedTitle: "",
            },
          }) ?? null;
      });
      expect(preparation).not.toBeNull();
      let splitCommand!: Promise<unknown>;
      act(() => {
        splitCommand = actions().splitNode("root", "split", "Root", "", {
          keyboardInsertion: preparation!,
        });
      });
      await waitFor(() => expect(splitNode).toHaveBeenCalledOnce());
      act(() => {
        actions().updateNodeDraft(
          "root",
          {
            title: "Root dirty",
            note: "",
            imageOffsetUtf16: 0,
          },
          "title",
        );
      });
      const historyContext = splitNode.mock.lastCall![2] as NotesHistoryContext;
      await act(async () =>
        split.resolve({
          workspace: settled,
          historyEntryId: historyContext.entryId,
          canUndo: true,
          canRedo: false,
          historyEpoch: historyContext.historyEpoch,
          nextUndoEntryId: historyContext.entryId,
          nextRedoEntryId: null,
          prunedEntryIds: [],
        }),
      );
      await act(async () => splitCommand);
      const pendingSelection =
        panes()[paneId].stateSlice.pendingPrimarySelection;
      expect(pendingSelection).toMatchObject({
        nodeId: "split",
        expectedUserInteractionRevision: 0,
      });

      let acknowledgement!: Promise<void>;
      act(() => {
        acknowledgement = actions().acknowledgeFocus(
          "split",
          pendingSelection!.requestId,
        );
      });
      await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
      act(() => {
        actions().updateNodeDraft(
          "split",
          {
            title: "Buffered stale claim",
            note: "",
            imageOffsetUtf16: 0,
          },
          "title",
        );
      });
      expect(result.current.draftsByNodeId.split).toBeUndefined();
      const editor = document
        .querySelector<HTMLElement>(`[data-notes-pane-id="${paneId}"]`)
        ?.querySelector<HTMLTextAreaElement>(
          "textarea[data-notes-provisional-insertion='true']",
        );
      expect(editor).not.toBeNull();
      const interactionRevision = actions().getUserInteractionRevision?.();
      editor!.setSelectionRange(1, 1);
      expect(fireEvent.keyDown(editor!, { key: "Backspace" })).toBe(true);
      expect(actions().getUserInteractionRevision?.()).toBe(
        interactionRevision,
      );
      editor!.value = "";
      editor!.setSelectionRange(0, 0);
      expect(fireEvent.keyDown(editor!, { key: "Backspace" })).toBe(false);
      expect(actions().getUserInteractionRevision?.()).toBe(
        interactionRevision! + 1,
      );
      const interveningPaneId = paneId === "primary" ? "secondary" : "primary";
      act(() => {
        result.current.paneRegistrySlice.setActivePaneId(interveningPaneId);
      });
      await act(async () =>
        save.resolve(
          workspace([
            node({ id: "root", title: "Root dirty", sortKey: 1024 }),
            node({ id: "split", title: "", sortKey: 2048 }),
          ]),
        ),
      );
      await act(async () => acknowledgement);

      expect(result.current.paneRegistrySlice.activePaneId).toBe(
        interveningPaneId,
      );
      expect(panes()[paneId].stateSlice.pendingPrimarySelection).toBeNull();
      expect(panes()[paneId].stateSlice.state.pendingFocusId).toBeNull();
      act(() => {
        actions().updateNodeDraft(
          "split",
          {
            title: "stale claim",
            note: "",
            imageOffsetUtf16: 0,
          },
          "title",
        );
      });
      expect(result.current.draftsByNodeId.split).toBeUndefined();
      act(() => {
        actions().updateNodeDraft(
          "root",
          {
            title: "Root still owns editing",
            note: "",
            imageOffsetUtf16: 0,
          },
          "title",
        );
      });
      expect(result.current.draftsByNodeId.root?.title).toBe(
        "Root still owns editing",
      );
    },
  );

  it.each(["primary", "secondary"] as const)(
    "keeps a same-revision %s focus replacement and active-pane choice when the prior claim settles",
    async (paneId) => {
      const initial = workspace([
        node({ id: "root", title: "Root", sortKey: 1024 }),
        node({ id: "first", title: "First", sortKey: 2048 }),
        node({ id: "replacement", title: "Replacement", sortKey: 3072 }),
      ]);
      const save = deferred<NotesWorkspace>();
      const updateNode = vi.fn().mockReturnValue(save.promise);
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(initial),
        updateNode,
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({
          vaultRoot: `/same-revision-${paneId}-focus-replacement`,
          repository: store,
        }),
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      const panes = () => result.current.paneRegistrySlice.panes;
      const actions = () => panes()[paneId].actionsSlice.actions;
      result.current.actions.publishOutlinePaneState?.({
        paneId,
        scope: { kind: "active" },
        zoomedNodeId: null,
        showCompleted: true,
        collapsedNodeIds: new Set(),
        locallyExpandedNodeIds: new Set(),
      });
      await act(async () => {
        expect(await actions().claimEditingFocus?.("root", "title")).toBe(true);
      });
      act(() => {
        actions().updateNodeDraft(
          "root",
          {
            title: "Root dirty",
            note: "",
            imageOffsetUtf16: 0,
          },
          "title",
        );
      });
      const interactionRevision = actions().getUserInteractionRevision?.();
      await act(async () =>
        actions().focusNode("first", {
          anchorUtf16: 1,
          focusUtf16: 1,
        }),
      );
      const firstRequest = panes()[paneId].stateSlice.pendingPrimarySelection;
      expect(firstRequest).toMatchObject({
        nodeId: "first",
        selection: { anchorUtf16: 1, focusUtf16: 1 },
      });

      let acknowledgement!: Promise<void>;
      act(() => {
        acknowledgement = actions().acknowledgeFocus(
          "first",
          firstRequest!.requestId,
        );
      });
      await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
      act(() => {
        actions().updateNodeDraft(
          "first",
          {
            title: "Buffered stale owner",
            note: "",
            imageOffsetUtf16: 0,
          },
          "title",
        );
      });
      expect(result.current.draftsByNodeId.first).toBeUndefined();
      await act(async () =>
        actions().focusNode("replacement", {
          anchorUtf16: 2,
          focusUtf16: 2,
        }),
      );
      const replacementRequest =
        panes()[paneId].stateSlice.pendingPrimarySelection;
      expect(replacementRequest).toMatchObject({
        nodeId: "replacement",
        selection: { anchorUtf16: 2, focusUtf16: 2 },
      });
      expect(replacementRequest?.requestId).not.toBe(firstRequest?.requestId);
      expect(actions().getUserInteractionRevision?.()).toBe(
        interactionRevision,
      );
      const interveningPaneId = paneId === "primary" ? "secondary" : "primary";
      act(() =>
        result.current.paneRegistrySlice.setActivePaneId(interveningPaneId),
      );

      await act(async () =>
        save.resolve(
          workspace([
            node({ id: "root", title: "Root dirty", sortKey: 1024 }),
            node({ id: "first", title: "First", sortKey: 2048 }),
            node({
              id: "replacement",
              title: "Replacement",
              sortKey: 3072,
            }),
          ]),
        ),
      );
      await act(async () => acknowledgement);

      expect(result.current.paneRegistrySlice.activePaneId).toBe(
        interveningPaneId,
      );
      expect(panes()[paneId].stateSlice.pendingPrimarySelection).toEqual(
        replacementRequest,
      );
      expect(panes()[paneId].stateSlice.state.pendingFocusId).toBe(
        "replacement",
      );
      act(() => {
        actions().updateNodeDraft(
          "first",
          {
            title: "Stale owner",
            note: "",
            imageOffsetUtf16: 0,
          },
          "title",
        );
      });
      expect(result.current.draftsByNodeId.first).toBeUndefined();
      act(() => {
        actions().updateNodeDraft(
          "root",
          {
            title: "Root still owns editing",
            note: "",
            imageOffsetUtf16: 0,
          },
          "title",
        );
      });
      expect(result.current.draftsByNodeId.root?.title).toBe(
        "Root still owns editing",
      );
    },
  );

  it("keeps a newer secondary focus request when the prior shared acknowledgement settles", async () => {
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(
          workspace([
            node({ id: "first", title: "First", sortKey: 1024 }),
            node({ id: "replacement", title: "Replacement", sortKey: 2048 }),
          ]),
        ),
    });
    const sharedAcknowledgement = deferred<void>();
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/secondary-focus-replacement-after-claim",
        repository: store,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const secondary = () =>
      result.current.paneRegistrySlice.panes.secondary.actionsSlice.actions;

    await act(async () =>
      secondary().focusNode("first", {
        anchorUtf16: 1,
        focusUtf16: 1,
      }),
    );
    const firstRequest =
      result.current.paneRegistrySlice.panes.secondary.stateSlice
        .pendingPrimarySelection;
    const originalAcknowledgeFocus =
      result.current.actionsSlice.actions.acknowledgeFocus;
    const acknowledgeFocus = vi
      .spyOn(result.current.actionsSlice.actions, "acknowledgeFocus")
      .mockImplementation(async (...args) => {
        await originalAcknowledgeFocus(...args);
        await sharedAcknowledgement.promise;
      });
    let acknowledgement!: Promise<void>;
    act(() => {
      acknowledgement = secondary().acknowledgeFocus(
        "first",
        firstRequest!.requestId,
      );
    });
    await waitFor(() => expect(acknowledgeFocus).toHaveBeenCalledOnce());

    await act(async () =>
      secondary().focusNode("replacement", {
        anchorUtf16: 2,
        focusUtf16: 2,
      }),
    );
    const replacementRequest =
      result.current.paneRegistrySlice.panes.secondary.stateSlice
        .pendingPrimarySelection;
    expect(replacementRequest).toMatchObject({
      nodeId: "replacement",
      selection: { anchorUtf16: 2, focusUtf16: 2 },
    });

    await act(async () => sharedAcknowledgement.resolve());
    await act(async () => acknowledgement);

    expect(
      result.current.paneRegistrySlice.panes.secondary.stateSlice
        .pendingPrimarySelection,
    ).toEqual(replacementRequest);
    expect(
      result.current.paneRegistrySlice.panes.secondary.stateSlice.state,
    ).toMatchObject({
      selectedId: "replacement",
      editingNoteId: "replacement",
      pendingFocusId: "replacement",
      pendingFocusField: "title",
    });
    acknowledgeFocus.mockRestore();
  });

  it.each([
    ["with a selection", { anchorUtf16: 2, focusUtf16: 2 }],
    ["without a selection", undefined],
  ] as const)(
    "keeps a newer secondary focus request %s when an earlier editing claim finishes flushing",
    async (_label, replacementSelection) => {
      const save = deferred<NotesWorkspace>();
      const updateNode = vi.fn().mockReturnValue(save.promise);
      const store = repository({
        loadWorkspace: vi
          .fn()
          .mockResolvedValue(
            workspace([
              node({ id: "root", title: "Root", sortKey: 1024 }),
              node({ id: "first", title: "First", sortKey: 2048 }),
              node({ id: "replacement", title: "Replacement", sortKey: 3072 }),
            ]),
          ),
        updateNode,
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({
          vaultRoot: "/secondary-focus-replacement-during-claim",
          repository: store,
        }),
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      const primary = () =>
        result.current.paneRegistrySlice.panes.primary.actionsSlice.actions;
      const secondary = () =>
        result.current.paneRegistrySlice.panes.secondary.actionsSlice.actions;

      await act(async () => {
        expect(await primary().claimEditingFocus?.("root", "title")).toBe(true);
      });
      act(() => {
        primary().updateNodeDraft(
          "root",
          { title: "Root dirty", note: "", imageOffsetUtf16: 0 },
          "title",
        );
      });

      let claim!: Promise<boolean>;
      act(() => {
        claim = secondary().claimEditingFocus!("first", "title");
      });
      await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());

      await act(async () =>
        secondary().focusNode("replacement", replacementSelection),
      );
      const replacementRequest =
        result.current.paneRegistrySlice.panes.secondary.stateSlice
          .pendingPrimarySelection;
      if (replacementSelection) {
        expect(replacementRequest).toMatchObject({
          nodeId: "replacement",
          selection: replacementSelection,
        });
      } else {
        expect(replacementRequest).toBeNull();
      }

      await act(async () =>
        save.resolve(
          workspace([
            node({ id: "root", title: "Root dirty", sortKey: 1024 }),
            node({ id: "first", title: "First", sortKey: 2048 }),
            node({ id: "replacement", title: "Replacement", sortKey: 3072 }),
          ]),
        ),
      );
      await expect(claim).resolves.toBe(false);

      expect(
        result.current.paneRegistrySlice.panes.secondary.stateSlice
          .pendingPrimarySelection,
      ).toEqual(replacementRequest);
      expect(
        result.current.paneRegistrySlice.panes.secondary.stateSlice.state,
      ).toMatchObject({
        selectedId: "replacement",
        editingNoteId: "replacement",
        pendingFocusId: "replacement",
        pendingFocusField: "title",
      });
    },
  );

  it("keeps a secondary Enter from committing the inactive primary outline first", async () => {
    const initial = workspace([node({ id: "root", title: "Root" })]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
    });
    let captured: UseNotesWorkspaceHookResult | null = null;
    const commits: {
      paneId: "primary" | "secondary";
      actualDuration: number;
    }[] = [];

    const OutlineProbe = memo(function OutlineProbe() {
      const { state } = useNotesState();
      const { optimisticKeyboardInsertions = [] } = useNotesDrafts();
      return (
        <output>
          {state.selectedId}:{optimisticKeyboardInsertions.length}
        </output>
      );
    });
    const Pane = memo(function Pane({ pane }: { pane: NotesPaneRuntimeSlice }) {
      return (
        <NotesPaneSliceScope pane={pane}>
          <Profiler
            id={pane.paneId}
            onRender={(id, _phase, actualDuration) => {
              commits.push({
                paneId: id as "primary" | "secondary",
                actualDuration,
              });
            }}
          >
            <OutlineProbe />
          </Profiler>
        </NotesPaneSliceScope>
      );
    });

    function Harness() {
      const value = useNotesWorkspace({
        vaultRoot: "/secondary-enter-commit-order",
        repository: store,
      });
      captured = value;
      const registry = value.paneRegistrySlice;
      return (
        <>
          <Pane pane={registry.panes.primary} />
          <Pane pane={registry.panes.secondary} />
        </>
      );
    }

    render(<Harness />);
    await waitFor(() => expect(captured?.status).toBe("ready"));
    act(() => {
      captured!.paneRegistrySlice.setActivePaneId("secondary");
    });
    await waitFor(() =>
      expect(captured?.paneRegistrySlice.activePaneId).toBe("secondary"),
    );
    const paneSnapshot = {
      scope: { kind: "active" } as const,
      zoomedNodeId: null,
      showCompleted: true,
      collapsedNodeIds: new Set<string>(),
      locallyExpandedNodeIds: new Set<string>(),
    };
    act(() => {
      captured!.actions.publishOutlinePaneState?.({
        ...paneSnapshot,
        paneId: "primary",
      });
      captured!.actions.publishOutlinePaneState?.({
        ...paneSnapshot,
        paneId: "secondary",
      });
    });
    commits.length = 0;
    const inactivePaneBefore = captured!.paneRegistrySlice.panes.primary;

    act(() => {
      captured!.paneRegistrySlice.panes.secondary.actionsSlice.actions.prepareKeyboardInsertion?.(
        {
          ownerPaneId: "secondary",
          intent: {
            token: 42,
            sourceId: "root",
            expectedNodeId: "split",
            postcondition: {
              kind: "split",
              expectedSourceTitle: "Ro",
              expectedInsertedTitle: "ot",
            },
          },
          optimistic: {
            sourceSelection: { anchorUtf16: 2, focusUtf16: 2 },
            sourceTitle: "Ro",
            insertedTitle: "ot",
          },
        },
      );
    });

    expect({
      inactivePaneRetained:
        captured!.paneRegistrySlice.panes.primary === inactivePaneBefore,
      commitOrder: commits.map(({ paneId }) => paneId),
      inactiveDuration: commits
        .filter(({ paneId }) => paneId === "primary")
        .reduce((total, { actualDuration }) => total + actualDuration, 0),
    }).toEqual({
      inactivePaneRetained: true,
      commitOrder: ["secondary"],
      inactiveDuration: 0,
    });
  });

  it("keeps the inactive pane slice stable across 50 opposite-pane focus moves", async () => {
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(
          workspace([
            node({ id: "root", sortKey: 1024 }),
            node({ id: "other", sortKey: 2048 }),
          ]),
        ),
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/pane-identity", repository: store }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const secondaryBefore = result.current.paneRegistrySlice.panes.secondary;
    for (let index = 0; index < 50; index += 1) {
      await act(async () => {
        await result.current.paneRegistrySlice.panes.primary.actionsSlice.actions.focusNode(
          index % 2 === 0 ? "other" : "root",
        );
      });
    }
    expect(result.current.paneRegistrySlice.panes.secondary).toBe(
      secondaryBefore,
    );

    const primaryBefore = result.current.paneRegistrySlice.panes.primary;
    for (let index = 0; index < 50; index += 1) {
      await act(async () => {
        await result.current.paneRegistrySlice.panes.secondary.actionsSlice.actions.focusNode(
          index % 2 === 0 ? "other" : "root",
        );
      });
    }
    expect(result.current.paneRegistrySlice.panes.primary).toBe(primaryBefore);
  });

  it("keeps a retained inactive primary facade live after its actions change", async () => {
    createNoteIdMock.mockReturnValue("created-after-reload");
    const firstStore = repository();
    const secondStore = repository();
    const { result, rerender } = renderHook(
      ({ vaultRoot, repository: currentRepository }) =>
        useNotesWorkspace({ vaultRoot, repository: currentRepository }),
      { initialProps: { vaultRoot: "/first", repository: firstStore } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const retainedPrimary = result.current.paneRegistrySlice.panes.primary;
    await act(async () => {
      await result.current.paneRegistrySlice.panes.secondary.actionsSlice.actions.focusNode(
        "root",
      );
    });
    rerender({ vaultRoot: "/second", repository: secondStore });
    await waitFor(() => expect(secondStore.loadWorkspace).toHaveBeenCalled());

    await act(async () => {
      await retainedPrimary.actionsSlice.actions.createRoot();
    });

    expect(secondStore.createNode).toHaveBeenCalledOnce();
    expect(firstStore.createNode).not.toHaveBeenCalled();
  });

  it("moves a node across panes with one mutation and focuses the destination", async () => {
    const moved = [
      node({ id: "page", sortKey: 1 }),
      node({ id: "root", parentId: "page", sortKey: 1 }),
    ];
    const moveNode = vi.fn().mockResolvedValue(workspace(moved));
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(
          workspace([
            node({ id: "root", sortKey: 1 }),
            node({ id: "page", sortKey: 2 }),
          ]),
        ),
      moveNode,
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const panes = () => result.current.paneRegistrySlice.panes;

    await act(async () =>
      panes().secondary.actionsSlice.actions.zoomTo("page"),
    );
    act(() => panes().primary.actionsSlice.actions.setSelectionAnchor("root"));
    await act(async () => {
      await panes().primary.actionsSlice.actions.moveNodeAcrossPanes?.(
        { id: "root", parentId: "page", afterId: null },
        "primary",
        "secondary",
      );
    });

    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(panes().primary.draftsSlice.selection).toBeNull();
    expect(panes().secondary.stateSlice.state).toMatchObject({
      selectedId: "root",
      editingNoteId: "root",
      pendingFocusId: "root",
    });
    expect(result.current.paneRegistrySlice.activePaneId).toBe("secondary");
  });

  it("moves a selected block across panes with one batch mutation", async () => {
    const initial = [
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "page", sortKey: 3 }),
    ];
    const moved = [
      node({ id: "page", sortKey: 1 }),
      node({ id: "first", parentId: "page", sortKey: 1 }),
      node({ id: "second", parentId: "page", sortKey: 2 }),
    ];
    const applyBatch = vi.fn().mockResolvedValue(workspace(moved));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace(initial)),
      applyBatch,
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const panes = () => result.current.paneRegistrySlice.panes;

    act(() => {
      panes().primary.actionsSlice.actions.setSelectionAnchor("first");
      panes().primary.actionsSlice.actions.extendSelectionTo("second");
    });
    const authority =
      await result.current.actionsSlice.prepareSelectionAuthority?.([
        "first",
        "second",
      ]);
    expect(authority).toBeDefined();
    await act(async () => {
      await panes().primary.actionsSlice.actions.applyPreparedSelectionBatchAcrossPanes?.(
        authority!,
        { type: "move", parentId: "page", afterId: null },
        "primary",
        "secondary",
      );
    });

    expect(applyBatch).toHaveBeenCalledTimes(1);
    expect(panes().primary.draftsSlice.selection).toBeNull();
    expect(panes().secondary.stateSlice.state.selectedId).toBe("first");
    expect(result.current.paneRegistrySlice.activePaneId).toBe("secondary");
  });

  it("undoes secondary navigation without changing the primary page", async () => {
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(
          workspace([
            node({ id: "root" }),
            node({ id: "other", sortKey: 2048 }),
          ]),
        ),
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const panes = () => result.current.paneRegistrySlice.panes;

    await act(async () => panes().primary.actionsSlice.actions.zoomTo("root"));
    await act(async () =>
      panes().secondary.actionsSlice.actions.zoomTo("other"),
    );
    await act(async () => panes().primary.actionsSlice.actions.undo?.());

    expect(panes().primary.stateSlice.state.zoomRootId).toBe("root");
    expect(panes().secondary.stateSlice.state.zoomRootId).toBeNull();
  });

  it("undoes primary navigation without changing the secondary page", async () => {
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(
          workspace([
            node({ id: "root" }),
            node({ id: "other", sortKey: 2048 }),
            node({ id: "third", sortKey: 3072 }),
          ]),
        ),
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const panes = () => result.current.paneRegistrySlice.panes;

    await act(async () => panes().primary.actionsSlice.actions.zoomTo("root"));
    await act(async () =>
      panes().secondary.actionsSlice.actions.zoomTo("other"),
    );
    await act(async () => panes().primary.actionsSlice.actions.zoomTo("third"));
    await act(async () => panes().primary.actionsSlice.actions.undo?.());

    expect(panes().primary.stateSlice.state.zoomRootId).toBe("root");
    expect(panes().secondary.stateSlice.state.zoomRootId).toBe("other");
  });

  it("lets only the latest pane editing claimant write the shared draft", async () => {
    const store = repository();
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const panes = () => result.current.paneRegistrySlice.panes;

    await act(async () => {
      expect(
        await panes().primary.actionsSlice.actions.claimEditingFocus?.(
          "root",
          "title",
        ),
      ).toBe(true);
      expect(
        await panes().secondary.actionsSlice.actions.claimEditingFocus?.(
          "root",
          "title",
        ),
      ).toBe(true);
    });
    act(() => {
      panes().primary.actionsSlice.actions.updateNodeDraft(
        "root",
        { title: "blocked", note: "", imageOffsetUtf16: 0 },
        "title",
      );
      panes().secondary.actionsSlice.actions.updateNodeDraft(
        "root",
        { title: "secondary", note: "", imageOffsetUtf16: 0 },
        "title",
      );
    });

    expect(result.current.draftsByNodeId.root?.title).toBe("secondary");
  });
});
