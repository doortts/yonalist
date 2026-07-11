import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import type { NoteNode } from "../../domain/notes";
import { NotesOutlinePane } from "./NotesOutlinePane";
import { NotesWorkspaceContext } from "./NotesWorkspaceContext";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import type { UseNotesWorkspaceResult } from "./useNotesWorkspace";

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
    parentId: null,
    sortKey: 1,
    title: overrides.id,
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    ...overrides
  };
}

function workspaceValue(options: {
  hasChildren?: boolean;
  deletingNotesData?: boolean;
  libraryView?: UseNotesWorkspaceResult["libraryView"];
} = {}): UseNotesWorkspaceResult {
  const state = normalizeWorkspace({
    nodes: [
      node({ id: "project", title: "Project" }),
      ...(options.hasChildren
        ? [node({ id: "child", parentId: "project", title: "First child" })]
        : [])
    ]
  });
  state.zoomRootId = "project";
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
    toggleStar: resolved(),
    duplicateNode: resolved(),
    removeEmptyNode: resolved(),
    deleteNode: resolved(),
    restoreNode: resolved(),
    emptyTrash: resolved(),
    selectLibraryView: resolved(),
    selectTag: resolved(),
    searchNotes: vi.fn().mockResolvedValue([]),
    openSearchResult: resolved(),
    deleteAllNotesData: resolved(),
    zoomTo: resolved()
  } as UseNotesWorkspaceResult["actions"];

  return {
    state,
    actions,
    deletingNotesData: options.deletingNotesData ?? false,
    libraryView: options.libraryView ?? "all",
    activeTag: null,
    tags: [],
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

function renderComposer(workspace: UseNotesWorkspaceResult) {
  return render(
    <VaultRootContext.Provider value="/vault">
      <NotesWorkspaceContext.Provider value={workspace}>
        <NotesOutlinePane />
      </NotesWorkspaceContext.Provider>
    </VaultRootContext.Provider>
  );
}

describe("NotesChildComposer", () => {
  it("creates the first child of a leaf zoom root through createChild", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue();
    renderComposer(workspace);

    const addChild = screen.getByRole("button", { name: "Add child" });
    expect(addChild).toBeVisible();
    expect(addChild.closest(".notes-child-composer")).toHaveAttribute(
      "data-has-children",
      "false"
    );

    await user.click(addChild);

    expect(workspace.actions.createChild).toHaveBeenCalledOnce();
    expect(workspace.actions.createChild).toHaveBeenCalledWith("project");
  });

  it("places the composer after the child list for a non-empty page", () => {
    renderComposer(workspaceValue({ hasChildren: true }));

    const list = screen.getByRole("list");
    const composer = screen
      .getByRole("button", { name: "Add child" })
      .closest(".notes-child-composer");

    expect(composer).not.toBeNull();
    expect(composer).toHaveAttribute("data-has-children", "true");
    expect(
      list.compareDocumentPosition(composer as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("creates a child from the keyboard", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue();
    renderComposer(workspace);

    const addChild = screen.getByRole("button", { name: "Add child" });
    addChild.focus();
    await user.keyboard("{Enter}");

    expect(workspace.actions.createChild).toHaveBeenCalledWith("project");
  });

  it.each([
    ["a disabled workspace", { deletingNotesData: true }],
    ["Trash", { libraryView: "trash" as const }]
  ])("does not create from %s", async (_label, options) => {
    const user = userEvent.setup();
    const workspace = workspaceValue(options);
    renderComposer(workspace);

    const addChild = screen.getByRole("button", { name: "Add child" });
    expect(addChild).toBeDisabled();

    await user.click(addChild);

    expect(workspace.actions.createChild).not.toHaveBeenCalled();
  });
});
