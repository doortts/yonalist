import {
  act,
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
    archivedAt: null,
    archiveRootId: null,
    ...overrides
  };
}

function workspaceValue(options: {
  title?: string;
  note?: string;
  draft?: NotesNodeDraft;
  pendingFocus?: { nodeId: string; field: "title" | "note" };
} = {}): UseNotesWorkspaceResult {
  const state = normalizeWorkspace({
    nodes: [
      node({
        id: "project",
        title: options.title ?? "Project",
        note: options.note ?? "Project context"
      }),
      node({ id: "child", parentId: "project", title: "First child" }),
      node({ id: "detail", parentId: "child", title: "Detail" })
    ]
  });
  state.zoomRootId = "project";
  state.pendingFocusId = options.pendingFocus?.nodeId ?? null;
  state.pendingFocusField = options.pendingFocus?.field ?? null;

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
    libraryView: "all",
    activeTagFilters: [],
    tagSummaries: [],
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

function textareasByName(name: string): HTMLTextAreaElement[] {
  return Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea"))
    .filter((textarea) => textarea.getAttribute("aria-label") === name);
}

function queryTextareaByName(name: string): HTMLTextAreaElement | null {
  return textareasByName(name)[0] ?? null;
}

function getTextareaByName(name: string): HTMLTextAreaElement {
  const textarea = queryTextareaByName(name);
  if (!textarea) {
    throw new Error(`Unable to find a textarea named ${name}`);
  }
  return textarea;
}

function editTextareaByName(name: string): HTMLTextAreaElement {
  const textarea = getTextareaByName(name);
  fireEvent.focus(textarea);
  return textarea;
}

describe("NotesPageHeader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the zoom root as a page header outside the rebased child list", () => {
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(
      64
    );
    renderZoomedOutline();

    const heading = screen.getByRole("heading", { name: "Project", level: 1 });
    const note = getTextareaByName("Supporting note: Project");
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

  it("routes unified history shortcuts from page and outline text fields", () => {
    const workspace = renderZoomedOutline();
    const title = editTextareaByName("Edit page title");
    const note = editTextareaByName("Supporting note: Project");
    const childTitle = textareasByName("Edit node title")[0]!;

    expect(fireEvent.keyDown(title, { key: "z", ctrlKey: true })).toBe(false);
    expect(
      fireEvent.keyDown(note, {
        key: "z",
        ctrlKey: true,
        shiftKey: true
      })
    ).toBe(false);
    expect(fireEvent.keyDown(childTitle, { key: "y", ctrlKey: true })).toBe(
      false
    );

    expect(workspace.actions.undo).toHaveBeenCalledOnce();
    expect(workspace.actions.redo).toHaveBeenCalledTimes(2);
  });

  it("keeps native composition history and suppresses Process shortcuts", () => {
    const workspace = renderZoomedOutline();
    const title = editTextareaByName("Edit page title");

    expect(
      fireEvent.keyDown(title, {
        key: "z",
        ctrlKey: true,
        isComposing: true
      })
    ).toBe(true);
    expect(
      fireEvent.keyDown(title, {
        key: "Process",
        ctrlKey: true
      })
    ).toBe(true);
    expect(workspace.actions.undo).not.toHaveBeenCalled();
    expect(workspace.actions.redo).not.toHaveBeenCalled();
  });

  it("restores pending history focus to the supporting-note field", async () => {
    const workspace = renderZoomedOutline(
      workspaceValue({ pendingFocus: { nodeId: "project", field: "note" } })
    );
    const note = getTextareaByName("Supporting note: Project");

    await waitFor(() => expect(note).toHaveFocus());
    expect(workspace.actions.acknowledgeFocus).toHaveBeenCalledWith("project");
  });

  it("auto-grows a long Korean page title beside a stable left menu rail", () => {
    const longTitle =
      "길고 자세한 한국어 페이지 제목도 메뉴 버튼 아래로 숨지 않고 필요한 만큼 여러 줄로 줄바꿈됩니다";
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(
      102
    );
    renderZoomedOutline(workspaceValue({ title: longTitle, note: "" }));

    const title = getTextareaByName("Edit page title");
    const titleRow = title.closest(".notes-page-title-row");
    const heading = title.closest(".notes-page-heading");
    const menu = screen.getByRole("button", {
      name: `More actions for ${longTitle}`
    });

    expect(title).toBeInstanceOf(HTMLTextAreaElement);
    expect(title).toHaveAttribute("rows", "1");
    expect(title).toHaveStyle({ height: "102px" });
    expect(titleRow).toContainElement(menu);
    expect(menu.closest(".notes-page-menu-slot")).not.toBeNull();
    expect(Array.from(titleRow?.children ?? [])).toEqual([
      menu.closest(".notes-page-menu-slot"),
      heading
    ]);
  });

  it("does not mount an empty page note before a reveal action", () => {
    const workspace = renderZoomedOutline(workspaceValue({ note: "" }));
    const title = editTextareaByName("Edit page title");
    const header = screen
      .getByRole("heading", { name: "Project", level: 1 })
      .closest(".notes-page-header");

    expect(header).not.toBeNull();
    expect(header?.querySelector(".notes-page-note")).toBeNull();
    expect(
      queryTextareaByName("Supporting note: Project")
    ).not.toBeInTheDocument();
    fireEvent.change(title, { target: { value: "Renamed project" } });
    expect(workspace.actions.updateNodeDraft).toHaveBeenCalledWith(
      "project",
      { title: "Renamed project", note: "" },
      "title"
    );
    fireEvent.blur(title);
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith("project");
  });

  it("reveals and focuses an empty page note with Shift+Enter", () => {
    renderZoomedOutline(workspaceValue({ note: "" }));
    const title = editTextareaByName("Edit page title");

    expect(
      fireEvent.keyDown(title, { key: "Enter", shiftKey: true })
    ).toBe(false);
    expect(
      getTextareaByName("Supporting note: Project")
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
      "Remove note",
      "Duplicate",
      "Export subtree",
      "Delete"
    ]);

    await user.click(within(menu).getByRole("menuitem", { name: "Complete" }));
    expect(workspace.actions.toggleComplete).toHaveBeenCalledWith("project");
  });

  it("removes and flushes the page note, hides its editor, and restores menu focus", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue();
    const rendered = render(zoomedOutline(workspace));
    const trigger = screen.getByRole("button", {
      name: "More actions for Project"
    });

    await user.click(trigger);
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Remove note"
      })
    );

    expect(workspace.actions.updateNodeDraft).toHaveBeenCalledWith(
      "project",
      { title: "Project", note: "" },
      "note"
    );
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith("project");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger).toHaveFocus();

    rendered.rerender(
      zoomedOutline(
        workspaceValue({
          draft: {
            title: "Project",
            note: "",
            revision: 1,
            status: "pending"
          }
        })
      )
    );
    expect(
      queryTextareaByName("Supporting note: Project")
    ).not.toBeInTheDocument();
    expect(getTextareaByName("Edit page title")).toHaveValue(
      "Project"
    );
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
        getTextareaByName("Supporting note: Project")
      ).toHaveFocus()
    );
    expect(trigger).not.toHaveFocus();
  });

  it("reflows a revealed long page note when its observed width narrows", async () => {
    const user = userEvent.setup();
    const callbacksByTarget = new Map<Element, ResizeObserverCallback>();
    const observe = vi.fn();
    const unobserve = vi.fn();
    let noteScrollHeight = 40;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly callback: ResizeObserverCallback;

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        observe(target: Element) {
          observe(target);
          callbacksByTarget.set(target, this.callback);
        }
        unobserve(target: Element) {
          unobserve(target);
          callbacksByTarget.delete(target);
        }
        disconnect() {}
      }
    );
    vi.spyOn(
      HTMLTextAreaElement.prototype,
      "scrollHeight",
      "get"
    ).mockImplementation(function (this: HTMLTextAreaElement) {
      return this.classList.contains("notes-page-note") ? noteScrollHeight : 34;
    });
    const view = render(zoomedOutline(workspaceValue({ note: "" })));

    await user.click(
      screen.getByRole("button", { name: "More actions for Project" })
    );
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Add note"
      })
    );
    const note = await waitFor(() => getTextareaByName("Supporting note: Project"));
    fireEvent.change(note, {
      target: {
        value:
          "페이지의 긴 한국어 보조 메모도 화면 너비가 줄어들 때 전체 내용이 보이도록 높이를 다시 계산해야 합니다"
      }
    });

    expect(note).toHaveFocus();
    expect(note).toHaveStyle({ height: "40px" });
    expect(observe).toHaveBeenCalledWith(note);

    const resizeCallback = callbacksByTarget.get(note);
    act(() =>
      resizeCallback?.(
        [
          {
            target: note,
            contentRect: { width: 620 }
          } as unknown as ResizeObserverEntry
        ],
        {} as ResizeObserver
      )
    );
    noteScrollHeight = 80;
    act(() =>
      resizeCallback?.(
        [
          {
            target: note,
            contentRect: { width: 280 }
          } as unknown as ResizeObserverEntry
        ],
        {} as ResizeObserver
      )
    );

    expect(note).toHaveStyle({ height: "80px" });
    view.unmount();
    expect(unobserve).toHaveBeenCalledWith(note);
  });

  it("keeps a revealed page note mounted after its draft becomes empty", () => {
    const initialWorkspace = workspaceValue();
    const view = render(zoomedOutline(initialWorkspace));
    const note = getTextareaByName("Supporting note: Project");
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

    const clearedNote = getTextareaByName("Supporting note: Project");
    expect(clearedNote).toHaveValue("");
    fireEvent.blur(clearedNote);
    expect(clearedWorkspace.actions.flushNodeDraft).toHaveBeenCalledWith(
      "project"
    );
  });

  it("does not carry page-note reveal state to a different zoom root", () => {
    const view = render(zoomedOutline(workspaceValue()));
    fireEvent.focus(
      getTextareaByName("Supporting note: Project")
    );
    const childWorkspace = workspaceValue();
    childWorkspace.state.zoomRootId = "child";

    view.rerender(zoomedOutline(childWorkspace));

    expect(
      screen.getByRole("heading", { name: "First child", level: 1 })
    ).toBeVisible();
    expect(
      queryTextareaByName("Supporting note: First child")
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
      getTextareaByName("Supporting note: Unsaved project")
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
