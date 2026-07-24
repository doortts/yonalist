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
  function makeRegistry(
    activePaneId: NotesPaneId,
    secondaryZoom: string,
    secondaryDraftTitle: string
  ): NotesPaneRegistrySlice {
    return {
      activePaneId,
      panes: {
        primary: pane("primary", "primary-zoom", "primary"),
        secondary: pane("secondary", secondaryZoom, secondaryDraftTitle)
      },
      setActivePaneId: vi.fn(),
      getPaneSession: (paneId) => createInitialNotesPaneSession(paneId),
      dispatchPane: vi.fn()
    };
  }

  function renderSecondary(
    deferWhenInactive: boolean,
    initialActive: NotesPaneId,
    seen: { zoom: string[]; title: string[] }
  ) {
    function Probe() {
      const { state } = useNotesState();
      const { draftsByNodeId } = useNotesDrafts();
      seen.zoom.push(state.zoomRootId ?? "");
      seen.title.push(draftsByNodeId.secondary?.title ?? "");
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
        act(() => view.rerender(tree(registry)))
    };
  }

  it("defers an inactive pane's state change but converges to the final value", () => {
    const seen = { zoom: [] as string[], title: [] as string[] };
    const { rerender } = renderSecondary(true, "primary", seen);

    rerender(makeRegistry("primary", "b", "draft-a"));

    // useDeferredValue renders the prior value first, then the new one, so the
    // pre-update "a" is committed at least twice (mount + deferred pass).
    expect(seen.zoom.filter((zoom) => zoom === "a").length).toBeGreaterThan(1);
    expect(seen.zoom.at(-1)).toBe("b");
    expect(screen.getByText("b:draft-a")).toBeInTheDocument();
  });

  it("defers an inactive pane's draft change but converges to the final value", () => {
    const seen = { zoom: [] as string[], title: [] as string[] };
    const { rerender } = renderSecondary(true, "primary", seen);

    rerender(makeRegistry("primary", "a", "draft-b"));

    expect(seen.title.at(-1)).toBe("draft-b");
    expect(screen.getByText("a:draft-b")).toBeInTheDocument();
  });

  it("reflects the active pane's change immediately without a deferred pass", () => {
    const seen = { zoom: [] as string[], title: [] as string[] };
    const { rerender } = renderSecondary(true, "secondary", seen);

    rerender(makeRegistry("secondary", "b", "draft-a"));

    expect(seen.zoom.filter((zoom) => zoom === "a").length).toBe(1);
    expect(seen.zoom.at(-1)).toBe("b");
  });

  it("does not defer a single (non-split) pane", () => {
    const seen = { zoom: [] as string[], title: [] as string[] };
    const { rerender } = renderSecondary(false, "primary", seen);

    rerender(makeRegistry("primary", "b", "draft-a"));

    expect(seen.zoom.filter((zoom) => zoom === "a").length).toBe(1);
    expect(seen.zoom.at(-1)).toBe("b");
  });

  it("flushes immediately when an inactive pane is promoted to active", () => {
    const seen = { zoom: [] as string[], title: [] as string[] };
    const { rerender } = renderSecondary(true, "primary", seen);

    // The change lands in the same commit that makes this pane active.
    rerender(makeRegistry("secondary", "b", "draft-a"));

    expect(seen.zoom.filter((zoom) => zoom === "a").length).toBe(1);
    expect(seen.zoom.at(-1)).toBe("b");
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
  return pane(paneId, paneId, paneId);
}

function pane(paneId: NotesPaneId, zoomRootId: string, draftTitle: string) {
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
      getNavigationVersion: () => (paneId === "primary" ? 1 : 2)
    }
  } as NotesActionsSlice;
  return { paneId, stateSlice, draftsSlice, actionsSlice };
}
