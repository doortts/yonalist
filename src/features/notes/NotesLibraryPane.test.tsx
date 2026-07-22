import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import {
  ExternalSourcesContext,
  type ExternalSourcesBoundary
} from "../../ExternalSourcesContext";
import type { ExternalSourcePageSnapshot } from "../../domain/externalSources";
import type {
  NoteNode,
  NoteNodeKind,
  NoteSearchResult
} from "../../domain/notes";
import { GITHUB_NOTIFICATIONS_PROVIDER_TITLE } from "../../services/githubNotificationsProvider";
import { NotesLibraryPane } from "./NotesLibraryPane";
import { NotesWorkspaceContext } from "./NotesWorkspaceContext";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import type { UseNotesWorkspaceResult } from "./useNotesWorkspace";

function deletedRoot(): NoteNode {
  return {
    id: "deleted",
    nodeKind: "text",
    parentId: null,
    sortKey: 1,
    title: "Deleted project",
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-11T00:00:00Z",
    updatedAt: "2026-07-11T00:00:00Z",
    deletedAt: "2026-07-11T02:00:00Z",
    archivedAt: null,
    archiveRootId: null,
    imageOffsetUtf16: 0
  };
}

function activeRoot(): NoteNode {
  return {
    ...deletedRoot(),
    id: "root",
    title: "Project",
    note: "Supporting note draft",
    deletedAt: null
  };
}

function trashWorkspace(): UseNotesWorkspaceResult {
  const state = normalizeWorkspace({ nodes: [deletedRoot()] });
  state.zoomRootId = "deleted";

  const resolved = () => vi.fn().mockResolvedValue(undefined);
  const actions = {
    acknowledgeFocus: resolved(),
    focusNode: resolved(),
    createRoot: resolved(),
    createNextTextSibling: resolved(),
    splitNode: resolved(),
    createChild: resolved(),
    updateNode: resolved(),
    updateNodeDraft: vi.fn(),
    flushNodeDraft: vi.fn().mockResolvedValue(true),
    flushAllDrafts: vi.fn().mockResolvedValue(true),
    applyImageAtomEdit: resolved(),
    applyImageAtomPaste: resolved(),
    moveNode: resolved(),
    applyBatch: resolved(),
    importSubtree: resolved(),
    toggleComplete: resolved(),
    toggleCollapsed: resolved(),
    expandAll: resolved(),
    collapseAll: resolved(),
    sortSubtreeAscending: resolved(),
    sortSubtreeDescending: resolved(),
    toggleStar: resolved(),
    duplicateNode: resolved(),
    removeEmptyNode: resolved(),
    deleteNode: resolved(),
    restoreNode: resolved(),
    archiveNode: resolved(),
    unarchiveNode: resolved(),
    emptyTrash: resolved(),
    selectLibraryView: resolved(),
    toggleTagFilter: resolved(),
    searchNotes: vi.fn().mockResolvedValue([]),
    openSearchResult: resolved(),
    deleteAllNotesData: resolved(),
    zoomTo: resolved(),
    setImageImportMaxDisplayWidth: vi.fn(),
    undo: resolved(),
    redo: resolved(),
    setSelectionAnchor: vi.fn(),
    extendSelectionTo: vi.fn(),
    toggleSelectionNode: vi.fn(),
    clearSelection: vi.fn()
  } as UseNotesWorkspaceResult["actions"];

  return {
    state,
    actions,
    deletingNotesData: false,
    libraryView: "trash",
    activeTagFilters: [],
    tagSummaries: [],
    locallyExpandedNodeIds: new Set(),
    draftsByNodeId: {},
    writeError: null,
    retryFailedDraft: resolved(),
    retryLastFailedWrite: resolved(),
    status: "ready",
    loading: false,
    error: null
  };
}

function activeWorkspace(
  options: {
    flushResult?: boolean;
    draft?: UseNotesWorkspaceResult["draftsByNodeId"][string];
    libraryView?: UseNotesWorkspaceResult["libraryView"];
  } = {}
): UseNotesWorkspaceResult {
  const root = activeRoot();
  const workspace = trashWorkspace();
  workspace.state = normalizeWorkspace({ nodes: [root] });
  workspace.state.zoomRootId = root.id;
  workspace.libraryView = options.libraryView ?? "all";
  workspace.draftsByNodeId = options.draft ? { [root.id]: options.draft } : {};
  vi.mocked(workspace.actions.flushNodeDraft).mockResolvedValue(
    options.flushResult ?? true
  );
  return workspace;
}

