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
    undo: resolved(),
    redo: resolved()
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

describe("NotesLibraryPane", () => {
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
