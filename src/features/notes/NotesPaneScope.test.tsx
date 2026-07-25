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

describe("NotesPaneScope deferral", () => {
  type SeenSlices = {
    zoom: string[];
    title: string[];
    actionVersion: number[];
  };

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

  function renderSecondary(
    deferWhenInactive: boolean,
    initialActive: NotesPaneId,
    seen: SeenSlices,
  ) {
    function Probe() {
      const { state } = useNotesState();
      const { draftsByNodeId } = useNotesDrafts();
      const { actions } = useNotesActions();
      seen.zoom.push(state.zoomRootId ?? "");
      seen.title.push(draftsByNodeId.secondary?.title ?? "");
      seen.actionVersion.push(actions.getNavigationVersion?.() ?? -1);
      return (
        <output>
          {state.zoomRootId}:{draftsByNodeId.secondary?.title}
        </output>
      );
    }
    const tree = (registry: NotesPaneRegistrySlice) => (
      <NotesPaneRegistryContext.Provider value={registry}>
        <NotesPaneScope paneId="secondary" deferWhenInactive={deferWhenInactive}>
          <Probe />
        </NotesPaneScope>
      </NotesPaneRegistryContext.Provider>
    );
    const view = render(tree(makeRegistry(initialActive, "a", "draft-a")));
    return {
      rerender: (registry: NotesPaneRegistrySlice) =>
        act(() => view.rerender(tree(registry))),
    };
  }

  const seenSlices = (): SeenSlices => ({
    zoom: [],
    title: [],
    actionVersion: [],
  });

  it("first retains then converges an inactive pane's state and drafts", () => {
    const seen = seenSlices();
    const { rerender } = renderSecondary(true, "primary", seen);
    const updateStart = seen.zoom.length;

    rerender(makeRegistry("primary", "b", "draft-b"));

    const updates = seen.zoom.slice(updateStart).map((zoom, index) => ({
      zoom,
      title: seen.title[updateStart + index],
    }));
    expect(updates).toContainEqual({ zoom: "a", title: "draft-a" });
    expect(updates.at(-1)).toEqual({ zoom: "b", title: "draft-b" });
    expect(screen.getByText("b:draft-b")).toBeInTheDocument();
  });

  it("reflects an active pane's state and drafts immediately", () => {
    const seen = seenSlices();
    const { rerender } = renderSecondary(true, "secondary", seen);
    const updateStart = seen.zoom.length;

    rerender(makeRegistry("secondary", "b", "draft-b"));

    expect(seen.zoom.slice(updateStart)).toEqual(["b"]);
    expect(seen.title.slice(updateStart)).toEqual(["draft-b"]);
  });

  it("does not defer a single pane when split deferral is disabled", () => {
    const seen = seenSlices();
    const { rerender } = renderSecondary(false, "primary", seen);
    const updateStart = seen.zoom.length;

    rerender(makeRegistry("primary", "b", "draft-b"));

    expect(seen.zoom.slice(updateStart)).toEqual(["b"]);
    expect(seen.title.slice(updateStart)).toEqual(["draft-b"]);
  });

  it("keeps actions current while state and drafts are deferred", () => {
    const seen = seenSlices();
    const { rerender } = renderSecondary(true, "primary", seen);
    const updateStart = seen.zoom.length;

    rerender(makeRegistry("primary", "b", "draft-b", 7));

    const updates = seen.zoom.slice(updateStart).map((zoom, index) => ({
      zoom,
      title: seen.title[updateStart + index],
      actionVersion: seen.actionVersion[updateStart + index],
    }));
    expect(updates).toContainEqual({
      zoom: "a",
      title: "draft-a",
      actionVersion: 7,
    });
    expect(updates.at(-1)).toEqual({
      zoom: "b",
      title: "draft-b",
      actionVersion: 7,
    });
  });

  it("uses current slices as soon as the pane becomes active", () => {
    const seen = seenSlices();
    const { rerender } = renderSecondary(true, "primary", seen);
    const updateStart = seen.zoom.length;

    rerender(makeRegistry("secondary", "b", "draft-b"));

    expect(seen.zoom.slice(updateStart)).toEqual(["b"]);
    expect(seen.title.slice(updateStart)).toEqual(["draft-b"]);
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
