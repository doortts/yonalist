import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import type { NoteNode } from "../../domain/notes";
import { NotesOutlinePane } from "./NotesOutlinePane";
import { NotesWorkspaceContext } from "./NotesWorkspaceContext";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import type { NotesNodeDraft, UseNotesWorkspaceResult } from "./useNotesWorkspace";

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
    ...overrides
  };
}

function workspaceValue(options: {
  note?: string;
  draft?: NotesNodeDraft;
} = {}): UseNotesWorkspaceResult {
  const state = normalizeWorkspace({
    nodes: [
      node({
        id: "project",
        title: "Project",
        note: options.note ?? "Project context"
      }),
      node({ id: "child", parentId: "project", title: "First child" }),
      node({ id: "detail", parentId: "child", title: "Detail" })
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
    deletingNotesData: false,
    libraryView: "all",
    activeTag: null,
    tags: [],
    locallyExpandedNodeIds: new Set(),
    draftsByNodeId: options.draft ? { project: options.draft } : {},
    writeError: null,
    retryFailedDraft: resolved(),
    retryLastFailedWrite: resolved(),
    status: "ready",
    loading: false,
    error: null
  };
}

function renderZoomedOutline(workspace = workspaceValue()) {
  render(
    <VaultRootContext.Provider value="/vault">
      <NotesWorkspaceContext.Provider value={workspace}>
        <NotesOutlinePane />
      </NotesWorkspaceContext.Provider>
    </VaultRootContext.Provider>
  );
  return workspace;
}

describe("NotesPageHeader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the zoom root as a page header outside the rebased child list", () => {
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(
      64
    );
    renderZoomedOutline();

    const heading = screen.getByRole("heading", { name: "Project", level: 1 });
    const note = screen.getByRole("textbox", {
      name: "Supporting note: Project"
    });
    const list = screen.getByRole("list");

    expect(heading).toBeVisible();
    expect(note).toHaveValue("Project context");
    expect(note).toHaveStyle({ height: "64px" });
    expect(note.closest(".notes-page-header")).not.toBeNull();
    expect(note.closest("ol")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Zoom into Project" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Zoom into First child" })
    ).toBeVisible();
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-level"))
    ).toEqual(["1", "2"]);
  });

  it("keeps an empty page note reachable through the existing draft pipeline", () => {
    const workspace = renderZoomedOutline(workspaceValue({ note: "" }));
    const title = screen.getByRole("textbox", { name: "Edit page title" });
    const note = screen.getByRole("textbox", {
      name: "Supporting note: Project"
    });

    expect(note).toBeVisible();
    fireEvent.change(title, { target: { value: "Renamed project" } });
    expect(workspace.actions.updateNodeDraft).toHaveBeenCalledWith("project", {
      title: "Renamed project",
      note: ""
    });
    fireEvent.change(note, { target: { value: "Added context" } });
    expect(workspace.actions.updateNodeDraft).toHaveBeenCalledWith("project", {
      title: "Project",
      note: "Added context"
    });
    fireEvent.blur(note);
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith("project");
    expect(fireEvent.keyDown(note, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(note, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(note, { key: "Process", isComposing: true })).toBe(
      true
    );
  });

  it("shows the zoom-root failed draft and retries it through workspace state", async () => {
    const user = userEvent.setup();
    const workspace = renderZoomedOutline(
      workspaceValue({
        draft: {
          title: "Unsaved project",
          note: "Unsaved context",
          revision: 2,
          status: "failed"
        }
      })
    );

    expect(
      screen.getByRole("heading", { name: "Unsaved project", level: 1 })
    ).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Supporting note: Unsaved project" })
    ).toHaveValue("Unsaved context");

    await user.click(screen.getByRole("button", { name: "Retry save" }));
    expect(workspace.retryFailedDraft).toHaveBeenCalledWith("project");
  });
});
