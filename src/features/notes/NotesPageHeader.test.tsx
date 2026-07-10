import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
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

function zoomedOutline(workspace: UseNotesWorkspaceResult) {
  return (
    <VaultRootContext.Provider value="/vault">
      <NotesWorkspaceContext.Provider value={workspace}>
        <NotesOutlinePane />
      </NotesWorkspaceContext.Provider>
    </VaultRootContext.Provider>
  );
}

function renderZoomedOutline(workspace = workspaceValue()) {
  render(zoomedOutline(workspace));
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

  it("does not mount an empty page note before a reveal action", () => {
    const workspace = renderZoomedOutline(workspaceValue({ note: "" }));
    const title = screen.getByRole("textbox", { name: "Edit page title" });
    const header = screen
      .getByRole("heading", { name: "Project", level: 1 })
      .closest(".notes-page-header");

    expect(header).not.toBeNull();
    expect(header?.querySelector(".notes-page-note")).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Supporting note: Project" })
    ).not.toBeInTheDocument();
    fireEvent.change(title, { target: { value: "Renamed project" } });
    expect(workspace.actions.updateNodeDraft).toHaveBeenCalledWith("project", {
      title: "Renamed project",
      note: ""
    });
    fireEvent.blur(title);
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith("project");
  });

  it("reveals and focuses an empty page note with Shift+Enter", () => {
    renderZoomedOutline(workspaceValue({ note: "" }));
    const title = screen.getByRole("textbox", { name: "Edit page title" });

    expect(
      fireEvent.keyDown(title, { key: "Enter", shiftKey: true })
    ).toBe(false);
    expect(
      screen.getByRole("textbox", { name: "Supporting note: Project" })
    ).toHaveFocus();
  });

  it("keeps zoom-root commands in the shared bullet menu", async () => {
    const user = userEvent.setup();
    const workspace = renderZoomedOutline();

    await user.click(
      screen.getByRole("button", { name: "More actions for Project" })
    );
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual([
      "Complete",
      "Star",
      "Edit note",
      "Duplicate",
      "Export subtree",
      "Delete"
    ]);

    await user.click(within(menu).getByRole("menuitem", { name: "Complete" }));
    expect(workspace.actions.toggleComplete).toHaveBeenCalledWith("project");
  });

  it("closes the page menu before focusing a newly revealed note", async () => {
    const user = userEvent.setup();
    renderZoomedOutline(workspaceValue({ note: "" }));
    const trigger = screen.getByRole("button", {
      name: "More actions for Project"
    });

    await user.click(trigger);
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Add note"
      })
    );

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Supporting note: Project" })
      ).toHaveFocus()
    );
    expect(trigger).not.toHaveFocus();
  });

  it("keeps a revealed page note mounted after its draft becomes empty", () => {
    const initialWorkspace = workspaceValue();
    const view = render(zoomedOutline(initialWorkspace));
    const note = screen.getByRole("textbox", {
      name: "Supporting note: Project"
    });
    fireEvent.focus(note);

    const clearedWorkspace = workspaceValue({
      draft: {
        title: "Project",
        note: "",
        revision: 1,
        status: "pending"
      }
    });
    view.rerender(zoomedOutline(clearedWorkspace));

    const clearedNote = screen.getByRole("textbox", {
      name: "Supporting note: Project"
    });
    expect(clearedNote).toHaveValue("");
    fireEvent.blur(clearedNote);
    expect(clearedWorkspace.actions.flushNodeDraft).toHaveBeenCalledWith(
      "project"
    );
  });

  it("does not carry page-note reveal state to a different zoom root", () => {
    const view = render(zoomedOutline(workspaceValue()));
    fireEvent.focus(
      screen.getByRole("textbox", { name: "Supporting note: Project" })
    );
    const childWorkspace = workspaceValue();
    childWorkspace.state.zoomRootId = "child";

    view.rerender(zoomedOutline(childWorkspace));

    expect(
      screen.getByRole("heading", { name: "First child", level: 1 })
    ).toBeVisible();
    expect(
      screen.queryByRole("textbox", {
        name: "Supporting note: First child"
      })
    ).not.toBeInTheDocument();
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

    await user.click(
      screen.getByRole("button", { name: "More actions for Unsaved project" })
    );
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Retry save"
      })
    );
    expect(workspace.retryFailedDraft).toHaveBeenCalledWith("project");
  });
});
