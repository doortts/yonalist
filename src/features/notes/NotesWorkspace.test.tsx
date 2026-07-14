import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import type {
  ApplyNotesBatchInput,
  CreateNoteNodeInput,
  NoteAttachment,
  NoteAttachmentsByNodeId,
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
import type { NotesAttachmentUiBoundary } from "./notesAttachmentController";
import { NotesLibraryPane } from "./NotesLibraryPane";
import { NotesOutlinePane } from "./NotesOutlinePane";

const notesStyles = readFileSync(
  join(process.cwd(), "src/features/notes/notes.css"),
  "utf8"
);
const appStyles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

function mockNarrowViewport(narrow: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(max-width: 720px)" ? narrow : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    }))
  );
}

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
    archivedAt: null,
    archiveRootId: null,
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

let confirmedAttachmentsByNodeId: NoteAttachmentsByNodeId = {};

function workspace(
  nodes: NoteNode[],
  attachmentsByNodeId: NoteAttachmentsByNodeId = confirmedAttachmentsByNodeId
): NotesWorkspace {
  return {
    nodes: nodes.map((current) => ({ ...current })),
    attachmentsByNodeId: Object.fromEntries(
      Object.entries(attachmentsByNodeId).map(([nodeId, attachments]) => [
        nodeId,
        attachments.map((attachment) => ({ ...attachment }))
      ])
    )
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
    originalName: `${overrides.id}.png`,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let confirmedNodes: NoteNode[];

function configureRepository(
  nodes: NoteNode[] = initialNodes(),
  attachmentsByNodeId: NoteAttachmentsByNodeId = {}
): void {
  confirmedNodes = nodes;
  confirmedAttachmentsByNodeId = attachmentsByNodeId;
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
  notesStoreMock.toggleStar.mockImplementation(
    async (_vaultRoot: string, nodeId: NoteId) => {
      confirmedNodes = confirmedNodes.map((current) =>
        current.id === nodeId
          ? { ...current, isStarred: !current.isStarred }
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
  notesStoreMock.archiveNode.mockImplementation(async () =>
    workspace(confirmedNodes)
  );
  notesStoreMock.unarchiveNode.mockImplementation(async () =>
    workspace(confirmedNodes)
  );
  notesStoreMock.importAttachmentPaths.mockImplementation(async () =>
    workspace(confirmedNodes)
  );
  notesStoreMock.readAttachmentBytes.mockRejectedValue(
    new Error("Attachment bytes are unavailable")
  );
  notesStoreMock.resizeAttachment.mockImplementation(async () =>
    workspace(confirmedNodes)
  );
  notesStoreMock.removeAttachment.mockImplementation(async () =>
    workspace(confirmedNodes)
  );
  notesStoreMock.splitNode.mockImplementation(async () =>
    workspace(confirmedNodes)
  );
  notesStoreMock.moveNode.mockImplementation(async () =>
    workspace(confirmedNodes)
  );
  notesStoreMock.applyBatch.mockImplementation(
    async (_vaultRoot: string, input: ApplyNotesBatchInput) => {
      const ids = new Set(input.nodeIds);
      if (input.op === "complete") {
        confirmedNodes = confirmedNodes.map((current) =>
          ids.has(current.id)
            ? {
                ...current,
                completedAt: input.completed ? "2026-07-10T01:00:00Z" : null
              }
            : current
        );
      } else if (input.op === "delete") {
        confirmedNodes = confirmedNodes.filter(
          (current) => !ids.has(current.id)
        );
      }
      // indent/outdent/move batch semantics are covered by the keyboard
      // resolution tests; the integration harness only needs completion and
      // deletion to reflect in the rendered tree.
      return workspace(confirmedNodes);
    }
  );
  notesStoreMock.emptyTrash.mockImplementation(async () =>
    workspace(confirmedNodes)
  );
  notesStoreMock.search.mockResolvedValue([]);
  notesStoreMock.searchStructured.mockResolvedValue([]);
  notesStoreMock.listTags.mockResolvedValue([]);
  notesStoreMock.listTagsWithCounts.mockResolvedValue([]);
  notesStoreMock.deleteDatabase.mockResolvedValue({
    attachmentCleanupFailed: false
  });
}

function renderNotesWorkspace(attachmentUi?: NotesAttachmentUiBoundary) {
  return render(
    <StrictMode>
      <VaultRootContext.Provider value="/vault">
        <NotesFeatureProvider attachmentUi={attachmentUi}>
          <NotesLibraryPane />
          <NotesOutlinePane />
        </NotesFeatureProvider>
      </VaultRootContext.Provider>
    </StrictMode>
  );
}

function queryTitleInput(value: string): HTMLTextAreaElement | null {
  return (
    Array.from(
      document.querySelectorAll<HTMLTextAreaElement>(
        'textarea[aria-label="Edit node title"]'
      )
    ).find(
      (input) => input.value === value || input.value.trim() === value.trim()
    ) ?? null
  );
}

function getTitleInput(value: string): HTMLTextAreaElement {
  const input = queryTitleInput(value);
  if (!input) {
    throw new Error(`Unable to find a node title input with value ${value}`);
  }
  fireEvent.focus(input);
  return input;
}

async function findTitleInput(value: string): Promise<HTMLTextAreaElement> {
  return waitFor(() => getTitleInput(value));
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
  fireEvent.focus(textarea);
  return textarea;
}

async function findTextareaByName(name: string): Promise<HTMLTextAreaElement> {
  return waitFor(() => getTextareaByName(name));
}

async function openNodeMenu(label: string, user = userEvent.setup()) {
  await user.click(
    await screen.findByRole("button", { name: `More actions for ${label}` })
  );
  return screen.findByRole("menu");
}

function mockOutlineRowRects() {
  const rectangle = (top: number, left = 0, width = 640, height = 28) =>
    ({
      x: left,
      y: top,
      top,
      left,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({})
    }) as DOMRect;

  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const row = this.closest<HTMLElement>(".notes-node");
      if (!row) {
        return rectangle(0);
      }
      const rows = Array.from(document.querySelectorAll(".notes-node"));
      return rectangle(rows.indexOf(row) * 28);
    });
}

function mockNotesContentWidth(width: number, viewportWidth = 900): void {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(viewportWidth);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const measuredWidth = this.classList.contains("notes-outline-content")
        ? width
        : 0;
      return {
        x: 0,
        y: 0,
        top: 0,
        right: measuredWidth,
        bottom: 0,
        left: 0,
        width: measuredWidth,
        height: 0,
        toJSON: () => ({})
      } as DOMRect;
    }
  );
}

describe("Notes workspace", () => {
  beforeEach(() => {
    mockNarrowViewport(false);
    configureRepository();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-theme");
  });

  it("uses the vault root and mocked repository without a Tauri runtime", async () => {
    renderNotesWorkspace();

    expect(await findTitleInput("Project")).toBeInTheDocument();
    expect(notesStoreMock.initialize).toHaveBeenCalledOnce();
    expect(notesStoreMock.initialize).toHaveBeenCalledWith("/vault");
    expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
      kind: "active"
    });
    expect("__TAURI_INTERNALS__" in window).toBe(false);
  });

  it("places the caret at the clicked title position without opting in supporting notes", async () => {
    configureRepository([
      node({
        id: "alpha",
        title: "Alpha 😀 omega",
        note: "Supporting detail"
      })
    ]);
    renderNotesWorkspace();

    const originalCaretPositionFromPoint = Object.getOwnPropertyDescriptor(
      document,
      "caretPositionFromPoint"
    );
    try {
      const presentation = await screen.findByRole("group", {
        name: "Edit node title"
      });
      const textNode = presentation.firstChild!;
      document.caretPositionFromPoint = vi.fn(() => ({
        offsetNode: textNode,
        offset: 8,
        getClientRect: vi.fn()
      } as CaretPosition));

      fireEvent.pointerDown(presentation, { clientX: 80, clientY: 20 });

      const title = screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Edit node title"
      });
      expect(title).toHaveFocus();
      expect(title.selectionStart).toBe(8);
      expect(title.selectionEnd).toBe(8);

      const notePresentation = screen.getByRole("group", {
        name: "Supporting note: Alpha 😀 omega"
      });
      const note = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Supporting note: Alpha 😀 omega"]'
      )!;
      const setNoteSelection = vi.spyOn(note, "setSelectionRange");

      fireEvent.pointerDown(notePresentation, { clientX: 80, clientY: 20 });

      expect(note).toHaveFocus();
      expect(setNoteSelection).not.toHaveBeenCalled();
      expect(document.caretPositionFromPoint).toHaveBeenCalledOnce();
    } finally {
      if (originalCaretPositionFromPoint) {
        Object.defineProperty(
          document,
          "caretPositionFromPoint",
          originalCaretPositionFromPoint
        );
      } else {
        delete (document as unknown as {
          caretPositionFromPoint?: Document["caretPositionFromPoint"];
        }).caretPositionFromPoint;
      }
    }
  });

  it("renders ordered node images beneath the supporting note and loads bytes lazily", async () => {
    const user = userEvent.setup();
    const root = node({
      id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306",
      title: "Project",
      note: "Supporting detail"
    });
    const first = attachment({
      id: "1c17ba74-a617-45e7-9e21-74068b63befe",
      nodeId: root.id,
      sortKey: 100,
      originalName: "first.png"
    });
    const second = attachment({
      id: "8f257d31-d255-4fc8-89dc-4e3b30f24a6e",
      nodeId: root.id,
      sortKey: 200,
      originalName: "second.png"
    });
    configureRepository([root], { [root.id]: [first, second] });
    notesStoreMock.readAttachmentBytes.mockResolvedValue(
      new Uint8Array([137, 80, 78, 71])
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => `blob:${blob.type}`)
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });

    renderNotesWorkspace();

    const groups = await screen.findAllByRole("group", { name: /^Image:/ });
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Image: first.png",
      "Image: second.png"
    ]);
    const supportingNote = await waitFor(() =>
      getTextareaByName("Supporting note: Project")
    );
    expect(
      supportingNote.compareDocumentPosition(groups[0]) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(notesStoreMock.readAttachmentBytes).not.toHaveBeenCalled();
    for (const group of groups) {
      await user.click(
        within(group).getByRole("button", { name: /^Load image / })
      );
    }
    await waitFor(() =>
      expect(notesStoreMock.readAttachmentBytes).toHaveBeenCalledTimes(4)
    );
    expect(
      notesStoreMock.readAttachmentBytes.mock.calls.map((call) => call[1])
    ).toEqual([first.id, first.id, second.id, second.id]);
  });

  it("uploads a menu-selected image through the injected picker and publishes it after import", async () => {
    const user = userEvent.setup();
    const root = node({
      id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306",
      title: "Project"
    });
    const imported = attachment({
      id: "1c17ba74-a617-45e7-9e21-74068b63befe",
      nodeId: root.id,
      originalName: "diagram.png"
    });
    configureRepository([root]);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      imported.id as ReturnType<typeof globalThis.crypto.randomUUID>
    );
    const attachmentUi = {
      openImageFiles: vi.fn().mockResolvedValue(["/incoming/diagram.png"]),
      subscribeToImageDrop: vi.fn().mockResolvedValue(vi.fn())
    };
    mockNotesContentWidth(700, 480);
    notesStoreMock.importAttachmentPaths.mockImplementation(
      async (_vaultRoot, input) => {
        expect(input.attachments[0]?.id).toBe(imported.id);
        confirmedAttachmentsByNodeId = { [root.id]: [imported] };
        return workspace(confirmedNodes);
      }
    );
    notesStoreMock.readAttachmentBytes.mockResolvedValue(
      new Uint8Array([137, 80, 78, 71])
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:diagram")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });
    renderNotesWorkspace(attachmentUi);

    const menu = await openNodeMenu("Project", user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Upload image" })
    );

    await waitFor(() => expect(attachmentUi.openImageFiles).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(notesStoreMock.importAttachmentPaths).toHaveBeenCalledOnce()
    );
    expect(notesStoreMock.importAttachmentPaths).toHaveBeenCalledWith(
      "/vault",
      {
        nodeId: root.id,
        attachments: [
          { id: imported.id, sourcePath: "/incoming/diagram.png" }
        ],
        initialMaxDisplayWidth: 480
      }
    );
    expect(
      await screen.findByRole("group", { name: "Image: diagram.png" })
    ).toBeVisible();
  });

  it("treats image picker cancellation as a no-op", async () => {
    const user = userEvent.setup();
    configureRepository([node({ id: "project", title: "Project" })]);
    const attachmentUi = {
      openImageFiles: vi.fn().mockResolvedValue(null),
      subscribeToImageDrop: vi.fn().mockResolvedValue(vi.fn())
    };
    renderNotesWorkspace(attachmentUi);

    const menu = await openNodeMenu("Project", user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Upload image" })
    );

    await waitFor(() => expect(attachmentUi.openImageFiles).toHaveBeenCalledOnce());
    expect(notesStoreMock.importAttachmentPaths).not.toHaveBeenCalled();
    expect(screen.queryByText(/image upload failed/i)).toBeNull();
  });

  it("shows a retryable import error without a phantom image and clears it after retry", async () => {
    const user = userEvent.setup();
    const root = node({
      id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306",
      title: "Project"
    });
    const imported = attachment({
      id: "1c17ba74-a617-45e7-9e21-74068b63befe",
      nodeId: root.id,
      originalName: "diagram.png"
    });
    configureRepository([root]);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      imported.id as ReturnType<typeof globalThis.crypto.randomUUID>
    );
    const attachmentUi = {
      openImageFiles: vi.fn().mockResolvedValue(["/incoming/diagram.png"]),
      subscribeToImageDrop: vi.fn().mockResolvedValue(vi.fn())
    };
    mockNotesContentWidth(480);
    notesStoreMock.importAttachmentPaths
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementation(async () => {
        confirmedAttachmentsByNodeId = { [root.id]: [imported] };
        return workspace(confirmedNodes);
      });
    notesStoreMock.readAttachmentBytes.mockResolvedValue(
      new Uint8Array([137, 80, 78, 71])
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:diagram")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });
    renderNotesWorkspace(attachmentUi);

    const menu = await openNodeMenu("Project", user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Upload image" })
    );

    const alert = await screen.findByRole("alert", {
      name: "Image upload failed"
    });
    expect(alert).toHaveTextContent("disk full");
    expect(screen.queryByRole("group", { name: "Image: diagram.png" })).toBeNull();

    await user.click(
      within(alert).getByRole("button", { name: "Retry image upload" })
    );

    expect(
      await screen.findByRole("group", { name: "Image: diagram.png" })
    ).toBeVisible();
    expect(attachmentUi.openImageFiles).toHaveBeenCalledOnce();
    expect(notesStoreMock.importAttachmentPaths).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("alert", { name: "Image upload failed" })
    ).toBeNull();
  });

  it("requires accessible confirmation before removing an image", async () => {
    const user = userEvent.setup();
    const root = node({
      id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306",
      title: "Project"
    });
    const image = attachment({
      id: "1c17ba74-a617-45e7-9e21-74068b63befe",
      nodeId: root.id,
      originalName: "diagram.png"
    });
    configureRepository([root], { [root.id]: [image] });
    notesStoreMock.removeAttachment.mockImplementation(async () => {
      confirmedAttachmentsByNodeId = { [root.id]: [] };
      return workspace(confirmedNodes);
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    renderNotesWorkspace();

    await user.click(
      await screen.findByRole("button", { name: "Load image diagram.png" })
    );
    const remove = await screen.findByRole("button", {
      name: "Remove diagram.png"
    });
    await user.click(remove);
    let dialog = await screen.findByRole("alertdialog", {
      name: "Remove image?"
    });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(notesStoreMock.removeAttachment).not.toHaveBeenCalled();
    expect(
      screen.getByRole("group", { name: "Image: diagram.png" })
    ).toBeVisible();

    await user.click(remove);
    dialog = await screen.findByRole("alertdialog", { name: "Remove image?" });
    await user.click(
      within(dialog).getByRole("button", { name: "Remove image" })
    );

    await waitFor(() =>
      expect(notesStoreMock.removeAttachment).toHaveBeenCalledWith(
        "/vault",
        image.id
      )
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "Image: diagram.png" })
      ).toBeNull()
    );
  });

  it.each(["Archive", "Trash"])(
    "renders images read-only in %s without attachment mutation commands",
    async (view) => {
      const user = userEvent.setup();
      const root = node({
        id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306",
        title: "Project",
        archivedAt:
          view === "Archive" ? "2026-07-12T00:00:00Z" : null,
        deletedAt: view === "Trash" ? "2026-07-12T00:00:00Z" : null
      });
      const image = attachment({
        id: "1c17ba74-a617-45e7-9e21-74068b63befe",
        nodeId: root.id,
        originalName: "diagram.png"
      });
      configureRepository([root], { [root.id]: [image] });
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        }
      );
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: vi.fn(() => "blob:diagram")
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: vi.fn()
      });
      renderNotesWorkspace();

      await user.click(await screen.findByRole("button", { name: view }));

      expect(
        await screen.findByRole("group", { name: "Image: diagram.png" })
      ).toBeVisible();
      expect(
        screen.queryByRole("separator", { name: "Resize diagram.png" })
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Remove diagram.png" })
      ).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Upload image" })).toBeNull();

      const row = document.querySelector<HTMLElement>(
        `[data-outline-id="${root.id}"]`
      );
      expect(row).not.toHaveAttribute("data-notes-attachment-target");
      expect(notesStoreMock.importAttachmentPaths).not.toHaveBeenCalled();
      expect(notesStoreMock.resizeAttachment).not.toHaveBeenCalled();
      expect(notesStoreMock.removeAttachment).not.toHaveBeenCalled();
    }
  );

  it("keeps native row and page textareas mounted behind interactive resting tags", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({
        id: "project",
        sortKey: 1,
        title: "Project #today",
        note: "Owned by @Alice"
      }),
      node({ id: "child", parentId: "project", title: "Child" })
    ]);
    const { container } = renderNotesWorkspace();

    const rowTag = await screen.findByRole("button", {
      name: "#today tag filter is inactive"
    });
    const row = rowTag.closest(".notes-node");
    const rowTitle = row?.querySelector("textarea.notes-node-title");
    const rowNote = row?.querySelector("textarea.notes-node-note");

    expect(rowTitle).toHaveValue("Project #today");
    expect(rowNote).toHaveValue("Owned by @Alice");
    expect(
      within(row as HTMLElement).getByRole("button", {
        name: "@Alice tag filter is inactive"
      })
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Zoom into Project #today" }));

    const pageHeader = container.querySelector(".notes-page-header");
    expect(pageHeader?.querySelector("textarea.notes-page-title")).toHaveValue(
      "Project #today"
    );
    expect(pageHeader?.querySelector("textarea.notes-page-note")).toHaveValue(
      "Owned by @Alice"
    );
    expect(
      within(pageHeader as HTMLElement).getByRole("button", {
        name: "#today tag filter is inactive"
      })
    ).toBeVisible();
    expect(
      within(pageHeader as HTMLElement).getByRole("button", {
        name: "@Alice tag filter is inactive"
      })
    ).toBeVisible();
  });

  it("renders separate arrow and bullet controls with the bullet as sortable activator", async () => {
    renderNotesWorkspace();

    const title = await findTitleInput("Project");
    expect(title.closest("li")).toHaveAttribute("aria-level", "1");
    expect(getTitleInput("Plan").closest("li")).toHaveAttribute(
      "aria-level",
      "2"
    );

    const projectBullet = screen.getByRole("button", {
      name: "Zoom into Project"
    });
    expect(projectBullet).toBeVisible();
    expect(projectBullet).toHaveClass("notes-node-bullet");
    expect(projectBullet).toHaveAttribute(
      "aria-roledescription",
      "sortable note"
    );
    expect(projectBullet).toHaveAttribute("aria-describedby");
    expect(
      screen.getByRole("button", { name: "Collapse Project" })
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "More actions for Project" })
    ).toBeVisible();
    expect(
      screen.queryByRole("checkbox", { name: /complete/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Move Project" })
    ).not.toBeInTheDocument();

    const projectRow = projectBullet.closest(".notes-node-main");
    expect(
      Array.from(projectRow?.children ?? []).map((element) =>
        element.classList.contains("notes-node-menu-slot")
          ? "menu"
          : element.classList.contains("notes-node-arrow-slot")
            ? "arrow"
            : element.classList.contains("notes-node-bullet")
              ? "bullet"
              : element.classList.contains("notes-node-title-field")
                ? "content"
                : "other"
      )
    ).toEqual(["menu", "arrow", "bullet", "content"]);

    const leafRow = getTitleInput("Outside branch").closest(".notes-node-main");
    expect(
      leafRow?.querySelector(".notes-node-arrow-slot")
    ).toBeEmptyDOMElement();
  });

  it("snapshots leaf, expanded, collapsed, and completed collapsed bullet states", async () => {
    configureRepository([
      node({ id: "leaf", sortKey: 1, title: "Leaf" }),
      node({ id: "expanded", sortKey: 2, title: "Expanded" }),
      node({ id: "expanded-child", parentId: "expanded", title: "Expanded child" }),
      node({ id: "collapsed", sortKey: 3, title: "Collapsed", isCollapsed: true }),
      node({ id: "collapsed-child", parentId: "collapsed", title: "Collapsed child" }),
      node({
        id: "completed-collapsed",
        sortKey: 4,
        title: "Completed collapsed",
        isCollapsed: true,
        completedAt: "2026-07-10T01:00:00Z"
      }),
      node({
        id: "completed-child",
        parentId: "completed-collapsed",
        title: "Completed child"
      })
    ]);
    renderNotesWorkspace();
    await findTitleInput("Leaf");

    const states = ["Leaf", "Expanded", "Collapsed", "Completed collapsed"].map(
      (title) => {
        const row = getTitleInput(title).closest<HTMLElement>(".notes-node")!;
        const main = row.querySelector(".notes-node-main")!;
        const bullet = within(row).getByRole("button", {
          name: `Zoom into ${title}`
        });
        return {
          title,
          completed: row.dataset.completed ?? "false",
          collapsed: bullet.dataset.collapsed ?? "false",
          controls: Array.from(main.children).map((element) =>
            element.className
          )
        };
      }
    );

    expect(states).toMatchInlineSnapshot(`
      [
        {
          "collapsed": "false",
          "completed": "false",
          "controls": [
            "notes-node-menu-slot",
            "notes-node-arrow-slot",
            "notes-node-bullet",
            "notes-text-field notes-node-title-field",
          ],
          "title": "Leaf",
        },
        {
          "collapsed": "false",
          "completed": "false",
          "controls": [
            "notes-node-menu-slot",
            "notes-node-arrow-slot",
            "notes-node-bullet",
            "notes-text-field notes-node-title-field",
          ],
          "title": "Expanded",
        },
        {
          "collapsed": "true",
          "completed": "false",
          "controls": [
            "notes-node-menu-slot",
            "notes-node-arrow-slot",
            "notes-node-bullet",
            "notes-text-field notes-node-title-field",
          ],
          "title": "Collapsed",
        },
        {
          "collapsed": "true",
          "completed": "true",
          "controls": [
            "notes-node-menu-slot",
            "notes-node-arrow-slot",
            "notes-node-bullet",
            "notes-text-field notes-node-title-field",
          ],
          "title": "Completed collapsed",
        },
      ]
    `);
  });

  it("retains an accent focus ring on collapsed bullet halos", async () => {
    configureRepository([
      node({ id: "collapsed", title: "Collapsed", isCollapsed: true }),
      node({ id: "collapsed-child", parentId: "collapsed", title: "Child" }),
      node({
        id: "completed-collapsed",
        sortKey: 2,
        title: "Completed collapsed",
        isCollapsed: true,
        completedAt: "2026-07-10T01:00:00Z"
      }),
      node({
        id: "completed-child",
        parentId: "completed-collapsed",
        title: "Completed child"
      })
    ]);
    renderNotesWorkspace();
    await findTitleInput("Collapsed");

    for (const label of ["Collapsed", "Completed collapsed"]) {
      const bullet = screen.getByRole("button", { name: `Zoom into ${label}` });
      expect(bullet).toHaveAttribute("data-collapsed", "true");
      bullet.focus();
      expect(bullet).toHaveFocus();
    }
    expect(notesStyles).toMatch(
      /\.notes-node-bullet\[data-collapsed="true"\]:focus-visible::before,[\s\S]*\.notes-node\[data-completed="true"\][\s\S]*\.notes-node-bullet\[data-collapsed="true"\]:focus-visible::before\s*{[^}]*box-shadow:\s*0 0 0 2px var\(--accent\),\s*inset 0 0 0 1px var\(--border-strong\);/s
    );
  });

  it("keeps title and supporting-note input outside drag activation", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();

    const title = await findTitleInput("Project");
    const projectBullet = screen.getByRole("button", {
      name: "Zoom into Project"
    });

    projectBullet.focus();
    expect(projectBullet).toHaveFocus();
    await user.click(title);
    await user.keyboard(" [ArrowLeft][ArrowRight]");
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();

    const supportingNote = getTextareaByName("Supporting note: Project");
    await user.click(supportingNote);
    await user.keyboard(" [ArrowUp][ArrowDown]");
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
  });

  it("uses the arrow only for collapse and the bullet only for zoom", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();

    await findTitleInput("Project");
    const collapse = screen.getByRole("button", { name: "Collapse Project" });
    const bullet = screen.getByRole("button", { name: "Zoom into Project" });

    await user.click(collapse);

    expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledWith(
      "/vault",
      "project"
    );
    expect(screen.getByRole("button", { name: "All notes" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(getTitleInput("Outside branch")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Zoom into Project" })
      ).toHaveAttribute("data-collapsed", "true")
    );

    await user.click(bullet);

    expect(
      within(screen.getByLabelText("Notes breadcrumb")).getByRole("button", {
        name: "Project"
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Project", level: 1 })
    ).toBeVisible();
    const zoomedPlan = getTitleInput("Plan");
    const zoomedMilestone = getTitleInput("Milestone");
    expect(zoomedPlan.closest("li")).toHaveAttribute("aria-level", "1");
    expect(zoomedPlan.closest(".notes-node")).toHaveAttribute(
      "data-guide-end-id",
      "milestone"
    );
    expect(
      zoomedMilestone.closest(".notes-node")?.querySelectorAll(
        ".notes-node-guide"
      )
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Zoom into Plan" })
    ).toHaveAttribute("data-sortable-activator", "true");
    expect(queryTitleInput("Outside branch")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All notes" }));
    const restoredTitle = await findTitleInput("Project");
    expect(queryTitleInput("Plan")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand Project" })
    ).toHaveAttribute("aria-expanded", "false");
    expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledOnce();
    await user.dblClick(restoredTitle);

    expect(screen.getByRole("button", { name: "All notes" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(getTitleInput("Outside branch")).toBeInTheDocument();
  });

  it("keeps completion reachable by keyboard and touch-style pointer input", async () => {
    const user = userEvent.setup();
    configureRepository([node({ id: "project", title: "Project" })]);
    renderNotesWorkspace();

    const title = await findTitleInput("Project");
    const bullet = screen.getByRole("button", { name: "Zoom into Project" });

    bullet.focus();
    await user.tab({ shift: true });
    expect(
      screen.getByRole("button", { name: "More actions for Project" })
    ).toHaveFocus();
    await user.keyboard("[Enter]");
    const keyboardMenu = await screen.findByRole("menu");
    expect(
      within(keyboardMenu).getByRole("menuitem", { name: "Complete" })
    ).toHaveFocus();
    await user.keyboard("[Enter]");

    expect(notesStoreMock.toggleComplete).toHaveBeenCalledWith(
      "/vault",
      "project"
    );
    const pointerMenu = await openNodeMenu("Project", user);
    const uncomplete = within(pointerMenu).getByRole("menuitem", {
      name: "Uncomplete"
    });

    fireEvent.pointerDown(title, { pointerType: "touch" });
    title.focus();
    expect(title.closest<HTMLElement>(".notes-node-main")).toContainElement(
      document.activeElement as HTMLElement | null
    );
    fireEvent.pointerDown(uncomplete, { pointerType: "touch" });
    fireEvent.click(uncomplete);

    await waitFor(() =>
      expect(notesStoreMock.toggleComplete).toHaveBeenCalledTimes(2)
    );
  });

  it("suspends bullet drag activation while queued workspace work is loading", async () => {
    const user = userEvent.setup();
    const completion = deferred<NotesWorkspace>();
    notesStoreMock.toggleComplete.mockReturnValue(completion.promise);
    renderNotesWorkspace();
    const projectBullet = await screen.findByRole("button", {
      name: "Zoom into Project"
    });
    expect(projectBullet).toHaveAttribute("aria-describedby");

    const menu = await openNodeMenu("Project", user);
    await user.click(within(menu).getByRole("menuitem", { name: "Complete" }));
    await waitFor(() =>
      expect(notesStoreMock.toggleComplete).toHaveBeenCalledOnce()
    );
    for (const bullet of screen.getAllByRole("button", { name: /^Zoom into / })) {
      expect(bullet).toBeEnabled();
      expect(bullet).not.toHaveAttribute("aria-describedby");
    }

    completion.resolve(workspace(confirmedNodes));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Zoom into Project" })
      ).toHaveAttribute("aria-describedby")
    );
  });

  it("announces an invalid self drop without queuing a move", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "first", sortKey: 1, title: "First" }),
      node({ id: "second", sortKey: 2, title: "Second" })
    ]);
    renderNotesWorkspace();
    const bullet = await screen.findByRole("button", {
      name: "Zoom into Second"
    });
    mockOutlineRowRects();

    bullet.focus();
    await user.keyboard("[Space][Space]");

    await waitFor(() =>
      expect(document.body).toHaveTextContent("No move was made for Second.")
    );
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
  });

  it("moves before the first row by keyboard through one queued action without optimistic order", async () => {
    const user = userEvent.setup();
    const move = deferred<NotesWorkspace>();
    configureRepository([
      node({ id: "first", sortKey: 1, title: "First" }),
      node({ id: "second", sortKey: 2, title: "Second" })
    ]);
    notesStoreMock.moveNode.mockReturnValue(move.promise);
    renderNotesWorkspace();
    const bullet = await screen.findByRole("button", {
      name: "Zoom into Second"
    });
    mockOutlineRowRects();

    bullet.focus();
    await user.keyboard("[Space][ArrowUp][Space]");

    await waitFor(() => expect(notesStoreMock.moveNode).toHaveBeenCalledOnce());
    expect(notesStoreMock.moveNode).toHaveBeenCalledWith("/vault", {
      id: "second",
      parentId: null,
      afterId: null,
      beforeId: "first"
    });
    expect(
      textareasByName("Edit node title")
        .map((input) => input.value)
    ).toEqual(["First", "Second"]);

    move.resolve(
      workspace([
        node({ id: "first", sortKey: 2, title: "First" }),
        node({ id: "second", sortKey: 1, title: "Second" })
      ])
    );
    await waitFor(() =>
      expect(
        textareasByName("Edit node title")
          .map((input) => input.value)
      ).toEqual(["Second", "First"])
    );
  });

  it("expands a collapsed drop parent before one pointer-driven child move", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "active", sortKey: 1, title: "Active" }),
      node({ id: "parent", sortKey: 2, title: "Parent", isCollapsed: true }),
      node({ id: "hidden", parentId: "parent", title: "Hidden" })
    ]);
    renderNotesWorkspace();
    const activeBullet = await screen.findByRole("button", {
      name: "Zoom into Active"
    });
    const parentBullet = screen.getByRole("button", {
      name: "Zoom into Parent"
    });
    mockOutlineRowRects();

    await user.pointer({
      keys: "[MouseLeft>]",
      target: activeBullet,
      coords: { clientX: 9, clientY: 14 }
    });
    await user.pointer({
      target: parentBullet,
      coords: { clientX: 14, clientY: 20 }
    });
    expect(activeBullet.closest(".notes-node")).toHaveAttribute(
      "data-dragging",
      "true"
    );
    await user.pointer({
      target: parentBullet,
      coords: { clientX: 36, clientY: 42 }
    });
    expect(document.body).toHaveTextContent("Active is over Parent.");
    const previews = document.querySelectorAll(
      ".notes-outline-drop-preview"
    );
    const movedBeforeDrop = notesStoreMock.moveNode.mock.calls.length > 0;
    await user.pointer({
      keys: "[/MouseLeft]",
      target: parentBullet,
      coords: { clientX: 36, clientY: 42 }
    });

    expect(previews).toHaveLength(1);
    expect(previews[0]).toHaveAttribute("aria-hidden", "true");
    expect(previews[0]).toHaveAttribute("data-parent-id", "parent");
    expect(previews[0]).toHaveAttribute("data-depth", "1");
    expect(
      (previews[0] as HTMLElement).style.getPropertyValue(
        "--notes-drop-depth"
      )
    ).toBe("1");
    expect(movedBeforeDrop).toBe(false);

    await waitFor(() => expect(notesStoreMock.moveNode).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(document.body).toHaveTextContent(
        "Queued move for Active at Parent."
      )
    );
    expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledWith(
      "/vault",
      "parent"
    );
    expect(notesStoreMock.moveNode).toHaveBeenCalledWith("/vault", {
      id: "active",
      parentId: "parent",
      afterId: "hidden"
    });
    expect(
      notesStoreMock.toggleCollapsed.mock.invocationCallOrder[0]
    ).toBeLessThan(notesStoreMock.moveNode.mock.invocationCallOrder[0]);
    expect(screen.getByRole("button", { name: "All notes" })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("lists root pages only and zooms through the full breadcrumb trail", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();

    const library = screen.getByLabelText("Notes library");
    expect(await within(library).findByRole("button", { name: "Project" })).toBeInTheDocument();
    expect(within(library).getByRole("button", { name: "Outside branch" })).toBeInTheDocument();
    expect(within(library).queryByRole("button", { name: "Plan" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Zoom into Project" }));
    const breadcrumb = screen.getByLabelText("Notes breadcrumb");
    expect(within(breadcrumb).getByRole("button", { name: "Project" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Project", level: 1 })
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Zoom into Project" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Zoom into Plan" })
    ).toBeVisible();
    expect(getTitleInput("Plan").closest("li")).toHaveAttribute(
      "aria-level",
      "1"
    );
    const projectNote = getTextareaByName("Supporting note: Project");
    expect(projectNote).toHaveValue("Project note");
    expect(projectNote.closest(".notes-page-header")).not.toBeNull();
    expect(projectNote.closest("ol")).toBeNull();
    expect(
      queryTitleInput("Outside branch")
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Zoom into Plan" }));
    expect(within(breadcrumb).getByRole("button", { name: "Project" })).toBeInTheDocument();
    expect(within(breadcrumb).getByRole("button", { name: "Plan" })).toBeInTheDocument();
    expect(
      queryTitleInput("Project")
    ).not.toBeInTheDocument();
  });

  it("focuses a created title exactly once across row unmount and remount", async () => {
    const user = userEvent.setup();
    const focusSpy = vi.spyOn(HTMLTextAreaElement.prototype, "focus");
    renderNotesWorkspace();
    await findTitleInput("Project");

    await user.click(screen.getByRole("button", { name: "New page" }));

    expect(notesStoreMock.createNode).toHaveBeenCalledWith(
      "/vault",
      expect.objectContaining({ parentId: null, title: "", note: "" })
    );
    expect(
      await findTitleInput("")
    ).toHaveFocus();
    expect(focusSpy).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Project" }));
    await waitFor(() =>
      expect(
        queryTitleInput("")
      ).not.toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: "All notes" }));

    expect(
      await findTitleInput("")
    ).toBeInTheDocument();
    expect(focusSpy).toHaveBeenCalledOnce();
    expect(notesStoreMock.createNode).toHaveBeenCalledOnce();
  });

  it("unzooms an All view before focusing a newly created root page", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");

    await user.click(screen.getByRole("button", { name: "Zoom into Project" }));
    expect(
      screen.getByRole("heading", { name: "Project", level: 1 })
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "New page" }));

    expect(await findTitleInput("")).toHaveFocus();
    expect(
      screen.queryByRole("heading", { name: "Project", level: 1 })
    ).not.toBeInTheDocument();
  });

  it("returns to unzoomed All so a page created from zoomed Starred stays visible and focused", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "starred", title: "Starred page", isStarred: true }),
      node({ id: "outside", title: "Outside page" })
    ]);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) =>
        workspace(
          scope.kind === "starred"
            ? confirmedNodes.filter((current) => current.isStarred)
            : confirmedNodes
        )
    );
    renderNotesWorkspace();
    await findTitleInput("Starred page");

    await user.click(screen.getByRole("button", { name: "Starred" }));
    await waitFor(() => expect(queryTitleInput("Outside page")).toBeNull());
    await user.click(
      screen.getByRole("button", { name: "Zoom into Starred page" })
    );
    expect(
      screen.getByRole("heading", { name: "Starred page", level: 1 })
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "New page" }));

    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(await findTitleInput("")).toHaveFocus();
    expect(
      screen.queryByRole("heading", { name: "Starred page", level: 1 })
    ).not.toBeInTheDocument();
    expect(queryTitleInput("Outside page")).toBeInTheDocument();
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
    await findTitleInput("Project");

    expect(within(outline).getByRole("list")).toHaveAttribute("role", "list");
    expect(
      within(outline)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-level"))
    ).toEqual(["1", "2", "3", "1"]);
    for (const item of within(outline).getAllByRole("listitem")) {
      expect(item).toHaveAttribute("role", "listitem");
    }

    const projectRow = getTitleInput("Project").closest<HTMLElement>(
      ".notes-node"
    );
    const planRow = getTitleInput("Plan").closest<HTMLElement>(".notes-node");
    const milestoneRow = getTitleInput("Milestone").closest<HTMLElement>(
      ".notes-node"
    );
    const outsideRow = getTitleInput("Outside branch").closest<HTMLElement>(
      ".notes-node"
    );

    expect(projectRow).toHaveAttribute("data-guide-end-id", "milestone");
    expect(planRow).toHaveAttribute("data-guide-end-id", "milestone");
    expect(milestoneRow).not.toHaveAttribute("data-guide-end-id");
    expect(outsideRow).not.toHaveAttribute("data-guide-end-id");
    expect(projectRow?.querySelectorAll(".notes-node-guide")).toHaveLength(0);
    expect(planRow?.querySelectorAll(".notes-node-guide")).toHaveLength(1);
    expect(milestoneRow?.querySelectorAll(".notes-node-guide")).toHaveLength(2);
    for (const guide of outline.querySelectorAll(".notes-node-guide")) {
      expect(guide).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("composes the labelled breadcrumb home button with an icon tooltip", async () => {
    renderNotesWorkspace();
    await findTitleInput("Project");

    const home = screen.getByRole("button", { name: "All notes" });

    expect(home).toHaveAttribute("aria-label", "All notes");
    expect(home).toHaveAttribute("data-base-ui-tooltip-trigger");
  });

  it("shares one centered content column between the page header and outline", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");

    await user.click(screen.getByRole("button", { name: "Project" }));

    const heading = await screen.findByRole("heading", {
      name: "Project",
      level: 1
    });
    const content = heading.closest<HTMLElement>(".notes-outline-content");

    expect(content).not.toBeNull();
    expect(within(content!).getByRole("list")).toBeInTheDocument();
  });

  it("uses uncapped depth-based indentation from the outline root", async () => {
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

    const deepestTitle = await findTitleInput("Depth 12");
    const deepestRow = deepestTitle.closest<HTMLElement>(".notes-node");

    expect(deepestRow).not.toBeNull();
    expect(deepestRow?.style.getPropertyValue("--notes-depth")).toBe("11");
    expect(deepestRow?.style.getPropertyValue("--notes-indent")).toBe("");
    expect(
      screen.getByLabelText("Notes outline").style.getPropertyValue(
        "--notes-outline-indent"
      )
    ).toBe("36px");
  });

  it("uses the 28px runtime indent token at narrow widths", async () => {
    mockNarrowViewport(true);
    renderNotesWorkspace();

    await findTitleInput("Project");

    expect(
      screen.getByLabelText("Notes outline").style.getPropertyValue(
        "--notes-outline-indent"
      )
    ).toBe("28px");
  });

  it("persists collapse and completion only after authoritative responses", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Plan");

    const collapse = screen.getByRole("button", { name: "Collapse Project" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    await user.click(collapse);

    expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledWith(
      "/vault",
      "project"
    );
    await waitFor(() =>
      expect(
        queryTitleInput("Plan")
      ).not.toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "Expand Project" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(
      screen.getByRole("button", { name: "Zoom into Project" })
    ).toHaveAttribute("data-collapsed", "true");

    const menu = await openNodeMenu("Project", user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Complete" })
    );
    expect(notesStoreMock.toggleComplete).toHaveBeenCalledWith(
      "/vault",
      "project"
    );
    await waitFor(() => expect(notesStoreMock.toggleComplete).toHaveBeenCalledOnce());
    const updatedMenu = await openNodeMenu("Project", user);
    expect(
      within(updatedMenu).getByRole("menuitem", { name: "Uncomplete" })
    ).toBeVisible();
  });

  it("hides completed node subtrees only in the visible projection", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({
        id: "done",
        sortKey: 1,
        title: "Completed project",
        completedAt: "2026-07-10T01:00:00Z"
      }),
      node({ id: "done-child", parentId: "done", title: "Hidden child" }),
      node({ id: "active", sortKey: 2, title: "Active project" })
    ]);
    renderNotesWorkspace();
    await findTitleInput("Completed project");

    const toggle = screen.getByRole("button", { name: "Completed items" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);

    expect(queryTitleInput("Completed project")).toBeNull();
    expect(queryTitleInput("Hidden child")).toBeNull();
    expect(getTitleInput("Active project")).toBeVisible();
    expect(notesStoreMock.toggleComplete).not.toHaveBeenCalled();
    expect(toggle).toHaveAccessibleName("Completed items");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);
    expect(await findTitleInput("Completed project")).toBeVisible();
    expect(getTitleInput("Hidden child")).toBeVisible();
  });

  it("explains when all root rows are hidden and the toggle restores them", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({
        id: "done",
        title: "Completed project",
        completedAt: "2026-07-10T01:00:00Z"
      }),
      node({ id: "done-child", parentId: "done", title: "Hidden child" })
    ]);
    renderNotesWorkspace();
    await findTitleInput("Completed project");
    const toggle = screen.getByRole("button", { name: "Completed items" });

    await user.click(toggle);

    expect(screen.getByText("Completed items are hidden.")).toBeVisible();
    expect(screen.queryByText("No outline yet.")).toBeNull();
    expect(queryTitleInput("Completed project")).toBeNull();

    await user.click(toggle);

    expect(await findTitleInput("Completed project")).toBeVisible();
    expect(screen.queryByText("Completed items are hidden.")).toBeNull();
  });

  it("keeps a completed zoom root header and its commands when rows are hidden", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({
        id: "done",
        title: "Completed project",
        completedAt: "2026-07-10T01:00:00Z"
      }),
      node({ id: "done-child", parentId: "done", title: "Hidden child" })
    ]);
    renderNotesWorkspace();
    await findTitleInput("Completed project");
    await user.click(
      screen.getByRole("button", { name: "Zoom into Completed project" })
    );

    const toggle = screen.getByRole("button", { name: "Completed items" });
    await user.click(toggle);

    expect(
      screen.getByRole("heading", { name: "Completed project", level: 1 })
    ).toBeVisible();
    expect(queryTitleInput("Hidden child")).toBeNull();
    expect(screen.getByText("Completed items are hidden.")).toBeVisible();
    const menu = await openNodeMenu("Completed project", user);
    expect(
      within(menu).getByRole("menuitem", { name: "Uncomplete" })
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(toggle);
    expect(await findTitleInput("Hidden child")).toBeVisible();
    expect(screen.queryByText("Completed items are hidden.")).toBeNull();
  });

  it("writes a title on blur with the current supporting note", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    const title = await findTitleInput("Project");
    expect(title).toHaveAccessibleName("Edit node title");

    await user.clear(title);
    await user.type(title, "Renamed project");
    expect(title).toHaveAccessibleName("Edit node title");
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

  it("coalesces rapid title edits into one write after 300 ms", async () => {
    renderNotesWorkspace();
    const title = await findTitleInput("Project");
    vi.useFakeTimers();

    fireEvent.change(title, { target: { value: "Project one" } });
    fireEvent.change(title, { target: { value: "Project latest" } });

    await vi.advanceTimersByTimeAsync(299);
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));

    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
    expect(notesStoreMock.updateNode).toHaveBeenCalledWith("/vault", {
      id: "project",
      title: "Project latest",
      note: "Project note"
    });
  });

  it("flushes a title on blur without a later duplicate timer write", async () => {
    renderNotesWorkspace();
    const title = await findTitleInput("Project");
    vi.useFakeTimers();

    fireEvent.change(title, { target: { value: "Blurred project" } });
    fireEvent.blur(title);

    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
  });

  it("keeps a failed title draft visible and retries the failed patch", async () => {
    const user = userEvent.setup();
    notesStoreMock.updateNode
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(
        workspace(
          initialNodes().map((current) =>
            current.id === "project"
              ? { ...current, title: "Project next" }
              : current
          )
        )
      );
    renderNotesWorkspace();
    const title = await findTitleInput("Project");

    fireEvent.change(title, { target: { value: "Project next" } });
    fireEvent.blur(title);

    const failedMenu = await openNodeMenu("Project next", user);
    expect(title).toHaveValue("Project next");
    await user.click(
      within(failedMenu).getByRole("menuitem", { name: "Retry save" })
    );

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(2)
    );
    expect(notesStoreMock.updateNode).toHaveBeenNthCalledWith(2, "/vault", {
      id: "project",
      title: "Project next",
      note: "Project note"
    });
    const savedMenu = await openNodeMenu("Project next", user);
    expect(
      within(savedMenu).queryByRole("menuitem", { name: "Retry save" })
    ).toBeNull();
  });

  it("retries the latest visible draft instead of a stale failed patch", async () => {
    const user = userEvent.setup();
    notesStoreMock.updateNode
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(
        workspace(
          initialNodes().map((current) =>
            current.id === "project"
              ? { ...current, title: "Newest visible title" }
              : current
          )
        )
      );
    renderNotesWorkspace();
    const title = await findTitleInput("Project");

    fireEvent.change(title, { target: { value: "Failed title" } });
    fireEvent.blur(title);
    const failedMenu = await openNodeMenu("Failed title", user);
    const retry = within(failedMenu).getByRole("menuitem", {
      name: "Retry save"
    });
    title.focus();
    fireEvent.change(title, { target: { value: "Newest visible title" } });
    fireEvent.click(retry);

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(2)
    );
    expect(notesStoreMock.updateNode).toHaveBeenNthCalledWith(2, "/vault", {
      id: "project",
      title: "Newest visible title",
      note: "Project note"
    });
    expect(title).toHaveValue("Newest visible title");
    await waitFor(() => expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(2));
  });

  it("renders and retries a failed unmount draft after a same-vault remount", async () => {
    const user = userEvent.setup();
    notesStoreMock.updateNode.mockRejectedValueOnce(new Error("disk full"));
    const firstMount = renderNotesWorkspace();
    const firstTitle = await findTitleInput("Project");

    fireEvent.change(firstTitle, { target: { value: "Recovered project" } });
    firstMount.unmount();
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();

    renderNotesWorkspace();
    const recoveredTitle = await findTitleInput("Recovered project");
    expect(recoveredTitle).toHaveValue("Recovered project");

    const failedMenu = await openNodeMenu("Recovered project", user);
    await user.click(
      within(failedMenu).getByRole("menuitem", { name: "Retry save" })
    );

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(2)
    );
    expect(notesStoreMock.updateNode).toHaveBeenNthCalledWith(2, "/vault", {
      id: "project",
      title: "Recovered project",
      note: "Project note"
    });
    const savedMenu = await openNodeMenu("Recovered project", user);
    expect(
      within(savedMenu).queryByRole("menuitem", { name: "Retry save" })
    ).toBeNull();
  });

  it("retries only the failed draft belonging to the clicked row", async () => {
    const user = userEvent.setup();
    notesStoreMock.updateNode
      .mockRejectedValueOnce(new Error("project failed"))
      .mockRejectedValueOnce(new Error("outside failed"));
    renderNotesWorkspace();
    const projectTitle = await findTitleInput("Project");
    const outsideTitle = getTitleInput("Outside branch");

    fireEvent.change(projectTitle, {
      target: { value: "Failed project draft" }
    });
    fireEvent.blur(projectTitle);
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(1)
    );

    fireEvent.change(outsideTitle, {
      target: { value: "Failed outside draft" }
    });
    fireEvent.blur(outsideTitle);
    const projectMenu = await openNodeMenu("Failed project draft", user);
    await user.click(
      within(projectMenu).getByRole("menuitem", { name: "Retry save" })
    );

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(3)
    );
    expect(notesStoreMock.updateNode).toHaveBeenNthCalledWith(3, "/vault", {
      id: "project",
      title: "Failed project draft",
      note: "Project note"
    });
    const savedProjectMenu = await openNodeMenu("Failed project draft", user);
    expect(
      within(savedProjectMenu).queryByRole("menuitem", { name: "Retry save" })
    ).toBeNull();
    await user.keyboard("{Escape}");
    const outsideMenu = await openNodeMenu("Failed outside draft", user);
    expect(
      within(outsideMenu).getByRole("menuitem", { name: "Retry save" })
    ).toBeVisible();
    expect(outsideTitle).toHaveValue("Failed outside draft");
  });

  it("shows and writes a nonempty supporting note on blur with the current title", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");

    const note = getTextareaByName("Supporting note: Project");
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

  it("removes a row supporting note through the draft queue without deleting its node", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");
    const trigger = screen.getByRole("button", {
      name: "More actions for Project"
    });

    const menu = await openNodeMenu("Project", user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Remove note" })
    );

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() =>
      expect(
        queryTextareaByName("Supporting note: Project")
      ).not.toBeInTheDocument()
    );
    expect(trigger).toHaveFocus();
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith("/vault", {
        id: "project",
        title: "Project",
        note: ""
      })
    );
    expect(getTitleInput("Project")).toBeInTheDocument();
    expect(notesStoreMock.softDeleteNode).not.toHaveBeenCalled();
  });

  it("keeps an empty supporting note hidden until the bullet menu opens it", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Outside branch");

    expect(
      queryTextareaByName("Supporting note: Outside branch")
    ).not.toBeInTheDocument();

    const menu = await openNodeMenu("Outside branch", user);
    const trigger = screen.getByRole("button", {
      name: "More actions for Outside branch"
    });
    await user.click(
      within(menu).getByRole("menuitem", { name: "Add note" })
    );

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() =>
      expect(
        getTextareaByName("Supporting note: Outside branch")
      ).toHaveFocus()
    );
    expect(trigger).not.toHaveFocus();
  });

  it("reflows a revealed long row note when its observed width narrows", async () => {
    const user = userEvent.setup();
    const callbacksByTarget = new Map<Element, ResizeObserverCallback>();
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    let noteScrollHeight = 40;
    const scrollHeight = vi
      .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLTextAreaElement) {
        return this.classList.contains("notes-node-note")
          ? noteScrollHeight
          : 28;
      });
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
        disconnect = disconnect;
      }
    );
    configureRepository([node({ id: "project", title: "Project" })]);
    const view = renderNotesWorkspace();
    await findTitleInput("Project");

    const menu = await openNodeMenu("Project", user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Add note" })
    );
    const note = await findTextareaByName("Supporting note: Project");
    const longNote =
      "긴 한국어 보조 메모도 데스크톱에서 모바일 너비로 줄어들면 모든 문장이 잘리지 않고 다시 줄바꿈되어야 합니다";
    fireEvent.change(note, { target: { value: longNote } });

    expect(note).toHaveFocus();
    expect(note).toHaveStyle({ height: "40px" });
    expect(observe).toHaveBeenCalledWith(note);

    const callback = callbacksByTarget.get(note);
    act(() =>
      callback?.(
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
      callback?.(
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

    const measuredCalls = scrollHeight.mock.calls.length;
    act(() =>
      callback?.(
        [
          {
            target: note,
            contentRect: { width: 280 }
          } as unknown as ResizeObserverEntry
        ],
        {} as ResizeObserver
      )
    );
    expect(scrollHeight).toHaveBeenCalledTimes(measuredCalls);

    view.unmount();
    expect(unobserve).toHaveBeenCalledWith(note);
    expect(disconnect).toHaveBeenCalled();
  });

  it("debounces supporting-note edits with the latest title patch", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");
    const note = getTextareaByName("Supporting note: Project");
    vi.useFakeTimers();

    fireEvent.change(note, { target: { value: "First note" } });
    fireEvent.change(note, { target: { value: "Latest note" } });
    await act(async () => vi.advanceTimersByTimeAsync(300));

    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
    expect(notesStoreMock.updateNode).toHaveBeenCalledWith("/vault", {
      id: "project",
      title: "Project",
      note: "Latest note"
    });
  });

  it("preserves newer title and note drafts when an older blur save resolves", async () => {
    const save = deferred<NotesWorkspace>();
    notesStoreMock.updateNode.mockReturnValueOnce(save.promise);
    const user = userEvent.setup();
    renderNotesWorkspace();
    const title = await findTitleInput("Project");
    const note = getTextareaByName("Supporting note: Project");

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
    const title = await findTitleInput("alphaXYZomega");
    title.focus();
    title.setSelectionRange(5, 8);

    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);
    expect(randomUUID).toHaveBeenCalledOnce();
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
      await findTitleInput("omega")
    ).toHaveFocus();
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
    expect(notesStoreMock.splitNode).toHaveBeenCalledOnce();
    randomUUID.mockRestore();
  });

  it("keeps a dirty title blur-saveable when split UUID generation fails", async () => {
    configureRepository([
      node({ id: "source", sortKey: 1, title: "alphaomega" })
    ]);
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockImplementation(() => {
        throw new Error("uuid failed");
      });
    renderNotesWorkspace();
    const title = await findTitleInput("alphaomega");
    fireEvent.change(title, { target: { value: "alpha omega" } });
    title.focus();
    title.setSelectionRange(5, 5);

    expect(() => fireEvent.keyDown(title, { key: "Enter" })).not.toThrow();
    fireEvent.blur(title);

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith("/vault", {
        id: "source",
        title: "alpha omega",
        note: ""
      })
    );
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();
    randomUUID.mockRestore();
  });

  it("saves dirty title and note drafts before splitting and adopts the prefix", async () => {
    configureRepository([
      node({
        id: "source",
        sortKey: 1,
        title: "alphaXYZomega",
        note: "old note"
      })
    ]);
    const save = deferred<NotesWorkspace>();
    notesStoreMock.updateNode.mockReturnValue(save.promise);
    notesStoreMock.splitNode.mockResolvedValue(
      workspace([
        node({
          id: "source",
          sortKey: 1,
          title: "alpha",
          note: "draft note"
        }),
        node({
          id: "00000000-0000-4000-8000-000000000002",
          sortKey: 2,
          title: "omega!"
        })
      ])
    );
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000002");
    renderNotesWorkspace();
    const title = await findTitleInput("alphaXYZomega");
    const note = getTextareaByName("Supporting note: alphaXYZomega");
    fireEvent.change(title, { target: { value: "alphaXYZomega!" } });
    fireEvent.change(note, { target: { value: "draft note" } });
    title.focus();
    title.setSelectionRange(5, 8);

    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);
    await waitFor(() => expect(notesStoreMock.updateNode).toHaveBeenCalledOnce());
    expect(notesStoreMock.updateNode).toHaveBeenCalledWith("/vault", {
      id: "source",
      title: "alphaXYZomega!",
      note: "draft note"
    });
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();

    await act(async () =>
      save.resolve(
        workspace([
          node({
            id: "source",
            sortKey: 1,
            title: "alphaXYZomega!",
            note: "draft note"
          })
        ])
      )
    );
    await waitFor(() => expect(notesStoreMock.splitNode).toHaveBeenCalledOnce());
    expect(notesStoreMock.splitNode).toHaveBeenCalledWith("/vault", {
      id: "source",
      newNodeId: "00000000-0000-4000-8000-000000000002",
      prefix: "alpha",
      suffix: "omega!"
    });

    expect(
      await findTitleInput("alpha")
    ).toHaveValue("alpha");
    expect(
      getTitleInput("omega!")
    ).toHaveFocus();
    randomUUID.mockRestore();
  });

  it("keeps a failed split prerequisite dirty and retries it before splitting", async () => {
    configureRepository([
      node({ id: "source", sortKey: 1, title: "alphaXYZomega" })
    ]);
    const retrySave = deferred<NotesWorkspace>();
    notesStoreMock.updateNode
      .mockRejectedValueOnce(new Error("save failed"))
      .mockReturnValueOnce(retrySave.promise);
    notesStoreMock.splitNode.mockResolvedValue(
      workspace([
        node({ id: "source", title: "alpha", sortKey: 1 }),
        node({
          id: "00000000-0000-4000-8000-000000000003",
          title: "omega!",
          sortKey: 2
        })
      ])
    );
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000003");
    renderNotesWorkspace();
    const title = await findTitleInput("alphaXYZomega");
    fireEvent.change(title, { target: { value: "alphaXYZomega!" } });
    title.focus();
    title.setSelectionRange(5, 8);

    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);
    await waitFor(() => expect(notesStoreMock.updateNode).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getAllByText("save failed")).toHaveLength(2)
    );
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();

    title.setSelectionRange(5, 8);
    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(2)
    );
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();

    await act(async () =>
      retrySave.resolve(
        workspace([
          node({ id: "source", title: "alphaXYZomega!", sortKey: 1 })
        ])
      )
    );
    await waitFor(() => expect(notesStoreMock.splitNode).toHaveBeenCalledOnce());
    randomUUID.mockRestore();
  });

  it("restores focus and surfaces a notice when a skipped split drops Enter", async () => {
    configureRepository([
      node({ id: "source", sortKey: 1, title: "alphaXYZomega" })
    ]);
    // Every draft flush fails, so the split's draft-flush barrier drops the
    // structural command: the coordinator settles it as "skipped".
    notesStoreMock.updateNode.mockRejectedValue(new Error("save failed"));
    renderNotesWorkspace();
    const title = await findTitleInput("alphaXYZomega");
    fireEvent.change(title, { target: { value: "alphaXYZomega!" } });
    title.focus();
    title.setSelectionRange(5, 8);

    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledOnce()
    );
    // The split never reached the backend...
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();
    // ...and instead of Enter vanishing silently the row explains the pause...
    await screen.findByText(/Command paused/i);
    // ...and hands focus back to the title so the caret is not stranded.
    await waitFor(() => expect(title).toHaveFocus());
  });

  describe("multi-node batch operations (Phase 4.1c)", () => {
    function threeRoots(): NoteNode[] {
      return [
        node({ id: "a", sortKey: 1, title: "Alpha" }),
        node({ id: "b", sortKey: 2, title: "Bravo" }),
        node({ id: "c", sortKey: 3, title: "Charlie" })
      ];
    }

    function useCtrlPlatform(): void {
      vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
    }

    it("completes a keyboard-selected range with a single applyBatch call", async () => {
      useCtrlPlatform();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      title.focus();
      // Shift+ArrowDown twice extends the live selection across all three
      // siblings without moving the caret off Alpha.
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce()
      );
      // History is not wired in this harness, so no history-context arg trails
      // the call (parity with the single-node commands here).
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith("/vault", {
        op: "complete",
        nodeIds: ["a", "b", "c"],
        completed: true
      });
      // The whole-selection path fully replaces the single-node command.
      expect(notesStoreMock.toggleComplete).not.toHaveBeenCalled();
    });

    it("soft-deletes a keyboard-selected range as one batch", async () => {
      useCtrlPlatform();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      title.focus();
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      fireEvent.keyDown(title, {
        key: "Backspace",
        ctrlKey: true,
        shiftKey: true
      });

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce()
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith("/vault", {
        op: "delete",
        nodeIds: ["a", "b"]
      });
      // The surviving neighbor takes focus.
      await waitFor(() => expect(getTitleInput("Charlie")).toHaveFocus());
      expect(notesStoreMock.softDeleteNode).not.toHaveBeenCalled();
    });

    it("keeps the single-node completion path when no selection is active", async () => {
      useCtrlPlatform();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      title.focus();
      fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });

      await waitFor(() =>
        expect(notesStoreMock.toggleComplete).toHaveBeenCalledWith("/vault", "a")
      );
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
    });

    it("surfaces a paused notice when a selection batch is dropped by a failed draft flush", async () => {
      useCtrlPlatform();
      configureRepository(threeRoots());
      notesStoreMock.updateNode.mockRejectedValue(new Error("save failed"));
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      title.focus();
      // The dirty draft is the barrier the batch must clear; typing collapses
      // the selection, so rebuild it with Shift+ArrowDown afterward.
      fireEvent.change(title, { target: { value: "Alpha edited" } });
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });

      await waitFor(() =>
        expect(notesStoreMock.updateNode).toHaveBeenCalled()
      );
      // The batch never reached the backend (Phase 3.5)...
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
      // ...and the row explains the pause instead of silently swallowing it.
      await screen.findByText(/Command paused/i);
    });
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
    const title = await findTitleInput("Second");
    fireEvent.change(title, { target: { value: "Second edited" } });
    title.focus();

    expect(fireEvent.keyDown(title, { key: "Tab" })).toBe(false);
    expect(fireEvent.keyDown(title, { key: "Tab" })).toBe(false);
    await waitFor(() => expect(notesStoreMock.updateNode).toHaveBeenCalledOnce());
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "All notes" }).focus();
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
    expect(screen.getByRole("button", { name: "All notes" })).toHaveFocus();

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
      await findTitleInput("Second edited")
    ).toHaveFocus();
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
    expect(notesStoreMock.moveNode).toHaveBeenCalledOnce();
  });

  it("expands a collapsed previous sibling before indenting and focusing", async () => {
    const before = [
      node({ id: "first", sortKey: 1, title: "First", isCollapsed: true }),
      node({ id: "hidden", parentId: "first", sortKey: 1, title: "Hidden" }),
      node({ id: "second", sortKey: 2, title: "Second" })
    ];
    configureRepository(before);
    const expand = deferred<NotesWorkspace>();
    const move = deferred<NotesWorkspace>();
    notesStoreMock.toggleCollapsed.mockReturnValue(expand.promise);
    notesStoreMock.moveNode.mockReturnValue(move.promise);
    renderNotesWorkspace();
    const second = await findTitleInput("Second");
    second.focus();

    expect(fireEvent.keyDown(second, { key: "Tab" })).toBe(false);
    await waitFor(() =>
      expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledWith(
        "/vault",
        "first"
      )
    );
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();

    const expanded = before.map((current) =>
      current.id === "first" ? { ...current, isCollapsed: false } : current
    );
    await act(async () => expand.resolve(workspace(expanded)));
    await waitFor(() => expect(notesStoreMock.moveNode).toHaveBeenCalledOnce());
    expect(notesStoreMock.moveNode).toHaveBeenCalledWith("/vault", {
      id: "second",
      parentId: "first",
      afterId: "hidden"
    });

    await act(async () =>
      move.resolve(
        workspace(
          expanded.map((current) =>
            current.id === "second"
              ? { ...current, parentId: "first", sortKey: 2 }
              : current
          )
        )
      )
    );
    expect(
      await findTitleInput("Second")
    ).toHaveFocus();
  });

  it("saves before Shift+Tab outdent and does not duplicate the handled blur", async () => {
    renderNotesWorkspace();
    const title = await findTitleInput("Milestone");
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

  it("flushes the pending debounce before a structural move without a timer duplicate", async () => {
    renderNotesWorkspace();
    const title = await findTitleInput("Milestone");
    vi.useFakeTimers();
    fireEvent.change(title, { target: { value: "Milestone queued" } });
    title.focus();

    expect(
      fireEvent.keyDown(title, { key: "Tab", shiftKey: true })
    ).toBe(false);
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
    expect(notesStoreMock.moveNode).toHaveBeenCalledOnce();
    expect(
      notesStoreMock.updateNode.mock.invocationCallOrder[0]
    ).toBeLessThan(notesStoreMock.moveNode.mock.invocationCallOrder[0]);
  });

  it("saves before moving focus through visible rows without a native focus command", async () => {
    const save = deferred<NotesWorkspace>();
    notesStoreMock.updateNode.mockReturnValue(save.promise);
    renderNotesWorkspace();
    const plan = await findTitleInput("Plan");
    fireEvent.change(plan, { target: { value: "Plan edited" } });
    plan.focus();

    expect(fireEvent.keyDown(plan, { key: "ArrowDown" })).toBe(false);
    expect(
      await findTitleInput("Milestone")
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
    const milestone = getTitleInput("Milestone");
    milestone.setSelectionRange(0, 0);
    expect(fireEvent.keyDown(milestone, { key: "ArrowUp" })).toBe(false);
    expect(
      await findTitleInput("Plan edited")
    ).toHaveFocus();
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
  });

  it("keeps horizontal caret movement native except at collapse boundaries", async () => {
    renderNotesWorkspace();
    const project = await findTitleInput("Project");
    project.focus();
    project.setSelectionRange(1, 1);
    expect(fireEvent.keyDown(project, { key: "ArrowLeft" })).toBe(true);
    expect(notesStoreMock.toggleCollapsed).not.toHaveBeenCalled();

    project.setSelectionRange(0, 0);
    expect(fireEvent.keyDown(project, { key: "ArrowLeft" })).toBe(false);
    await waitFor(() => expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        queryTitleInput("Plan")
      ).not.toBeInTheDocument()
    );

    project.setSelectionRange(project.value.length, project.value.length);
    expect(fireEvent.keyDown(project, { key: "ArrowRight" })).toBe(false);
    await waitFor(() => expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledTimes(2));
    const plan = await findTitleInput("Plan");

    project.setSelectionRange(project.value.length, project.value.length);
    expect(fireEvent.keyDown(project, { key: "ArrowRight" })).toBe(false);
    expect(plan).toHaveFocus();
  });

  it("serializes rapid non-repeat collapse commands until the first settles", async () => {
    const before = [
      node({ id: "project", sortKey: 1, title: "Project" }),
      node({ id: "plan", parentId: "project", sortKey: 1, title: "Plan" })
    ];
    configureRepository(before);
    const collapse = deferred<NotesWorkspace>();
    notesStoreMock.toggleCollapsed.mockReturnValue(collapse.promise);
    renderNotesWorkspace();
    const project = await findTitleInput("Project");
    project.focus();
    project.setSelectionRange(0, 0);

    expect(fireEvent.keyDown(project, { key: "ArrowLeft" })).toBe(false);
    expect(fireEvent.keyDown(project, { key: "ArrowLeft" })).toBe(false);
    await waitFor(() =>
      expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledOnce()
    );

    await act(async () =>
      collapse.resolve(
        workspace(
          before.map((current) =>
            current.id === "project"
              ? { ...current, isCollapsed: true }
              : current
          )
        )
      )
    );
    await waitFor(() => expect(queryTitleInput("Plan")).not.toBeInTheDocument());
    expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledOnce();
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
    const empty = await findTitleInput("");
    empty.focus();
    empty.setSelectionRange(0, 0);

    expect(fireEvent.keyDown(empty, { key: "Backspace" })).toBe(false);
    expect(fireEvent.keyDown(empty, { key: "Backspace" })).toBe(false);
    await waitFor(() => expect(notesStoreMock.updateNode).toHaveBeenCalledOnce());
    expect(notesStoreMock.updateNode).toHaveBeenCalledWith("/vault", {
      id: "empty",
      title: "",
      note: ""
    });
    expect(notesStoreMock.removeEmptyNode).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "All notes" }).focus();

    await act(async () => save.resolve(workspace(before)));
    await waitFor(() =>
      expect(notesStoreMock.removeEmptyNode).toHaveBeenCalledWith(
        "/vault",
        "empty"
      )
    );
    expect(screen.getByRole("button", { name: "All notes" })).toHaveFocus();

    await act(async () =>
      remove.resolve(workspace(before.filter((current) => current.id !== "empty")))
    );
    expect(
      await findTitleInput("First")
    ).toHaveFocus();
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
    expect(notesStoreMock.removeEmptyNode).toHaveBeenCalledOnce();
  });

  it("focuses the first lifted child after removing a collapsed empty parent", async () => {
    const before = [
      node({ id: "empty", sortKey: 1, title: "", isCollapsed: true }),
      node({ id: "lifted-a", parentId: "empty", sortKey: 1, title: "Lifted A" }),
      node({ id: "lifted-b", parentId: "empty", sortKey: 2, title: "Lifted B" }),
      node({ id: "next", sortKey: 2, title: "Next" })
    ];
    configureRepository(before);
    const remove = deferred<NotesWorkspace>();
    notesStoreMock.removeEmptyNode.mockReturnValue(remove.promise);
    renderNotesWorkspace();
    const empty = await findTitleInput("");
    empty.focus();
    empty.setSelectionRange(0, 0);

    expect(fireEvent.keyDown(empty, { key: "Backspace" })).toBe(false);
    await waitFor(() =>
      expect(notesStoreMock.removeEmptyNode).toHaveBeenCalledWith(
        "/vault",
        "empty"
      )
    );

    await act(async () =>
      remove.resolve(
        workspace([
          node({ id: "lifted-a", sortKey: 1, title: "Lifted A" }),
          node({ id: "lifted-b", sortKey: 2, title: "Lifted B" }),
          node({ id: "next", sortKey: 3, title: "Next" })
        ])
      )
    );
    expect(
      await findTitleInput("Lifted A")
    ).toHaveFocus();
  });

  it("keeps Backspace native when an empty title has a nonempty note", async () => {
    configureRepository([
      node({ id: "kept", title: "", note: "supporting context" })
    ]);
    renderNotesWorkspace();
    const title = await findTitleInput("");
    title.focus();
    title.setSelectionRange(0, 0);

    expect(fireEvent.keyDown(title, { key: "Backspace" })).toBe(true);
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
    expect(notesStoreMock.removeEmptyNode).not.toHaveBeenCalled();
  });

  it("does not intercept composing, Process, or supporting-note keys", async () => {
    renderNotesWorkspace();
    const title = await findTitleInput("Project");
    title.focus();
    title.setSelectionRange(0, 0);

    expect(
      fireEvent.keyDown(title, { key: "Enter", isComposing: true })
    ).toBe(true);
    expect(
      fireEvent.keyDown(title, { key: "Enter", repeat: true })
    ).toBe(false);
    expect(fireEvent.keyDown(title, { key: "Process" })).toBe(true);
    const note = getTextareaByName("Supporting note: Project");
    expect(fireEvent.keyDown(note, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(note, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(note, { key: "Backspace" })).toBe(true);

    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    expect(notesStoreMock.removeEmptyNode).not.toHaveBeenCalled();
  });

  it("opens and focuses an empty row note with Shift+Enter", async () => {
    renderNotesWorkspace();
    const title = await findTitleInput("Outside branch");

    expect(
      fireEvent.keyDown(title, { key: "Enter", shiftKey: true })
    ).toBe(false);
    expect(
      getTextareaByName("Supporting note: Outside branch")
    ).toHaveFocus();
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();
  });

  it.each([
    { platform: "Win32", modifier: { ctrlKey: true }, label: "Ctrl" },
    { platform: "MacIntel", modifier: { metaKey: true }, label: "Cmd" }
  ])(
    "toggles completion with $label+Enter on $platform",
    async ({ platform, modifier }) => {
      vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
      renderNotesWorkspace();
      const title = await findTitleInput("Outside branch");

      expect(fireEvent.keyDown(title, { key: "Enter", ...modifier })).toBe(false);
      await waitFor(() =>
        expect(notesStoreMock.toggleComplete).toHaveBeenCalledWith(
          "/vault",
          "outside"
        )
      );
    }
  );

  it.each([
    {
      platform: "Win32",
      modifier: { altKey: true },
      label: "Alt"
    },
    {
      platform: "MacIntel",
      modifier: { metaKey: true },
      label: "Cmd"
    }
  ])("duplicates with $label+Shift+D on $platform", async ({ platform, modifier }) => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
    renderNotesWorkspace();
    const title = await findTitleInput("Outside branch");

    expect(
      fireEvent.keyDown(title, { key: "D", shiftKey: true, ...modifier })
    ).toBe(false);
    await waitFor(() =>
      expect(notesStoreMock.duplicateNode).toHaveBeenCalledWith(
        "/vault",
        "outside"
      )
    );
  });

  it.each([
    { platform: "Win32", modifier: { ctrlKey: true }, label: "Ctrl" },
    { platform: "MacIntel", modifier: { metaKey: true }, label: "Cmd" }
  ])(
    "deletes with $label+Shift+Backspace on $platform",
    async ({ platform, modifier }) => {
      vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
      renderNotesWorkspace();
      const title = await findTitleInput("Outside branch");

      expect(
        fireEvent.keyDown(title, {
          key: "Backspace",
          shiftKey: true,
          ...modifier
        })
      ).toBe(false);
      await waitFor(() =>
        expect(notesStoreMock.softDeleteNode).toHaveBeenCalledWith(
          "/vault",
          "outside"
        )
      );
    }
  );

  it("ignores composing, repeated, and textarea Workflowy shortcuts", async () => {
    renderNotesWorkspace();
    const title = await findTitleInput("Project");
    const note = getTextareaByName("Supporting note: Project");

    expect(
      fireEvent.keyDown(title, {
        key: "Enter",
        ctrlKey: true,
        isComposing: true
      })
    ).toBe(true);
    expect(
      fireEvent.keyDown(title, { key: "D", altKey: true, shiftKey: true, repeat: true })
    ).toBe(true);
    expect(
      fireEvent.keyDown(note, { key: "Backspace", metaKey: true, shiftKey: true })
    ).toBe(true);

    expect(notesStoreMock.toggleComplete).not.toHaveBeenCalled();
    expect(notesStoreMock.duplicateNode).not.toHaveBeenCalled();
    expect(notesStoreMock.softDeleteNode).not.toHaveBeenCalled();
  });

  it("exposes duplicate and delete through the bullet menu", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");

    const duplicateMenu = await openNodeMenu("Outside branch", user);
    await user.click(
      within(duplicateMenu).getByRole("menuitem", { name: "Duplicate" })
    );
    expect(notesStoreMock.duplicateNode).toHaveBeenCalledWith(
      "/vault",
      "outside"
    );

    const deleteMenu = await openNodeMenu("Outside branch", user);
    await user.click(
      within(deleteMenu).getByRole("menuitem", { name: "Delete" })
    );
    expect(notesStoreMock.softDeleteNode).toHaveBeenCalledWith(
      "/vault",
      "outside"
    );
  });

  it("shows counted typed tags, AND filter chips, and accessible removal across library views", async () => {
    const user = userEvent.setup();
    notesStoreMock.listTagsWithCounts.mockResolvedValue([
      {
        prefix: "#",
        normalizedTag: "work",
        displayTag: "Work",
        count: 2
      },
      {
        prefix: "@",
        normalizedTag: "work",
        displayTag: "Work",
        count: 1
      }
    ]);
    renderNotesWorkspace();
    await findTitleInput("Project");

    const views = screen.getByRole("group", { name: "Notes library views" });
    await user.click(within(views).getByRole("button", { name: "Starred" }));
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "starred"
      })
    );
    await user.click(within(views).getByRole("button", { name: "Recent" }));
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "recent"
      })
    );
    await user.click(within(views).getByRole("button", { name: "Tags" }));
    const hashTag = await screen.findByRole("button", {
      name: "#Work, 2 notes"
    });
    const mentionTag = screen.getByRole("button", {
      name: "@Work, 1 note"
    });
    await user.click(hashTag);
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "tags",
        tags: [{ prefix: "#", normalizedTag: "work" }]
      })
    );
    expect(hashTag).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Remove #Work filter" })
    ).toBeVisible();

    await user.click(mentionTag);
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "tags",
        tags: [
          { prefix: "#", normalizedTag: "work" },
          { prefix: "@", normalizedTag: "work" }
        ]
      })
    );
    expect(screen.getByRole("button", { name: "Remove @Work filter" }))
      .toBeVisible();

    await user.click(screen.getByRole("button", { name: "Remove #Work filter" }));
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "tags",
        tags: [{ prefix: "@", normalizedTag: "work" }]
      })
    );
    expect(screen.queryByRole("button", { name: "Remove #Work filter" }))
      .not.toBeInTheDocument();
    await user.click(within(views).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "archive"
      })
    );
    await user.click(within(views).getByRole("button", { name: "Trash" }));
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "trash"
      })
    );
    await user.click(within(views).getByRole("button", { name: "All" }));
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "active"
      })
    );
  });

  it("shows a zero-count active chip and removes the local result when its sole tag is saved away", async () => {
    const user = userEvent.setup();
    configureRepository([node({ id: "tagged", title: "#Work" })]);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) =>
        workspace(
          scope.kind === "tags"
            ? confirmedNodes.filter((current) => current.title.includes("#Work"))
            : confirmedNodes
        )
    );
    notesStoreMock.listTagsWithCounts.mockImplementation(async () =>
      confirmedNodes.some((current) => current.title.includes("#Work"))
        ? [
            {
              prefix: "#",
              normalizedTag: "work",
              displayTag: "Work",
              count: 1
            }
          ]
        : []
    );
    renderNotesWorkspace();

    await user.click(await screen.findByRole("button", { name: "Tags" }));
    await user.click(
      await screen.findByRole("button", { name: "#Work, 1 note" })
    );
    const title = await findTitleInput("#Work");
    fireEvent.change(title, { target: { value: "No tag" } });
    fireEvent.blur(title);

    await waitFor(() => expect(notesStoreMock.updateNode).toHaveBeenCalled());
    const chips = screen.getByRole("list", { name: "Active tag filters" });
    await waitFor(() => expect(chips).toHaveTextContent("#work0"));
    expect(queryTitleInput("No tag")).toBeNull();
    expect(screen.getByText("No pages yet.")).toBeVisible();
  });

  it("keeps only the newest asynchronous search results", async () => {
    const first = deferred<
      Array<{
        nodeId: string;
        title: string;
        parentTrail: string[];
        matchedField: "title";
      }>
    >();
    const second = deferred<
      Array<{
        nodeId: string;
        title: string;
        parentTrail: string[];
        matchedField: "title";
      }>
    >();
    notesStoreMock.search.mockImplementation(
      async (_vaultRoot: string, query: string) =>
        query === "Old" ? first.promise : second.promise
    );
    renderNotesWorkspace();
    const search = await screen.findByRole("searchbox", {
      name: "Search notes"
    });

    fireEvent.change(search, { target: { value: "Old" } });
    fireEvent.change(search, { target: { value: "New" } });
    second.resolve([
      {
        nodeId: "new",
        title: "New result",
        parentTrail: ["Project"],
        matchedField: "title"
      }
    ]);
    expect(
      await screen.findByRole("option", { name: /New result/ })
    ).toBeInTheDocument();

    first.resolve([
      {
        nodeId: "old",
        title: "Old result",
        parentTrail: ["Project"],
        matchedField: "title"
      }
    ]);
    await act(async () => first.promise);
    expect(
      screen.queryByRole("option", { name: /Old result/ })
    ).not.toBeInTheDocument();
  });

  it("runs mixed structured queries and renders their ancestor trail", async () => {
    notesStoreMock.searchStructured.mockResolvedValue([
      {
        nodeId: "plan",
        title: "Plan",
        parentTrail: ["Project", "Roadmap"],
        matchedField: "note"
      }
    ]);
    renderNotesWorkspace();
    const search = await screen.findByRole("searchbox", {
      name: "Search notes"
    });

    fireEvent.change(search, {
      target: { value: "roadmap #Work -@Alice #Soon OR @Bob" }
    });

    expect(
      await screen.findByRole("option", {
        name: "Plan, in Project / Roadmap, note match"
      })
    ).toHaveTextContent("Project / Roadmap");
    expect(notesStoreMock.searchStructured).toHaveBeenLastCalledWith("/vault", {
      text: "roadmap",
      requiredTags: [
        { prefix: "#", normalizedTag: "work", displayTag: "Work" }
      ],
      excludedTags: [
        { prefix: "@", normalizedTag: "alice", displayTag: "Alice" }
      ],
      orGroups: [
        [
          { prefix: "#", normalizedTag: "soon", displayTag: "Soon" },
          { prefix: "@", normalizedTag: "bob", displayTag: "Bob" }
        ]
      ]
    });
    expect(notesStoreMock.search).not.toHaveBeenCalled();
  });

  it("shows structured query validation errors without searching", async () => {
    renderNotesWorkspace();
    const search = await screen.findByRole("searchbox", {
      name: "Search notes"
    });
    const invalid = Array.from({ length: 65 }, (_, index) => `#tag${index}`)
      .join(" ");

    fireEvent.change(search, { target: { value: invalid } });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Structured Notes search has more than 64 unique tag alternatives."
    );
    expect(notesStoreMock.search).not.toHaveBeenCalled();
    expect(notesStoreMock.searchStructured).not.toHaveBeenCalled();
  });

  it("hides rendered search results as soon as the query changes", async () => {
    const oldSearch = deferred<
      Array<{
        nodeId: string;
        title: string;
        parentTrail: string[];
        matchedField: "title";
      }>
    >();
    const newSearch = deferred<
      Array<{
        nodeId: string;
        title: string;
        parentTrail: string[];
        matchedField: "title";
      }>
    >();
    notesStoreMock.search.mockImplementation(
      async (_vaultRoot: string, query: string) =>
        query === "Old" ? oldSearch.promise : newSearch.promise
    );
    renderNotesWorkspace();
    const search = await screen.findByRole("searchbox", {
      name: "Search notes"
    });

    fireEvent.change(search, { target: { value: "Old" } });
    oldSearch.resolve([
      {
        nodeId: "project",
        title: "Old result",
        parentTrail: [],
        matchedField: "title"
      }
    ]);
    expect(
      await screen.findByRole("option", { name: /Old result/ })
    ).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "New" } });

    expect(
      screen.queryByRole("option", { name: /Old result/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Search results" })).toBeNull();

    newSearch.resolve([
      {
        nodeId: "outside",
        title: "New result",
        parentTrail: [],
        matchedField: "title"
      }
    ]);
    expect(
      await screen.findByRole("option", { name: /New result/ })
    ).toBeInTheDocument();
  });

  it("supports complete keyboard navigation and selection in search results", async () => {
    const user = userEvent.setup();
    notesStoreMock.search.mockResolvedValue([
      {
        nodeId: "project",
        title: "Project",
        parentTrail: [],
        matchedField: "title"
      },
      {
        nodeId: "plan",
        title: "Plan",
        parentTrail: ["Project"],
        matchedField: "title"
      },
      {
        nodeId: "outside",
        title: "Outside branch",
        parentTrail: [],
        matchedField: "title"
      }
    ]);
    renderNotesWorkspace();
    const search = await screen.findByRole("searchbox", {
      name: "Search notes"
    });

    await user.type(search, "result");
    let options = await screen.findAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("tabindex", "0");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
    expect(options[1]).toHaveAttribute("tabindex", "-1");

    options[0].focus();
    await user.keyboard("{ArrowDown}");
    expect(options[1]).toHaveFocus();
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("tabindex", "-1");

    await user.keyboard("{End}");
    expect(options[2]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(options[0]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(options[2]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(options[0]).toHaveFocus();

    await user.keyboard("{Enter}");
    const pageTitle = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Edit page title"
    });
    expect(pageTitle).toHaveValue("Project");
    expect(pageTitle).toHaveFocus();

    await user.type(search, "result");
    options = await screen.findAllByRole("option");
    options[0].focus();
    await user.keyboard("{End}");
    await user.keyboard(" ");
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLTextAreaElement>("textbox", {
          name: "Edit page title"
        })
      ).toHaveValue("Outside branch");
      expect(
        screen.getByRole("textbox", { name: "Edit page title" })
      ).toHaveFocus();
    });
  });

  it("opens a search result in active context without persisting expansion", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "page", title: "Page", isCollapsed: true }),
      node({
        id: "section",
        parentId: "page",
        title: "Section",
        isCollapsed: true
      }),
      node({ id: "target", parentId: "section", title: "Target" })
    ]);
    notesStoreMock.search.mockResolvedValue([
      {
        nodeId: "target",
        title: "Target",
        parentTrail: ["Page", "Section"],
        matchedField: "title"
      }
    ]);
    renderNotesWorkspace();

    await user.type(
      await screen.findByRole("searchbox", { name: "Search notes" }),
      "Target"
    );
    await user.click(
      await screen.findByRole("option", { name: /Target/ })
    );

    expect(screen.getByLabelText("Notes breadcrumb")).toHaveTextContent("Page");
    expect(await findTitleInput("Target")).toHaveFocus();
    expect(notesStoreMock.toggleCollapsed).not.toHaveBeenCalled();
    expect(notesStoreMock.loadWorkspace).toHaveBeenLastCalledWith("/vault", {
      kind: "active"
    });
  });

  it("toggles a row star with state-aware bullet menu copy", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");

    const menu = await openNodeMenu("Project", user);
    await user.click(within(menu).getByRole("menuitem", { name: "Star" }));

    expect(notesStoreMock.toggleStar).toHaveBeenCalledWith("/vault", "project");
    const updatedMenu = await openNodeMenu("Project", user);
    expect(
      within(updatedMenu).getByRole("menuitem", { name: "Unstar" })
    ).toBeVisible();
  });

  it("keeps a filtered workspace scoped after a row mutation", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "starred", title: "Starred page", isStarred: true }),
      node({ id: "outside", title: "Outside page" })
    ]);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) =>
        workspace(
          scope.kind === "starred"
            ? confirmedNodes.filter((current) => current.isStarred)
            : confirmedNodes
        )
    );
    renderNotesWorkspace();
    await findTitleInput("Starred page");

    await user.click(screen.getByRole("button", { name: "Starred" }));
    await waitFor(() => expect(queryTitleInput("Outside page")).toBeNull());
    const menu = await openNodeMenu("Starred page", user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Complete" })
    );

    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenLastCalledWith("/vault", {
        kind: "starred"
      })
    );
    expect(queryTitleInput("Outside page")).toBeNull();
  });

  it("archives root pages from the library and exposes a read-only Archive workflow", async () => {
    const user = userEvent.setup();
    let activeNodes = [
      node({ id: "project", sortKey: 1, title: "Project" }),
      node({ id: "child", parentId: "project", sortKey: 1, title: "Child" }),
      node({ id: "outside", sortKey: 2, title: "Outside" })
    ];
    let archivedNodes: NoteNode[] = [];
    let deletedNodes: NoteNode[] = [];
    configureRepository(activeNodes);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) => {
        if (scope.kind === "archive") {
          return workspace(archivedNodes);
        }
        if (scope.kind === "trash") {
          return workspace(deletedNodes);
        }
        return workspace(activeNodes);
      }
    );
    notesStoreMock.archiveNode.mockImplementation(async (_vault, rootId) => {
      const subtree = activeNodes.filter(
        (current) => current.id === rootId || current.parentId === rootId
      );
      activeNodes = activeNodes.filter((current) => !subtree.includes(current));
      archivedNodes = subtree.map((current) => ({
        ...current,
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: rootId
      }));
      return workspace(activeNodes);
    });
    notesStoreMock.softDeleteNode.mockImplementation(async (_vault, rootId) => {
      const subtree = archivedNodes.filter(
        (current) => current.archiveRootId === rootId
      );
      archivedNodes = archivedNodes.filter(
        (current) => current.archiveRootId !== rootId
      );
      deletedNodes = subtree.map((current) => ({
        ...current,
        deletedAt: "2026-07-11T02:00:00Z",
        archivedAt: null,
        archiveRootId: null
      }));
      return workspace(activeNodes);
    });
    notesStoreMock.restoreNode.mockImplementation(async () => {
      activeNodes = [
        ...activeNodes,
        ...deletedNodes.map((current) => ({
          ...current,
          deletedAt: null
        }))
      ];
      deletedNodes = [];
      return workspace(activeNodes);
    });
    renderNotesWorkspace();
    await findTitleInput("Project");
    const library = screen.getByLabelText("Notes library");

    await user.click(
      within(library).getByRole("button", { name: "Project" })
    );
    await user.click(
      within(library).getByRole("button", { name: "Page actions for Project" })
    );
    const pageMenu = await screen.findByRole("menu");
    await user.click(within(pageMenu).getByRole("menuitem", { name: "Archive" }));
    await waitFor(() =>
      expect(notesStoreMock.archiveNode).toHaveBeenCalledWith("/vault", "project")
    );
    const activeFallbackTitle = await findTextareaByName("Edit page title");
    expect(activeFallbackTitle).toHaveValue("Outside");
    await waitFor(() => expect(activeFallbackTitle).toHaveFocus());

    await user.click(within(library).getByRole("button", { name: "Archive" }));
    await user.click(
      await within(library).findByRole("button", { name: "Project" })
    );
    expect(getTextareaByName("Edit page title")).toHaveAttribute(
      "readonly"
    );
    expect(screen.getByRole("button", { name: "Add child" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "New page" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "More actions for Child" })
    ).toBeNull();

    const rootActions = screen.getByRole("button", {
      name: "More actions for Project"
    });
    expect(rootActions).toBeEnabled();
    await user.click(rootActions);
    const archivedMenu = await screen.findByRole("menu");
    expect(
      within(archivedMenu).getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual(["Unarchive", "Move to Trash"]);
    await user.click(
      within(archivedMenu).getByRole("menuitem", { name: "Move to Trash" })
    );
    const trashDialog = screen.getByRole("alertdialog", {
      name: "Move page to Trash?"
    });
    expect(
      within(trashDialog).getByText(
        "Move Project and all of its descendants to Trash?"
      )
    ).toBeVisible();
    expect(notesStoreMock.softDeleteNode).not.toHaveBeenCalled();
    await user.click(
      within(trashDialog).getByRole("button", { name: "Move to Trash" })
    );
    await waitFor(() =>
      expect(notesStoreMock.softDeleteNode).toHaveBeenCalledWith(
        "/vault",
        "project"
      )
    );
    expect(await within(library).findByText("Archive is empty.")).toBeVisible();

    await user.click(within(library).getByRole("button", { name: "Trash" }));
    await user.click(
      await within(library).findByRole("button", { name: "Project" })
    );
    const trashTitle = getTextareaByName("Edit page title");
    expect(trashTitle).toHaveValue("Project");
    expect(trashTitle).toHaveAttribute("readonly");
    await user.click(
      screen.getByRole("button", { name: "More actions for Project" })
    );
    const trashHeaderMenu = await screen.findByRole("menu");
    expect(
      within(trashHeaderMenu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
    ).toEqual(["Restore"]);
    await user.click(
      within(trashHeaderMenu).getByRole("menuitem", { name: "Restore" })
    );
    await waitFor(() =>
      expect(notesStoreMock.restoreNode).toHaveBeenCalledWith(
        "/vault",
        "project"
      )
    );
    const restoredTitle = await findTextareaByName("Edit page title");
    expect(restoredTitle).toHaveValue("Project");
    expect(restoredTitle).not.toHaveAttribute("readonly");
    await waitFor(() => expect(restoredTitle).toHaveFocus());
    expect(
      within(library).getByRole("button", { name: "All" })
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the next archived page title read-only after Unarchive closes its menu", async () => {
    const user = userEvent.setup();
    const activeNodes = [node({ id: "active", title: "Active" })];
    let archivedNodes = [
      node({
        id: "archived-first",
        sortKey: 1,
        title: "Archived first",
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-first"
      }),
      node({
        id: "archived-second",
        sortKey: 2,
        title: "Archived second 07/12/2026",
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-second"
      })
    ];
    configureRepository(activeNodes);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) =>
        workspace(scope.kind === "archive" ? archivedNodes : activeNodes)
    );
    notesStoreMock.unarchiveNode.mockImplementation(async (_vault, rootId) => {
      archivedNodes = archivedNodes.filter((current) => current.id !== rootId);
      return workspace(activeNodes);
    });
    renderNotesWorkspace();
    const library = screen.getByLabelText("Notes library");

    await user.click(within(library).getByRole("button", { name: "Archive" }));
    await user.click(
      await within(library).findByRole("button", { name: "Archived first" })
    );
    await user.click(
      screen.getByRole("button", { name: "More actions for Archived first" })
    );
    const menu = await screen.findByRole("menu");
    await user.click(
      within(menu).getByRole("menuitem", { name: "Unarchive" })
    );

    const fallbackTitle = await screen.findByRole("group", {
      name: "Page title"
    });
    expect(fallbackTitle).toHaveTextContent("Archived second 07/12/2026");
    expect(fallbackTitle).toHaveAttribute("aria-readonly", "true");
    expect(fallbackTitle).toHaveAttribute("tabindex", "-1");
    expect(fallbackTitle).not.toHaveFocus();
    expect(
      fallbackTitle.querySelector(".notes-date-token")
    ).toHaveTextContent("07/12/2026");
    expect(
      screen.queryByRole("button", { name: "Edit date 07/12/2026" })
    ).not.toBeInTheDocument();

    await user.click(fallbackTitle);
    fireEvent.keyDown(fallbackTitle, { key: "Enter" });

    expect(
      screen.queryByRole("textbox", { name: "Edit page title" })
    ).not.toBeInTheDocument();
    const mountedTitle = queryTextareaByName("Edit page title");
    expect(mountedTitle).toHaveValue("Archived second 07/12/2026");
    expect(mountedTitle).toHaveAttribute("readonly");
    expect(mountedTitle).toHaveAttribute("aria-hidden", "true");
    expect(mountedTitle).toHaveAttribute("tabindex", "-1");
    expect(mountedTitle).not.toHaveFocus();
  });

  it("keeps Trash read-only while allowing restore and confirmed emptying", async () => {
    const user = userEvent.setup();
    const activeNodes = [node({ id: "project", title: "Project" })];
    let deletedNodes = [
      node({
        id: "deleted",
        title: "Deleted note",
        deletedAt: "2026-07-10T01:00:00Z"
      })
    ];
    configureRepository(activeNodes);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) =>
        workspace(scope.kind === "trash" ? deletedNodes : activeNodes)
    );
    notesStoreMock.restoreNode.mockImplementation(async () => {
      deletedNodes = [];
      return workspace(activeNodes);
    });
    renderNotesWorkspace();
    await findTitleInput("Project");

    await user.click(screen.getByRole("button", { name: "Trash" }));
    expect(
      await screen.findByRole("button", {
        name: "More actions for Deleted note"
      })
    ).toBeInTheDocument();
    expect(queryTitleInput("Deleted note")).toBeNull();
    expect(screen.queryByRole("button", { name: "Move Deleted note" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Star Deleted note" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Duplicate Deleted note" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Deleted note" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New page" })).toBeNull();

    const trashMenu = await openNodeMenu("Deleted note", user);
    expect(within(trashMenu).getAllByRole("menuitem")).toHaveLength(1);
    await user.click(
      within(trashMenu).getByRole("menuitem", { name: "Restore" })
    );
    expect(notesStoreMock.restoreNode).toHaveBeenCalledWith("/vault", "deleted");

    deletedNodes = [
      node({
        id: "another-deleted",
        title: "Another deleted note",
        deletedAt: "2026-07-10T01:00:00Z"
      })
    ];
    await user.click(screen.getByRole("button", { name: "All" }));
    await user.click(screen.getByRole("button", { name: "Trash" }));
    await screen.findByRole("button", {
      name: "More actions for Another deleted note"
    });
    await user.click(screen.getByRole("button", { name: "Empty trash" }));
    expect(notesStoreMock.emptyTrash).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog", { name: "Empty trash?" });
    await user.click(within(confirm).getByRole("button", { name: "Empty trash" }));
    expect(notesStoreMock.emptyTrash).toHaveBeenCalledWith("/vault");
  });

  it("does not expose deleted rows for editing while choosing a tag", async () => {
    const user = userEvent.setup();
    const activeNodes = [node({ id: "project", title: "Project" })];
    const deletedNodes = [
      node({
        id: "deleted",
        title: "Deleted note",
        deletedAt: "2026-07-10T01:00:00Z"
      })
    ];
    configureRepository(activeNodes);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) =>
        workspace(scope.kind === "trash" ? deletedNodes : activeNodes)
    );
    notesStoreMock.listTagsWithCounts.mockResolvedValue([
      {
        prefix: "#",
        normalizedTag: "work",
        displayTag: "Work",
        count: 1
      }
    ]);
    renderNotesWorkspace();
    await findTitleInput("Project");

    await user.click(screen.getByRole("button", { name: "Trash" }));
    await screen.findByRole("button", {
      name: "More actions for Deleted note"
    });
    await user.click(screen.getByRole("button", { name: "Tags" }));

    expect(
      await screen.findByRole("button", { name: "#Work, 1 note" })
    ).toBeInTheDocument();
    expect(queryTitleInput("Deleted note")).toBeNull();
    expect(screen.queryByRole("button", { name: "Move Deleted note" })).toBeNull();
  });

  it("flushes drafts before deleting only the Notes database", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    const title = await findTitleInput("Project");
    await user.clear(title);
    await user.type(title, "Unsaved project");

    await user.click(
      screen.getByRole("button", { name: "Notes data settings" })
    );
    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" })
    );
    const confirm = screen.getByRole("alertdialog", {
      name: "Delete all Notes data?"
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete Notes data" })
    );

    await waitFor(() =>
      expect(notesStoreMock.deleteDatabase).toHaveBeenCalledWith("/vault")
    );
    expect(notesStoreMock.updateNode).toHaveBeenCalled();
    expect(
      notesStoreMock.updateNode.mock.invocationCallOrder.at(-1)
    ).toBeLessThan(notesStoreMock.deleteDatabase.mock.invocationCallOrder[0]);
    expect(queryTextareaByName("Edit node title")).toBeNull();
    expect(screen.getByText("No outline yet.")).toBeInTheDocument();
    expect(notesStoreMock.emptyTrash).not.toHaveBeenCalled();
  });

  it("disables workspace controls while Notes data deletion is pending", async () => {
    const user = userEvent.setup();
    const deletion = deferred<void>();
    notesStoreMock.deleteDatabase.mockReturnValue(deletion.promise);
    renderNotesWorkspace();
    await findTitleInput("Project");

    await user.click(
      screen.getByRole("button", { name: "Notes data settings" })
    );
    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" })
    );
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: "Delete all Notes data?" })
      ).getByRole("button", { name: "Delete Notes data" })
    );
    await waitFor(() => expect(notesStoreMock.deleteDatabase).toHaveBeenCalledOnce());

    expect(
      screen.getByRole("searchbox", { name: "Search notes", hidden: true })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "New page", hidden: true })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Starred", hidden: true })
    ).toBeDisabled();
    for (const titleInput of textareasByName("Edit node title")) {
      expect(titleInput).toBeDisabled();
    }
    expect(
      screen.getByRole("button", {
        name: "More actions for Project",
        hidden: true
      })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Close Notes data settings" })
    ).toBeDisabled();

    await act(async () => deletion.resolve());
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Notes data" })).toBeNull()
    );
  });

  it("renders loading, empty, and error states", async () => {
    configureRepository([]);
    notesStoreMock.loadWorkspace.mockRejectedValueOnce(new Error("Load failed"));
    renderNotesWorkspace();

    expect(screen.getAllByText("Loading notes...")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "New page" })).toBeDisabled();
    expect(await screen.findAllByText("Load failed")).toHaveLength(2);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(
      within(screen.getByLabelText("Notes outline")).getByRole("alert")
    ).toHaveTextContent("Load failed");
    expect(
      within(screen.getByLabelText("Notes library")).queryByRole("alert")
    ).not.toBeInTheDocument();
  });

  it("keeps long titles and one compact menu trigger in stable layout hooks", async () => {
    const longTitle =
      "아주 긴 한국어 프로젝트 제목은 여러 줄로 자연스럽게 줄바꿈되어도 화살표와 글머리표와 메뉴를 덮지 않아야 합니다";
    let resizeCallback: ResizeObserverCallback | undefined;
    let titleScrollHeight = 52;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.spyOn(
      HTMLTextAreaElement.prototype,
      "scrollHeight",
      "get"
    ).mockImplementation(() => titleScrollHeight);
    configureRepository([node({ id: "project", title: longTitle })]);
    renderNotesWorkspace();

    const title = await findTitleInput(longTitle);
    const row = title.closest<HTMLElement>(".notes-node-main");
    const menuSlot = row?.querySelector<HTMLElement>(".notes-node-menu-slot");

    expect(row).not.toBeNull();
    expect(menuSlot).not.toBeNull();
    expect(title).toBeInstanceOf(HTMLTextAreaElement);
    expect(title).toHaveAttribute("rows", "1");
    expect(title).toHaveStyle({ height: "52px" });

    titleScrollHeight = 76;
    act(() =>
      resizeCallback?.(
        [
          {
            target: title,
            contentRect: { width: 320 }
          } as unknown as ResizeObserverEntry
        ],
        {} as ResizeObserver
      )
    );
    expect(title).toHaveStyle({ height: "76px" });
    expect(title.closest(".notes-text-field")?.parentElement).toBe(row);
    expect(menuSlot?.parentElement).toBe(row);
    expect(
      within(row!).getAllByRole("button", {
        name: `More actions for ${longTitle}`
      })
    ).toHaveLength(1);
    expect(within(row!).queryByRole("button", { name: /Complete/ })).toBeNull();
    expect(within(row!).queryByRole("button", { name: /Duplicate/ })).toBeNull();

    title.focus();
    expect(row).toContainElement(document.activeElement as HTMLElement | null);
    fireEvent.mouseEnter(row!);
    expect(menuSlot).toBeInTheDocument();
  });

  it("uses stable Workflowy row geometry without action overlap", () => {
    expect(notesStyles).toMatch(
      /\.notes-outline\s*{[^}]*--notes-outline-indent:\s*36px;[^}]*--notes-menu-width:\s*24px;[^}]*--notes-bullet-center-offset:\s*61px;[^}]*--notes-content-offset:\s*74px;/s
    );
    expect(notesStyles).not.toMatch(
      /\.notes-node\s*{[^}]*--notes-bullet-center-offset:/s
    );
    expect(notesStyles).toMatch(
      /\.notes-node\s*{[^}]*--notes-depth:\s*0;[^}]*--notes-indent:\s*calc\(var\(--notes-depth\) \* var\(--notes-outline-indent\)\);/s
    );
    expect(notesStyles).toMatch(
      /\.notes-outline-content\s*{[^}]*width:\s*min\(100%, 700px\);[^}]*min-width:\s*0;[^}]*margin-inline:\s*auto;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-outline-rows\s*{[^}]*overflow-x:\s*auto;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-page-header\s*{[^}]*width:\s*100%;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-page-title-row\s*{[^}]*grid-template-columns:\s*var\(--notes-content-offset\) minmax\(0, 1fr\);[^}]*align-items:\s*start;[^}]*gap:\s*0;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-node-main\s*{[^}]*grid-template-columns:\s*var\(--notes-menu-width\) 20px 18px minmax\(0, 1fr\);[^}]*align-items:\s*start;[^}]*gap:\s*4px;[^}]*min-height:\s*28px;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-node-arrow-slot\s*{[^}]*width:\s*20px;[^}]*height:\s*28px;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-node-bullet\s*{[^}]*width:\s*18px;[^}]*height:\s*28px;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-node-bullet-dot\s*{[^}]*width:\s*7px;[^}]*height:\s*7px;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-node-title\s*{[^}]*grid-column:\s*4;[^}]*grid-row:\s*1;[^}]*min-height:\s*28px;[^}]*overflow:\s*hidden;[^}]*resize:\s*none;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*font-size:\s*16px;[^}]*line-height:\s*24px;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-node-menu-slot\s*{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;[^}]*width:\s*var\(--notes-menu-width\);[^}]*min-width:\s*var\(--notes-menu-width\);/s
    );
    expect(notesStyles).toMatch(
      /\.notes-bullet-menu-trigger\s*{[^}]*width:\s*24px;[^}]*height:\s*28px;/s
    );
    expect(notesStyles).toMatch(
      /@media \(hover:\s*hover\) and \(pointer:\s*fine\)\s*{[\s\S]*\.notes-node-main \.notes-bullet-menu-trigger,[\s\S]*\.notes-page-title-row \.notes-bullet-menu-trigger\s*{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s
    );
    expect(notesStyles).toMatch(
      /@media \(hover:\s*hover\) and \(pointer:\s*fine\)\s*{[\s\S]*\.notes-node-main:hover \.notes-bullet-menu-trigger,[\s\S]*\.notes-node-main:focus-within \.notes-bullet-menu-trigger,[\s\S]*\.notes-node\[data-selected="true"\] \.notes-bullet-menu-trigger,[\s\S]*\.notes-page-header:hover \.notes-bullet-menu-trigger,[\s\S]*\.notes-page-header:focus-within \.notes-bullet-menu-trigger,[\s\S]*\.notes-page-header\[data-selected="true"\] \.notes-bullet-menu-trigger,[\s\S]*\.notes-bullet-menu-trigger:focus-visible,[\s\S]*\.notes-bullet-menu-trigger\[data-popup-open\]\s*{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s
    );
    expect(notesStyles).toMatch(
      /@media \(hover:\s*none\), \(pointer:\s*coarse\)\s*{[\s\S]*\.notes-bullet-menu-trigger,[\s\S]*\.notes-child-composer-button\s*{[^}]*opacity:\s*0\.68;[^}]*pointer-events:\s*auto;[^}]*}[\s\S]*\.notes-bullet-menu-trigger:disabled,[\s\S]*\.notes-child-composer-button:disabled\s*{[^}]*opacity:\s*0\.34;/s
    );
    expect(notesStyles).not.toContain("--notes-actions-width: 149px");
    expect(notesStyles).not.toContain(".notes-node-actions");
    expect(notesStyles).toMatch(
      /\.notes-node-title:focus-visible\s*{[^}]*outline:\s*0;[^}]*box-shadow:\s*none;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-node-note\s*{[^}]*width:\s*calc\(100% - var\(--notes-indent\) - var\(--notes-content-offset\)\);[^}]*margin:\s*2px 0 8px calc\(var\(--notes-indent\) \+ var\(--notes-content-offset\)\);/s
    );
    expect(notesStyles).toMatch(
      /\.notes-page-title\s*{[^}]*min-height:\s*34px;[^}]*overflow:\s*hidden;[^}]*resize:\s*none;[^}]*font-size:\s*27px;[^}]*font-weight:\s*700;[^}]*line-height:\s*34px;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-page-note\s*{[^}]*width:\s*calc\(100% - var\(--notes-content-offset\)\);[^}]*margin:\s*4px 0 0 var\(--notes-content-offset\);[^}]*resize:\s*none;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*font-size:\s*14px;[^}]*line-height:\s*20px;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-node-note\s*{[^}]*resize:\s*none;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*font-size:\s*14px;[^}]*line-height:\s*20px;/s
    );
    expect(notesStyles).not.toContain(".notes-complete-checkbox");
    expect(notesStyles).toMatch(
      /\.notes-node-bullet\[data-collapsed="true"\]::before[^}]*{[^}]*width:\s*26px;[^}]*height:\s*26px;[^}]*background:\s*var\(--bg-hover\);/s
    );
    expect(notesStyles).not.toMatch(
      /\.notes-node-main:(?:hover|focus-within)[^{]*{[^}]*background:/s
    );
    expect(notesStyles).toMatch(
      /\.notes-node-guides\s*{[^}]*position:\s*absolute;[^}]*grid-template-columns:\s*repeat\([^}]*var\(--notes-outline-indent\)[^}]*\);/s
    );
    expect(notesStyles).toMatch(
      /\.notes-node-guide\s*{[^}]*width:\s*1px;[^}]*margin-inline-start:\s*var\(--notes-bullet-center-offset\);/s
    );
    expect(notesStyles).toMatch(
      /\.notes-outline-drop-preview\s*{[^}]*position:\s*absolute;[^}]*inset-inline-start:\s*calc\([^}]*var\(--notes-drop-depth\)[^}]*var\(--notes-outline-indent\)[^}]*var\(--notes-bullet-center-offset\)[^}]*\);[^}]*height:\s*2px;/s
    );
    expect(notesStyles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*\.notes-outline\s*{[^}]*--notes-outline-indent:\s*28px;[^}]*--notes-menu-width:\s*28px;[^}]*--notes-bullet-center-offset:\s*70px;[^}]*--notes-content-offset:\s*84px;/s
    );
    expect(notesStyles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*\.notes-outline-toolbar\s*{[^}]*padding-inline:\s*8px;[\s\S]*\.notes-outline-rows\s*{[^}]*padding-inline:\s*12px;/s
    );
    expect(notesStyles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*\.notes-breadcrumb\s*{[^}]*overflow:\s*hidden;[\s\S]*\.notes-breadcrumb-button\s*{[^}]*max-width:\s*112px;/s
    );
    expect(notesStyles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*\.notes-node-main,[\s\S]*\.notes-child-composer\s*{[^}]*grid-template-columns:\s*var\(--notes-menu-width\) 28px 28px minmax\(0, 1fr\);[^}]*gap:\s*0;[\s\S]*\.notes-node-arrow-slot,[\s\S]*\.notes-collapse-button,[\s\S]*\.notes-node-bullet,[\s\S]*\.notes-bullet-menu-trigger,[\s\S]*\.notes-child-composer-button\s*{[^}]*width:\s*28px;/s
    );
    expect(notesStyles).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*\.notes-node\s*{[^}]*transition:\s*none !important;/s
    );
  });

  it("renders image drop position as a non-layout-shifting thin slot", () => {
    const dropPositionRule = notesStyles.match(
      /\.notes-image-drop-position\s*{([^}]*)}/s
    )?.[1];

    expect(dropPositionRule).toBeDefined();
    expect(dropPositionRule).toMatch(/position:\s*absolute;/);
    expect(dropPositionRule).toMatch(/box-sizing:\s*border-box;/);
    expect(dropPositionRule).toMatch(/inset-block-end:\s*-3px;/);
    expect(dropPositionRule).toMatch(/height:\s*6px;/);
    expect(dropPositionRule).toMatch(
      /border:\s*1px solid var\(--accent\);/
    );
    expect(dropPositionRule).toMatch(/border-radius:\s*2px;/);
    expect(dropPositionRule).toMatch(
      /background:\s*var\(--accent-soft\);/
    );
  });

  it("resolves collapsed halo tokens in light and dark themes", () => {
    const style = document.createElement("style");
    style.textContent = appStyles.replace(/^@import .*;$/gm, "");
    document.head.append(style);

    document.documentElement.removeAttribute("data-theme");
    const lightStyle = getComputedStyle(document.documentElement);
    const lightHalo = lightStyle
      .getPropertyValue("--bg-hover")
      .trim();
    const lightHaloStrong = lightStyle
      .getPropertyValue("--bg-active")
      .trim();
    document.documentElement.dataset.theme = "dark";
    const darkStyle = getComputedStyle(document.documentElement);
    const darkHalo = darkStyle
      .getPropertyValue("--bg-hover")
      .trim();
    const darkHaloStrong = darkStyle
      .getPropertyValue("--bg-active")
      .trim();

    expect(lightHalo).toBe("rgb(17 24 39 / 5%)");
    expect(lightHaloStrong).toBe("rgb(17 24 39 / 8%)");
    expect(darkHalo).toBe("rgb(255 255 255 / 6%)");
    expect(darkHaloStrong).toBe("rgb(255 255 255 / 10%)");
    expect(darkHalo).not.toBe(lightHalo);
    expect(darkHaloStrong).not.toBe(lightHaloStrong);
    expect(notesStyles).toMatch(
      /\.notes-node-bullet\[data-collapsed="true"\]::before[^}]*background:\s*var\(--bg-hover\);/s
    );
    expect(notesStyles).toMatch(
      /\.notes-node-bullet\[data-collapsed="true"\](?::hover|:focus-visible)::before[^}]*background:\s*var\(--bg-active\);/s
    );

    style.remove();
    document.documentElement.removeAttribute("data-theme");
  });

  it("keeps a disabled non-empty child composer subdued on hover and focus", () => {
    expect(notesStyles).toMatch(
      /@media \(hover:\s*hover\) and \(pointer:\s*fine\)\s*{[\s\S]*\.notes-child-composer\[data-has-children="true"\]:hover[\s\S]*\.notes-child-composer-button:disabled,[\s\S]*\.notes-child-composer:focus-within \.notes-child-composer-button:disabled,[\s\S]*\.notes-child-composer-button:disabled:focus-visible\s*{[^}]*opacity:\s*0\.34;/s
    );
  });

  it("uses one accessible non-underline focus rule for the resting node title", () => {
    const titlePresentationFocusRules = Array.from(
      notesStyles.matchAll(
        /\.notes-node-title-field > \.notes-token-text:focus-visible\s*{([^}]*)}/gs
      ),
      (match) => match[1]
    );

    expect(titlePresentationFocusRules).toHaveLength(1);
    const [titlePresentationFocusRule] = titlePresentationFocusRules;
    expect(titlePresentationFocusRule).toMatch(
      /outline:\s*2px solid var\(--accent\);/
    );
    expect(titlePresentationFocusRule).toMatch(/outline-offset:\s*2px;/);
    expect(titlePresentationFocusRule).toMatch(/box-shadow:\s*none;/);
    expect(titlePresentationFocusRule).not.toMatch(
      /border-bottom|text-decoration|inset\s+0\s+-\d+px/
    );
  });

  it("keeps the editing title textarea free of a focus line", () => {
    const titleEditorFocusRules = Array.from(
      notesStyles.matchAll(
        /\.notes-node-title:focus-visible\s*{([^}]*)}/gs
      ),
      (match) => match[1]
    );

    expect(titleEditorFocusRules).toHaveLength(1);
    const [titleEditorFocusRule] = titleEditorFocusRules;
    expect(titleEditorFocusRule).toMatch(/outline:\s*0;/);
    expect(titleEditorFocusRule).toMatch(/box-shadow:\s*none;/);
    expect(titleEditorFocusRule).not.toMatch(
      /border-bottom|text-decoration|inset\s+0\s+-\d+px/
    );
  });

  it("keeps the resting supporting-note presentation focus underline", () => {
    expect(notesStyles).toMatch(
      /\.notes-node-note-field > \.notes-token-text:focus-visible\s*{[^}]*box-shadow:\s*inset 0 -2px 0 var\(--accent\);[^}]*outline:\s*0;/s
    );
  });

  it("gives the library page menu trigger the standard visible focus ring", () => {
    expect(notesStyles).toMatch(
      /\.notes-library-page-menu-trigger:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\);[^}]*outline-offset:\s*-1px;/
    );
  });
});
