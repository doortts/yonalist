import { render, waitFor } from "@testing-library/react";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useState
} from "react";
import { flushSync } from "react-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import {
  NotesActionsContext,
  NotesDraftsContext,
  NotesPaneRegistryContext,
  NotesStateContext
} from "./NotesWorkspaceContext";
import { NotesDetailSplitHost } from "./NotesDetailSplitHost";
import {
  createInitialNotesPaneSession,
  type NotesPaneId
} from "./notesPaneSession";
import {
  defaultNotesSplitLayout,
  saveNotesSplitLayout
} from "./notesSplitLayoutStore";
import type {
  NotesPaneRegistrySlice,
  NotesPaneRuntimeSlice,
  NotesWorkspaceActions
} from "./notesWorkspaceTypes";

const outlineRenders = vi.hoisted(() => ({
  primary: 0,
  secondary: 0
}));

vi.mock("./NotesOutlinePane", async () => {
  const { useNotesPaneId } = await import("./NotesPaneScope");
  return {
    NotesOutlinePane: () => {
      outlineRenders[useNotesPaneId()] += 1;
      return null;
    }
  };
});

vi.mock("./NotesSplitDndContext", () => ({
  NotesSplitDndContext: ({ children }: { children: ReactNode }) => children
}));

vi.mock("../../components/ui/Tooltip", () => ({
  IconTooltip: ({ children }: { children: ReactNode }) => children
}));

const actions = {
  flushAllDrafts: vi.fn().mockResolvedValue(true),
  focusNode: vi.fn().mockResolvedValue(undefined),
  acknowledgeFocus: vi.fn().mockResolvedValue(undefined),
  zoomTo: vi.fn().mockResolvedValue(undefined)
} as unknown as NotesWorkspaceActions;

function pane(
  paneId: NotesPaneId,
  selectedId: string | null
): NotesPaneRuntimeSlice {
  return {
    paneId,
    stateSlice: {
      state: {
        nodesById: {},
        childIdsByParent: {},
        rootIds: [],
        attachmentsByNodeId: {},
        selectedId,
        zoomRootId: null,
        editingNoteId: null,
        pendingFocusId: null,
        pendingFocusField: null,
        status: "loading",
        error: null
      },
      deletingNotesData: false,
      libraryView: "all",
      activeTagFilters: [],
      tagSummaries: [],
      locallyExpandedNodeIds: new Set(),
      status: "loading",
      loading: true,
      error: null
    },
    draftsSlice: {
      draftsByNodeId: {},
      writeError: null
    },
    actionsSlice: { actions } as NotesPaneRuntimeSlice["actionsSlice"]
  };
}

const setActivePaneId = vi.fn();
const dispatchPane = vi.fn();

function registry(
  activePaneId: NotesPaneId,
  primary: NotesPaneRuntimeSlice,
  secondary: NotesPaneRuntimeSlice
): NotesPaneRegistrySlice {
  return {
    activePaneId,
    panes: { primary, secondary },
    setActivePaneId,
    getPaneSession: (paneId) => createInitialNotesPaneSession(paneId),
    dispatchPane
  };
}

function Harness({
  activePaneId,
  primary,
  secondary
}: {
  readonly activePaneId: NotesPaneId;
  readonly primary: NotesPaneRuntimeSlice;
  readonly secondary: NotesPaneRuntimeSlice;
}) {
  return (
    <VaultRootContext.Provider value="/render-vault">
      <NotesPaneRegistryContext.Provider
        value={registry(activePaneId, primary, secondary)}
      >
        <NotesActionsContext.Provider value={primary.actionsSlice}>
          <NotesStateContext.Provider value={primary.stateSlice}>
            <NotesDraftsContext.Provider value={primary.draftsSlice}>
              <NotesDetailSplitHost />
            </NotesDraftsContext.Provider>
          </NotesStateContext.Provider>
        </NotesActionsContext.Provider>
      </NotesPaneRegistryContext.Provider>
    </VaultRootContext.Provider>
  );
}

interface TestPanes {
  readonly primary: NotesPaneRuntimeSlice;
  readonly secondary: NotesPaneRuntimeSlice;
}

function StatefulHarness({
  activePaneId,
  primary,
  secondary,
  captureUpdate
}: TestPanes & {
  readonly activePaneId: NotesPaneId;
  readonly captureUpdate: (
    update: Dispatch<SetStateAction<TestPanes>>
  ) => void;
}) {
  const [panes, setPanes] = useState<TestPanes>({ primary, secondary });
  captureUpdate(setPanes);
  return (
    <Harness
      activePaneId={activePaneId}
      primary={panes.primary}
      secondary={panes.secondary}
    />
  );
}

describe("NotesDetailSplitHost render boundary", () => {
  beforeEach(() => {
    localStorage.clear();
    outlineRenders.primary = 0;
    outlineRenders.secondary = 0;
    vi.clearAllMocks();
    saveNotesSplitLayout(localStorage, "/render-vault", {
      ...defaultNotesSplitLayout(),
      splitOpen: true
    });
  });

  it("does not commit the inactive pane across 50 opposite-pane updates", () => {
    let primary = pane("primary", "primary-0");
    let secondary = pane("secondary", "secondary-0");
    const rendered = render(
      <Harness
        activePaneId="primary"
        primary={primary}
        secondary={secondary}
      />
    );

    const primaryBeforeSecondaryMoves = outlineRenders.primary;
    for (let index = 1; index <= 50; index += 1) {
      secondary = pane("secondary", `secondary-${index}`);
      rendered.rerender(
        <Harness
          activePaneId="primary"
          primary={primary}
          secondary={secondary}
        />
      );
    }
    expect(outlineRenders.primary).toBe(primaryBeforeSecondaryMoves);

    const secondaryBeforePrimaryMoves = outlineRenders.secondary;
    for (let index = 1; index <= 50; index += 1) {
      primary = pane("primary", `primary-${index}`);
      rendered.rerender(
        <Harness
          activePaneId="secondary"
          primary={primary}
          secondary={secondary}
        />
      );
    }
    expect(outlineRenders.secondary).toBe(secondaryBeforePrimaryMoves);
  });

  it.each(["primary", "secondary"] as const)(
    "commits the active %s structural slice before the inactive outline",
    async (activePaneId) => {
      let primary = pane("primary", "primary-before");
      let secondary = pane("secondary", "secondary-before");
      let updatePanes: Dispatch<SetStateAction<TestPanes>> | null = null;
      render(
        <StatefulHarness
          activePaneId={activePaneId}
          primary={primary}
          secondary={secondary}
          captureUpdate={(update) => {
            updatePanes = update;
          }}
        />
      );
      const inactivePaneId =
        activePaneId === "primary" ? "secondary" : "primary";
      const before = { ...outlineRenders };

      primary = pane("primary", "primary-after");
      secondary = pane("secondary", "secondary-after");
      flushSync(() => {
        updatePanes?.({ primary, secondary });
      });

      expect(outlineRenders[activePaneId]).toBe(before[activePaneId] + 1);
      expect(outlineRenders[inactivePaneId]).toBe(before[inactivePaneId]);
      await waitFor(() =>
        expect(outlineRenders[inactivePaneId]).toBeGreaterThan(
          before[inactivePaneId]
        )
      );
    }
  );
});
