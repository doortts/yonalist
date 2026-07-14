import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import type { NoteNode } from "../../domain/notes";

const notesStoreMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  loadWorkspace: vi.fn(),
  createNode: vi.fn(),
  updateNode: vi.fn(),
  splitNode: vi.fn(),
  moveNode: vi.fn(),
  applyBatch: vi.fn(),
  toggleComplete: vi.fn(),
  toggleCollapsed: vi.fn(),
  toggleStar: vi.fn(),
  duplicateNode: vi.fn(),
  removeEmptyNode: vi.fn(),
  softDeleteNode: vi.fn(),
  restoreNode: vi.fn(),
  archiveNode: vi.fn(),
  unarchiveNode: vi.fn(),
  importAttachmentPaths: vi.fn(),
  readAttachmentBytes: vi.fn(),
  resizeAttachment: vi.fn(),
  removeAttachment: vi.fn(),
  emptyTrash: vi.fn(),
  search: vi.fn(),
  searchStructured: vi.fn(),
  listTags: vi.fn(),
  listTagsWithCounts: vi.fn(),
  deleteDatabase: vi.fn()
}));

vi.mock("../../services/notesStore", () => ({ notesStore: notesStoreMock }));

import { NotesFeatureProvider } from "./NotesFeature";
import { NotesLibraryPane } from "./NotesLibraryPane";
import { NotesOutlinePane } from "./NotesOutlinePane";

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
    nodeKind: "text",
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
    archivedAt: null,
    archiveRootId: null,
    ...overrides
  };
}

function initialNodes(): NoteNode[] {
  return [
    node({ id: "project", sortKey: 1, title: "Project" }),
    node({ id: "plan", parentId: "project", sortKey: 1, title: "Plan" }),
    node({
      id: "milestone",
      parentId: "plan",
      sortKey: 1,
      title: "Milestone"
    })
  ];
}

function workspaceOf(nodes: NoteNode[]) {
  return { nodes: nodes.map((current) => ({ ...current })), attachmentsByNodeId: {} };
}

function configureRepository(nodes: NoteNode[] = initialNodes()): void {
  for (const method of Object.values(notesStoreMock)) {
    method.mockReset();
  }
  notesStoreMock.initialize.mockResolvedValue(undefined);
  notesStoreMock.loadWorkspace.mockResolvedValue(workspaceOf(nodes));
  notesStoreMock.search.mockResolvedValue([]);
  notesStoreMock.searchStructured.mockResolvedValue([]);
  notesStoreMock.listTags.mockResolvedValue([]);
  notesStoreMock.listTagsWithCounts.mockResolvedValue([]);
  notesStoreMock.emptyTrash.mockResolvedValue(workspaceOf(nodes));
  notesStoreMock.deleteDatabase.mockResolvedValue({
    attachmentCleanupFailed: false
  });
}

function renderNotesWorkspace({ active = true } = {}) {
  // Mirrors App.tsx's `feature-pane-slot` wrapper: Notes' panes stay mounted
  // (keepMounted) while another feature is active, and App marks the inactive
  // slot `hidden` so it drops out of the a11y tree while React keeps the
  // subtree alive.
  return render(
    <VaultRootContext.Provider value="/vault">
      <NotesFeatureProvider>
        <div hidden={!active}>
          <NotesLibraryPane />
        </div>
        <div hidden={!active}>
          <NotesOutlinePane />
        </div>
      </NotesFeatureProvider>
    </VaultRootContext.Provider>
  );
}

async function findTitleInput(value: string) {
  return waitFor(() => {
    const input = Array.from(
      document.querySelectorAll<HTMLTextAreaElement>(
        'textarea[aria-label="Edit node title"]'
      )
    ).find((candidate) => candidate.value === value);
    if (!input) {
      throw new Error(`Unable to find a node title input with value ${value}`);
    }
    return input;
  });
}

describe("Notes quick-jump wiring (Cmd/Ctrl+K)", () => {
  beforeEach(() => {
    configureRepository();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the palette on Cmd+K while Notes is mounted and active", async () => {
    renderNotesWorkspace();
    await findTitleInput("Project");

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(
      await screen.findByRole("dialog", { name: "Jump to note" })
    ).toBeInTheDocument();
  });

  it("also opens on Ctrl+K", async () => {
    renderNotesWorkspace();
    await findTitleInput("Project");

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(
      await screen.findByRole("dialog", { name: "Jump to note" })
    ).toBeInTheDocument();
  });

  it("does not open when the Notes pane sits under a hidden ancestor (a different feature is active)", async () => {
    renderNotesWorkspace({ active: false });
    await findTitleInput("Project");

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ignores an IME-composition keydown so it does not steal the shortcut from the input method", async () => {
    renderNotesWorkspace();
    await findTitleInput("Project");

    fireEvent.keyDown(window, { key: "k", metaKey: true, isComposing: true });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("searches via the existing FTS action and zooms into the selected result on Enter", async () => {
    notesStoreMock.search.mockResolvedValue([
      { nodeId: "milestone", title: "Milestone", parentTrail: ["Project", "Plan"], matchedField: "title" }
    ]);
    renderNotesWorkspace();
    await findTitleInput("Project");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = await screen.findByRole("combobox", { name: "Jump to note" });
    fireEvent.change(input, { target: { value: "milestone" } });

    await waitFor(() =>
      expect(notesStoreMock.search).toHaveBeenCalledWith("/vault", "milestone")
    );
    await screen.findByRole("option", { name: "Milestone, in Project / Plan" });

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(
      await screen.findByRole("heading", { name: "Milestone", level: 1 })
    ).toBeVisible();
  });
});
