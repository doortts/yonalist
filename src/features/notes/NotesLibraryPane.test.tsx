import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import type { NoteNode } from "../../domain/notes";
import { NotesLibraryPane } from "./NotesLibraryPane";
import { NotesWorkspaceContext } from "./NotesWorkspaceContext";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import type { UseNotesWorkspaceResult } from "./useNotesWorkspace";

const notesStyles = readFileSync(
  join(process.cwd(), "src/features/notes/notes.css"),
  "utf8"
);

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

function renderLibrary(workspace = activeWorkspace()) {
  return render(
    <VaultRootContext.Provider value="/vault">
      <NotesWorkspaceContext.Provider value={workspace}>
        <NotesLibraryPane />
      </NotesWorkspaceContext.Provider>
    </VaultRootContext.Provider>
  );
}

describe("NotesLibraryPane", () => {
  it("uses geometry-neutral separators for the compact 144px budget", () => {
    expect(notesStyles).toMatch(
      /\.notes-library-header\s*\{[^}]*box-shadow:\s*inset 0 -1px 0 var\(--border\);/s
    );
    expect(notesStyles).toMatch(
      /\.notes-library-discovery\s*\{[^}]*box-shadow:\s*inset 0 -1px 0 var\(--border\);/s
    );
    expect(notesStyles).not.toMatch(
      /\.notes-library-header\s*\{[^}]*border-bottom:\s*1px/s
    );
    expect(notesStyles).not.toMatch(
      /\.notes-library-discovery\s*\{[^}]*border-bottom:\s*1px/s
    );
  });

  it("keeps compact view labels on one ellipsized line", () => {
    expect(notesStyles).toMatch(
      /\.notes-library-views button span\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s
    );
  });

  it("keeps New page in the title row and all six views in a compact grid", () => {
    renderLibrary();

    const library = screen.getByRole("region", { name: "Notes library" });
    const header = library.querySelector(".notes-library-header");
    expect(header).not.toBeNull();
    expect(
      within(header as HTMLElement).getByRole("button", { name: "New page" })
    ).toBeVisible();

    const views = within(library).getByRole("group", {
      name: "Notes library views"
    });
    expect(
      within(views).getAllByRole("button").map((button) => button.textContent)
    ).toEqual(["All", "Starred", "Recent", "Tags", "Archive", "Trash"]);

    expect(notesStyles).toMatch(
      /\.notes-library-views\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/s
    );
    expect(notesStyles).toMatch(
      /\.notes-library-header\s*\{[^}]*min-height:\s*40px;[^}]*padding-block:\s*4px;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-search-field\s*\{[^}]*min-height:\s*36px;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-library-discovery\s*\{[^}]*padding:\s*4px 10px 2px;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-library-views\s*\{[^}]*gap:\s*2px 4px;[^}]*margin-top:\s*4px;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-library-views button\s*\{[^}]*min-height:\s*28px;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-library-list\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s
    );
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
