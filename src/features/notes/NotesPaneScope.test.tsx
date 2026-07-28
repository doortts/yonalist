import { act, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  NotesPaneRegistryContext,
  useNotesActions,
  useNotesDrafts,
  useNotesState
} from "./NotesWorkspaceContext";
import { NotesPaneScope } from "./NotesPaneScope";
import {
  createInitialNotesPaneSession,
  type NotesPaneId
} from "./notesPaneSession";
import { useNotesPaneSessions } from "./useNotesPaneSessions";
import type {
  NotesActionsSlice,
  NotesDraftsSlice,
  NotesPaneRegistrySlice,
  NotesStateSlice
} from "./notesWorkspaceTypes";

describe("NotesPaneScope", () => {
  it("provides the slices belonging to the requested pane", () => {
    const primary = fakePane("primary");
    const secondary = fakePane("secondary");
    const registry: NotesPaneRegistrySlice = {
      activePaneId: "primary",
      panes: { primary, secondary },
      setActivePaneId: vi.fn(),
      getPaneSession: (paneId) =>
        createInitialNotesPaneSession(paneId),
      dispatchPane: vi.fn()
    };

    function Probe() {
      const { state } = useNotesState();
      const { draftsByNodeId } = useNotesDrafts();
      const { actions } = useNotesActions();
      return (
        <output>
          {state.zoomRootId}:{Object.keys(draftsByNodeId)[0]}:
          {actions.getNavigationVersion?.()}
        </output>
      );
    }

    render(
      <NotesPaneRegistryContext.Provider value={registry}>
        <NotesPaneScope paneId="secondary">
          <Probe />
        </NotesPaneScope>
      </NotesPaneRegistryContext.Provider>
    );

    expect(screen.getByText("secondary:secondary:2")).toBeInTheDocument();
  });
});

describe("NotesPaneScope current slices", () => {
  function makeRegistry(
    activePaneId: NotesPaneId,
    secondaryZoom: string,
    secondaryDraftTitle: string,
    secondaryActionVersion = 2,
  ): NotesPaneRegistrySlice {
    return {
      activePaneId,
      panes: {
        primary: pane("primary", "primary-zoom", "primary"),
        secondary: pane(
          "secondary",
          secondaryZoom,
          secondaryDraftTitle,
          secondaryActionVersion,
        ),
      },
      setActivePaneId: vi.fn(),
      getPaneSession: (paneId) => createInitialNotesPaneSession(paneId),
      dispatchPane: vi.fn(),
    };
  }

  it("publishes current state, drafts, and actions to an inactive split pane", () => {
    function Probe({ paneId }: { paneId: NotesPaneId }) {
      const { state } = useNotesState();
      const { draftsByNodeId } = useNotesDrafts();
      const { actions } = useNotesActions();
      return (
        <output data-testid={`${paneId}-slices`}>
          {state.zoomRootId}:{draftsByNodeId[paneId]?.title}:
          {actions.getNavigationVersion?.()}
        </output>
      );
    }
    const tree = (registry: NotesPaneRegistrySlice) => (
      <NotesPaneRegistryContext.Provider value={registry}>
        <NotesPaneScope paneId="primary">
          <Probe paneId="primary" />
        </NotesPaneScope>
        <NotesPaneScope paneId="secondary">
          <Probe paneId="secondary" />
        </NotesPaneScope>
      </NotesPaneRegistryContext.Provider>
    );
    const view = render(tree(makeRegistry("primary", "a", "draft-a")));

    act(() =>
      view.rerender(tree(makeRegistry("primary", "b", "draft-b", 7))),
    );

    expect(screen.getByTestId("primary-slices")).toHaveTextContent(
      "primary-zoom:primary:1",
    );
    expect(screen.getByTestId("secondary-slices")).toHaveTextContent(
      "b:draft-b:7",
    );
  });
});

describe("useNotesPaneSessions", () => {
  it("updates one pane without changing the other pane reference", () => {
    const { result } = renderHook(() => useNotesPaneSessions());
    const secondaryBefore = result.current.panes.secondary;

    act(() => {
      result.current.dispatchPane("primary", {
        type: "setNavigation",
        patch: { zoomRootId: "page-a" }
      });
    });

    expect(result.current.panes.primary.zoomRootId).toBe("page-a");
    expect(result.current.panes.secondary).toBe(secondaryBefore);
  });

  it("tracks the active pane independently from pane navigation", () => {
    const { result } = renderHook(() => useNotesPaneSessions());

    act(() => result.current.setActivePaneId("secondary"));

    expect(result.current.activePaneId).toBe("secondary");
    expect(result.current.panes.primary.zoomRootId).toBeNull();
    expect(result.current.panes.secondary.zoomRootId).toBeNull();
  });
});

function fakePane(paneId: NotesPaneId) {
  return pane(
    paneId,
    paneId,
    paneId,
    paneId === "primary" ? 1 : 2,
  );
}

function pane(
  paneId: NotesPaneId,
  zoomRootId: string,
  draftTitle: string,
  navigationVersion = paneId === "primary" ? 1 : 2,
) {
  const stateSlice = {
    state: {
      nodesById: {},
      childIdsByParent: {},
      rootIds: [],
      attachmentsByNodeId: {},
      selectedId: null,
      zoomRootId,
      editingNoteId: null,
      pendingFocusId: null,
      pendingFocusField: null,
      status: "ready",
      error: null
    },
    deletingNotesData: false,
    libraryView: "all",
    activeTagFilters: [],
    tagSummaries: [],
    locallyExpandedNodeIds: new Set(),
    status: "ready",
    loading: false,
    error: null
  } satisfies NotesStateSlice;
  const draftsSlice = {
    draftsByNodeId: {
      [paneId]: {
        title: draftTitle,
        note: "",
        imageOffsetUtf16: 0,
        revision: 1,
        status: "pending"
      }
    },
    writeError: null
  } satisfies NotesDraftsSlice;
  const actionsSlice = {
    actions: {
      getNavigationVersion: () => navigationVersion,
    }
  } as NotesActionsSlice;
  return { paneId, stateSlice, draftsSlice, actionsSlice };
}
