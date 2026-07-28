import { act, render, renderHook, waitFor } from "@testing-library/react";
import { memo, Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteNode, NotesStore, NotesWorkspace } from "../../domain/notes";
import {
  NotesActionsContext,
  NotesDraftsContext,
  NotesStateContext,
  useNotesActions,
  useNotesDrafts,
  useNotesState,
} from "./NotesWorkspaceContext";
import { NotesPaneSliceScope } from "./NotesPaneScope";
import { createOutlineVisibleSignature } from "./notesKeyboardInsertion";
import {
  useNotesWorkspace,
  type UseNotesWorkspaceHookResult,
  type UseNotesWorkspaceResult
} from "./useNotesWorkspace";
import type { NotesPaneRuntimeSlice } from "./notesWorkspaceTypes";

const createNoteIdMock = vi.hoisted(() => vi.fn());

vi.mock("../../domain/notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../domain/notes")>()),
  createNoteId: createNoteIdMock
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
    markdownImageWidth: overrides.markdownImageWidth ?? null
  };
}

function workspace(nodes: NoteNode[]): NotesWorkspace {
  return { nodes };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function repository(overrides: Partial<NotesStore> = {}): NotesStore {
  const empty = vi.fn().mockResolvedValue(workspace([]));
  const initialHistoryState = {
    canUndo: false,
    canRedo: false,
    historyEpoch: "history-epoch",
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: []
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
      canRedo: false
    }),
    redo: vi.fn().mockResolvedValue({
      workspace: workspace([]),
      replayedEntryId: null,
      canUndo: false,
      canRedo: false
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
      ...initialHistoryState,
      historyReset: true
    }),
    pruneHistoryEntries: vi.fn().mockResolvedValue(initialHistoryState),
    prepareNavigation: vi.fn().mockResolvedValue(initialHistoryState),
    closeHistorySession: vi.fn().mockResolvedValue(undefined),
    emptyTrash: empty,
    search: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
    listTagsWithCounts: vi.fn().mockResolvedValue([]),
    deleteDatabase: vi.fn().mockResolvedValue({ attachmentCleanupFailed: false }),
    importAttachmentPaths: vi.fn().mockResolvedValue(workspace([])),
    importAttachmentBytes: vi.fn().mockResolvedValue(workspace([])),
    ...overrides
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
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const actionsBefore = result.current.actions;
    const actionsSliceBefore = result.current.actionsSlice;
    const draftsBefore = result.current.draftsByNodeId;

    await act(async () => {
      result.current.actions.updateNodeDraft("root", {
        title: "typed",
        note: ""
      , imageOffsetUtf16: 0});
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
      const value = useNotesWorkspace({ vaultRoot: "/vault", repository: store });
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
      captured!.actions.updateNodeDraft("root", { title: "typed", note: "" , imageOffsetUtf16: 0});
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
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
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
      loadWorkspace: vi.fn().mockResolvedValue(
        workspace([
          node({ id: "root" }),
          node({ id: "other", sortKey: 2048 })
        ])
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const panes = () => result.current.paneRegistrySlice.panes;
    await act(async () => panes().primary.actionsSlice.actions.zoomTo("root"));
    await act(async () =>
      panes().secondary.actionsSlice.actions.zoomTo("other")
    );
    act(() =>
      panes().secondary.actionsSlice.actions.setSelectionAnchor("other")
    );

    expect(panes().primary.stateSlice.state.zoomRootId).toBe("root");
    expect(panes().secondary.stateSlice.state.zoomRootId).toBe("other");
    expect(panes().primary.draftsSlice.selection).toBeNull();
    expect(panes().secondary.draftsSlice.selection).toEqual({
      anchorId: "other",
      headId: "other"
    });
    expect(panes().primary.stateSlice.state.nodesById).toBe(
      panes().secondary.stateSlice.state.nodesById
    );
  });

  it("keeps newer focus after synchronous direct caret updates in either pane", async () => {
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(
        workspace([
          node({ id: "root", sortKey: 1024 }),
          node({ id: "other", sortKey: 2048 })
        ])
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/caret-authority", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const panes = () => result.current.paneRegistrySlice.panes;

    await act(async () => {
      panes().primary.actionsSlice.actions.notifyCaretMovedByDom?.(
        "other",
        "title"
      );
      await panes().primary.actionsSlice.actions.focusNode("root");
      panes().secondary.actionsSlice.actions.notifyCaretMovedByDom?.(
        "other",
        "title"
      );
      await panes().secondary.actionsSlice.actions.focusNode("root");
    });
    expect(frames).toHaveLength(0);
    expect(panes().primary.stateSlice.state).toMatchObject({
      selectedId: "root",
      editingNoteId: "root",
      pendingFocusId: "root",
      pendingFocusField: "title"
    });
    expect(panes().secondary.stateSlice.state).toMatchObject({
      selectedId: "root",
      editingNoteId: "root",
      pendingFocusId: "root",
      pendingFocusField: "title"
    });

    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });

    expect(panes().primary.stateSlice.state).toMatchObject({
      selectedId: "root",
      editingNoteId: "root",
      pendingFocusId: "root",
      pendingFocusField: "title"
    });
    expect(panes().secondary.stateSlice.state).toMatchObject({
      selectedId: "root",
      editingNoteId: "root",
      pendingFocusId: "root",
      pendingFocusField: "title"
    });
  });

  it("keeps newer editing claims and zoom history after synchronous direct caret updates", async () => {
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(
        workspace([
          node({ id: "root", sortKey: 1024 }),
          node({ id: "other", sortKey: 2048 })
        ])
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/caret-click-zoom-authority",
        repository: store
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const panes = () => result.current.paneRegistrySlice.panes;

    await act(async () => {
      panes().primary.actionsSlice.actions.notifyCaretMovedByDom?.(
        "other",
        "title"
      );
      await panes().primary.actionsSlice.actions.claimEditingFocus?.(
        "root",
        "title"
      );
      panes().secondary.actionsSlice.actions.notifyCaretMovedByDom?.(
        "other",
        "title"
      );
      await panes().secondary.actionsSlice.actions.claimEditingFocus?.(
        "root",
        "title"
      );
    });
    expect(frames).toHaveLength(0);
    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
    expect(panes().primary.stateSlice.state.selectedId).toBe("other");
    expect(panes().secondary.stateSlice.state).toMatchObject({
      selectedId: "root",
      editingNoteId: "root"
    });

    await act(async () => {
      panes().primary.actionsSlice.actions.notifyCaretMovedByDom?.(
        "other",
        "title"
      );
      const primaryZoom =
        panes().primary.actionsSlice.actions.zoomTo("root");
      panes().secondary.actionsSlice.actions.notifyCaretMovedByDom?.(
        "other",
        "title"
      );
      const secondaryZoom =
        panes().secondary.actionsSlice.actions.zoomTo("root");
      await Promise.all([primaryZoom, secondaryZoom]);
    });
    expect(frames).toHaveLength(0);
    expect(panes().primary.stateSlice.state).toMatchObject({
      selectedId: "root",
      zoomRootId: "root"
    });
    expect(panes().secondary.stateSlice.state).toMatchObject({
      selectedId: "root",
      zoomRootId: "root"
    });
  });

  it("publishes only the active pane for each synchronous repeated editing claim", async () => {
    const rows = Array.from({ length: 101 }, (_, index) =>
      node({
        id: `row-${index}`,
        sortKey: (index + 1) * 1024
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace(rows))
    });
    let captured: UseNotesWorkspaceHookResult | null = null;
    let primaryPaneRenders = 0;
    let secondaryPaneRenders = 0;
    const PrimaryPaneProbe = memo(function PrimaryPaneProbe({
      pane: _pane
    }: {
      pane: NotesPaneRuntimeSlice;
    }) {
      primaryPaneRenders += 1;
      return null;
    });
    const SecondaryPaneProbe = memo(function SecondaryPaneProbe({
      pane: _pane
    }: {
      pane: NotesPaneRuntimeSlice;
    }) {
      secondaryPaneRenders += 1;
      return null;
    });
    function Harness() {
      const value = useNotesWorkspace({
        vaultRoot: "/caret-claim-coalescing",
        repository: store
      });
      captured = value;
      return (
        <>
          <PrimaryPaneProbe pane={value.paneRegistrySlice.panes.primary} />
          <SecondaryPaneProbe pane={value.paneRegistrySlice.panes.secondary} />
        </>
      );
    }
    render(<Harness />);
    await waitFor(() => expect(captured?.status).toBe("ready"));
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const primaryBefore = primaryPaneRenders;
    const secondaryBefore = secondaryPaneRenders;

    const settleDirectClaim = async (
      paneId: "primary" | "secondary",
      nodeId: string
    ) => {
      let claim: Promise<boolean> | undefined;
      act(() => {
        const actions =
          captured!.paneRegistrySlice.panes[paneId].actionsSlice.actions;
        claim = actions.claimEditingFocus?.(nodeId, "title");
        actions.notifyCaretMovedByDom?.(nodeId, "title");
      });
      await act(async () => {
        await claim;
      });
    };
    for (let index = 1; index <= 50; index += 1) {
      await settleDirectClaim("primary", `row-${index}`);
    }
    for (let index = 99; index >= 50; index -= 1) {
      await settleDirectClaim("secondary", `row-${index}`);
    }

    expect(frames).toHaveLength(0);
    expect(primaryPaneRenders).toBe(primaryBefore + 50);
    expect(secondaryPaneRenders).toBe(secondaryBefore + 50);

    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
    expect(primaryPaneRenders).toBe(primaryBefore + 50);
    expect(secondaryPaneRenders).toBe(secondaryBefore + 50);
  });

  it.each(["primary", "secondary"] as const)(
    "keeps the inactive outline at zero commits across 50 %s caret moves",
    async (activePaneId) => {
      const rows = Array.from({ length: 51 }, (_, index) =>
        node({
          id: `row-${index}`,
          sortKey: (index + 1) * 1024,
        }),
      );
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(workspace(rows)),
      });
      let captured: UseNotesWorkspaceHookResult | null = null;
      const outlineCommits = { primary: 0, secondary: 0 };
      const OutlineProbe = memo(function OutlineProbe({
        paneId,
      }: {
        paneId: "primary" | "secondary";
      }) {
        const { state } = useNotesState();
        useNotesDrafts();
        return <output>{paneId}:{state.selectedId}</output>;
      });

      const Pane = memo(function Pane({
        pane,
        currentActivePaneId,
      }: {
        pane: NotesPaneRuntimeSlice;
        currentActivePaneId: "primary" | "secondary";
      }) {
        return (
          <NotesPaneSliceScope
            pane={pane}
            activePaneId={currentActivePaneId}
            deferWhenInactive
          >
            <Profiler
              id={`${pane.paneId}-outline`}
              onRender={() => {
                outlineCommits[pane.paneId] += 1;
              }}
            >
              <OutlineProbe paneId={pane.paneId} />
            </Profiler>
          </NotesPaneSliceScope>
        );
      });

      function Harness() {
        const value = useNotesWorkspace({
          vaultRoot: `/inactive-outline-${activePaneId}`,
          repository: store,
        });
        captured = value;
        const registry = value.paneRegistrySlice;
        return (
          <>
            <Pane
              pane={registry.panes.primary}
              currentActivePaneId={registry.activePaneId}
            />
            <Pane
              pane={registry.panes.secondary}
              currentActivePaneId={registry.activePaneId}
            />
          </>
        );
      }

      render(<Harness />);
      await waitFor(() => expect(captured?.status).toBe("ready"));
      act(() => {
        captured!.paneRegistrySlice.setActivePaneId(activePaneId);
      });
      await waitFor(() =>
        expect(captured?.paneRegistrySlice.activePaneId).toBe(activePaneId),
      );
      outlineCommits.primary = 0;
      outlineCommits.secondary = 0;

      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal(
        "requestAnimationFrame",
        (callback: FrameRequestCallback) => {
          frames.push(callback);
          return frames.length;
        },
      );
      vi.stubGlobal("cancelAnimationFrame", vi.fn());

      for (let index = 1; index <= 50; index += 1) {
        let claim: Promise<boolean> | undefined;
        act(() => {
          const actions =
            captured!.paneRegistrySlice.panes[activePaneId].actionsSlice.actions;
          claim = actions.claimEditingFocus?.(`row-${index}`, "title");
          actions.notifyCaretMovedByDom?.(`row-${index}`, "title");
        });
        await act(async () => {
          expect(await claim).toBe(true);
        });
      }

      const inactivePaneId =
        activePaneId === "primary" ? "secondary" : "primary";
      expect(frames).toHaveLength(0);
      expect(outlineCommits[inactivePaneId]).toBe(0);
      expect(outlineCommits[activePaneId]).toBe(50);

      expect(outlineCommits[inactivePaneId]).toBe(0);
      expect(outlineCommits[activePaneId]).toBe(50);
    },
  );

  it.each([
    ["primary", "before"],
    ["primary", "after"],
    ["secondary", "before"],
    ["secondary", "after"]
  ] as const)(
    "does not publish a denied %s direct caret when failure settles %s its frame",
    async (paneId, failureTiming) => {
      const update = deferred<NotesWorkspace>();
      const updateNode = vi.fn().mockReturnValue(update.promise);
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(
          workspace([
            node({ id: "root", sortKey: 1024 }),
            node({ id: "other", sortKey: 2048 })
          ])
        ),
        updateNode
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({
          vaultRoot: `/denied-direct-${paneId}-${failureTiming}`,
          repository: store
        })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      const actions =
        result.current.paneRegistrySlice.panes[paneId].actionsSlice.actions;
      await act(async () => {
        expect(await actions.claimEditingFocus?.("root", "title")).toBe(true);
      });
      act(() => {
        actions.updateNodeDraft("root", {
          title: "dirty",
          note: "",
          imageOffsetUtf16: 0
        });
        result.current.paneRegistrySlice.setActivePaneId(
          paneId === "primary" ? "secondary" : "primary"
        );
      });
      const previousActivePaneId =
        paneId === "primary" ? "secondary" : "primary";
      await waitFor(() =>
        expect(result.current.paneRegistrySlice.activePaneId).toBe(
          previousActivePaneId
        )
      );
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal(
        "requestAnimationFrame",
        (callback: FrameRequestCallback) => {
          frames.push(callback);
          return frames.length;
        }
      );
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      let claim: Promise<boolean> | undefined;
      act(() => {
        claim = actions.claimEditingFocus?.("other", "title");
        actions.notifyCaretMovedByDom?.("other", "title");
      });
      await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());

      if (failureTiming === "after") {
        act(() => {
          for (const frame of frames.splice(0)) frame(0);
        });
      }
      await act(async () => {
        update.reject(new Error("denied"));
        expect(await claim).toBe(false);
      });
      if (failureTiming === "before") {
        act(() => {
          for (const frame of frames.splice(0)) frame(0);
        });
      }

      const state =
        result.current.paneRegistrySlice.panes[paneId].stateSlice.state;
      expect(state.selectedId).not.toBe("other");
      expect(state.editingNoteId).not.toBe("other");
      expect(result.current.paneRegistrySlice.activePaneId).toBe(
        previousActivePaneId
      );
    }
  );

  it("restores the complete primary selection when a framed direct caret claim is denied", async () => {
    const update = deferred<NotesWorkspace>();
    const updateNode = vi.fn().mockReturnValue(update.promise);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(
        workspace([
          node({ id: "root", sortKey: 1024 }),
          node({ id: "middle", sortKey: 2048 }),
          node({ id: "other", sortKey: 3072 })
        ])
      ),
      updateNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/denied-primary-direct-selection",
        repository: store
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const actions =
      result.current.paneRegistrySlice.panes.primary.actionsSlice.actions;
    await act(async () => {
      expect(await actions.claimEditingFocus?.("root", "title")).toBe(true);
    });
    const selection = {
      anchorId: "root",
      headId: "other",
      explicitNodeIds: ["root", "middle"] as const
    };
    act(() => {
      actions.updateNodeDraft("root", {
        title: "dirty",
        note: "",
        imageOffsetUtf16: 0
      });
      expect(actions.replaceSelection?.(selection)).toBe(true);
    });
    const before =
      result.current.paneRegistrySlice.panes.primary.stateSlice.state;
    expect(
      result.current.paneRegistrySlice.panes.primary.draftsSlice.selection
    ).toEqual(selection);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let claim: Promise<boolean> | undefined;
    act(() => {
      claim = actions.claimEditingFocus?.("other", "title");
      actions.notifyCaretMovedByDom?.("other", "title");
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
    expect(
      result.current.paneRegistrySlice.panes.primary.draftsSlice.selection
    ).toBeNull();

    await act(async () => {
      update.reject(new Error("denied"));
      expect(await claim).toBe(false);
    });

    const primary =
      result.current.paneRegistrySlice.panes.primary;
    expect(primary.stateSlice.state).toMatchObject({
      selectedId: before.selectedId,
      editingNoteId: before.editingNoteId,
      pendingFocusId: before.pendingFocusId,
      pendingFocusField: before.pendingFocusField
    });
    expect(primary.draftsSlice.selection).toEqual(selection);
  });

  it("does not restore an old primary selection over a newer selection", async () => {
    const update = deferred<NotesWorkspace>();
    const updateNode = vi.fn().mockReturnValue(update.promise);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(
        workspace([
          node({ id: "root", sortKey: 1024 }),
          node({ id: "middle", sortKey: 2048 }),
          node({ id: "other", sortKey: 3072 })
        ])
      ),
      updateNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/stale-denied-primary-selection",
        repository: store
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const actions =
      result.current.paneRegistrySlice.panes.primary.actionsSlice.actions;
    await act(async () => {
      expect(await actions.claimEditingFocus?.("root", "title")).toBe(true);
    });
    act(() => {
      actions.updateNodeDraft("root", {
        title: "dirty",
        note: "",
        imageOffsetUtf16: 0
      });
      expect(
        actions.replaceSelection?.({
          anchorId: "root",
          headId: "middle"
        })
      ).toBe(true);
    });
    expect(
      result.current.paneRegistrySlice.panes.primary.draftsSlice.selection
    ).toEqual({
      anchorId: "root",
      headId: "middle"
    });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let claim: Promise<boolean> | undefined;
    act(() => {
      claim = actions.claimEditingFocus?.("other", "title");
      actions.notifyCaretMovedByDom?.("other", "title");
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
    act(() => {
      for (const frame of frames.splice(0)) frame(0);
      expect(
        actions.replaceSelection?.({
          anchorId: "middle",
          headId: "other"
        })
      ).toBe(true);
    });

    await act(async () => {
      update.reject(new Error("denied"));
      expect(await claim).toBe(false);
    });

    expect(
      result.current.paneRegistrySlice.panes.primary.draftsSlice.selection
    ).toEqual({
      anchorId: "middle",
      headId: "other"
    });
  });

  it("keeps a slow successful secondary direct claim merged after its frame", async () => {
    const update = deferred<NotesWorkspace>();
    const updateNode = vi.fn().mockReturnValue(update.promise);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(
        workspace([
          node({ id: "root", sortKey: 1024 }),
          node({ id: "other", sortKey: 2048 })
        ])
      ),
      updateNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/slow-successful-secondary-direct",
        repository: store
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const actions =
      result.current.paneRegistrySlice.panes.secondary.actionsSlice.actions;
    await act(async () => {
      expect(await actions.claimEditingFocus?.("root", "title")).toBe(true);
    });
    act(() => {
      actions.updateNodeDraft("root", {
        title: "dirty",
        note: "",
        imageOffsetUtf16: 0
      });
    });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let claim: Promise<boolean> | undefined;
    act(() => {
      claim = actions.claimEditingFocus?.("other", "title");
      actions.notifyCaretMovedByDom?.("other", "title");
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
    const afterFrame =
      result.current.paneRegistrySlice.getPaneSession("secondary");
    const navigationVersion = afterFrame.navigationVersion;
    expect(afterFrame.pendingFocusField).toBeNull();

    await act(async () => {
      update.resolve(
        workspace([
          node({ id: "root", title: "dirty", sortKey: 1024 }),
          node({ id: "other", sortKey: 2048 })
        ])
      );
      expect(await claim).toBe(true);
    });

    const settled =
      result.current.paneRegistrySlice.getPaneSession("secondary");
    expect(settled.navigationVersion).toBe(navigationVersion);
    expect(settled.pendingFocusField).toBeNull();
  });

  it.each([
    ["primary", "successful"],
    ["primary", "failed"],
    ["secondary", "successful"],
    ["secondary", "failed"]
  ] as const)(
    "does not let an old %s %s claim supersede a newer direct move",
    async (paneId, outcome) => {
      const update = deferred<NotesWorkspace>();
      const updateNode = vi.fn().mockReturnValue(update.promise);
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(
          workspace([
            node({ id: "root", sortKey: 1024 }),
            node({ id: "other", sortKey: 2048 })
          ])
        ),
        updateNode
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({
          vaultRoot: `/old-success-newer-direct-${paneId}`,
          repository: store
        })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      const actions =
        result.current.paneRegistrySlice.panes[paneId].actionsSlice.actions;
      await act(async () => {
        expect(await actions.claimEditingFocus?.("root", "title")).toBe(true);
      });
      act(() => {
        actions.updateNodeDraft("root", {
          title: "dirty",
          note: "",
          imageOffsetUtf16: 0
        });
      });
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal(
        "requestAnimationFrame",
        (callback: FrameRequestCallback) => {
          frames.push(callback);
          return frames.length;
        }
      );
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      let oldClaim: Promise<boolean> | undefined;
      act(() => {
        oldClaim = actions.claimEditingFocus?.("other", "title");
        actions.notifyCaretMovedByDom?.("other", "title");
        actions.notifyCaretMovedByDom?.("root", "title");
      });
      await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
      await act(async () => {
        if (outcome === "successful") {
          update.resolve(
            workspace([
              node({ id: "root", sortKey: 1024 }),
              node({ id: "other", sortKey: 2048 })
            ])
          );
        } else {
          update.reject(new Error("denied"));
        }
        expect(await oldClaim).toBe(outcome === "successful");
      });
      act(() => {
        for (const frame of frames.splice(0)) frame(0);
      });

      const state =
        result.current.paneRegistrySlice.panes[paneId].stateSlice.state;
      expect(state.selectedId).toBe("root");
      expect(state.editingNoteId).toBe("root");
      expect(state.pendingFocusField).toBeNull();
    }
  );

  it("routes a secondary split focus only to the secondary pane", async () => {
    const initial = workspace([
      node({ id: "root", title: "Root", sortKey: 1024 }),
      node({ id: "other", title: "Other", sortKey: 2048 })
    ]);
    const settled = workspace([
      node({ id: "root", title: "Ro", sortKey: 1024 }),
      node({ id: "split", title: "ot", sortKey: 1536 }),
      node({ id: "other", title: "Other", sortKey: 2048 })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      splitNode: vi.fn().mockResolvedValue(settled)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/secondary-insertion-routing",
        repository: store
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const panes = () => result.current.paneRegistrySlice.panes;

    await act(async () => panes().primary.actionsSlice.actions.zoomTo("other"));
    await act(async () => {
      await panes().primary.actionsSlice.actions.acknowledgeFocus("other");
    });
    expect(panes().primary.stateSlice.state).toMatchObject({
      selectedId: "other",
      pendingFocusId: null
    });
    result.current.actions.publishOutlinePaneState?.({
      paneId: "primary",
      scope: { kind: "active" },
      zoomedNodeId: "other",
      showCompleted: true,
      collapsedNodeIds: new Set(),
      locallyExpandedNodeIds: new Set(),
      interactionEpoch: 0,
      visibleSignature: createOutlineVisibleSignature([]),
      geometryGeneration: 0,
      activeDrag: false
    });
    result.current.actions.publishOutlinePaneState?.({
      paneId: "secondary",
      scope: { kind: "active" },
      zoomedNodeId: null,
      showCompleted: true,
      collapsedNodeIds: new Set(),
      locallyExpandedNodeIds: new Set(),
      interactionEpoch: 0,
      visibleSignature: createOutlineVisibleSignature([
        {
          id: "root",
          parentId: null,
          depth: 0,
          isCollapsed: false,
          ancestorIds: [],
          ancestorGuideDepths: [],
          visibleDescendantEndId: null
        },
        {
          id: "other",
          parentId: null,
          depth: 0,
          isCollapsed: false,
          ancestorIds: [],
          ancestorGuideDepths: [],
          visibleDescendantEndId: null
        }
      ]),
      geometryGeneration: 0,
      activeDrag: false
    });
    let preparation: ReturnType<
      NonNullable<
        typeof result.current.actions.prepareKeyboardInsertion
      >
    > = null;
    act(() => {
      preparation =
        panes().secondary.actionsSlice.actions.prepareKeyboardInsertion?.({
        ownerPaneId: "secondary",
        interactionEpochAtDispatch: 0,
        intent: {
          token: 41,
          sourceId: "root",
          expectedNodeId: "split",
          postcondition: {
            kind: "split",
            expectedSourceTitle: "Ro",
            expectedInsertedTitle: "ot"
          }
        },
        optimistic: {
          sourceSelection: { anchorUtf16: 2, focusUtf16: 2 },
          sourceTitle: "Ro",
          insertedTitle: "ot"
        }
      }) ?? null;
    });
    expect(preparation).not.toBeNull();
    expect(
      panes().primary.draftsSlice.optimisticKeyboardInsertions
    ).toEqual([]);
    expect(
      panes().secondary.draftsSlice.optimisticKeyboardInsertions?.[0]
        .pending.intent.expectedNodeId
    ).toBe("split");
    expect(
      panes().primary.stateSlice.state.nodesById.split
    ).toBeUndefined();
    expect(
      panes().secondary.stateSlice.state.nodesById.split
    ).toBeUndefined();

    await act(async () => {
      await panes().secondary.actionsSlice.actions.splitNode(
        "root",
        "split",
        "Ro",
        "ot",
        { keyboardInsertion: preparation! }
      );
    });

    expect(panes().primary.stateSlice.state).toMatchObject({
      selectedId: "other",
      pendingFocusId: null
    });
    expect(panes().secondary.stateSlice.state).toMatchObject({
      selectedId: "split",
      editingNoteId: "split",
      pendingFocusId: null,
      pendingFocusField: null
    });
    expect(
      panes().secondary.actionsSlice.actions
        .pendingKeyboardInsertionInteractionEpoch?.("split")
    ).toBeUndefined();

    await act(async () => {
      await panes().secondary.actionsSlice.actions.acknowledgeFocus("split");
    });
    expect(panes().secondary.stateSlice.state.pendingFocusId).toBeNull();
    expect(
      panes().secondary.actionsSlice.actions
        .pendingKeyboardInsertionInteractionEpoch?.("split")
    ).toBeUndefined();
  });

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
    const Pane = memo(function Pane({
      pane,
      activePaneId,
    }: {
      pane: NotesPaneRuntimeSlice;
      activePaneId: "primary" | "secondary";
    }) {
      return (
        <NotesPaneSliceScope
          pane={pane}
          activePaneId={activePaneId}
          deferWhenInactive
        >
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
          <Pane
            pane={registry.panes.primary}
            activePaneId={registry.activePaneId}
          />
          <Pane
            pane={registry.panes.secondary}
            activePaneId={registry.activePaneId}
          />
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
      interactionEpoch: 0,
      visibleSignature: createOutlineVisibleSignature([
        {
          id: "root",
          parentId: null,
          depth: 0,
          isCollapsed: false,
          ancestorIds: [],
          ancestorGuideDepths: [],
          visibleDescendantEndId: null,
        },
      ]),
      geometryGeneration: 0,
      activeDrag: false,
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
    const inactivePaneBefore =
      captured!.paneRegistrySlice.panes.primary;

    act(() => {
      captured!.paneRegistrySlice.panes.secondary.actionsSlice.actions
        .prepareKeyboardInsertion?.({
          ownerPaneId: "secondary",
          interactionEpochAtDispatch: 0,
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
        });
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
      loadWorkspace: vi.fn().mockResolvedValue(
        workspace([
          node({ id: "root", sortKey: 1024 }),
          node({ id: "other", sortKey: 2048 })
        ])
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/pane-identity", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const secondaryBefore = result.current.paneRegistrySlice.panes.secondary;
    for (let index = 0; index < 50; index += 1) {
      await act(async () => {
        await result.current.paneRegistrySlice.panes.primary.actionsSlice.actions
          .focusNode(index % 2 === 0 ? "other" : "root");
      });
    }
    expect(result.current.paneRegistrySlice.panes.secondary).toBe(
      secondaryBefore
    );

    const primaryBefore = result.current.paneRegistrySlice.panes.primary;
    for (let index = 0; index < 50; index += 1) {
      await act(async () => {
        await result.current.paneRegistrySlice.panes.secondary.actionsSlice.actions
          .focusNode(index % 2 === 0 ? "other" : "root");
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
      { initialProps: { vaultRoot: "/first", repository: firstStore } }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const retainedPrimary = result.current.paneRegistrySlice.panes.primary;
    await act(async () => {
      await result.current.paneRegistrySlice.panes.secondary.actionsSlice.actions
        .focusNode("root");
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
      node({ id: "root", parentId: "page", sortKey: 1 })
    ];
    const moveNode = vi.fn().mockResolvedValue(workspace(moved));
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(
          workspace([
            node({ id: "root", sortKey: 1 }),
            node({ id: "page", sortKey: 2 })
          ])
        ),
      moveNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const panes = () => result.current.paneRegistrySlice.panes;

    await act(async () =>
      panes().secondary.actionsSlice.actions.zoomTo("page")
    );
    act(() => panes().primary.actionsSlice.actions.setSelectionAnchor("root"));
    await act(async () => {
      await panes().primary.actionsSlice.actions.moveNodeAcrossPanes?.(
        { id: "root", parentId: "page", afterId: null },
        "primary",
        "secondary"
      );
    });

    expect(moveNode).toHaveBeenCalledTimes(1);
    expect(panes().primary.draftsSlice.selection).toBeNull();
    expect(panes().secondary.stateSlice.state).toMatchObject({
      selectedId: "root",
      editingNoteId: "root",
      pendingFocusId: "root"
    });
    expect(result.current.paneRegistrySlice.activePaneId).toBe("secondary");
  });

  it("moves a selected block across panes with one batch mutation", async () => {
    const initial = [
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "page", sortKey: 3 })
    ];
    const moved = [
      node({ id: "page", sortKey: 1 }),
      node({ id: "first", parentId: "page", sortKey: 1 }),
      node({ id: "second", parentId: "page", sortKey: 2 })
    ];
    const applyBatch = vi.fn().mockResolvedValue(workspace(moved));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace(initial)),
      applyBatch
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
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
        "second"
      ]);
    expect(authority).toBeDefined();
    await act(async () => {
      await panes().primary.actionsSlice.actions.applyPreparedSelectionBatchAcrossPanes?.(
        authority!,
        { type: "move", parentId: "page", afterId: null },
        "primary",
        "secondary"
      );
    });

    expect(applyBatch).toHaveBeenCalledTimes(1);
    expect(panes().primary.draftsSlice.selection).toBeNull();
    expect(panes().secondary.stateSlice.state.selectedId).toBe("first");
    expect(result.current.paneRegistrySlice.activePaneId).toBe("secondary");
  });

  it("undoes secondary navigation without changing the primary page", async () => {
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(
        workspace([
          node({ id: "root" }),
          node({ id: "other", sortKey: 2048 })
        ])
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const panes = () => result.current.paneRegistrySlice.panes;

    await act(async () => panes().primary.actionsSlice.actions.zoomTo("root"));
    await act(async () =>
      panes().secondary.actionsSlice.actions.zoomTo("other")
    );
    await act(async () => panes().primary.actionsSlice.actions.undo?.());

    expect(panes().primary.stateSlice.state.zoomRootId).toBe("root");
    expect(panes().secondary.stateSlice.state.zoomRootId).toBeNull();
  });

  it("undoes primary navigation without changing the secondary page", async () => {
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(
        workspace([
          node({ id: "root" }),
          node({ id: "other", sortKey: 2048 }),
          node({ id: "third", sortKey: 3072 })
        ])
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const panes = () => result.current.paneRegistrySlice.panes;

    await act(async () => panes().primary.actionsSlice.actions.zoomTo("root"));
    await act(async () =>
      panes().secondary.actionsSlice.actions.zoomTo("other")
    );
    await act(async () => panes().primary.actionsSlice.actions.zoomTo("third"));
    await act(async () => panes().primary.actionsSlice.actions.undo?.());

    expect(panes().primary.stateSlice.state.zoomRootId).toBe("root");
    expect(panes().secondary.stateSlice.state.zoomRootId).toBe("other");
  });

  it("lets only the latest pane editing claimant write the shared draft", async () => {
    const store = repository();
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const panes = () => result.current.paneRegistrySlice.panes;

    await act(async () => {
      expect(
        await panes().primary.actionsSlice.actions.claimEditingFocus?.(
          "root",
          "title"
        )
      ).toBe(true);
      expect(
        await panes().secondary.actionsSlice.actions.claimEditingFocus?.(
          "root",
          "title"
        )
      ).toBe(true);
    });
    act(() => {
      panes().primary.actionsSlice.actions.updateNodeDraft(
        "root",
        { title: "blocked", note: "", imageOffsetUtf16: 0 },
        "title"
      );
      panes().secondary.actionsSlice.actions.updateNodeDraft(
        "root",
        { title: "secondary", note: "", imageOffsetUtf16: 0 },
        "title"
      );
    });

    expect(result.current.draftsByNodeId.root?.title).toBe("secondary");
  });
});
