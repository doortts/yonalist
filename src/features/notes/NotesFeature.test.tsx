import {
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import {
  ExternalSourcesContext,
  type ExternalSourcesBoundary,
} from "../../ExternalSourcesContext";
import {
  GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
  GITHUB_NOTIFICATIONS_ROOT_ID,
} from "../../services/githubNotificationsProvider";

const notesStoreMock = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue({
    canUndo: false,
    canRedo: false,
    historyEpoch: "history-epoch",
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: [],
  }),
  historyStatus: vi.fn().mockResolvedValue({
    canUndo: false,
    canRedo: false,
    historyEpoch: "history-epoch",
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: [],
  }),
  prepareNavigation: vi.fn().mockResolvedValue({
    canUndo: false,
    canRedo: false,
    historyEpoch: "history-epoch",
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: [],
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
  deleteNodes: vi.fn(),
  restoreNode: vi.fn().mockResolvedValue({ nodes: [] }),
  emptyTrash: vi.fn().mockResolvedValue({ nodes: [] }),
}));

vi.mock("../../services/notesStore", () => ({ notesStore: notesStoreMock }));

import { NotesFeatureProvider, notesFeatureRuntime } from "./NotesFeature";
import { useNotesImageResidencyLease } from "./NotesImageResidencyContext";
import { useNotesPaneRegistry } from "./NotesWorkspaceContext";
import { useNotesActions, useNotesState } from "./NotesWorkspaceContext";
import type { NotesPreparedSelectionAuthority } from "./notesWorkspaceTypes";

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

function DeleteProbe({ nodeId }: { nodeId: string }) {
  const { actions } = useNotesActions();
  return (
    <button type="button" onClick={() => void actions.deleteNode(nodeId)}>
      Delete probe
    </button>
  );
}

function BatchDeleteWithFocusProbe({
  nodeIds,
  focusNodeId,
}: {
  nodeIds: readonly string[];
  focusNodeId: string;
}) {
  const { actions } = useNotesActions();
  const { state } = useNotesState();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void actions.applyBatch(nodeIds, { type: "delete" }, { focusNodeId })
        }
      >
        Delete batch with focus
      </button>
      <output aria-label="Workspace roots">{state.rootIds.join(",")}</output>
      <output aria-label="Pending focus">
        {state.pendingFocusId ?? "none"}
      </output>
    </>
  );
}

