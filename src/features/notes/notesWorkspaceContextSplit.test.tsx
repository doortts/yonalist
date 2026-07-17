import { act, render, renderHook, waitFor } from "@testing-library/react";
import { memo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteNode, NotesStore, NotesWorkspace } from "../../domain/notes";
import {
  NotesActionsContext,
  NotesDraftsContext,
  NotesStateContext,
  useNotesActions,
  useNotesDrafts,
  useNotesState
} from "./NotesWorkspaceContext";
import {
  useNotesWorkspace,
  type UseNotesWorkspaceResult
} from "./useNotesWorkspace";

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
    ...overrides
  };
}

function workspace(nodes: NoteNode[]): NotesWorkspace {
  return { nodes };
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
    loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
    createNode: empty,
    updateNode: empty,
    splitNode: empty,
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
      captured!.actions.updateNodeDraft("root", { title: "typed", note: "" });
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
});
