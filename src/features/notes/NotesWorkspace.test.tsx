import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import type {
  CreateNoteNodeInput,
  NoteId,
  NoteNode,
  NotesWorkspace,
  UpdateNoteNodeInput
} from "../../domain/notes";

const notesStoreMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  loadWorkspace: vi.fn(),
  createNode: vi.fn(),
  updateNode: vi.fn(),
  splitNode: vi.fn(),
  moveNode: vi.fn(),
  toggleComplete: vi.fn(),
  toggleCollapsed: vi.fn(),
  duplicateNode: vi.fn(),
  removeEmptyNode: vi.fn(),
  softDeleteNode: vi.fn(),
  restoreNode: vi.fn(),
  emptyTrash: vi.fn()
}));

vi.mock("../../services/notesStore", () => ({ notesStore: notesStoreMock }));

import { NotesFeatureProvider } from "./NotesFeature";
import { NotesLibraryPane } from "./NotesLibraryPane";
import { NotesOutlinePane } from "./NotesOutlinePane";

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
    parentId: null,
    sortKey: 1024,
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

function initialNodes(): NoteNode[] {
  return [
    node({
      id: "project",
      sortKey: 1,
      title: "Project",
      note: "Project note"
    }),
    node({
      id: "plan",
      parentId: "project",
      sortKey: 1,
      title: "Plan"
    }),
    node({
      id: "milestone",
      parentId: "plan",
      sortKey: 1,
      title: "Milestone"
    }),
    node({ id: "outside", sortKey: 2, title: "Outside branch" })
  ];
}

