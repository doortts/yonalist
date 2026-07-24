import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import { NotesDetailSplitHost } from "./NotesDetailSplitHost";
import {
  NotesActionsContext,
  NotesDraftsContext,
  NotesPaneRegistryContext,
  NotesStateContext
} from "./NotesWorkspaceContext";
import { createInitialNotesPaneSession } from "./notesPaneSession";
import {
  NOTES_SPLIT_LAYOUT_STORAGE_KEY,
  defaultNotesSplitLayout
} from "./notesSplitLayoutStore";
import type {
  NotesActionsSlice,
  NotesDraftsSlice,
  NotesPaneRegistrySlice,
  NotesPaneRuntimeSlice,
  NotesStateSlice
} from "./notesWorkspaceTypes";

// Replace the heavy outline leaf with a render-counting stub so the test covers
// the composite host tree (host + real NotesPaneScope + contexts) without
// mounting the whole workspace. The stub subscribes to its pane's own state
// slice, exactly like the real pane, so it re-renders precisely when that slice
// changes or when the host churns its element reference.
const mocks = vi.hoisted(() => ({
  renderCounts: {} as Record<string, number>
}));

vi.mock("./NotesOutlinePane", async () => {
  const { useNotesPaneId } = await import("./NotesPaneScope");
  const { useNotesState } = await import("./NotesWorkspaceContext");
  return {
    NotesOutlinePane: ({ toolbarTrailing }: { toolbarTrailing?: unknown }) => {
      const paneId = useNotesPaneId();
      useNotesState();
      mocks.renderCounts[paneId] = (mocks.renderCounts[paneId] ?? 0) + 1;
      return createElement(
        "div",
        { "data-testid": `outline-${paneId}` },
        toolbarTrailing as never
      );
    }
  };
});

const VAULT = "vault-a";

function makeStateSlice(status = "loading"): NotesStateSlice {
  return {
    state: {
      nodesById: {},
      childIdsByParent: {},
      rootIds: [],
      attachmentsByNodeId: {},
      selectedId: null,
      zoomRootId: null,
      editingNoteId: null,
      pendingFocusId: null,
      pendingFocusField: null,
      status,
      error: null
    },
    deletingNotesData: false,
    libraryView: "all",
    activeTagFilters: [],
    tagSummaries: [],
    locallyExpandedNodeIds: new Set(),
    status,
    loading: false,
    error: null
  } as unknown as NotesStateSlice;
}

function makePaneRuntime(
  paneId: "primary" | "secondary",
  stateSlice: NotesStateSlice = makeStateSlice()
): NotesPaneRuntimeSlice {
  return {
    paneId,
    stateSlice,
    draftsSlice: { draftsByNodeId: {}, writeError: null } as NotesDraftsSlice,
    actionsSlice: {
      actions: {
        releaseEditingFocus: vi.fn(),
        zoomTo: vi.fn(async () => {})
      }
    } as unknown as NotesActionsSlice
  };
}

// A fresh registry object wrapping the given pane runtimes. In production the
// registry slice gets a new identity on every workspace update, which is what
// forces the host to re-render; reusing the pane runtimes byref lets a test say
// "the workspace churned, but this pane's data did not."
function makeRegistry(
  primary: NotesPaneRuntimeSlice,
  secondary: NotesPaneRuntimeSlice,
  activePaneId: "primary" | "secondary" = "primary"
): NotesPaneRegistrySlice {
  return {
    activePaneId,
    panes: { primary, secondary },
    setActivePaneId: vi.fn(),
    getPaneSession: vi.fn(() => createInitialNotesPaneSession("primary")),
    dispatchPane: vi.fn()
  };
}

function seedSplitOpen(splitOpen: boolean): void {
  window.localStorage.setItem(
    NOTES_SPLIT_LAYOUT_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      vaults: { [VAULT]: { ...defaultNotesSplitLayout(), splitOpen } }
    })
  );
}

