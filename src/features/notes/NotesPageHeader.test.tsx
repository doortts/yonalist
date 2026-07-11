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
import type { NoteAttachment, NoteNode } from "../../domain/notes";
import { NotesOutlinePane } from "./NotesOutlinePane";
import { NotesDateTodayProvider } from "./NotesDatePickerIntegration";
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

function attachment(
  overrides: Partial<NoteAttachment> & Pick<NoteAttachment, "id" | "nodeId">
): NoteAttachment {
  const contentHash = overrides.contentHash ?? "a".repeat(64);
  return {
    sortKey: 1024,
    relativePath: `notes-assets/${contentHash}.png`,
    contentHash,
    originalName: "diagram.png",
    mimeType: "image/png",
    byteSize: 4,
    intrinsicWidth: 640,
    intrinsicHeight: 320,
    displayWidth: 320,
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z",
    ...overrides
  };
}

function workspaceValue(options: {
  title?: string;
  note?: string;
  childTitle?: string;
  childNote?: string;
  draft?: NotesNodeDraft;
  deletingNotesData?: boolean;
  libraryView?: UseNotesWorkspaceResult["libraryView"];
  pendingFocus?: { nodeId: string; field: "title" | "note" };
  attachments?: NoteAttachment[];
  attachmentUploadError?: string;
} = {}): UseNotesWorkspaceResult {
  const state = normalizeWorkspace({
    nodes: [
      node({
        id: "project",
        title: options.title ?? "Project",
        note: options.note ?? "Project context"
      }),
      node({
        id: "child",
        parentId: "project",
        title: options.childTitle ?? "First child",
        note: options.childNote ?? ""
      }),
      node({ id: "detail", parentId: "child", title: "Detail" })
    ],
    attachmentsByNodeId: options.attachments
      ? { project: options.attachments }
      : {}
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
    uploadImage: resolved(),
    retryImageUpload: resolved(),
    loadAttachmentBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
    resizeImage: resolved(),
    removeImage: resolved(),
    undo: resolved(),
    redo: resolved()
  } as UseNotesWorkspaceResult["actions"];

  return {
    state,
    actions,
    deletingNotesData: options.deletingNotesData ?? false,
    libraryView: options.libraryView ?? "all",
    activeTagFilters: [],
    tagSummaries: [],
    locallyExpandedNodeIds: new Set(),
    attachmentUploadErrorsByNodeId: options.attachmentUploadError
      ? { project: options.attachmentUploadError }
      : {},
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
    <NotesDateTodayProvider today={{ year: 2026, month: 7, day: 11 }}>
      <VaultRootContext.Provider value="/vault">
        <NotesWorkspaceContext.Provider value={workspace}>
          <NotesOutlinePane />
        </NotesWorkspaceContext.Provider>
      </VaultRootContext.Provider>
    </NotesDateTodayProvider>
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

  it("renders page-root attachments and retry UI immediately below the header note", async () => {
    const user = userEvent.setup();
    const image = attachment({ id: "image-1", nodeId: "project" });
    const workspace = workspaceValue({
      attachments: [image],
      attachmentUploadError: "Image upload failed: disk full"
    });

    renderZoomedOutline(workspace);

    const group = screen.getByRole("group", { name: "Image: diagram.png" });
    const manualLoad = within(group).getByRole("button", {
      name: "Load image diagram.png"
    });
    const alert = screen.getByRole("alert", { name: "Image upload failed" });
    const note = getTextareaByName("Supporting note: Project");
    const attachments = group.closest(".notes-page-attachments");

    expect(attachments).not.toBeNull();
    expect(
      note.compareDocumentPosition(attachments!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(manualLoad).toBeVisible();
    expect(alert).toHaveTextContent("disk full");
    expect(workspace.actions.loadAttachmentBytes).not.toHaveBeenCalled();

    await user.click(
      within(alert).getByRole("button", { name: "Retry image upload" })
    );
    expect(workspace.actions.retryImageUpload).toHaveBeenCalledWith("project");
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
      "Add date",
      "Upload image",
      "Remove note",
      "Duplicate",
      "Export subtree",
      "Delete"
    ]);

    await user.click(within(menu).getByRole("menuitem", { name: "Complete" }));
    expect(workspace.actions.toggleComplete).toHaveBeenCalledWith("project");

    await user.click(
      screen.getByRole("button", { name: "More actions for Project" })
    );
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Upload image"
      })
    );
    expect(workspace.actions.uploadImage).toHaveBeenCalledWith("project");
  });

  it("opens a title picker from non-composing !! and commits one flush and one Undo step", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue({ title: "Plan", note: "Context" });
    const rendered = render(zoomedOutline(workspace));
    const title = editTextareaByName("Edit page title");

    fireEvent.input(title, {
      target: {
        value: "Plan !!",
        selectionStart: 7,
        selectionEnd: 7
      },
      inputType: "insertText",
      data: "!"
    });

    const picker = await screen.findByRole("dialog", { name: "Choose date" });
    expect(workspace.actions.flushNodeDraft).not.toHaveBeenCalled();
    await user.click(within(picker).getByRole("button", { name: "Today" }));
    await user.keyboard("{Enter}");

    expect(workspace.actions.updateNodeDraft).toHaveBeenLastCalledWith(
      "project",
      { title: "Plan 07/11/2026", note: "Context" },
      "title"
    );
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledTimes(1);
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith("project");
    expect(title).not.toHaveFocus();

    const committedWorkspace = workspaceValue({
      draft: {
        title: "Plan 07/11/2026",
        note: "Context",
        revision: 1,
        status: "pending"
      }
    });
    rendered.rerender(zoomedOutline(committedWorkspace));
    await waitFor(() => expect(title).toHaveFocus());
    expect(title.selectionStart).toBe(15);
    expect(title.selectionEnd).toBe(15);

    fireEvent.keyDown(title, { key: "z", ctrlKey: true });
    expect(committedWorkspace.actions.undo).toHaveBeenCalledOnce();
  });

  it("suppresses the !! picker while the page title is IME composing", () => {
    renderZoomedOutline(workspaceValue({ title: "Plan" }));
    const title = editTextareaByName("Edit page title");
    fireEvent.compositionStart(title, { data: "!" });

    fireEvent.input(title, {
      target: {
        value: "Plan !!",
        selectionStart: 7,
        selectionEnd: 7
      },
      inputType: "insertCompositionText",
      data: "!",
      isComposing: true
    });

    expect(
      screen.queryByRole("dialog", { name: "Choose date" })
    ).not.toBeInTheDocument();
  });

  it("opens Add date at the resting page-title end and restores title focus", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue({ title: "Plan", note: "Context" });
    const rendered = render(zoomedOutline(workspace));

    await user.click(
      screen.getByRole("button", { name: "More actions for Plan" })
    );
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Add date"
      })
    );
    const picker = await screen.findByRole("dialog", { name: "Choose date" });
    await user.click(within(picker).getByRole("button", { name: "Tomorrow" }));
    await user.keyboard("{Enter}");

    expect(workspace.actions.updateNodeDraft).toHaveBeenCalledWith(
      "project",
      { title: "Plan 07/12/2026", note: "Context" },
      "title"
    );
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledOnce();
    expect(getTextareaByName("Edit page title")).not.toHaveFocus();

    const committedWorkspace = workspaceValue({
      draft: {
        title: "Plan 07/12/2026",
        note: "Context",
        revision: 1,
        status: "pending"
      }
    });
    rendered.rerender(zoomedOutline(committedWorkspace));
    const title = getTextareaByName("Edit page title");
    await waitFor(() => expect(title).toHaveFocus());
    fireEvent.blur(title);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit date 07/12/2026" })
      ).toBeVisible()
    );
    fireEvent.focus(title);
    fireEvent.keyDown(title, { key: "z", ctrlKey: true });
    expect(committedWorkspace.actions.undo).toHaveBeenCalledOnce();
  });

  it("replaces the selected title text from Add date without rewriting its neighbors", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue({
      title: "Plan replace next",
      note: "Context"
    });
    render(zoomedOutline(workspace));
    const title = editTextareaByName("Edit page title");
    title.setSelectionRange(5, 12);
    fireEvent.select(title);

    await user.click(
      screen.getByRole("button", {
        name: "More actions for Plan replace next"
      })
    );
    vi.mocked(workspace.actions.flushNodeDraft).mockClear();
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Add date"
      })
    );
    const picker = await screen.findByRole("dialog", { name: "Choose date" });
    await user.click(within(picker).getByRole("button", { name: "Tomorrow" }));
    await user.keyboard("{Enter}");

    expect(workspace.actions.updateNodeDraft).toHaveBeenCalledWith(
      "project",
      { title: "Plan 07/12/2026 next", note: "Context" },
      "title"
    );
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledOnce();
  });

  it.each([
    ["disabled", { deletingNotesData: true }],
    ["read-only", { libraryView: "archive" as const }]
  ])("keeps %s title and note date pills noninteractive", async (_label, mode) => {
    const user = userEvent.setup();
    const workspace = workspaceValue({
      ...mode,
      title: "Project 07/12/2026",
      note: "Page note 07/13/2026",
      childTitle: "Child 07/14/2026",
      childNote: "Child note 07/15/2026"
    });
    const { container } = render(zoomedOutline(workspace));

    expect(
      screen.queryByRole("button", { name: /^Edit date / })
    ).not.toBeInTheDocument();
    const pills = container.querySelectorAll(".notes-date-token");
    expect(pills.length).toBeGreaterThanOrEqual(2);
    await user.click(pills[0] as HTMLElement);
    expect(
      screen.queryByRole("dialog", { name: "Choose date" })
    ).not.toBeInTheDocument();
    expect(workspace.actions.updateNodeDraft).not.toHaveBeenCalled();
  });

  it("edits and removes one page-title pill without changing a tag or second date", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue({
      title: "🚀 #today today and 07/13/2026",
      note: "Context"
    });
    const rendered = render(zoomedOutline(workspace));

    expect(
      screen.getByRole("button", { name: "#today tag filter is inactive" })
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Edit date today" })
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Edit date 07/13/2026" })
    );
    await user.click(screen.getByRole("button", { name: "Remove date" }));

    expect(workspace.actions.updateNodeDraft).toHaveBeenCalledWith(
      "project",
      { title: "🚀 #today today and ", note: "Context" },
      "title"
    );
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledOnce();
    expect(getTextareaByName("Edit page title")).not.toHaveFocus();

    rendered.rerender(
      zoomedOutline(
        workspaceValue({
          draft: {
            title: "🚀 #today today and ",
            note: "Context",
            revision: 1,
            status: "pending"
          }
        })
      )
    );
    await waitFor(() =>
      expect(getTextareaByName("Edit page title")).toHaveFocus()
    );
  });

  it("formats a page supporting-note date range and leaves title text untouched", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue({
      title: "Plan #tag",
      note: "Window 07/12/2026 only"
    });
    const rendered = render(zoomedOutline(workspace));

    await user.click(
      screen.getByRole("button", { name: "Edit date 07/12/2026" })
    );
    const picker = screen.getByRole("dialog", { name: "Choose date" });
    await user.click(within(picker).getByRole("checkbox", { name: "Range" }));
    await user.click(
      within(picker).getByRole("button", {
        name: "Tuesday, July 14, 2026"
      })
    );
    await user.click(
      within(picker).getByRole("button", {
        name: "Thursday, July 16, 2026"
      })
    );
    await user.selectOptions(
      within(picker).getByRole("combobox", { name: "Format" }),
      "MM-DD-YY"
    );
    within(picker).getByRole("textbox", { name: "Date" }).focus();
    await user.keyboard("{Enter}");

    expect(workspace.actions.updateNodeDraft).toHaveBeenCalledWith(
      "project",
      { title: "Plan #tag", note: "Window 07-14-26 - 07-16-26 only" },
      "note"
    );
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledOnce();
    expect(
      getTextareaByName("Supporting note: Plan #tag")
    ).not.toHaveFocus();

    rendered.rerender(
      zoomedOutline(
        workspaceValue({
          draft: {
            title: "Plan #tag",
            note: "Window 07-14-26 - 07-16-26 only",
            revision: 1,
            status: "pending"
          }
        })
      )
    );
    await waitFor(() =>
      expect(getTextareaByName("Supporting note: Plan #tag")).toHaveFocus()
    );
  });

  it("supports independent date pills in outline title and supporting-note fields", async () => {
    const user = userEvent.setup();
    const workspace = renderZoomedOutline(
      workspaceValue({
        childTitle: "Child 07/14/2026",
        childNote: "Follow up tomorrow"
      })
    );

    expect(
      screen.getByRole("button", { name: "Edit date 07/14/2026" })
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Edit date tomorrow" })
    );
    await user.click(screen.getByRole("button", { name: "Remove date" }));

    expect(workspace.actions.updateNodeDraft).toHaveBeenCalledWith(
      "child",
      { title: "Child 07/14/2026", note: "Follow up " },
      "note"
    );
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith("child");
  });

  it("dismisses a pill picker with Escape and returns focus without writing", async () => {
    const user = userEvent.setup();
    const workspace = renderZoomedOutline(
      workspaceValue({ title: "Plan today", note: "Context" })
    );

    await user.click(screen.getByRole("button", { name: "Edit date today" }));
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Choose date" })
      ).not.toBeInTheDocument()
    );
    expect(workspace.actions.updateNodeDraft).not.toHaveBeenCalled();
    expect(workspace.actions.flushNodeDraft).not.toHaveBeenCalled();
    expect(getTextareaByName("Edit page title")).toHaveFocus();
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
