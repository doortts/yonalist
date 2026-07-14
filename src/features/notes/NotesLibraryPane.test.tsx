import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import type { NoteNode } from "../../domain/notes";
import { NotesLibraryPane } from "./NotesLibraryPane";
import { NotesWorkspaceContext } from "./NotesWorkspaceContext";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import type { UseNotesWorkspaceResult } from "./useNotesWorkspace";

function deletedRoot(): NoteNode {
  return {
    id: "deleted",
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
    archiveRootId: null
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
    splitNode: resolved(),
    createChild: resolved(),
    updateNode: resolved(),
    updateNodeDraft: vi.fn(),
    flushNodeDraft: vi.fn().mockResolvedValue(true),
    flushAllDrafts: vi.fn().mockResolvedValue(true),
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

describe("NotesLibraryPane", () => {
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
      { title: "Renamed", note: root.note },
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
      }
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
        { title: "Renamed", note: "Unsaved supporting note" },
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
      }
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
        { title: "Renamed", note: "Unsaved supporting note" },
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
});
