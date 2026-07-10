import {
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

  it("creates a root page and focuses its title once after render", async () => {
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