function workspace(nodes: NoteNode[]): NotesWorkspace {
  return { nodes: nodes.map((current) => ({ ...current })) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let confirmedNodes: NoteNode[];

function configureRepository(nodes: NoteNode[] = initialNodes()): void {
  confirmedNodes = nodes;
  for (const method of Object.values(notesStoreMock)) {
    method.mockReset();
  }

  notesStoreMock.initialize.mockResolvedValue(undefined);
  notesStoreMock.loadWorkspace.mockImplementation(async () =>
    workspace(confirmedNodes)
  );
  notesStoreMock.createNode.mockImplementation(
    async (_vaultRoot: string, input: CreateNoteNodeInput) => {
      confirmedNodes = [
        ...confirmedNodes,
        node({
          id: input.id,
          parentId: input.parentId,
          sortKey:
            Math.max(0, ...confirmedNodes.map((current) => current.sortKey)) +
            1,
          title: input.title,
          note: input.note
        })
      ];
      return workspace(confirmedNodes);
    }
  );
  notesStoreMock.updateNode.mockImplementation(
    async (_vaultRoot: string, input: UpdateNoteNodeInput) => {
      confirmedNodes = confirmedNodes.map((current) =>
        current.id === input.id
          ? { ...current, title: input.title, note: input.note }
          : current
      );
      return workspace(confirmedNodes);
    }
  );
  notesStoreMock.toggleCollapsed.mockImplementation(
    async (_vaultRoot: string, nodeId: NoteId) => {
      confirmedNodes = confirmedNodes.map((current) =>
        current.id === nodeId
          ? { ...current, isCollapsed: !current.isCollapsed }
          : current
      );
      return workspace(confirmedNodes);
    }
  );
  notesStoreMock.toggleComplete.mockImplementation(
    async (_vaultRoot: string, nodeId: NoteId) => {
      confirmedNodes = confirmedNodes.map((current) =>
        current.id === nodeId
          ? {
              ...current,
              completedAt:
                current.completedAt === null
                  ? "2026-07-10T01:00:00Z"
                  : null
            }
          : current
      );
      return workspace(confirmedNodes);
    }
  );
  notesStoreMock.duplicateNode.mockImplementation(
    async (_vaultRoot: string, nodeId: NoteId) => {
      const source = confirmedNodes.find((current) => current.id === nodeId);
      if (source) {
        confirmedNodes = [
          ...confirmedNodes,
          {
            ...source,
            id: `${source.id}-copy`,
            sortKey: source.sortKey + 0.5,
            title: `${source.title} copy`
          }
        ];
      }
      return workspace(confirmedNodes);
    }
  );
  notesStoreMock.removeEmptyNode.mockImplementation(async () =>
    workspace(confirmedNodes)
  );
  notesStoreMock.softDeleteNode.mockImplementation(
    async (_vaultRoot: string, nodeId: NoteId) => {
      confirmedNodes = confirmedNodes.filter((current) => current.id !== nodeId);
      return workspace(confirmedNodes);
    }
  );
  notesStoreMock.restoreNode.mockImplementation(async () =>
    workspace(confirmedNodes)
  );
  notesStoreMock.splitNode.mockImplementation(async () =>
    workspace(confirmedNodes)
  );
  notesStoreMock.moveNode.mockImplementation(async () =>
    workspace(confirmedNodes)
  );
  notesStoreMock.emptyTrash.mockImplementation(async () =>
    workspace(confirmedNodes)
  );
}

function renderNotesWorkspace() {
  return render(
    <StrictMode>
      <VaultRootContext.Provider value="/vault">
        <NotesFeatureProvider>
          <NotesLibraryPane />
          <NotesOutlinePane />
        </NotesFeatureProvider>
      </VaultRootContext.Provider>
    </StrictMode>
  );
}

describe("Notes workspace", () => {
  beforeEach(() => {
    configureRepository();
  });

  it("uses the vault root and mocked repository without a Tauri runtime", async () => {
    renderNotesWorkspace();

    expect(
      await screen.findByRole("textbox", { name: "Edit node title: Project" })
    ).toBeInTheDocument();
    expect(notesStoreMock.initialize).toHaveBeenCalledOnce();
    expect(notesStoreMock.initialize).toHaveBeenCalledWith("/vault");
    expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
      kind: "active"
    });
    expect("__TAURI_INTERNALS__" in window).toBe(false);
  });

  it("lists root pages only and zooms through the full breadcrumb trail", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();

    const library = screen.getByLabelText("Notes library");
    expect(await within(library).findByRole("button", { name: "Project" })).toBeInTheDocument();
    expect(within(library).getByRole("button", { name: "Outside branch" })).toBeInTheDocument();
    expect(within(library).queryByRole("button", { name: "Plan" })).not.toBeInTheDocument();

    await user.dblClick(
      screen.getByRole("textbox", { name: "Edit node title: Project" })
    );
    const breadcrumb = screen.getByLabelText("Notes breadcrumb");
    expect(within(breadcrumb).getByRole("button", { name: "Project" })).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", {
        name: "Edit node title: Outside branch"
      })
    ).not.toBeInTheDocument();

    await user.dblClick(
      screen.getByRole("textbox", { name: "Edit node title: Plan" })
    );
    expect(within(breadcrumb).getByRole("button", { name: "Project" })).toBeInTheDocument();
    expect(within(breadcrumb).getByRole("button", { name: "Plan" })).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Edit node title: Project" })
    ).not.toBeInTheDocument();
  });

  it("focuses a created title exactly once across row unmount and remount", async () => {
    const user = userEvent.setup();
    const focusSpy = vi.spyOn(HTMLInputElement.prototype, "focus");
    renderNotesWorkspace();
    await screen.findByRole("textbox", { name: "Edit node title: Project" });

    await user.click(screen.getByRole("button", { name: "New page" }));

    expect(notesStoreMock.createNode).toHaveBeenCalledWith(
      "/vault",
      expect.objectContaining({ parentId: null, title: "", note: "" })
    );
    expect(
      await screen.findByRole("textbox", { name: "Edit node title" })
    ).toHaveFocus();
    expect(focusSpy).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Project" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Edit node title" })
      ).not.toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: "All notes" }));

    expect(
      await screen.findByRole("textbox", { name: "Edit node title" })
    ).toBeInTheDocument();
    expect(focusSpy).toHaveBeenCalledOnce();
    expect(notesStoreMock.createNode).toHaveBeenCalledOnce();
  });

  it("marks the active library root as the current page", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();

    const library = screen.getByLabelText("Notes library");
    const project = await within(library).findByRole("button", {
      name: "Project"
    });

    await user.click(project);

    expect(project).toHaveAttribute("aria-current", "page");
  });

  it("exposes visible outline rows as list items with accurate levels", async () => {
    renderNotesWorkspace();

    const outline = screen.getByLabelText("Notes outline");
    await within(outline).findByRole("textbox", {
      name: "Edit node title: Project"
    });

    expect(within(outline).getByRole("list")).toBeInTheDocument();
    expect(
      within(outline)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-level"))
    ).toEqual(["1", "2", "3", "1"]);
  });

  it("composes the labelled breadcrumb home button with an icon tooltip", async () => {
    renderNotesWorkspace();
    await screen.findByRole("textbox", { name: "Edit node title: Project" });

    const home = screen.getByRole("button", { name: "All notes" });

    expect(home).toHaveAttribute("aria-label", "All notes");
    expect(home).toHaveAttribute("data-base-ui-tooltip-trigger");
  });

  it("caps indentation for deeply nested rows", async () => {
    configureRepository(
      Array.from({ length: 12 }, (_, index) =>
        node({
          id: `depth-${index + 1}`,
          parentId: index === 0 ? null : `depth-${index}`,
          sortKey: 1,
          title: `Depth ${index + 1}`
        })
      )
    );
    renderNotesWorkspace();

    const deepestTitle = await screen.findByRole("textbox", {
      name: "Edit node title: Depth 12"
    });
    const deepestRow = deepestTitle.closest<HTMLElement>(".notes-node");

    expect(deepestRow).not.toBeNull();
    expect(deepestRow?.style.getPropertyValue("--notes-indent")).toBe(
      "min(264px, 20%)"
    );
  });

  it("persists collapse and completion only after authoritative responses", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await screen.findByRole("textbox", { name: "Edit node title: Plan" });

    const collapse = screen.getByRole("button", { name: "Collapse Project" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    await user.click(collapse);

    expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledWith(
      "/vault",
      "project"
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Edit node title: Plan" })
      ).not.toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "Expand Project" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );

    await user.click(
      screen.getByRole("checkbox", { name: "Mark Project complete" })
    );
    expect(notesStoreMock.toggleComplete).toHaveBeenCalledWith(
      "/vault",
      "project"
    );
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "Mark Project incomplete" })
      ).toBeChecked()
    );
  });

  it("writes a title on blur with the current supporting note", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    const title = await screen.findByRole("textbox", {
      name: "Edit node title: Project"
    });

    await user.clear(title);
    await user.type(title, "Renamed project");
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
    fireEvent.blur(title);

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith("/vault", {
        id: "project",
        title: "Renamed project",
        note: "Project note"
      })
    );
  });

  it("toggles and writes a supporting note on blur with the current title", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await screen.findByRole("textbox", { name: "Edit node title: Project" });

    expect(
      screen.queryByRole("textbox", { name: "Supporting note: Project" })
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Show supporting note for Project" })
    );
    const note = screen.getByRole("textbox", {
      name: "Supporting note: Project"
    });
    expect(note).toHaveValue("Project note");

    await user.clear(note);
    await user.type(note, "Updated context");
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
    fireEvent.blur(note);

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith("/vault", {
        id: "project",
        title: "Project",
        note: "Updated context"
      })
    );
  });

  it("preserves newer title and note drafts when an older blur save resolves", async () => {
    const save = deferred<NotesWorkspace>();
    notesStoreMock.updateNode.mockReturnValueOnce(save.promise);
    const user = userEvent.setup();
    renderNotesWorkspace();
    const title = await screen.findByRole("textbox", {
      name: "Edit node title: Project"
    });
    await user.click(
      screen.getByRole("button", { name: "Show supporting note for Project" })
    );
    const note = screen.getByRole("textbox", {
      name: "Supporting note: Project"
    });

    fireEvent.change(title, { target: { value: "Submitted title" } });
    fireEvent.change(note, { target: { value: "Submitted note" } });
    fireEvent.blur(title);
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith("/vault", {
        id: "project",
        title: "Submitted title",
        note: "Submitted note"
      })
    );

    fireEvent.change(title, { target: { value: "Newer title" } });
    fireEvent.change(note, { target: { value: "Newer note" } });
    await act(async () =>
      save.resolve(
        workspace(
          initialNodes().map((current) =>
            current.id === "project"
              ? {
                  ...current,
                  title: "Submitted title",
                  note: "Submitted note"
                }
              : current
          )
        )
      )
    );

    await waitFor(() => {
      expect(title).toHaveValue("Newer title");
      expect(note).toHaveValue("Newer note");
    });
  });

  it("splits the selected title range and focuses the suffix only after success", async () => {
    configureRepository([
      node({ id: "source", sortKey: 1, title: "alphaXYZomega" })
    ]);
    const split = deferred<NotesWorkspace>();
    notesStoreMock.splitNode.mockReturnValue(split.promise);
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000001");
    renderNotesWorkspace();
    const title = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Edit node title: alphaXYZomega"
    });
    title.focus();
    title.setSelectionRange(5, 8);

    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);
    await waitFor(() => expect(notesStoreMock.splitNode).toHaveBeenCalledOnce());
    expect(notesStoreMock.splitNode).toHaveBeenCalledWith("/vault", {
      id: "source",
      newNodeId: "00000000-0000-4000-8000-000000000001",
      prefix: "alpha",
      suffix: "omega"
    });
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
    expect(title).toHaveFocus();

    await act(async () =>
      split.resolve(
        workspace([
          node({ id: "source", sortKey: 1, title: "alpha" }),
          node({
            id: "00000000-0000-4000-8000-000000000001",
            sortKey: 2,
            title: "omega"
          })
        ])
      )
    );

    expect(
      await screen.findByRole("textbox", { name: "Edit node title: omega" })
    ).toHaveFocus();
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
    randomUUID.mockRestore();
  });

  it("saves a dirty draft before Tab move and focuses after the move response", async () => {
    const before = [
      node({ id: "project", sortKey: 1, title: "Project" }),
      node({ id: "first", parentId: "project", sortKey: 1, title: "First" }),
      node({ id: "leaf", parentId: "first", sortKey: 1, title: "Leaf" }),
      node({ id: "second", parentId: "project", sortKey: 2, title: "Second" })
    ];
    configureRepository(before);
    const save = deferred<NotesWorkspace>();
    const move = deferred<NotesWorkspace>();
    const invocations: string[] = [];
    notesStoreMock.updateNode.mockImplementation(() => {
      invocations.push("update");
      return save.promise;
    });
    notesStoreMock.moveNode.mockImplementation(() => {
      invocations.push("move");
      return move.promise;
    });
    renderNotesWorkspace();
    const title = await screen.findByRole("textbox", {
      name: "Edit node title: Second"
    });
    fireEvent.change(title, { target: { value: "Second edited" } });
    title.focus();

    expect(fireEvent.keyDown(title, { key: "Tab" })).toBe(false);
    await waitFor(() => expect(notesStoreMock.updateNode).toHaveBeenCalledOnce());
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "New page" }).focus();
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();

    const saved = before.map((current) =>
      current.id === "second" ? { ...current, title: "Second edited" } : current
    );
    await act(async () => save.resolve(workspace(saved)));
    await waitFor(() => expect(notesStoreMock.moveNode).toHaveBeenCalledOnce());
    expect(invocations).toEqual(["update", "move"]);
    expect(notesStoreMock.moveNode).toHaveBeenCalledWith("/vault", {
      id: "second",
      parentId: "first",
      afterId: "leaf"
    });
    expect(screen.getByRole("button", { name: "New page" })).toHaveFocus();

    await act(async () =>
      move.resolve(
        workspace(
          saved.map((current) =>
            current.id === "second"
              ? { ...current, parentId: "first", sortKey: 2 }
              : current
          )
        )
      )
    );
    expect(
      await screen.findByRole("textbox", {
        name: "Edit node title: Second edited"
      })
    ).toHaveFocus();
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
  });

  it("saves before Shift+Tab outdent and does not duplicate the handled blur", async () => {
    renderNotesWorkspace();
    const title = await screen.findByRole("textbox", {
      name: "Edit node title: Milestone"
    });
    fireEvent.change(title, { target: { value: "Milestone edited" } });
    title.focus();

    expect(
      fireEvent.keyDown(title, { key: "Tab", shiftKey: true })
    ).toBe(false);
    await waitFor(() => expect(notesStoreMock.moveNode).toHaveBeenCalledOnce());
    expect(notesStoreMock.updateNode).toHaveBeenCalledWith("/vault", {
      id: "milestone",
      title: "Milestone edited",
      note: ""
    });
    expect(notesStoreMock.moveNode).toHaveBeenCalledWith("/vault", {
      id: "milestone",
      parentId: "project",
      afterId: "plan"
    });
    expect(
      notesStoreMock.updateNode.mock.invocationCallOrder[0]
    ).toBeLessThan(notesStoreMock.moveNode.mock.invocationCallOrder[0]);

    fireEvent.blur(title);
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
  });

  it("saves before moving focus through visible rows without a native focus command", async () => {
    const save = deferred<NotesWorkspace>();
    notesStoreMock.updateNode.mockReturnValue(save.promise);
    renderNotesWorkspace();
    const plan = await screen.findByRole("textbox", {
      name: "Edit node title: Plan"
    });
    fireEvent.change(plan, { target: { value: "Plan edited" } });
    plan.focus();

    expect(fireEvent.keyDown(plan, { key: "ArrowDown" })).toBe(false);
    expect(
      await screen.findByRole("textbox", {
        name: "Edit node title: Milestone"
      })
    ).toHaveFocus();
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();

    await act(async () =>
      save.resolve(
        workspace(
          initialNodes().map((current) =>
            current.id === "plan"
              ? { ...current, title: "Plan edited" }
              : current
          )
        )
      )
    );
    const milestone = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Edit node title: Milestone"
    });
    milestone.setSelectionRange(0, 0);
    expect(fireEvent.keyDown(milestone, { key: "ArrowUp" })).toBe(false);
    expect(
      await screen.findByRole("textbox", {
        name: "Edit node title: Plan edited"
      })
    ).toHaveFocus();
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
  });

  it("keeps horizontal caret movement native except at collapse boundaries", async () => {
    renderNotesWorkspace();
    const project = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Edit node title: Project"
    });
    project.focus();
    project.setSelectionRange(1, 1);
    expect(fireEvent.keyDown(project, { key: "ArrowLeft" })).toBe(true);
    expect(notesStoreMock.toggleCollapsed).not.toHaveBeenCalled();

    project.setSelectionRange(0, 0);
    expect(fireEvent.keyDown(project, { key: "ArrowLeft" })).toBe(false);
    await waitFor(() => expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Edit node title: Plan" })
      ).not.toBeInTheDocument()
    );

    project.setSelectionRange(project.value.length, project.value.length);
    expect(fireEvent.keyDown(project, { key: "ArrowRight" })).toBe(false);
    await waitFor(() => expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledTimes(2));
    const plan = await screen.findByRole("textbox", {
      name: "Edit node title: Plan"
    });

    project.setSelectionRange(project.value.length, project.value.length);
    expect(fireEvent.keyDown(project, { key: "ArrowRight" })).toBe(false);
    expect(plan).toHaveFocus();
  });

  it("persists an empty draft before removal and focuses only after success", async () => {
    const before = [
      node({ id: "first", sortKey: 1, title: "First" }),
      node({ id: "empty", sortKey: 2, title: "", note: "" }),
      node({ id: "last", sortKey: 3, title: "Last" })
    ];
    configureRepository(before);
    const save = deferred<NotesWorkspace>();
    const remove = deferred<NotesWorkspace>();
    notesStoreMock.updateNode.mockReturnValue(save.promise);
    notesStoreMock.removeEmptyNode.mockReturnValue(remove.promise);
    renderNotesWorkspace();
    const empty = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Edit node title"
    });
    empty.focus();
    empty.setSelectionRange(0, 0);

    expect(fireEvent.keyDown(empty, { key: "Backspace" })).toBe(false);
    await waitFor(() => expect(notesStoreMock.updateNode).toHaveBeenCalledOnce());
    expect(notesStoreMock.updateNode).toHaveBeenCalledWith("/vault", {
      id: "empty",
      title: "",
      note: ""
    });
    expect(notesStoreMock.removeEmptyNode).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "New page" }).focus();

    await act(async () => save.resolve(workspace(before)));
    await waitFor(() =>
      expect(notesStoreMock.removeEmptyNode).toHaveBeenCalledWith(
        "/vault",
        "empty"
      )
    );
    expect(screen.getByRole("button", { name: "New page" })).toHaveFocus();

    await act(async () =>
      remove.resolve(workspace(before.filter((current) => current.id !== "empty")))
    );
    expect(
      await screen.findByRole("textbox", { name: "Edit node title: First" })
    ).toHaveFocus();
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
  });

  it("keeps Backspace native when an empty title has a nonempty note", async () => {
    configureRepository([
      node({ id: "kept", title: "", note: "supporting context" })
    ]);
    renderNotesWorkspace();
    const title = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Edit node title"
    });
    title.focus();
    title.setSelectionRange(0, 0);

    expect(fireEvent.keyDown(title, { key: "Backspace" })).toBe(true);
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
    expect(notesStoreMock.removeEmptyNode).not.toHaveBeenCalled();
  });

  it("does not intercept composing, Process, or supporting-note keys", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    const title = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Edit node title: Project"
    });
    title.focus();
    title.setSelectionRange(0, 0);

    expect(
      fireEvent.keyDown(title, { key: "Enter", isComposing: true })
    ).toBe(true);
    expect(fireEvent.keyDown(title, { key: "Process" })).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Show supporting note for Project" })
    );
    const note = screen.getByRole("textbox", {
      name: "Supporting note: Project"
    });
    expect(fireEvent.keyDown(note, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(note, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(note, { key: "Backspace" })).toBe(true);

    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    expect(notesStoreMock.removeEmptyNode).not.toHaveBeenCalled();
  });

  it("exposes named duplicate and delete controls", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await screen.findByRole("textbox", { name: "Edit node title: Project" });

    await user.click(
      screen.getByRole("button", { name: "Duplicate Outside branch" })
    );
    expect(notesStoreMock.duplicateNode).toHaveBeenCalledWith(
      "/vault",
      "outside"
    );

    await user.click(
      screen.getByRole("button", { name: "Delete Outside branch" })
    );
    expect(notesStoreMock.softDeleteNode).toHaveBeenCalledWith(
      "/vault",
      "outside"
    );
  });

  it("renders loading, empty, and error states", async () => {
    configureRepository([]);
    notesStoreMock.loadWorkspace.mockRejectedValueOnce(new Error("Load failed"));
    renderNotesWorkspace();

    expect(screen.getAllByText("Loading notes...")).toHaveLength(2);
    expect(await screen.findAllByText("Load failed")).toHaveLength(2);
  });
});