function PreparedDeleteProbe({ nodeIds }: { nodeIds: readonly string[] }) {
  const actions = useNotesActions();
  const [prepared, setPrepared] =
    useState<NotesPreparedSelectionAuthority | null>(null);
  const [settled, setSettled] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void actions.prepareSelectionAuthority?.(nodeIds).then(setPrepared)
        }
      >
        Prepare selection
      </button>
      <button
        type="button"
        disabled={!prepared}
        onClick={() => {
          if (!prepared) return;
          void actions
            .applyPreparedSelectionBatch?.(prepared, { type: "delete" })
            .then(() => setSettled(true));
        }}
      >
        Delete prepared selection
      </button>
      <button
        type="button"
        onClick={() => actions.actions.setSelectionAnchor(nodeIds.at(-1)!)}
      >
        Invalidate selection
      </button>
      {settled && <span>Delete settled</span>}
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
      renderSettingsPanes: vi.fn(),
    });

    render(
      <VaultRootContext.Provider value="/feature-vault">
        <NotesFeatureProvider>
          <ResidencyProbe />
          {panes.middle}
          {panes.detail}
        </NotesFeatureProvider>
      </VaultRootContext.Provider>,
    );

    expect(screen.getByLabelText("Notes library")).toHaveClass(
      "list-pane",
      "notes-library-pane",
    );
    expect(screen.getByLabelText("Notes outline")).toBeInTheDocument();
    expect(await screen.findByText("No pages yet.")).toBeInTheDocument();
    expect(notesStoreMock.initialize).toHaveBeenCalledWith(
      "/feature-vault",
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
    expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith(
      "/feature-vault",
      { kind: "active" },
    );
    const residencyProbe = screen.getByRole("button", {
      name: "Residency probe",
    });
    expect(residencyProbe).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(residencyProbe);
    expect(residencyProbe).toHaveAttribute("aria-pressed", "true");
  });

  it("opens and closes one secondary pane without opening another workspace", async () => {
    const panes = notesFeatureRuntime.renderPanes({
      renderInboxPanes: vi.fn(),
      renderSettingsPanes: vi.fn(),
    });
    const { container } = render(
      <VaultRootContext.Provider value="/split-vault">
        <NotesFeatureProvider>{panes.detail}</NotesFeatureProvider>
      </VaultRootContext.Provider>,
    );
    await screen.findByText("No outline yet.");

    expect(screen.getAllByLabelText("Notes outline")).toHaveLength(1);
    expect(container.querySelectorAll('[id^="DndDescribedBy-"]')).toHaveLength(
      1,
    );
    const split = screen.getByRole("button", { name: "Split view" });
    expect(split).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(split);
    await waitFor(() =>
      expect(screen.getAllByLabelText("Notes outline")).toHaveLength(2),
    );
    expect(container.querySelectorAll('[id^="DndDescribedBy-"]')).toHaveLength(
      1,
    );
    expect(split).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );

    fireEvent.keyDown(screen.getByRole("separator"), {
      key: "ArrowRight",
    });
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "52",
    );

    fireEvent.click(split);
    await waitFor(() =>
      expect(screen.getAllByLabelText("Notes outline")).toHaveLength(1),
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
          markdownImageWidth: null,
        },
      ],
    });
    const panes = notesFeatureRuntime.renderPanes({
      renderInboxPanes: vi.fn(),
      renderSettingsPanes: vi.fn(),
    });
    const { container } = render(
      <VaultRootContext.Provider value="/split-navigation-vault">
        <NotesFeatureProvider>
          <ActivePaneProbe />
          {panes.detail}
        </NotesFeatureProvider>
      </VaultRootContext.Provider>,
    );
    const primary = container.querySelector<HTMLElement>(
      '[data-notes-pane-id="primary"]',
    )!;
    await within(primary).findByRole("button", { name: "Zoom into Root" });
    fireEvent.click(screen.getByRole("button", { name: "Split view" }));
    await waitFor(() =>
      expect(screen.getAllByLabelText("Notes outline")).toHaveLength(2),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Activate secondary pane" }),
    );
    expect(screen.getByLabelText("Active Notes pane")).toHaveTextContent(
      "secondary",
    );
    const primaryBullet = within(primary).getByRole("button", {
      name: "Zoom into Root",
    });
    fireEvent.pointerDown(primaryBullet, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    expect(screen.getByLabelText("Active Notes pane")).toHaveTextContent(
      "primary",
    );
    fireEvent.click(primaryBullet);

    expect(
      await within(primary).findByRole("heading", {
        name: "Root",
        level: 1,
      }),
    ).toBeVisible();
    expect(screen.getByLabelText("Active Notes pane")).toHaveTextContent(
      "primary",
    );
  });

  it("keeps one Notes outline and projects source state under the stored GN root", async () => {
    notesStoreMock.loadWorkspace.mockResolvedValueOnce({
      nodes: [
        {
          id: GITHUB_NOTIFICATIONS_ROOT_ID,
          nodeKind: "text",
          parentId: null,
          sortKey: 1,
          title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
          note: "",
          imageOffsetUtf16: 0,
          layoutMode: "bullets",
          isCollapsed: false,
          isStarred: false,
          completedAt: null,
          createdAt: "2026-07-22T00:00:00Z",
          updatedAt: "2026-07-22T00:00:00Z",
          deletedAt: null,
          archivedAt: null,
          archiveRootId: null,
          isReadonly: undefined,
          pluginState: { collapsedGroups: [] },
        },
      ],
    });
    const panes = notesFeatureRuntime.renderPanes({
      renderInboxPanes: vi.fn(),
      renderSettingsPanes: vi.fn(),
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
          completionErrors: {},
        },
      ],
      refresh: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
      openDetails: vi.fn(),
    };

    render(
      <VaultRootContext.Provider value="/feature-vault">
        <ExternalSourcesContext.Provider value={externalSources}>
          <NotesFeatureProvider>
            {panes.middle}
            {panes.detail}
          </NotesFeatureProvider>
        </ExternalSourcesContext.Provider>
      </VaultRootContext.Provider>,
    );

    expect(await screen.findByLabelText("Notes outline")).toBeInTheDocument();
    expect(
      await screen.findByText("Connect GitHub to view notifications."),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText(`${GITHUB_NOTIFICATIONS_PROVIDER_TITLE} outline`),
    ).toBeNull();
  });

  it("uses one shared readonly delete confirmation and retries exact stale-safe ids", async () => {
    const user = userEvent.setup();
    const rootId = "11111111-1111-4111-8111-111111111111";
    const readonlyId = "22222222-2222-4222-8222-222222222222";
    const addedReadonlyId = "33333333-3333-4333-8333-333333333333";
    notesStoreMock.loadWorkspace.mockResolvedValueOnce({
      nodes: [
        {
          id: rootId,
          nodeKind: "text",
          parentId: null,
          sortKey: 1,
          title: "Root",
          note: "",
          imageOffsetUtf16: 0,
          layoutMode: "bullets",
          isCollapsed: false,
          isStarred: false,
          completedAt: null,
          createdAt: "2026-07-24T00:00:00Z",
          updatedAt: "2026-07-24T00:00:00Z",
          deletedAt: null,
          archivedAt: null,
          archiveRootId: null,
        },
        {
          id: readonlyId,
          nodeKind: "text",
          parentId: rootId,
          sortKey: 1,
          title: "Protected",
          note: "",
          imageOffsetUtf16: 0,
          layoutMode: "bullets",
          isCollapsed: false,
          isStarred: false,
          completedAt: null,
          createdAt: "2026-07-24T00:00:00Z",
          updatedAt: "2026-07-24T00:00:00Z",
          deletedAt: null,
          archivedAt: null,
          archiveRootId: null,
          isReadonly: true,
        },
      ],
    });
    notesStoreMock.deleteNodes
      .mockResolvedValueOnce({ readonlyDescendantIds: [readonlyId] })
      .mockResolvedValueOnce({ readonlyDescendantIds: [readonlyId] })
      .mockRejectedValueOnce({
        code: "readonlyConfirmationStale",
        message: "Notes readonly delete confirmation is stale.",
      })
      .mockResolvedValueOnce({
        readonlyDescendantIds: [readonlyId, addedReadonlyId],
      })
      .mockResolvedValueOnce({ nodes: [] });

    render(
      <VaultRootContext.Provider value="/feature-vault">
        <NotesFeatureProvider>
          <DeleteProbe nodeId={rootId} />
        </NotesFeatureProvider>
      </VaultRootContext.Provider>,
    );
    await screen.findByRole("button", { name: "Delete probe" });

    await user.click(screen.getByRole("button", { name: "Delete probe" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveAccessibleName(
      "읽기 전용 블릿이 포함되어 있습니다. 함께 삭제할까요?",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "취소" })).toHaveFocus(),
    );
    await user.click(screen.getByRole("button", { name: "취소" }));
    expect(notesStoreMock.deleteNodes).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Delete probe" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() =>
      expect(
        screen.getByText("2개의 읽기 전용 블릿이 포함되어 있습니다."),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() =>
      expect(notesStoreMock.deleteNodes).toHaveBeenCalledTimes(5),
    );
    expect(notesStoreMock.deleteNodes).toHaveBeenLastCalledWith(
      "/feature-vault",
      {
        nodeIds: [rootId],
        expectedReadonlyDescendantIds: [readonlyId, addedReadonlyId],
      },
      expect.objectContaining({ commandKind: "trash" }),
    );
  });

  it("preflights only selection forest roots when a readonly descendant is selected implicitly", async () => {
    const rootId = "44444444-4444-4444-8444-444444444444";
    const readonlyId = "55555555-5555-4555-8555-555555555555";
    const root = {
      id: rootId,
      nodeKind: "text" as const,
      parentId: null,
      sortKey: 1,
      title: "Root",
      note: "",
      imageOffsetUtf16: 0,
      layoutMode: "bullets" as const,
      isCollapsed: false,
      isStarred: false,
      completedAt: null,
      createdAt: "2026-07-24T00:00:00Z",
      updatedAt: "2026-07-24T00:00:00Z",
      deletedAt: null,
      archivedAt: null,
      archiveRootId: null,
    };
    const readonlyChild = {
      ...root,
      id: readonlyId,
      parentId: rootId,
      title: "Protected",
      isReadonly: true,
    };
    notesStoreMock.loadWorkspace.mockResolvedValue({
      nodes: [root, readonlyChild],
    });
    notesStoreMock.deleteNodes.mockReset().mockResolvedValueOnce({
      readonlyDescendantIds: [readonlyId],
    });

    render(
      <VaultRootContext.Provider value="/feature-vault">
        <NotesFeatureProvider>
          <PreparedDeleteProbe nodeIds={[rootId, readonlyId]} />
        </NotesFeatureProvider>
      </VaultRootContext.Provider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Prepare selection" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Delete prepared selection" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete prepared selection",
      }),
    );

    await screen.findByRole("alertdialog");
    expect(notesStoreMock.deleteNodes).toHaveBeenCalledWith(
      "/feature-vault",
      { nodeIds: [rootId] },
      expect.objectContaining({ commandKind: "trash" }),
    );
  });

  it("drops a prepared readonly delete if its selection authority changes during queue validation", async () => {
    const rootId = "66666666-6666-4666-8666-666666666666";
    const readonlyId = "77777777-7777-4777-8777-777777777777";
    const root = {
      id: rootId,
      nodeKind: "text" as const,
      parentId: null,
      sortKey: 1,
      title: "Root",
      note: "",
      imageOffsetUtf16: 0,
      layoutMode: "bullets" as const,
      isCollapsed: false,
      isStarred: false,
      completedAt: null,
      createdAt: "2026-07-24T00:00:00Z",
      updatedAt: "2026-07-24T00:00:00Z",
      deletedAt: null,
      archivedAt: null,
      archiveRootId: null,
    };
    const readonlyChild = {
      ...root,
      id: readonlyId,
      parentId: rootId,
      title: "Protected",
      isReadonly: true,
    };
    const activeWorkspace = { nodes: [root, readonlyChild] };
    notesStoreMock.deleteNodes.mockReset();
    notesStoreMock.loadWorkspace.mockResolvedValue(activeWorkspace);
    let resolveValidation!: (value: typeof activeWorkspace) => void;
    const validation = new Promise<typeof activeWorkspace>((resolve) => {
      resolveValidation = resolve;
    });
    let delayValidation = false;
    let validationStarted = false;
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) => {
        if (delayValidation && scope.kind === "active") {
          validationStarted = true;
          return validation;
        }
        return activeWorkspace;
      },
    );

    render(
      <VaultRootContext.Provider value="/feature-vault">
        <NotesFeatureProvider>
          <PreparedDeleteProbe nodeIds={[rootId, readonlyId]} />
        </NotesFeatureProvider>
      </VaultRootContext.Provider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Prepare selection" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Delete prepared selection" }),
      ).toBeEnabled(),
    );

    delayValidation = true;
    fireEvent.click(
      screen.getByRole("button", { name: "Delete prepared selection" }),
    );
    await waitFor(() => expect(validationStarted).toBe(true));
    fireEvent.click(
      screen.getByRole("button", { name: "Invalidate selection" }),
    );
    delayValidation = false;
    resolveValidation(activeWorkspace);

    expect(await screen.findByText("Delete settled")).toBeInTheDocument();
    expect(notesStoreMock.deleteNodes).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("preserves a row delete survivor focus through the shared deleteNodes settlement", async () => {
    const deletedIds = [
      "88888888-8888-4888-8888-888888888888",
      "99999999-9999-4999-8999-999999999999",
    ];
    const focusNodeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const baseNode = {
      id: deletedIds[0]!,
      nodeKind: "text" as const,
      parentId: null,
      sortKey: 1,
      title: "Alpha",
      note: "",
      imageOffsetUtf16: 0,
      layoutMode: "bullets" as const,
      isCollapsed: false,
      isStarred: false,
      completedAt: null,
      createdAt: "2026-07-24T00:00:00Z",
      updatedAt: "2026-07-24T00:00:00Z",
      deletedAt: null,
      archivedAt: null,
      archiveRootId: null,
    };
    const survivor = {
      ...baseNode,
      id: focusNodeId,
      sortKey: 3,
      title: "Charlie",
    };
    notesStoreMock.loadWorkspace.mockReset().mockResolvedValue({
      nodes: [
        baseNode,
        { ...baseNode, id: deletedIds[1]!, sortKey: 2, title: "Bravo" },
        survivor,
      ],
    });
    notesStoreMock.deleteNodes.mockReset().mockResolvedValue({
      nodes: [survivor],
    });

    render(
      <VaultRootContext.Provider value="/feature-vault">
        <NotesFeatureProvider>
          <BatchDeleteWithFocusProbe
            nodeIds={deletedIds}
            focusNodeId={focusNodeId}
          />
        </NotesFeatureProvider>
      </VaultRootContext.Provider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Workspace roots")).toHaveTextContent(
        [...deletedIds, focusNodeId].join(","),
      ),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete batch with focus" }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Pending focus")).toHaveTextContent(
        focusNodeId,
      ),
    );
    expect(notesStoreMock.deleteNodes).toHaveBeenCalledWith(
      "/feature-vault",
      { nodeIds: deletedIds },
      expect.objectContaining({ commandKind: "trash" }),
    );
    expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
  });
});