function externalPage(): ExternalSourcePageSnapshot {
  return {
    providerId: "github-notifications",
    connectionId: "github:user-7",
    title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
    availability: "online",
    items: [],
    loaded: true,
    loading: false,
    error: null,
    syncedAt: "2026-07-22T00:00:00Z",
    completingKeys: new Set(),
    completionErrors: {}
  };
}

function externalBoundary(
  overrides: Partial<ExternalSourcesBoundary> = {}
): ExternalSourcesBoundary {
  return {
    pages: [externalPage()],
    activeProviderId: "github-notifications",
    selectProvider: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    openDetails: vi.fn(),
    ...overrides
  };
}

function renderLibraryWithExternal(
  workspace: UseNotesWorkspaceResult,
  boundary = externalBoundary()
) {
  const rendered = render(
    <VaultRootContext.Provider value="/vault">
      <ExternalSourcesContext.Provider value={boundary}>
        <NotesWorkspaceContext.Provider value={workspace}>
          <NotesLibraryPane />
        </NotesWorkspaceContext.Provider>
      </ExternalSourcesContext.Provider>
    </VaultRootContext.Provider>
  );
  return { ...rendered, boundary };
}

describe("NotesLibraryPane", () => {
  it("shows the action-free virtual root only in All before local roots", () => {
    const workspace = activeWorkspace();
    renderLibraryWithExternal(workspace);

    const rows = document.querySelectorAll(
      ".notes-library-list > .notes-library-page-row"
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute(
      "data-external-provider-id",
      "github-notifications"
    );
    expect(rows[1]).toHaveTextContent("Project");
    expect(screen.queryByText("No pages yet.")).not.toBeInTheDocument();
    const virtualRoot = rows[0] as HTMLElement;
    expect(within(virtualRoot).queryByRole("textbox")).toBeNull();
    expect(within(virtualRoot).queryByRole("button", { name: /actions/i })).toBeNull();
    expect(within(virtualRoot).queryByText(/Star|Archive|Trash|Duplicate|Export/)).toBeNull();
    expect(screen.getByRole("button", { name: "Project" })).not.toHaveAttribute(
      "aria-current"
    );
  });

  it("does not show virtual roots or leave them active outside All", () => {
    const workspace = activeWorkspace({ libraryView: "starred" });
    renderLibraryWithExternal(workspace);

    expect(
      screen.queryByRole("button", {
        name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE
      })
    ).not.toBeInTheDocument();
  });

  it("does not show the local empty state when All has a virtual root", () => {
    const workspace = activeWorkspace();
    workspace.state = normalizeWorkspace({ nodes: [] });
    renderLibraryWithExternal(workspace);

    expect(
      screen.getByRole("button", { name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE })
    ).toBeInTheDocument();
    expect(screen.queryByText("No pages yet.")).toBeNull();
  });

  it("flushes drafts before opening a provider and then clears selection", async () => {
    const user = userEvent.setup();
    const workspace = activeWorkspace();
    const boundary = externalBoundary({ activeProviderId: null });
    const events: string[] = [];
    vi.mocked(workspace.actions.flushAllDrafts).mockImplementation(async () => {
      events.push("flush drafts");
      return true;
    });
    vi.mocked(workspace.actions.clearSelection).mockImplementation(() => {
      events.push("clear selection");
    });
    vi.mocked(boundary.selectProvider).mockImplementation(() => {
      events.push("select provider");
    });
    renderLibraryWithExternal(workspace, boundary);

    await user.click(
      screen.getByRole("button", { name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE })
    );

    expect(workspace.actions.flushAllDrafts).toHaveBeenCalledTimes(1);
    expect(workspace.actions.clearSelection).toHaveBeenCalledTimes(1);
    expect(boundary.selectProvider).toHaveBeenCalledWith("github-notifications");
    expect(events).toEqual(["flush drafts", "clear selection", "select provider"]);
  });

  it("keeps the provider closed when draft flush fails", async () => {
    const user = userEvent.setup();
    const workspace = activeWorkspace();
    vi.mocked(workspace.actions.flushAllDrafts).mockResolvedValue(false);
    const boundary = externalBoundary({ activeProviderId: null });
    renderLibraryWithExternal(workspace, boundary);

    await user.click(
      screen.getByRole("button", { name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE })
    );

    expect(workspace.actions.clearSelection).not.toHaveBeenCalled();
    expect(boundary.selectProvider).not.toHaveBeenCalled();
  });

  it("clears the provider before New page, local root, and library view actions", async () => {
    const user = userEvent.setup();
    const workspace = activeWorkspace();
    const boundary = externalBoundary();
    const events: string[] = [];
    vi.mocked(boundary.selectProvider).mockImplementation(() => {
      events.push("clear provider");
    });
    vi.mocked(workspace.actions.createRoot).mockImplementation(async () => {
      events.push("local action");
      return "committed";
    });
    vi.mocked(workspace.actions.zoomTo).mockImplementation(async () => {
      events.push("local action");
    });
    vi.mocked(workspace.actions.selectLibraryView).mockImplementation(async () => {
      events.push("local action");
    });
    renderLibraryWithExternal(workspace, boundary);

    for (const [buttonName, action] of [
      ["New page", workspace.actions.createRoot],
      ["Project", workspace.actions.zoomTo],
      ["Starred", workspace.actions.selectLibraryView]
    ] as const) {
      events.length = 0;
      vi.mocked(boundary.selectProvider).mockClear();
      vi.mocked(action).mockClear();
      await user.click(screen.getByRole("button", { name: buttonName }));
      expect(boundary.selectProvider).toHaveBeenCalledWith(null);
      expect(action).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["clear provider", "local action"]);
    }
  });

  it("clears the provider before opening a Notes search result", async () => {
    const user = userEvent.setup();
    const workspace = activeWorkspace();
    vi.mocked(workspace.actions.searchNotes).mockResolvedValue([
      {
        nodeId: "root",
        title: "Local result",
        nodeKind: "text",
        imageOffsetUtf16: 0,
        attachmentName: null,
        displayLabel: "Local result",
        parentTrail: [],
        parentTrailKinds: [],
        matchedField: "title"
      }
    ]);
    const boundary = externalBoundary();
    const events: string[] = [];
    vi.mocked(boundary.selectProvider).mockImplementation(() => {
      events.push("clear provider");
    });
    vi.mocked(workspace.actions.openSearchResult).mockImplementation(async () => {
      events.push("open search result");
    });
    renderLibraryWithExternal(workspace, boundary);

    await user.type(screen.getByRole("searchbox", { name: "Search notes" }), "local");
    await user.click(await screen.findByRole("option", { name: /Local result/ }));

    expect(boundary.selectProvider).toHaveBeenCalledWith(null);
    expect(workspace.actions.openSearchResult).toHaveBeenCalledWith("root");
    expect(events).toEqual(["clear provider", "open search result"]);
  });

  it("clears the provider before selecting a local tag", async () => {
    const user = userEvent.setup();
    const workspace = activeWorkspace({ libraryView: "tags" });
    workspace.tagSummaries = [
      { prefix: "#", normalizedTag: "local", displayTag: "local", count: 1 }
    ];
    const boundary = externalBoundary();
    renderLibraryWithExternal(workspace, boundary);

    await user.click(screen.getByRole("button", { name: "#local, 1 note" }));

    expect(boundary.selectProvider).toHaveBeenCalledWith(null);
    expect(workspace.actions.toggleTagFilter).toHaveBeenCalledWith(
      workspace.tagSummaries[0]
    );
  });

  it("keeps external titles out of Notes search results", async () => {
    const user = userEvent.setup();
    const workspace = activeWorkspace();
    const boundary = externalBoundary();
    renderLibraryWithExternal(workspace, boundary);

    await user.type(
      screen.getByRole("searchbox", { name: "Search notes" }),
      "external thread title"
    );

    expect(await screen.findByText("No matches.")).toBeInTheDocument();
    expect(workspace.actions.searchNotes).toHaveBeenCalledWith(
      "external thread title"
    );
  });

  it("does not mark loading error state as transient workspace busy", () => {
    const workspace = activeWorkspace();
    workspace.state.status = "loading";
    workspace.state.error = "Move failed";
    render(
      <VaultRootContext.Provider value="/vault">
        <NotesWorkspaceContext.Provider value={workspace}>
          <NotesLibraryPane />
        </NotesWorkspaceContext.Provider>
      </VaultRootContext.Provider>
    );

    const library = screen.getByRole("region", { name: "Notes library" });
    expect(library).toHaveAttribute("aria-busy", "true");
    expect(library).not.toHaveAttribute("data-transient-workspace-busy");
    expect(
      within(library).getByRole("button", { name: "New page" })
    ).toBeDisabled();
  });

  it("renames the active root through a title draft and flush", async () => {
    const user = userEvent.setup();
    const root = activeRoot();
    const workspace = activeWorkspace();
    render(
      <VaultRootContext.Provider value="/vault">
        <NotesWorkspaceContext.Provider value={workspace}>
          <NotesLibraryPane />
        </NotesWorkspaceContext.Provider>
      </VaultRootContext.Provider>
    );

    await user.click(screen.getByRole("button", { name: "Project" }));
    const input = screen.getByRole("textbox", { name: "Rename Project" });
    await user.clear(input);
    await user.type(input, "Renamed{Enter}");

    expect(workspace.actions.updateNodeDraft).toHaveBeenCalledWith(
      root.id,
      { title: "Renamed", note: root.note, imageOffsetUtf16: 0 },
      "title"
    );
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith(root.id);
    await waitFor(() =>
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    );
  });

  it("preserves a supporting-note draft and keeps a failed rename after rerender", async () => {
    const user = userEvent.setup();
    const root = activeRoot();
    const workspace = activeWorkspace({
      flushResult: false,
      draft: {
        title: root.title,
        note: "Unsaved supporting note",
        revision: 1,
        status: "pending"
      , imageOffsetUtf16: 0}
    });
    const rendered = render(
      <VaultRootContext.Provider value="/vault">
        <NotesWorkspaceContext.Provider value={workspace}>
          <NotesLibraryPane />
        </NotesWorkspaceContext.Provider>
      </VaultRootContext.Provider>
    );

    await user.click(screen.getByRole("button", { name: "Project" }));
    const input = screen.getByRole("textbox", { name: "Rename Project" });
    await user.clear(input);
    await user.type(input, "Renamed{Enter}");

    await waitFor(() =>
      expect(workspace.actions.updateNodeDraft).toHaveBeenCalledWith(
        root.id,
        {
          title: "Renamed",
          note: "Unsaved supporting note",
          imageOffsetUtf16: 0
        },
        "title"
      )
    );
    expect(input).toHaveValue("Renamed");

    const failedWorkspace = activeWorkspace({
      flushResult: false,
      draft: {
        title: "Renamed",
        note: "Unsaved supporting note",
        revision: 2,
        status: "failed"
      , imageOffsetUtf16: 0}
    });
    rendered.rerender(
      <VaultRootContext.Provider value="/vault">
        <NotesWorkspaceContext.Provider value={failedWorkspace}>
          <NotesLibraryPane />
        </NotesWorkspaceContext.Provider>
      </VaultRootContext.Provider>
    );

    expect(screen.getByRole("textbox", { name: "Rename Renamed" })).toHaveValue(
      "Renamed"
    );

    await user.type(
      screen.getByRole("textbox", { name: "Rename Renamed" }),
      "{Enter}"
    );
    await waitFor(() =>
      expect(failedWorkspace.actions.updateNodeDraft).toHaveBeenCalledWith(
        root.id,
        {
          title: "Renamed",
          note: "Unsaved supporting note",
          imageOffsetUtf16: 0
        },
        "title"
      )
    );
    expect(failedWorkspace.actions.flushNodeDraft).toHaveBeenCalledWith(root.id);
    expect(screen.getByRole("textbox", { name: "Rename Renamed" })).toHaveValue(
      "Renamed"
    );
  });

  it.each(["archive", "trash"] as const)(
    "does not open rename in the %s library view",
    async (libraryView) => {
      const user = userEvent.setup();
      const workspace = activeWorkspace({ libraryView });
      render(
        <VaultRootContext.Provider value="/vault">
          <NotesWorkspaceContext.Provider value={workspace}>
            <NotesLibraryPane />
          </NotesWorkspaceContext.Provider>
        </VaultRootContext.Provider>
      );

      await user.click(screen.getByRole("button", { name: "Project" }));

      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(workspace.actions.updateNodeDraft).not.toHaveBeenCalled();
      expect(workspace.actions.flushNodeDraft).not.toHaveBeenCalled();
    }
  );

  it("routes Restore for the viewed trash root through the workspace action", async () => {
    const user = userEvent.setup();
    const workspace = trashWorkspace();
    render(
      <VaultRootContext.Provider value="/vault">
        <NotesWorkspaceContext.Provider value={workspace}>
          <NotesLibraryPane />
        </NotesWorkspaceContext.Provider>
      </VaultRootContext.Provider>
    );

    const library = screen.getByRole("region", { name: "Notes library" });
    await user.click(
      within(library).getByRole("button", {
        name: "Page actions for Deleted project"
      })
    );
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Restore" }));

    await waitFor(() =>
      expect(workspace.actions.restoreNode).toHaveBeenCalledWith("deleted")
    );
    expect(workspace.actions.zoomTo).not.toHaveBeenCalled();
    expect(workspace.actions.selectLibraryView).not.toHaveBeenCalled();
  });

  it.each(["all", "archive", "trash", "tags"] as const)(
    "uses stored filenames for image hits and ancestors in %s search rows",
    async (libraryView) => {
      const user = userEvent.setup();
      const workspace = activeWorkspace({ libraryView });
      if (libraryView === "tags") {
        workspace.activeTagFilters = [
          { prefix: "#", normalizedTag: "filtered" }
        ];
      }
      const kindAwareResult = {
        nodeId: "unloaded-image",
        title: "hidden-result.png",
        nodeKind: "image",
        imageOffsetUtf16: 0,
        attachmentName: "hidden-result.png",
        displayLabel: "hidden-result.png",
        parentTrail: ["hidden-parent.png", "Visible page"],
        parentTrailKinds: ["image", "text"],
        matchedField: "note"
      } satisfies NoteSearchResult & {
        nodeKind: NoteNodeKind;
        parentTrailKinds: NoteNodeKind[];
      };
      vi.mocked(workspace.actions.searchNotes).mockResolvedValue([
        kindAwareResult
      ]);

      render(
        <VaultRootContext.Provider value="/vault">
          <NotesWorkspaceContext.Provider value={workspace}>
            <NotesLibraryPane />
          </NotesWorkspaceContext.Provider>
        </VaultRootContext.Provider>
      );

      await user.type(
        screen.getByRole("searchbox", { name: "Search notes" }),
        "diagram"
      );

      const result = await screen.findByRole("option", {
        name:
          "hidden-result.png, in hidden-parent.png / Visible page, note match"
      });
      expect(result).toHaveTextContent(
        "hidden-result.pnghidden-parent.png / Visible page"
      );
      expect(result).toHaveAccessibleName(
        "hidden-result.png, in hidden-parent.png / Visible page, note match"
      );
    }
  );

  it("fails closed when a search result arrives without kind metadata", async () => {
    const user = userEvent.setup();
    const workspace = activeWorkspace();
    vi.mocked(workspace.actions.searchNotes).mockResolvedValue([
      {
        nodeId: "unloaded-result",
        title: "possibly-private-filename.png",
        parentTrail: ["possibly-private-parent.png"],
        matchedField: "note"
      } as unknown as NoteSearchResult
    ]);

    render(
      <VaultRootContext.Provider value="/vault">
        <NotesWorkspaceContext.Provider value={workspace}>
          <NotesLibraryPane />
        </NotesWorkspaceContext.Provider>
      </VaultRootContext.Provider>
    );

    await user.type(
      screen.getByRole("searchbox", { name: "Search notes" }),
      "private"
    );

    const result = await screen.findByRole("option", {
      name: "Note, in Note, note match"
    });
    expect(result).toHaveTextContent("NoteNote");
    expect(result).not.toHaveTextContent("possibly-private-filename.png");
    expect(result).not.toHaveTextContent("possibly-private-parent.png");
  });
});
