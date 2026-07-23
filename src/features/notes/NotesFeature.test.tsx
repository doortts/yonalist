import {
  fireEvent,
  render,
  screen,
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

function ResidencyProbe() {
  const lease = useNotesImageResidencyLease();
  return (
    <button type="button" aria-pressed={lease.active} onClick={lease.activate}>
      Residency probe
    </button>
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
});
