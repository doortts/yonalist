import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import {
  ExternalSourcesContext,
  type ExternalSourcesBoundary
} from "../../ExternalSourcesContext";
import { GITHUB_NOTIFICATIONS_PROVIDER_TITLE } from "../../services/githubNotificationsProvider";

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

  it("routes the detail pane to the active external page", async () => {
    const panes = notesFeatureRuntime.renderPanes({
      renderInboxPanes: vi.fn(),
      renderSettingsPanes: vi.fn()
    });
    const externalSources: ExternalSourcesBoundary = {
      pages: [
        {
          providerId: "github-notifications",
          connectionId: null,
          title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
          availability: "disconnected",
          items: [],
          loaded: false,
          loading: false,
          error: null,
          syncedAt: null,
          completingKeys: new Set(),
          completionErrors: {}
        }
      ],
      activeProviderId: "github-notifications",
      selectProvider: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
      openDetails: vi.fn()
    };

    render(
      <VaultRootContext.Provider value="/feature-vault">
        <ExternalSourcesContext.Provider value={externalSources}>
          <NotesFeatureProvider>
            {panes.middle}
            {panes.detail}
          </NotesFeatureProvider>
        </ExternalSourcesContext.Provider>
      </VaultRootContext.Provider>
    );

    expect(
      await screen.findByLabelText(
        `${GITHUB_NOTIFICATIONS_PROVIDER_TITLE} outline`
      )
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Notes outline")).toBeNull();
  });
});
