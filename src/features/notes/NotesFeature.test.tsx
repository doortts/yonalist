import {
  fireEvent,
  render,
  screen,
  within,
  waitFor
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";

const notesStoreMock = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue({
    canUndo: false,
    canRedo: false,
    historyEpoch: "history-epoch",
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: []
  }),
  historyStatus: vi.fn().mockResolvedValue({
    canUndo: false,
    canRedo: false,
    historyEpoch: "history-epoch",
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: []
  }),
  prepareNavigation: vi.fn().mockResolvedValue({
    canUndo: false,
    canRedo: false,
    historyEpoch: "history-epoch",
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: []
  }),
  closeHistorySession: vi.fn().mockResolvedValue(undefined),
  loadWorkspace: vi.fn().mockResolvedValue({ nodes: [] }),
  createNode: vi.fn().mockResolvedValue({ nodes: [] }),
  updateNode: vi.fn().mockResolvedValue({ nodes: [] }),
  splitNode: vi.fn().mockResolvedValue({ nodes: [] }),
  moveNode: vi.fn().mockResolvedValue({ nodes: [] }),
  applyBatch: vi.fn().mockResolvedValue({ nodes: [] }),
  toggleComplete: vi.fn().mockResolvedValue({ nodes: [] }),
  toggleCollapsed: vi.fn().mockResolvedValue({ nodes: [] }),
  duplicateNode: vi.fn().mockResolvedValue({ nodes: [] }),
  removeEmptyNode: vi.fn().mockResolvedValue({ nodes: [] }),
  softDeleteNode: vi.fn().mockResolvedValue({ nodes: [] }),
  restoreNode: vi.fn().mockResolvedValue({ nodes: [] }),
  emptyTrash: vi.fn().mockResolvedValue({ nodes: [] })
}));

vi.mock("../../services/notesStore", () => ({ notesStore: notesStoreMock }));

import {
  NotesFeatureProvider,
  notesFeatureRuntime
} from "./NotesFeature";
import { useNotesImageResidencyLease } from "./NotesImageResidencyContext";
import { useNotesPaneRegistry } from "./NotesWorkspaceContext";

function ResidencyProbe() {
  const lease = useNotesImageResidencyLease();
  return (
    <button type="button" aria-pressed={lease.active} onClick={lease.activate}>
      Residency probe
    </button>
  );
}

function ActivePaneProbe() {
  const registry = useNotesPaneRegistry();
  return (
    <>
      <output aria-label="Active Notes pane">{registry.activePaneId}</output>
      <button
        type="button"
        onClick={() => registry.setActivePaneId("secondary")}
      >
        Activate secondary pane
      </button>
    </>
  );
}

describe("NotesFeature", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("renders its working panes through the registry provider", async () => {
    const panes = notesFeatureRuntime.renderPanes({
      renderInboxPanes: vi.fn(),
      renderSettingsPanes: vi.fn()
    });

    render(
      <VaultRootContext.Provider value="/feature-vault">
        <NotesFeatureProvider>
          <ResidencyProbe />
          {panes.middle}
          {panes.detail}
        </NotesFeatureProvider>
      </VaultRootContext.Provider>
    );

    expect(screen.getByLabelText("Notes library")).toHaveClass(
      "list-pane",
      "notes-library-pane"
    );
    expect(screen.getByLabelText("Notes outline")).toBeInTheDocument();
    expect(await screen.findByText("No pages yet.")).toBeInTheDocument();
    expect(notesStoreMock.initialize).toHaveBeenCalledWith(
      "/feature-vault",
      expect.objectContaining({ sessionId: expect.any(String) })
    );
    expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith(
      "/feature-vault",
      { kind: "active" }
    );
    const residencyProbe = screen.getByRole("button", {
      name: "Residency probe"
    });
    expect(residencyProbe).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(residencyProbe);
    expect(residencyProbe).toHaveAttribute("aria-pressed", "true");
  });

  it("opens and closes one secondary pane without opening another workspace", async () => {
    const panes = notesFeatureRuntime.renderPanes({
      renderInboxPanes: vi.fn(),
      renderSettingsPanes: vi.fn()
    });
    const { container } = render(
      <VaultRootContext.Provider value="/split-vault">
        <NotesFeatureProvider>{panes.detail}</NotesFeatureProvider>
      </VaultRootContext.Provider>
    );
    await screen.findByText("No outline yet.");

    expect(screen.getAllByLabelText("Notes outline")).toHaveLength(1);
    expect(
      container.querySelectorAll('[id^="DndDescribedBy-"]')
    ).toHaveLength(1);
    const split = screen.getByRole("button", { name: "Split view" });
    expect(split).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(split);
    await waitFor(() =>
      expect(screen.getAllByLabelText("Notes outline")).toHaveLength(2)
    );
    expect(
      container.querySelectorAll('[id^="DndDescribedBy-"]')
    ).toHaveLength(1);
    expect(split).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "50"
    );

    fireEvent.keyDown(screen.getByRole("separator"), {
      key: "ArrowRight"
    });
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "52"
    );

    fireEvent.click(split);
    await waitFor(() =>
      expect(screen.getAllByLabelText("Notes outline")).toHaveLength(1)
    );
    expect(notesStoreMock.initialize).toHaveBeenCalledTimes(1);
  });

  it("zooms the primary pane when its bullet is clicked in split view", async () => {
    notesStoreMock.loadWorkspace.mockResolvedValueOnce({
      nodes: [
        {
          id: "root",
          nodeKind: "text",
          parentId: null,
          sortKey: 1024,
          title: "Root",
          note: "",
          layoutMode: "bullets",
          markerKind: "bullet",
          isCollapsed: false,
          isStarred: false,
          completedAt: null,
          createdAt: "2026-07-24T00:00:00Z",
          updatedAt: "2026-07-24T00:00:00Z",
          deletedAt: null,
          archivedAt: null,
          archiveRootId: null,
          imageOffsetUtf16: 0,
          markdownImageWidth: null
        }
      ]
    });
    const panes = notesFeatureRuntime.renderPanes({
      renderInboxPanes: vi.fn(),
      renderSettingsPanes: vi.fn()
    });
    const { container } = render(
      <VaultRootContext.Provider value="/split-navigation-vault">
        <NotesFeatureProvider>
          <ActivePaneProbe />
          {panes.detail}
        </NotesFeatureProvider>
      </VaultRootContext.Provider>
    );
    const primary = container.querySelector<HTMLElement>(
      '[data-notes-pane-id="primary"]'
    )!;
    await within(primary).findByRole("button", { name: "Zoom into Root" });
    fireEvent.click(screen.getByRole("button", { name: "Split view" }));
    await waitFor(() =>
      expect(screen.getAllByLabelText("Notes outline")).toHaveLength(2)
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Activate secondary pane" })
    );
    expect(screen.getByLabelText("Active Notes pane")).toHaveTextContent(
      "secondary"
    );
    const primaryBullet = within(primary).getByRole("button", {
      name: "Zoom into Root"
    });
    fireEvent.pointerDown(primaryBullet, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse"
    });
    expect(screen.getByLabelText("Active Notes pane")).toHaveTextContent(
      "primary"
    );
    fireEvent.click(primaryBullet);

    expect(
      await within(primary).findByRole("heading", {
        name: "Root",
        level: 1
      })
    ).toBeVisible();
    expect(screen.getByLabelText("Active Notes pane")).toHaveTextContent(
      "primary"
    );
  });
});
