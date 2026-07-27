import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AppNavigationContext,
  type AppNavigation
} from "../../AppNavigationContext";
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
import {
  GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
  GITHUB_NOTIFICATIONS_ROOT_ID
} from "../../services/githubNotificationsProvider";
import {
  NotesNavigationContent,
  NotesNavigationHeaderActions
} from "./NotesNavigationContent";
import { NotesWorkspaceContext } from "./NotesWorkspaceContext";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import type { UseNotesWorkspaceResult } from "./useNotesWorkspace";

function NotesLibraryPane({
  navigation = { openNotes: vi.fn(), openSettings: vi.fn() }
}: {
  readonly navigation?: AppNavigation;
}) {
  return (
    <AppNavigationContext.Provider value={navigation}>
      <>
        <NotesNavigationHeaderActions />
        <NotesNavigationContent />
      </>
    </AppNavigationContext.Provider>
  );
}

function deletedRoot(): NoteNode {
  return {
    id: "deleted",
    nodeKind: "text",
    markerKind: "bullet",
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
    imageOffsetUtf16: 0,
    markdownImageWidth: null
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

function githubRoot(sortKey = 2): NoteNode {
  return {
    ...activeRoot(),
    id: GITHUB_NOTIFICATIONS_ROOT_ID,
    sortKey,
    title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
    isReadonly: undefined,
    pluginState: { collapsedGroups: [] }
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
    setReadonly: resolved(),
    materializeGithubNotification: resolved(),
    refreshMaterializedGithubNotifications: resolved(),
    markMaterializedGithubNotificationRead: resolved(),
    setGithubGroupCollapsed: resolved(),
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
    deleteNodes: resolved(),
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
  const libraryView = options.libraryView ?? "all";
  workspace.state = normalizeWorkspace({
    nodes: libraryView === "all" ? [root, githubRoot()] : [root]
  });
  workspace.state.zoomRootId = root.id;
  workspace.libraryView = libraryView;
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
    refresh: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    openDetails: vi.fn(),
    ...overrides
  };
}

function renderNavigationWithExternal(
  workspace: UseNotesWorkspaceResult,
  boundary = externalBoundary(),
  navigation: AppNavigation = {
    openNotes: vi.fn(),
    openSettings: vi.fn()
  }
) {
  const rendered = render(
    <AppNavigationContext.Provider value={navigation}>
      <VaultRootContext.Provider value="/vault">
        <ExternalSourcesContext.Provider value={boundary}>
          <NotesWorkspaceContext.Provider value={workspace}>
            <>
              <NotesNavigationHeaderActions />
              <NotesNavigationContent />
            </>
          </NotesWorkspaceContext.Provider>
        </ExternalSourcesContext.Provider>
      </VaultRootContext.Provider>
    </AppNavigationContext.Provider>
  );
  return { ...rendered, boundary, navigation };
}

describe("NotesNavigationContent", () => {
  it("presents the feature as Yonalist", () => {
    renderNavigationWithExternal(activeWorkspace());

    expect(
      screen.getByLabelText("Yonalist library"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Library" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search Yonalist" }),
    ).toBeInTheDocument();
  });

  it("traverses stored roots once and keeps the action-free GN row in stored order", () => {
    const workspace = activeWorkspace();
    workspace.state = normalizeWorkspace({
      nodes: [
        activeRoot(),
        githubRoot(),
        { ...activeRoot(), id: "root-b", sortKey: 3, title: "Project B" }
      ]
    });
    renderNavigationWithExternal(workspace);

    const rows = document.querySelectorAll(
      ".notes-library-list > .notes-library-page-row"
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Project");
    expect(rows[1]).toHaveAttribute(
      "data-external-provider-id",
      "github-notifications"
    );
    expect(rows[2]).toHaveTextContent("Project B");
    expect(screen.queryByText("No pages yet.")).not.toBeInTheDocument();
    const pluginRoot = rows[1] as HTMLElement;
    expect(within(pluginRoot).queryByRole("textbox")).toBeNull();
    expect(within(pluginRoot).queryByRole("button", { name: /actions/i })).toBeNull();
    expect(within(pluginRoot).queryByText(/Star|Archive|Trash|Duplicate|Export/)).toBeNull();
    expect(screen.getByRole("button", { name: "Project" })).not.toHaveAttribute(
      "aria-current"
    );
  });

  it("does not synthesize GN outside the roots returned by the workspace", () => {
    const workspace = activeWorkspace({ libraryView: "starred" });
    renderNavigationWithExternal(workspace);

    expect(
      screen.queryByRole("button", {
        name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE
      })
    ).not.toBeInTheDocument();
  });

  it("does not show the local empty state when the stored GN root exists", () => {
    const workspace = activeWorkspace();
    workspace.state = normalizeWorkspace({ nodes: [githubRoot()] });
    renderNavigationWithExternal(workspace);

    expect(
      screen.getByRole("button", { name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE })
    ).toBeInTheDocument();
    expect(screen.queryByText("No pages yet.")).toBeNull();
  });

  it("hides a stored GN root when the provider page is absent", () => {
    const workspace = activeWorkspace();
    workspace.state = normalizeWorkspace({ nodes: [githubRoot()] });

    renderNavigationWithExternal(
      workspace,
      externalBoundary({ pages: [] })
    );

    expect(
      screen.queryByRole("button", {
        name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE
      })
    ).not.toBeInTheDocument();
    expect(screen.getByText("No pages yet.")).toBeInTheDocument();
    expect(workspace.state.nodesById[GITHUB_NOTIFICATIONS_ROOT_ID])
      .toBeDefined();
  });

  it("flushes drafts before zooming to the stored GN root and clears selection", async () => {
    const user = userEvent.setup();
    const workspace = activeWorkspace();
    const boundary = externalBoundary();
    const events: string[] = [];
    vi.mocked(workspace.actions.flushAllDrafts).mockImplementation(async () => {
      events.push("flush drafts");
      return true;
    });
    vi.mocked(workspace.actions.clearSelection).mockImplementation(() => {
      events.push("clear selection");
    });
    vi.mocked(workspace.actions.zoomTo).mockImplementation(async (nodeId) => {
      events.push(`zoom ${nodeId}`);
    });
    const navigation: AppNavigation = {
      openNotes: vi.fn(() => events.push("open notes")),
      openSettings: vi.fn()
    };
    renderNavigationWithExternal(workspace, boundary, navigation);

    await user.click(
      screen.getByRole("button", { name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE })
    );

    expect(workspace.actions.flushAllDrafts).toHaveBeenCalledTimes(1);
    expect(workspace.actions.clearSelection).toHaveBeenCalledTimes(1);
    expect(workspace.actions.zoomTo).toHaveBeenCalledWith(
      GITHUB_NOTIFICATIONS_ROOT_ID
    );
    expect(events).toEqual([
      "open notes",
      "flush drafts",
      "clear selection",
      `zoom ${GITHUB_NOTIFICATIONS_ROOT_ID}`
    ]);
  });

  it("keeps the stored GN root closed when draft flush fails", async () => {
    const user = userEvent.setup();
    const workspace = activeWorkspace();
    vi.mocked(workspace.actions.flushAllDrafts).mockResolvedValue(false);
    const boundary = externalBoundary();
    renderNavigationWithExternal(workspace, boundary);

    await user.click(
      screen.getByRole("button", { name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE })
    );

    expect(workspace.actions.clearSelection).not.toHaveBeenCalled();
    expect(workspace.actions.zoomTo).not.toHaveBeenCalled();
  });

  it("runs local navigation", async () => {
    const user = userEvent.setup();
    const workspace = activeWorkspace();
    workspace.state.zoomRootId = null;
    const boundary = externalBoundary();
    const events: string[] = [];
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
    const navigation: AppNavigation = {
      openNotes: vi.fn(() => events.push("open notes")),
      openSettings: vi.fn()
    };
    renderNavigationWithExternal(workspace, boundary, navigation);

    await user.click(screen.getByRole("button", { name: "New page" }));
    await user.click(screen.getByRole("button", { name: "Project" }));
    await user.click(screen.getByRole("button", { name: "Starred" }));

    expect(workspace.actions.createRoot).toHaveBeenCalledTimes(1);
    expect(workspace.actions.zoomTo).toHaveBeenCalledWith("root");
    expect(workspace.actions.selectLibraryView).toHaveBeenCalledWith("starred");
    expect(events).toEqual([
      "open notes",
      "local action",
      "open notes",
      "local action",
      "open notes",
      "local action"
    ]);
  });

  it("returns to Notes before starting an active-page rename from Settings", async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    const navigation: AppNavigation = {
      openNotes: vi.fn(() => events.push("open notes")),
      openSettings: vi.fn()
    };
    renderNavigationWithExternal(
      activeWorkspace(),
      externalBoundary(),
      navigation
    );

    await user.click(screen.getByRole("button", { name: "Project" }));

    expect(events).toEqual(["open notes"]);
    expect(
      screen.getByRole("textbox", { name: "Rename Project" })
    ).toBeInTheDocument();
  });

  it("opens a Notes search result", async () => {
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
    vi.mocked(workspace.actions.openSearchResult).mockImplementation(async () => {
      events.push("open search result");
    });
    const navigation: AppNavigation = {
      openNotes: vi.fn(() => events.push("open notes")),
      openSettings: vi.fn()
    };
    renderNavigationWithExternal(workspace, boundary, navigation);

    await user.type(
      screen.getByRole("searchbox", { name: "Search Yonalist" }),
      "local",
    );
    await user.click(await screen.findByRole("option", { name: /Local result/ }));

    expect(workspace.actions.openSearchResult).toHaveBeenCalledWith("root");
    expect(events).toEqual(["open notes", "open search result"]);
  });

  it("returns to Notes before running navigation selected from Settings", async () => {
    const user = userEvent.setup();
    const workspace = activeWorkspace();
    const events: string[] = [];
    const navigation: AppNavigation = {
      openNotes: vi.fn(() => events.push("open notes")),
      openSettings: vi.fn()
    };
    vi.mocked(workspace.actions.selectLibraryView).mockImplementation(
      async () => {
        events.push("select starred");
      }
    );
    renderNavigationWithExternal(workspace, externalBoundary(), navigation);

    await user.click(screen.getByRole("button", { name: "Starred" }));

    expect(events).toEqual(["open notes", "select starred"]);
  });

  it("opens Notes before selecting a local tag", async () => {
    const user = userEvent.setup();
    const workspace = activeWorkspace({ libraryView: "tags" });
    workspace.tagSummaries = [
      { prefix: "#", normalizedTag: "local", displayTag: "local", count: 1 }
    ];
    const events: string[] = [];
    const navigation: AppNavigation = {
      openNotes: vi.fn(() => events.push("open notes")),
      openSettings: vi.fn()
    };
    vi.mocked(workspace.actions.toggleTagFilter).mockImplementation(async () => {
      events.push("toggle tag");
    });
    renderNavigationWithExternal(workspace, externalBoundary(), navigation);

    await user.click(screen.getByRole("button", { name: "#local, 1 note" }));

    expect(events).toEqual(["open notes", "toggle tag"]);
  });

  it("keeps external titles out of Notes search results", async () => {
    const user = userEvent.setup();
    const workspace = activeWorkspace();
    const boundary = externalBoundary();
    renderNavigationWithExternal(workspace, boundary);

    await user.type(
      screen.getByRole("searchbox", { name: "Search Yonalist" }),
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

    const library = screen.getByLabelText("Yonalist library");
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

    const library = screen.getByLabelText("Yonalist library");
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
        screen.getByRole("searchbox", { name: "Search Yonalist" }),
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
      screen.getByRole("searchbox", { name: "Search Yonalist" }),
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
