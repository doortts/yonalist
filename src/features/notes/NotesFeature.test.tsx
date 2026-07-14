import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";

const notesStoreMock = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(undefined),
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

import { NotesFeatureProvider, notesFeature } from "./NotesFeature";
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
  it("renders its working panes through the registry provider", async () => {
    const panes = notesFeature.renderPanes({
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
    expect(notesStoreMock.initialize).toHaveBeenCalledWith("/feature-vault");
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
});