function renderHost(options: {
  registry: NotesPaneRegistrySlice;
  actions?: NotesActionsSlice;
}) {
  const controls = { setRegistry: (_: NotesPaneRegistrySlice) => {} };
  const actions =
    options.actions ??
    ({ actions: { flushAllDrafts: vi.fn(async () => true) } } as unknown as
      NotesActionsSlice);
  const hostState = makeStateSlice();
  const hostDrafts = {
    draftsByNodeId: {},
    writeError: null
  } as NotesDraftsSlice;

  function Harness() {
    const [registry, setRegistry] = useState(options.registry);
    controls.setRegistry = setRegistry;
    return (
      <VaultRootContext.Provider value={VAULT}>
        <NotesPaneRegistryContext.Provider value={registry}>
          <NotesActionsContext.Provider value={actions}>
            <NotesStateContext.Provider value={hostState}>
              <NotesDraftsContext.Provider value={hostDrafts}>
                <NotesDetailSplitHost />
              </NotesDraftsContext.Provider>
            </NotesStateContext.Provider>
          </NotesActionsContext.Provider>
        </NotesPaneRegistryContext.Provider>
      </VaultRootContext.Provider>
    );
  }

  return { ...render(<Harness />), controls };
}

describe("NotesDetailSplitHost pane re-render isolation", () => {
  beforeEach(() => {
    for (const key of Object.keys(mocks.renderCounts)) {
      delete mocks.renderCounts[key];
    }
  });

  it("bails both pane subtrees out of a workspace update that changes no pane data", () => {
    seedSplitOpen(true);
    const primary = makePaneRuntime("primary");
    const secondary = makePaneRuntime("secondary");
    const { controls } = renderHost({ registry: makeRegistry(primary, secondary) });

    expect(mocks.renderCounts.primary).toBe(1);
    expect(mocks.renderCounts.secondary).toBe(1);

    // A workspace update hands the host a fresh registry identity (as it does on
    // every mutation), re-rendering the host and both NotesPaneScopes, but the
    // pane runtimes are unchanged. With stable element references both panes
    // must bail; without the fix the host churns the elements and both re-render.
    act(() => controls.setRegistry(makeRegistry(primary, secondary)));

    expect(mocks.renderCounts.primary).toBe(1);
    expect(mocks.renderCounts.secondary).toBe(1);
  });

  it("re-renders only the pane whose slice advanced, leaving the inactive pane intact", () => {
    seedSplitOpen(true);
    const secondary = makePaneRuntime("secondary");
    const { controls } = renderHost({
      registry: makeRegistry(makePaneRuntime("primary"), secondary)
    });

    expect(mocks.renderCounts.primary).toBe(1);
    expect(mocks.renderCounts.secondary).toBe(1);

    // The active (primary) pane's slice advances; the inactive (secondary) pane
    // runtime is reused byref. The active pane must reflect the update, the
    // inactive pane must not re-render at all.
    act(() =>
      controls.setRegistry(makeRegistry(makePaneRuntime("primary"), secondary))
    );

    expect(mocks.renderCounts.primary).toBe(2);
    expect(mocks.renderCounts.secondary).toBe(1);
  });

  it("closes the split view: flushes drafts, releases the secondary pane, refocuses the toggle", async () => {
    seedSplitOpen(true);
    const flushAllDrafts = vi.fn(async () => true);
    const secondary = makePaneRuntime("secondary");
    const registry = makeRegistry(
      makePaneRuntime("primary"),
      secondary,
      "secondary"
    );
    renderHost({
      registry,
      actions: {
        actions: { flushAllDrafts }
      } as unknown as NotesActionsSlice
    });

    expect(screen.getByTestId("outline-secondary")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Split view" }));
      await Promise.resolve();
    });

    expect(flushAllDrafts).toHaveBeenCalledTimes(1);
    expect(secondary.actionsSlice.actions.releaseEditingFocus).toHaveBeenCalled();
    expect(registry.setActivePaneId).toHaveBeenCalledWith("primary");
    expect(screen.queryByTestId("outline-secondary")).toBeNull();
  });
});
