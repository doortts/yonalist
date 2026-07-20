import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import type {
  NoteAttachment,
  NoteNode,
  NotesWorkspaceScope
} from "../../domain/notes";
import { NotesOutlinePane } from "./NotesOutlinePane";
import { NotesDateTodayProvider } from "./NotesDatePickerIntegration";
import { NotesImageResidencyProvider } from "./NotesImageResidencyContext";
import {
  createNotesImageAtomEditorRegistry,
  type NotesImageAtomEditorAuthority
} from "./notesImageAtomEditorRegistry";
import {
  readImageAtomDomSelection,
  writeImageAtomDomSelection
} from "./imageAtomDomSelection";
import { NOTES_IMAGE_ATOM_CLIPBOARD_MIME } from "./notesImageAtomClipboard";
import { NotesWorkspaceContext } from "./NotesWorkspaceContext";
import type { NotesWorkspaceCommandOutcome } from "./notesWorkspaceCoordinator";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import type {
  NotesImageAtomPasteAuthority,
  NotesNodeDraft,
  NotesPreparedMove,
  UseNotesWorkspaceResult
} from "./useNotesWorkspace";

const capturedImageAtomEditorProps = vi.hoisted(
  () => new Map<string, import("./ImageAtomEditor").ImageAtomEditorProps>()
);

vi.mock("./ImageAtomEditor", async () => {
  const actual = await vi.importActual<typeof import("./ImageAtomEditor")>(
    "./ImageAtomEditor"
  );
  const react = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    ImageAtomEditor: react.forwardRef<
      import("./ImageAtomEditor").ImageAtomEditorHandle,
      import("./ImageAtomEditor").ImageAtomEditorProps
    >((props, ref) => {
      capturedImageAtomEditorProps.set(props.nodeId, props);
      return react.createElement(actual.ImageAtomEditor, { ...props, ref });
    })
  };
});

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
    nodeKind: "text",
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
    imageOffsetUtf16: 0,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function deferredInternalImagePaste(editor: HTMLElement) {
  const bytes = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0
  ]);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes)
  );
  const contentHash = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const bytesGate = deferred<ArrayBuffer>();
  const file = new File([bytes], "internal.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", {
    value: () => bytesGate.promise
  });
  const custom = JSON.stringify({
    version: 1,
    kind: "notes-image-atom",
    beforeText: "copied-before",
    afterText: "copied-after",
    image: {
      originalName: "internal.png",
      mimeType: "image/png",
      byteSize: bytes.byteLength,
      contentHash
    }
  });
  const event = createEvent.paste(editor, {
    bubbles: true,
    cancelable: true,
    clipboardData: {
      types: [NOTES_IMAGE_ATOM_CLIPBOARD_MIME, "Files"],
      items: {
        0: {
          kind: "file",
          type: "image/png",
          getAsFile: () => file
        },
        length: 1
      },
      getData: (type: string) =>
        type === NOTES_IMAGE_ATOM_CLIPBOARD_MIME ? custom : ""
    }
  });
  return {
    event,
    settle: () => bytesGate.resolve(bytes.slice().buffer)
  };
}

function workspaceValue(options: {
  nodeKind?: NoteNode["nodeKind"];
  title?: string;
  note?: string;
  imageOffsetUtf16?: number;
  childTitle?: string;
  childNote?: string;
  childNodeKind?: NoteNode["nodeKind"];
  childImageOffsetUtf16?: number;
  includeChild?: boolean;
  draft?: NotesNodeDraft;
  deletingNotesData?: boolean;
  libraryView?: UseNotesWorkspaceResult["libraryView"];
  pendingFocus?: { nodeId: string; field: "title" | "note" };
  pendingPrimarySelection?: {
    requestId: number;
    nodeId: string;
    field: "title";
    selection: { anchorUtf16: number; focusUtf16: number };
  };
  attachments?: NoteAttachment[];
  childAttachments?: NoteAttachment[];
  attachmentUploadError?: string;
  attachmentUploadRetryAttemptId?: string;
  includeOtherRoot?: boolean;
  writeError?: UseNotesWorkspaceResult["writeError"];
  retryLastFailedWrite?: UseNotesWorkspaceResult["retryLastFailedWrite"];
} = {}): UseNotesWorkspaceResult {
  const state = normalizeWorkspace({
    nodes: [
      node({
        id: "project",
        nodeKind: options.nodeKind ?? "text",
        title: options.title ?? "Project",
        note: options.note ?? "Project context",
        imageOffsetUtf16: options.imageOffsetUtf16 ?? 0
      }),
      ...(options.includeChild === false
        ? []
        : [
            node({
              id: "child",
              parentId: "project",
              nodeKind: options.childNodeKind ?? "text",
              title: options.childTitle ?? "First child",
              note: options.childNote ?? "",
              imageOffsetUtf16: options.childImageOffsetUtf16 ?? 0
            }),
            node({ id: "detail", parentId: "child", title: "Detail" })
          ]),
      ...(options.includeOtherRoot
        ? [node({ id: "inbox", sortKey: 2048, title: "Inbox" })]
        : [])
    ],
    attachmentsByNodeId: {
      ...(options.attachments ? { project: options.attachments } : {}),
      ...(options.childAttachments ? { child: options.childAttachments } : {})
    }
  });
  state.zoomRootId = "project";
  state.pendingFocusId = options.pendingFocus?.nodeId ?? null;
  state.pendingFocusField = options.pendingFocus?.field ?? null;

  const resolved = () => vi.fn().mockResolvedValue(undefined);
  const actions = {
    acknowledgeFocus: resolved(),
    focusNode: resolved(),
    createRoot: resolved(),
    createNextTextSibling: resolved(),
    splitNode: resolved(),
    createChild: resolved(),
    updateNode: resolved(),
    updateNodeDraft: vi.fn(),
    flushNodeDraft: vi.fn().mockResolvedValue(true),
    flushAllDrafts: vi.fn().mockResolvedValue(true),
    applyImageAtomEdit: resolved(),
    applyImageAtomPaste: resolved(),
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
    uploadImage: resolved(),
    importDroppedImagePaths: resolved(),
    retryImageUpload: resolved(),
    loadAttachmentBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
    resizeImage: resolved(),
    removeImage: resolved(),
    undo: resolved(),
    redo: resolved(),
    setSelectionAnchor: vi.fn(),
    extendSelectionTo: vi.fn(),
    toggleSelectionNode: vi.fn(),
    clearSelection: vi.fn()
  } as UseNotesWorkspaceResult["actions"];
  const imagePasteAuthority = {} as NotesImageAtomPasteAuthority;
  const imageEditorAuthority = {} as NotesImageAtomEditorAuthority;

  const result = {
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
    attachmentUploadRetryAttemptIdsByNodeId:
      options.attachmentUploadRetryAttemptId
        ? { project: options.attachmentUploadRetryAttemptId }
        : {},
    draftsByNodeId: options.draft ? { project: options.draft } : {},
    writeError: options.writeError ?? null,
    retryFailedDraft: resolved(),
    retryLastFailedWrite: options.retryLastFailedWrite ?? resolved(),
    captureActiveImageAtomEditorAuthority: vi.fn(() => imageEditorAuthority),
    captureImageAtomPasteAuthority: vi.fn(() => imagePasteAuthority),
    isImageAtomPasteAuthorityCurrent: vi.fn(() => true),
    applyImageAtomPasteWithAuthority: vi.fn(
      (_authority, nodeId, selection, fragment) =>
        actions.applyImageAtomPaste(nodeId, selection, fragment)
    ),
    status: "ready",
    loading: false,
    error: null
  } as UseNotesWorkspaceResult;
  if (options.pendingPrimarySelection) {
    (
      result as UseNotesWorkspaceResult & {
        pendingPrimarySelection?: typeof options.pendingPrimarySelection;
      }
    ).pendingPrimarySelection = options.pendingPrimarySelection;
  }
  return result;
}

function connectImagePasteAuthority(
  workspace: UseNotesWorkspaceResult,
  registry: ReturnType<typeof createNotesImageAtomEditorRegistry>
) {
  workspace.captureActiveImageAtomEditorAuthority = vi.fn(
    (nodeId, selectionAuthority) =>
      registry.capturePasteAuthority(nodeId, selectionAuthority)
  );
  workspace.captureImageAtomPasteAuthority = vi.fn(
    (_nodeId, editorAuthority) =>
      editorAuthority as unknown as NotesImageAtomPasteAuthority
  );
  workspace.isImageAtomPasteAuthorityCurrent = vi.fn((authority) =>
    registry.isPasteAuthorityCurrent(
      authority as unknown as NotesImageAtomEditorAuthority
    )
  );
}

function zoomedOutline(workspace: UseNotesWorkspaceResult) {
  return (
    <NotesDateTodayProvider today={{ year: 2026, month: 7, day: 11 }}>
      <VaultRootContext.Provider value="/vault">
        <NotesImageResidencyProvider scopeKey="/vault">
          <NotesWorkspaceContext.Provider value={workspace}>
            <NotesOutlinePane />
          </NotesWorkspaceContext.Provider>
        </NotesImageResidencyProvider>
      </VaultRootContext.Provider>
    </NotesDateTodayProvider>
  );
}

function renderZoomedOutline(workspace = workspaceValue()) {
  render(zoomedOutline(workspace));
  return workspace;
}

function preparedMove(
  sourceId: string,
  scope: NotesWorkspaceScope
): NotesPreparedMove {
  return {
    token: 1,
    vaultRoot: "/vault",
    scope,
    generation: 1,
    sourceId,
    nodes: [
      node({ id: "project", title: "Project" }),
      node({ id: "child", parentId: "project", title: "First child" }),
      node({ id: "detail", parentId: "child", title: "Detail" }),
      node({ id: "inbox", sortKey: 2048, title: "Inbox" })
    ]
  };
}

function moveScopeForView(
  libraryView: "starred" | "recent" | "tags"
): NotesWorkspaceScope {
  return libraryView === "tags"
    ? { kind: "tags", tags: [] }
    : { kind: libraryView };
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

function expectImageAtomEmptyRegions(
  editor: HTMLElement,
  beforeEmpty: boolean,
  afterEmpty: boolean
): void {
  const before = editor.querySelector<HTMLElement>(
    '[data-image-atom-region="before"]'
  );
  const after = editor.querySelector<HTMLElement>(
    '[data-image-atom-region="after"]'
  );
  if (beforeEmpty) {
    expect(before).toHaveAttribute("data-image-atom-empty", "true");
  } else {
    expect(before).not.toHaveAttribute("data-image-atom-empty");
  }
  if (afterEmpty) {
    expect(after).toHaveAttribute("data-image-atom-empty", "true");
  } else {
    expect(after).not.toHaveAttribute("data-image-atom-empty");
  }
}

function editTextareaByName(name: string): HTMLTextAreaElement {
  const textarea = getTextareaByName(name);
  fireEvent.focus(textarea);
  return textarea;
}

describe("NotesPageHeader", () => {
  beforeEach(() => {
    capturedImageAtomEditorProps.clear();
  });

  it("restores a backward replay textarea range only after the page title commits", async () => {
    const workspace = workspaceValue({
      title: "abcdef",
      pendingFocus: { nodeId: "project", field: "title" },
      pendingPrimarySelection: {
        requestId: 41,
        nodeId: "project",
        field: "title",
        selection: { anchorUtf16: 5, focusUtf16: 1 }
      }
    });
    renderZoomedOutline(workspace);

    const title = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Edit page title"
    });
    await waitFor(() => {
      expect(title).toHaveFocus();
      expect(title.selectionStart).toBe(1);
      expect(title.selectionEnd).toBe(5);
      expect(title.selectionDirection).toBe("backward");
    });
    expect(workspace.actions.acknowledgeFocus).toHaveBeenLastCalledWith(
      "project",
      41
    );
  });

  it("restores an atom-only replay selection in the committed page image editor", async () => {
    const workspace = workspaceValue({
      nodeKind: "image",
      title: "beforeafter",
      imageOffsetUtf16: 6,
      attachments: [attachment({ id: "page-image", nodeId: "project" })],
      pendingFocus: { nodeId: "project", field: "title" },
      pendingPrimarySelection: {
        requestId: 42,
        nodeId: "project",
        field: "title",
        selection: { anchorUtf16: 6, focusUtf16: 7 }
      }
    });
    renderZoomedOutline(workspace);

    const editor = await screen.findByRole("textbox", { name: "Image note" });
    await waitFor(() => {
      const [before, atom, after] = editor.querySelectorAll<HTMLElement>(
        "[data-image-atom-region]"
      );
      expect(readImageAtomDomSelection(
        { host: editor, before: before!, atom: atom!, after: after! },
        document.getSelection()!
      )).toEqual({ anchorUtf16: 6, focusUtf16: 7 });
    });
    expect(workspace.actions.acknowledgeFocus).toHaveBeenLastCalledWith(
      "project",
      42
    );
  });

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

  it("uses one image atom editor as page primary content with its description beneath", () => {
    const image = attachment({ id: "image-1", nodeId: "project" });
    renderZoomedOutline(
      workspaceValue({
        nodeKind: "image",
        title: "diagram.png",
        note: "Architecture description",
        attachments: [image]
      })
    );

    const heading = screen.getByRole("heading", {
      name: "diagram.png",
      level: 1
    });
    const editor = screen.getByRole("textbox", { name: "Image note" });
    const content = within(editor).getByRole("group", {
      name: "Image: diagram.png"
    });
    const description = getTextareaByName("Supporting note: Image");

    expect(editor).toHaveAttribute("aria-multiline", "true");
    expect(editor).toHaveAttribute("contenteditable", "true");
    expect(editor.querySelectorAll("[data-image-atom-region]")).toHaveLength(3);
    expect(heading).not.toContainElement(content);
    expect(heading.parentElement).toBe(editor.parentElement);
    expect(heading.parentElement).toHaveClass("notes-page-primary");
    expect(
      heading.querySelector("button, input, textarea, [tabindex]")
    ).toBeNull();
    expect(heading.querySelector("textarea.notes-page-title")).toBeNull();
    expect(heading).not.toHaveTextContent("diagram.png");
    expect(
      content.compareDocumentPosition(description) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(description).toHaveValue("Architecture description");
    expect(
      screen.getByRole("button", { name: "More actions for Image" })
    ).toBeVisible();
    expect(heading.closest(".notes-page-header")).toContainElement(editor);
    expect(
      screen.getByRole("button", { name: "Zoom into First child" })
    ).toBeVisible();
  });

  it("commits an image atom cut through a writable page header", async () => {
    const workspace = workspaceValue({
      nodeKind: "image",
      title: "beforeafter",
      imageOffsetUtf16: 6,
      attachments: [attachment({ id: "page-image", nodeId: "project" })]
    });
    const applyImageAtomEdit = vi.fn().mockResolvedValue("committed");
    workspace.actions.applyImageAtomEdit = applyImageAtomEdit;
    renderZoomedOutline(workspace);

    expect(
      screen
        .getByRole("textbox", { name: "Image note" })
        .querySelectorAll("[data-image-atom-region]")
    ).toHaveLength(3);
    const props = capturedImageAtomEditorProps.get("project")!;
    const selection = { anchorUtf16: 10, focusUtf16: 3 };

    expect(props.loadAttachmentBytes).toBe(workspace.actions.loadAttachmentBytes);
    await expect(props.onAtomCut!(selection)).resolves.toBe(true);
    expect(applyImageAtomEdit).toHaveBeenCalledWith("project", selection, {
      kind: "remove",
      replacementText: ""
    });
  });

  it.each(["failed", "skipped"] as const)(
    "returns false when a page-header image atom cut is %s",
    async (outcome) => {
      const workspace = workspaceValue({
        nodeKind: "image",
        title: "beforeafter",
        imageOffsetUtf16: 6,
        attachments: [attachment({ id: "page-image", nodeId: "project" })]
      });
      const applyImageAtomEdit = vi.fn().mockResolvedValue(outcome);
      workspace.actions.applyImageAtomEdit = applyImageAtomEdit;
      renderZoomedOutline(workspace);
      const props = capturedImageAtomEditorProps.get("project")!;
      const selection = { anchorUtf16: 3, focusUtf16: 10 };

      await expect(props.onAtomCut!(selection)).resolves.toBe(false);
      expect(applyImageAtomEdit).toHaveBeenCalledWith("project", selection, {
        kind: "remove",
        replacementText: ""
      });
    }
  );

  it.each([
    ["image only", "", 0, true, true],
    ["text before", "before", 6, false, true],
    ["text after", "after", 0, true, false],
    ["text on both sides", "beforeafter", 6, false, false]
  ])(
    "marks only empty zoomed image rows for %s",
    (_label, title, imageOffsetUtf16, beforeEmpty, afterEmpty) => {
      renderZoomedOutline(
        workspaceValue({
          nodeKind: "image",
          title,
          imageOffsetUtf16,
          attachments: [attachment({ id: "page-image", nodeId: "project" })]
        })
      );

      expectImageAtomEmptyRegions(
        screen.getByRole("textbox", { name: "Image note" }),
        beforeEmpty,
        afterEmpty
      );
    }
  );

  it("preserves selected-atom F6 and Escape semantics in the page-header editor", async () => {
    const user = userEvent.setup();
    renderZoomedOutline(
      workspaceValue({
        nodeKind: "image",
        title: "beforeafter",
        imageOffsetUtf16: 6,
        attachments: [attachment({ id: "page-image", nodeId: "project" })]
      })
    );

    const editor = await screen.findByRole("textbox", { name: "Image note" });
    const [before, atom, after] = editor.querySelectorAll<HTMLElement>(
      "[data-image-atom-region]"
    );
    act(() =>
      writeImageAtomDomSelection(
        { host: editor, before: before!, atom: atom!, after: after! },
        { anchorUtf16: 7, focusUtf16: 6 },
        document.getSelection()!
      )
    );

    const group = within(editor).getByRole("group", {
      name: "Image: diagram.png"
    });
    expect(fireEvent.keyDown(editor, { key: "F6" })).toBe(false);
    expect(group).toHaveFocus();

    await user.tab();
    const firstControl = within(group).getByRole("button", {
      name: "Load image diagram.png"
    });
    expect(firstControl).toHaveFocus();
    fireEvent.keyDown(firstControl, { key: "Escape" });

    expect(editor).toHaveFocus();
    expect(readImageAtomDomSelection(
      { host: editor, before: before!, atom: atom!, after: after! },
      document.getSelection()!
    )).toEqual({ anchorUtf16: 7, focusUtf16: 6 });
  });

  it.each([
    ["read-only", { libraryView: "archive" as const }],
    ["disabled", { deletingNotesData: true }]
  ])("does not expose editable image-atom entry while the page header is %s", async (_label, mode) => {
    renderZoomedOutline(
      workspaceValue({
        ...mode,
        nodeKind: "image",
        title: "beforeafter",
        imageOffsetUtf16: 6,
        attachments: [attachment({ id: "page-image", nodeId: "project" })]
      })
    );

    const editor = await screen.findByRole("textbox", { name: "Image note" });
    const group = within(editor).getByRole("group", {
      name: "Image: diagram.png"
    });
    expect(editor).toHaveAttribute("aria-readonly", "true");
    expect(editor).toHaveAttribute("contenteditable", "false");
    expect(fireEvent.keyDown(editor, { key: "F6" })).toBe(true);
    expect(group).not.toHaveFocus();
    const props = capturedImageAtomEditorProps.get("project")!;
    expect(props.loadAttachmentBytes).toBeUndefined();
    expect(props.onAtomCut).toBeUndefined();
  });

  it("opens an existing-date picker from the page image atom", async () => {
    const user = userEvent.setup();
    renderZoomedOutline(
      workspaceValue({
        nodeKind: "image",
        title: "Before 07/12/2026 after",
        attachments: [attachment({ id: "image-1", nodeId: "project" })]
      })
    );

    await user.click(
      screen.getByRole("button", { name: "Edit date 07/12/2026" })
    );

    expect(
      await screen.findByRole("dialog", { name: "Choose date" })
    ).toBeVisible();
  });

  it.each([
    ["archive", { libraryView: "archive" as const }],
    ["trash", { libraryView: "trash" as const }],
    ["disabled", { deletingNotesData: true }]
  ])("does not activate image dates while %s", async (_label, mode) => {
    const workspace = workspaceValue({
      ...mode,
      nodeKind: "image",
      title: "Before 07/12/2026 after",
      attachments: [attachment({ id: "image-1", nodeId: "project" })]
    });
    renderZoomedOutline(workspace);

    expect(
      screen.queryByRole("button", { name: "Edit date 07/12/2026" })
    ).toBeNull();
    expect(workspace.actions.updateNodeDraft).not.toHaveBeenCalled();
    expect(workspace.actions.flushNodeDraft).not.toHaveBeenCalled();
  });

  it("does not activate a valid standard-row image date while disabled", () => {
    const workspace = workspaceValue({
      deletingNotesData: true,
      childNodeKind: "image",
      childTitle: "Before 07/12/2026 after",
      childImageOffsetUtf16: 6,
      childAttachments: [attachment({ id: "image-child", nodeId: "child" })]
    });
    renderZoomedOutline(workspace);

    expect(
      screen.queryByRole("button", { name: "Edit date 07/12/2026" })
    ).toBeNull();
    expect(workspace.actions.updateNodeDraft).not.toHaveBeenCalled();
    expect(workspace.actions.flushNodeDraft).not.toHaveBeenCalled();
  });

  it("moves the image offset when an existing date before the atom changes length", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue({
      nodeKind: "image",
      title: "today after",
      imageOffsetUtf16: 5,
      attachments: [attachment({ id: "image-1", nodeId: "project" })]
    });
    renderZoomedOutline(workspace);

    await user.click(screen.getByRole("button", { name: "Edit date today" }));
    const picker = screen.getByRole("dialog", { name: "Choose date" });
    await user.click(within(picker).getByRole("button", { name: "Today" }));
    await user.keyboard("{Enter}");

    expect(workspace.actions.updateNodeDraft).toHaveBeenLastCalledWith(
      "project",
      {
        title: "07/11/2026 after",
        note: "Project context",
        imageOffsetUtf16: 10
      },
      "title"
    );
  });

  it("keeps the image offset for an existing date after the atom", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue({
      nodeKind: "image",
      title: "before today",
      imageOffsetUtf16: 0,
      attachments: [attachment({ id: "image-1", nodeId: "project" })]
    });
    renderZoomedOutline(workspace);

    await user.click(screen.getByRole("button", { name: "Edit date today" }));
    const picker = screen.getByRole("dialog", { name: "Choose date" });
    await user.click(within(picker).getByRole("button", { name: "Today" }));
    await user.keyboard("{Enter}");

    expect(workspace.actions.updateNodeDraft).toHaveBeenLastCalledWith(
      "project",
      {
        title: "before 07/11/2026",
        note: "Project context",
        imageOffsetUtf16: 0
      },
      "title"
    );
  });

  it("opens a typed-date picker from the latest page image-atom draft", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue({
      nodeKind: "image",
      title: "before!after",
      imageOffsetUtf16: 6,
      attachments: [attachment({ id: "image-1", nodeId: "project" })]
    });
    renderZoomedOutline(workspace);
    const editor = screen.getByRole("textbox", { name: "Image note" });
    const afterText = editor.querySelector<HTMLElement>(
      '[data-image-atom-region="after"] [data-image-atom-raw]'
    )!.firstChild!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(afterText, 1);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent(
      editor,
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: "!"
      })
    );
    const picker = await screen.findByRole("dialog", { name: "Choose date" });
    await user.click(within(picker).getByRole("button", { name: "Today" }));
    await user.keyboard("{Enter}");

    expect(workspace.actions.updateNodeDraft).toHaveBeenLastCalledWith(
      "project",
      {
        title: "before 07/11/2026 after",
        note: "Project context",
        imageOffsetUtf16: 6
      },
      "title"
    );
  });

  it("keeps a zoomed image node actionable when its attachment is missing", () => {
    renderZoomedOutline(
      workspaceValue({
        nodeKind: "image",
        title: "missing.png",
        note: "Recovery details"
      })
    );

    const heading = screen.getByRole("heading", {
      name: "missing.png",
      level: 1
    });
    const content = screen.getByRole("group", { name: "Image: missing.png" });
    expect(heading).not.toContainElement(content);
    expect(within(content).getByRole("alert")).toHaveTextContent(
      "Image unavailable"
    );
    expect(
      screen.getByRole("button", { name: "More actions for Image" })
    ).toBeVisible();
    expect(getTextareaByName("Supporting note: Image")).toHaveValue(
      "Recovery details"
    );
    expect(heading.closest(".notes-page-header")).not.toHaveTextContent(
      "missing.png"
    );
  });

  it("routes page-primary Enter keys without falling back to legacy text splitting", async () => {
    const workspace = workspaceValue({
      nodeKind: "image",
      title: "diagram.png",
      note: "",
      attachments: [attachment({ id: "image-1", nodeId: "project" })]
    });
    const applyImageAtomEdit = vi.fn().mockResolvedValue("committed");
    workspace.actions.applyImageAtomEdit = applyImageAtomEdit;
    renderZoomedOutline(workspace);
    const editor = screen.getByRole("textbox", { name: "Image note" });
    expect(fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })).toBe(false);
    expect(getTextareaByName("Supporting note: Image")).toHaveFocus();

    const refreshedEditor = screen.getByRole("textbox", { name: "Image note" });
    fireEvent.click(
      refreshedEditor.querySelector<HTMLElement>(
        '[data-image-atom-region="atom"]'
      )!
    );
    expect(fireEvent.keyDown(refreshedEditor, { key: "Enter" })).toBe(false);
    await waitFor(() => expect(applyImageAtomEdit).toHaveBeenCalledOnce());
    expect(applyImageAtomEdit).toHaveBeenCalledWith(
      "project",
      expect.objectContaining({ anchorUtf16: 0, focusUtf16: 1 }),
      expect.objectContaining({ kind: "enter" })
    );
    expect(workspace.actions.splitNode).not.toHaveBeenCalled();
  });

  it("routes a focused page-primary external image paste through the image atom", async () => {
    const workspace = workspaceValue({
      nodeKind: "image",
      title: "diagram.png",
      attachments: [attachment({ id: "image-1", nodeId: "project" })]
    });
    const registry = createNotesImageAtomEditorRegistry();
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    workspace.registerActiveImageAtomEditor = (editor) => registry.register(editor);
    workspace.claimActiveImageAtomPaste = (event) => registry.claimPaste(event);
    workspace.actions.importClipboardImages = importClipboardImages;
    renderZoomedOutline(workspace);

    const editor = screen.getByRole("textbox", { name: "Image note" });
    editor.focus();
    fireEvent.click(
      editor.querySelector<HTMLElement>("[data-image-atom-region=\"atom\"]")!
    );
    const file = new File([new Uint8Array([137, 80, 78, 71])], "external.png", {
      type: "image/png"
    });
    const event = createEvent.paste(editor, {
      bubbles: true,
      cancelable: true,
      clipboardData: {
        types: ["Files"],
        items: {
          0: {
            kind: "file",
            type: "image/png",
            getAsFile: () => file
          },
          length: 1
        },
        getData: () => ""
      }
    });

    fireEvent(editor, event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(workspace.actions.applyImageAtomPaste).toHaveBeenCalledOnce()
    );
    expect(importClipboardImages).not.toHaveBeenCalled();
  });

  it("persists the published image draft before admitting its paste", async () => {
    const workspace = workspaceValue({
      nodeKind: "image",
      title: "diagram.png",
      attachments: [attachment({ id: "image-1", nodeId: "project" })]
    });
    const registry = createNotesImageAtomEditorRegistry();
    let persisted = false;
    const authority = {} as NotesImageAtomPasteAuthority;
    vi.mocked(workspace.actions.flushNodeDraft).mockImplementation(async () => {
      persisted = true;
      return true;
    });
    workspace.captureImageAtomPasteAuthority = vi.fn(() =>
      persisted ? authority ?? null : null
    );
    workspace.registerActiveImageAtomEditor = (editor) => registry.register(editor);
    workspace.claimActiveImageAtomPaste = (event) => registry.claimPaste(event);
    renderZoomedOutline(workspace);

    const editor = screen.getByRole("textbox", { name: "Image note" });
    editor.focus();
    fireEvent.click(editor.querySelector<HTMLElement>("[data-image-atom-region=atom]")!);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "external.png", {
      type: "image/png"
    });
    fireEvent.paste(editor, {
      clipboardData: {
        types: ["Files"],
        items: {
          0: { kind: "file", type: "image/png", getAsFile: () => file },
          length: 1
        },
        getData: () => ""
      }
    });

    await waitFor(() =>
      expect(workspace.actions.applyImageAtomPaste).toHaveBeenCalledOnce()
    );
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith("project");
  });

  it.each([
    [
      "page header",
      {
        nodeKind: "image" as const,
        title: "beforeafter",
        imageOffsetUtf16: 6,
        attachments: [attachment({ id: "image-1", nodeId: "project" })]
      },
      "project"
    ],
    [
      "outline row",
      {
        childNodeKind: "image" as const,
        childTitle: "beforeafter",
        childImageOffsetUtf16: 6,
        childAttachments: [attachment({ id: "image-child", nodeId: "child" })]
      },
      "child"
    ]
  ])(
    "drops a %s image paste when the same host blurs and refocuses during draft flush",
    async (_label, options, nodeId) => {
      const workspace = workspaceValue(options);
      const registry = createNotesImageAtomEditorRegistry();
      const flush = deferred<boolean>();
      vi.mocked(workspace.actions.flushNodeDraft).mockReturnValue(flush.promise);
      workspace.registerActiveImageAtomEditor = (editor) =>
        registry.register(editor);
      workspace.claimActiveImageAtomPaste = (event) => registry.claimPaste(event);
      connectImagePasteAuthority(workspace, registry);
      renderZoomedOutline(workspace);

      const editor = screen.getByRole("textbox", { name: "Image note" });
      const atom = editor.querySelector<HTMLElement>(
        "[data-image-atom-region=atom]"
      )!;
      editor.focus();
      fireEvent.click(atom);
      const file = new File([new Uint8Array([137, 80, 78, 71])], "external.png", {
        type: "image/png"
      });
      fireEvent.paste(editor, {
        clipboardData: {
          types: ["Files"],
          items: {
            0: { kind: "file", type: "image/png", getAsFile: () => file },
            length: 1
          },
          getData: () => ""
        }
      });
      await waitFor(() =>
        expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith(nodeId)
      );

      await act(async () => {
        editor.blur();
        editor.focus();
        fireEvent.click(atom);
      });
      await act(async () => {
        flush.resolve(true);
        await flush.promise;
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(workspace.actions.applyImageAtomPaste).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "page header",
      {
        nodeKind: "image" as const,
        title: "beforeafter",
        imageOffsetUtf16: 6,
        attachments: [attachment({ id: "image-1", nodeId: "project" })]
      }
    ],
    [
      "outline row",
      {
        childNodeKind: "image" as const,
        childTitle: "beforeafter",
        childImageOffsetUtf16: 6,
        childAttachments: [attachment({ id: "image-child", nodeId: "child" })]
      }
    ]
  ])(
    "commits a %s image paste when ownership stays unchanged during draft flush",
    async (_label, options) => {
      const workspace = workspaceValue(options);
      const registry = createNotesImageAtomEditorRegistry();
      const flush = deferred<boolean>();
      vi.mocked(workspace.actions.flushNodeDraft).mockReturnValue(flush.promise);
      workspace.registerActiveImageAtomEditor = (editor) =>
        registry.register(editor);
      workspace.claimActiveImageAtomPaste = (event) => registry.claimPaste(event);
      connectImagePasteAuthority(workspace, registry);
      renderZoomedOutline(workspace);

      const editor = screen.getByRole("textbox", { name: "Image note" });
      editor.focus();
      fireEvent.click(
        editor.querySelector<HTMLElement>("[data-image-atom-region=atom]")!
      );
      const file = new File([new Uint8Array([137, 80, 78, 71])], "external.png", {
        type: "image/png"
      });
      fireEvent.paste(editor, {
        clipboardData: {
          types: ["Files"],
          items: {
            0: { kind: "file", type: "image/png", getAsFile: () => file },
            length: 1
          },
          getData: () => ""
        }
      });
      await waitFor(() =>
        expect(workspace.actions.flushNodeDraft).toHaveBeenCalledOnce()
      );

      await act(async () => {
        flush.resolve(true);
        await flush.promise;
      });

      await waitFor(() =>
        expect(workspace.actions.applyImageAtomPaste).toHaveBeenCalledOnce()
      );
    }
  );

  it("silently consumes a claimed image paste when its explicit draft save fails", async () => {
    const workspace = workspaceValue({
      nodeKind: "image",
      title: "diagram.png",
      attachments: [attachment({ id: "image-1", nodeId: "project" })]
    });
    const registry = createNotesImageAtomEditorRegistry();
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    vi.mocked(workspace.actions.flushNodeDraft).mockResolvedValue(false);
    workspace.actions.importClipboardImages = importClipboardImages;
    workspace.registerActiveImageAtomEditor = (editor) => registry.register(editor);
    workspace.claimActiveImageAtomPaste = (event) => registry.claimPaste(event);
    renderZoomedOutline(workspace);

    const editor = screen.getByRole("textbox", { name: "Image note" });
    editor.focus();
    fireEvent.click(editor.querySelector<HTMLElement>("[data-image-atom-region=atom]")!);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "external.png", {
      type: "image/png"
    });
    const event = createEvent.paste(editor, {
      bubbles: true,
      cancelable: true,
      clipboardData: {
        types: ["Files"],
        items: {
          0: { kind: "file", type: "image/png", getAsFile: () => file },
          length: 1
        },
        getData: () => ""
      }
    });
    fireEvent(editor, event);

    await waitFor(() => expect(workspace.actions.flushNodeDraft).toHaveBeenCalled());
    expect(event.defaultPrevented).toBe(true);
    expect(workspace.actions.applyImageAtomPaste).not.toHaveBeenCalled();
    expect(importClipboardImages).not.toHaveBeenCalled();
  });

  it("drops a deferred image-atom paste when its exact selection moves", async () => {
    const workspace = workspaceValue({
      nodeKind: "image",
      title: "beforeafter",
      imageOffsetUtf16: 6,
      attachments: [attachment({ id: "image-1", nodeId: "project" })]
    });
    const registry = createNotesImageAtomEditorRegistry();
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    workspace.registerActiveImageAtomEditor = (editor) => registry.register(editor);
    workspace.claimActiveImageAtomPaste = (event) => registry.claimPaste(event);
    workspace.actions.importClipboardImages = importClipboardImages;
    renderZoomedOutline(workspace);

    const editor = screen.getByRole("textbox", { name: "Image note" });
    editor.focus();
    fireEvent.click(
      editor.querySelector<HTMLElement>("[data-image-atom-region=atom]")!
    );
    const paste = await deferredInternalImagePaste(editor);
    fireEvent(editor, paste.event);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const afterText = editor.querySelector<HTMLElement>(
      "[data-image-atom-region=after] [data-image-atom-raw]"
    )!.firstChild!;
    const range = document.createRange();
    range.setStart(afterText, 2);
    range.collapse(true);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    await act(async () => {
      paste.settle();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(workspace.isImageAtomPasteAuthorityCurrent).toHaveBeenCalled()
    );
    expect(paste.event.defaultPrevented).toBe(true);
    expect(workspace.actions.applyImageAtomPaste).not.toHaveBeenCalled();
    expect(importClipboardImages).not.toHaveBeenCalled();
  });

  it("drops a deferred image paste after blur and refocus of the same host and range", async () => {
    const workspace = workspaceValue({
      nodeKind: "image",
      title: "beforeafter",
      imageOffsetUtf16: 6,
      attachments: [attachment({ id: "image-1", nodeId: "project" })]
    });
    const registry = createNotesImageAtomEditorRegistry();
    workspace.registerActiveImageAtomEditor = (editor) => registry.register(editor);
    workspace.claimActiveImageAtomPaste = (event) => registry.claimPaste(event);
    connectImagePasteAuthority(workspace, registry);
    renderZoomedOutline(workspace);
    const editor = screen.getByRole("textbox", { name: "Image note" });
    editor.focus();
    const atom = editor.querySelector<HTMLElement>("[data-image-atom-region=atom]")!;
    fireEvent.click(atom);
    const paste = await deferredInternalImagePaste(editor);
    fireEvent(editor, paste.event);
    await waitFor(() =>
      expect(workspace.captureImageAtomPasteAuthority).toHaveBeenCalled()
    );
    editor.blur();
    editor.focus();
    fireEvent.click(atom);
    await act(async () => paste.settle());

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workspace.actions.applyImageAtomPaste).not.toHaveBeenCalled();
  });

  it("drops a deferred image paste after selection A-to-B-to-A ABA", async () => {
    const workspace = workspaceValue({
      nodeKind: "image",
      title: "beforeafter",
      imageOffsetUtf16: 6,
      attachments: [attachment({ id: "image-1", nodeId: "project" })]
    });
    const registry = createNotesImageAtomEditorRegistry();
    workspace.registerActiveImageAtomEditor = (editor) => registry.register(editor);
    workspace.claimActiveImageAtomPaste = (event) => registry.claimPaste(event);
    connectImagePasteAuthority(workspace, registry);
    renderZoomedOutline(workspace);
    const editor = screen.getByRole("textbox", { name: "Image note" });
    editor.focus();
    const atom = editor.querySelector<HTMLElement>("[data-image-atom-region=atom]")!;
    fireEvent.click(atom);
    const paste = await deferredInternalImagePaste(editor);
    fireEvent(editor, paste.event);
    await waitFor(() =>
      expect(workspace.captureImageAtomPasteAuthority).toHaveBeenCalled()
    );
    const afterText = editor.querySelector<HTMLElement>(
      "[data-image-atom-region=after] [data-image-atom-raw]"
    )!.firstChild!;
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(afterText, 1, afterText, 1);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(atom);
    fireEvent(document, new Event("selectionchange"));
    await act(async () => paste.settle());

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workspace.actions.applyImageAtomPaste).not.toHaveBeenCalled();
  });

  it("commits a deferred image paste after a no-op restore and duplicate selection events", async () => {
    const workspace = workspaceValue({
      nodeKind: "image",
      title: "beforeafter",
      imageOffsetUtf16: 6,
      attachments: [attachment({ id: "image-1", nodeId: "project" })]
    });
    const registry = createNotesImageAtomEditorRegistry();
    workspace.registerActiveImageAtomEditor = (editor) => registry.register(editor);
    workspace.claimActiveImageAtomPaste = (event) => registry.claimPaste(event);
    connectImagePasteAuthority(workspace, registry);
    renderZoomedOutline(workspace);
    const editor = screen.getByRole("textbox", { name: "Image note" });
    editor.focus();
    const atom = editor.querySelector<HTMLElement>("[data-image-atom-region=atom]")!;
    fireEvent.click(atom);
    const paste = await deferredInternalImagePaste(editor);
    fireEvent(editor, paste.event);
    await waitFor(() =>
      expect(workspace.captureImageAtomPasteAuthority).toHaveBeenCalled()
    );
    fireEvent.click(atom);
    fireEvent(document, new Event("selectionchange"));
    fireEvent(document, new Event("selectionchange"));
    await act(async () => paste.settle());

    await waitFor(() =>
      expect(workspace.actions.applyImageAtomPaste).toHaveBeenCalledOnce()
    );
  });

  it.each(["draft", "attachment", "scope", "workspace generation"])(
    "drops a deferred image-atom paste when %s authority becomes stale",
    async () => {
      const workspace = workspaceValue({
        nodeKind: "image",
        title: "beforeafter",
        imageOffsetUtf16: 6,
        attachments: [attachment({ id: "image-1", nodeId: "project" })]
      });
      const registry = createNotesImageAtomEditorRegistry();
      let generation = 1;
      const capture = vi.fn(() => ({ generation }));
      const isCurrent = vi.fn(
        (authority: { generation: number }) => authority.generation === generation
      );
      Object.assign(workspace, {
        registerActiveImageAtomEditor: (editor: Parameters<typeof registry.register>[0]) =>
          registry.register(editor),
        claimActiveImageAtomPaste: (event: ClipboardEvent) =>
          registry.claimPaste(event),
        captureImageAtomPasteAuthority: capture,
        isImageAtomPasteAuthorityCurrent: isCurrent
      });
      renderZoomedOutline(workspace);

      const editor = screen.getByRole("textbox", { name: "Image note" });
      editor.focus();
      fireEvent.click(
        editor.querySelector<HTMLElement>("[data-image-atom-region=atom]")!
      );
      const paste = await deferredInternalImagePaste(editor);
      fireEvent(editor, paste.event);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      generation += 1;
      await act(async () => {
        paste.settle();
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => expect(isCurrent).toHaveBeenCalled());
      expect(paste.event.defaultPrevented).toBe(true);
      expect(workspace.actions.applyImageAtomPaste).not.toHaveBeenCalled();
      expect(capture).toHaveBeenCalledOnce();
    }
  );

  it("exposes an attachment target only for a writable page header", () => {
    const view = render(zoomedOutline(workspaceValue()));
    const header = screen
      .getByRole("heading", { name: "Project", level: 1 })
      .closest("header");
    expect(header).toHaveAttribute("data-notes-attachment-target", "project");

    view.rerender(
      zoomedOutline(workspaceValue({ deletingNotesData: true }))
    );
    expect(
      screen.getByRole("heading", { name: "Project", level: 1 }).closest("header")
    ).not.toHaveAttribute("data-notes-attachment-target");

    view.rerender(zoomedOutline(workspaceValue({ libraryView: "archive" })));
    expect(
      screen.getByRole("heading", { name: "Project", level: 1 }).closest("header")
    ).not.toHaveAttribute("data-notes-attachment-target");
  });

  it("renders page-root attachments and retry UI immediately below the header note", async () => {
    const user = userEvent.setup();
    const image = attachment({ id: "image-1", nodeId: "project" });
    const workspace = workspaceValue({
      attachments: [image],
      attachmentUploadError: "Image upload failed: disk full",
      attachmentUploadRetryAttemptId: "attempt-1"
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
    expect(workspace.actions.retryImageUpload).toHaveBeenCalledWith(
      "project",
      "attempt-1"
    );
  });

  it("renders image-node upload status without a legacy list and retries the exact attempt", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue({
      nodeKind: "image",
      title: "diagram.png",
      attachments: [attachment({ id: "image-1", nodeId: "project" })],
      attachmentUploadError: "Image upload failed: disk full",
      attachmentUploadRetryAttemptId: "image-attempt-1"
    });
    renderZoomedOutline(workspace);

    const header = screen
      .getByRole("heading", { name: "diagram.png", level: 1 })
      .closest<HTMLElement>(".notes-page-header")!;
    const alert = within(header).getByRole("alert", {
      name: "Image upload failed"
    });
    expect(alert).toHaveTextContent("disk full");
    expect(header.querySelector(".notes-attachment-list")).toBeNull();
    expect(
      within(header).getAllByRole("group", { name: "Image: diagram.png" })
    ).toHaveLength(1);

    await user.click(
      within(alert).getByRole("button", { name: "Retry image upload" })
    );
    expect(workspace.actions.retryImageUpload).toHaveBeenCalledWith(
      "project",
      "image-attempt-1"
    );
  });

  it.each([
    ["read-only", { libraryView: "archive" as const }],
    ["disabled", { deletingNotesData: true }]
  ])("does not offer image-header retry while %s", (_label, mode) => {
    renderZoomedOutline(
      workspaceValue({
        nodeKind: "image",
        title: "diagram.png",
        attachments: [attachment({ id: "image-1", nodeId: "project" })],
        attachmentUploadError: "Image upload failed: disk full",
        attachmentUploadRetryAttemptId: "image-attempt-1",
        ...mode
      })
    );

    const alert = screen.getByRole("alert", { name: "Image upload failed" });
    expect(alert).toHaveTextContent("disk full");
    expect(
      within(alert).queryByRole("button", { name: "Retry image upload" })
    ).toBeNull();
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

  it("creates a first child from plain Enter in the page title", () => {
    const workspace = renderZoomedOutline();
    const title = editTextareaByName("Edit page title");
    title.setSelectionRange(title.value.length, title.value.length);

    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);

    expect(workspace.actions.createChild).toHaveBeenCalledOnce();
    expect(workspace.actions.createChild).toHaveBeenCalledWith(
      "project",
      "first"
    );
    expect(workspace.actions.splitNode).not.toHaveBeenCalled();
  });

  it("does not create a page child while Enter is composing", () => {
    const workspace = renderZoomedOutline();
    const title = editTextareaByName("Edit page title");

    expect(
      fireEvent.keyDown(title, { key: "Enter", isComposing: true })
    ).toBe(true);
    expect(workspace.actions.createChild).not.toHaveBeenCalled();
  });

  it("exits the page note to the next visible title with its live value", () => {
    const workspace = renderZoomedOutline();
    const note = editTextareaByName("Supporting note: Project");
    expect(note).toHaveAttribute("rows", "1");
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(note, "Revised context");
    note.setSelectionRange(note.value.length, note.value.length);

    expect(fireEvent.keyDown(note, { key: "ArrowDown" })).toBe(false);

    expect(workspace.actions.updateNodeDraft).toHaveBeenLastCalledWith(
      "project",
      { title: "Project", note: "Revised context", imageOffsetUtf16: 0 },
      "note"
    );
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith("project");
    expect(workspace.actions.focusNode).toHaveBeenCalledWith("child");
  });

  it("moves page-note Shift+Enter to the next visible title with its live value", () => {
    const workspace = renderZoomedOutline();
    const note = editTextareaByName("Supporting note: Project");
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(note, "Revised context");

    expect(
      fireEvent.keyDown(note, { key: "Enter", shiftKey: true })
    ).toBe(false);
    expect(workspace.actions.updateNodeDraft).toHaveBeenLastCalledWith(
      "project",
      { title: "Project", note: "Revised context", imageOffsetUtf16: 0 },
      "note"
    );
    expect(workspace.actions.focusNode).toHaveBeenCalledWith("child");
    expect(workspace.actions.createChild).not.toHaveBeenCalled();
  });

  it("creates the first child from Shift+Enter in a childless page note", () => {
    const workspace = renderZoomedOutline(
      workspaceValue({ includeChild: false })
    );
    const note = editTextareaByName("Supporting note: Project");

    expect(
      fireEvent.keyDown(note, { key: "Enter", shiftKey: true })
    ).toBe(false);
    expect(workspace.actions.createChild).toHaveBeenCalledWith(
      "project",
      "first"
    );
    expect(
      vi.mocked(workspace.actions.updateNodeDraft).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(workspace.actions.createChild).mock.invocationCallOrder[0]
    );
  });

  it("exits the page note to its own title with Escape", () => {
    const workspace = renderZoomedOutline();
    const note = editTextareaByName("Supporting note: Project");

    expect(fireEvent.keyDown(note, { key: "Escape" })).toBe(false);

    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith("project");
    expect(workspace.actions.focusNode).toHaveBeenCalledWith("project");
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
      { title: "Renamed project", note: "", imageOffsetUtf16: 0 },
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

  it.each([
    ["Tab", false],
    ["Shift+Tab", true]
  ])("keeps page-title focus at the %s boundary", (_label, shiftKey) => {
    const workspace = renderZoomedOutline();
    const title = getTextareaByName("Edit page title");
    act(() => title.focus());

    expect(fireEvent.keyDown(title, { key: "Tab", shiftKey })).toBe(false);
    expect(title).toHaveFocus();
    expect(workspace.actions.moveNode).not.toHaveBeenCalled();
  });

  it("keeps zoom-root commands in the shared bullet menu", async () => {
    const user = userEvent.setup();
    const workspace = renderZoomedOutline();

    await user.click(
      screen.getByRole("button", { name: "More actions for Project" })
    );
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getAllByRole("menuitem").map((item) =>
        item.querySelector(":scope > span")?.textContent
      )
    ).toEqual([
      "Complete",
      "Star",
      "Edit note",
      "Add date",
      "Upload image",
      "Move To...",
      "Expand all",
      "Collapse all",
      "Sort A-Z",
      "Sort Z-A",
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

  it("moves a normal row to an active destination while excluding its subtree", async () => {
    const user = userEvent.setup();
    const workspace = renderZoomedOutline(
      workspaceValue({ includeOtherRoot: true })
    );

    await user.click(
      screen.getByRole("button", { name: "More actions for First child" })
    );
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Move To..."
      })
    );

    expect(screen.getByRole("option", { name: "Top level" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Project" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Inbox" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "First child" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Detail" }))
      .not.toBeInTheDocument();

    const search = screen.getByRole("searchbox", {
      name: "Search move destinations"
    });
    await user.type(search, "Inbox");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(workspace.actions.moveNode).toHaveBeenCalledOnce();
    expect(workspace.actions.moveNode).toHaveBeenCalledWith(
      { id: "child", parentId: "inbox", afterId: null },
      "child"
    );
  });

  it.each(["starred", "recent", "tags"] as const)(
    "moves rows from the %s projection using its full-active snapshot",
    async (libraryView) => {
      const user = userEvent.setup();
      const workspace = workspaceValue({ libraryView });
      const prepared = preparedMove(
        "child",
        moveScopeForView(libraryView)
      );
      workspace.prepareMoveNode = vi.fn().mockResolvedValue(prepared);
      workspace.commitPreparedMove = vi.fn().mockResolvedValue({ ok: true });
      renderZoomedOutline(workspace);

      await user.click(
        screen.getByRole("button", { name: "More actions for First child" })
      );
      await user.click(
        within(await screen.findByRole("menu")).getByRole("menuitem", {
          name: "Move To..."
        })
      );
      await user.click(await screen.findByRole("option", { name: "Inbox" }));

      expect(workspace.prepareMoveNode).toHaveBeenCalledWith("child");
      expect(workspace.commitPreparedMove).toHaveBeenCalledWith(
        prepared,
        "inbox"
      );
      expect(workspace.actions.moveNode).not.toHaveBeenCalled();
    }
  );

  it.each(["starred", "recent", "tags"] as const)(
    "moves page headers from the %s projection using its full-active snapshot",
    async (libraryView) => {
      const user = userEvent.setup();
      const workspace = workspaceValue({ libraryView });
      const prepared = preparedMove(
        "project",
        moveScopeForView(libraryView)
      );
      workspace.prepareMoveNode = vi.fn().mockResolvedValue(prepared);
      workspace.commitPreparedMove = vi.fn().mockResolvedValue({ ok: true });
      renderZoomedOutline(workspace);

      await user.click(
        screen.getByRole("button", { name: "More actions for Project" })
      );
      await user.click(
        within(await screen.findByRole("menu")).getByRole("menuitem", {
          name: "Move To..."
        })
      );
      await user.click(await screen.findByRole("option", { name: "Inbox" }));

      expect(workspace.prepareMoveNode).toHaveBeenCalledWith("project");
      expect(workspace.commitPreparedMove).toHaveBeenCalledWith(
        prepared,
        "inbox"
      );
      expect(workspace.actions.moveNode).not.toHaveBeenCalled();
    }
  );

  it("commits the root destination from the row snapshot", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue({ libraryView: "starred" });
    const prepared = preparedMove("child", { kind: "starred" });
    workspace.prepareMoveNode = vi.fn().mockResolvedValue(prepared);
    workspace.commitPreparedMove = vi.fn().mockResolvedValue({ ok: true });
    renderZoomedOutline(workspace);

    await user.click(
      screen.getByRole("button", { name: "More actions for First child" })
    );
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Move To..."
      })
    );
    await user.click(
      await screen.findByRole("option", { name: "Top level" })
    );

    expect(workspace.commitPreparedMove).toHaveBeenCalledWith(prepared, null);
  });

  it("keeps a page Move To chooser open when its prepared target was removed", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue({ libraryView: "recent" });
    const prepared = preparedMove("project", { kind: "recent" });
    workspace.prepareMoveNode = vi.fn().mockResolvedValue(prepared);
    workspace.commitPreparedMove = vi.fn().mockResolvedValue({
      ok: false,
      error: "That destination is no longer active. Refresh Move To."
    });
    renderZoomedOutline(workspace);

    await user.click(
      screen.getByRole("button", { name: "More actions for Project" })
    );
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Move To..."
      })
    );
    await user.click(await screen.findByRole("option", { name: "Inbox" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "destination is no longer active"
    );
    expect(screen.getByRole("menu")).toBeVisible();
  });

  it("gives the page root subtree actions and readable timestamps", async () => {
    const user = userEvent.setup();
    const workspace = renderZoomedOutline();

    await user.click(
      screen.getByRole("button", { name: "More actions for Project" })
    );
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText(/^Created /)).toBeVisible();
    expect(within(menu).getByText(/^Changed /)).toBeVisible();
    await user.click(
      within(menu).getByRole("menuitem", { name: "Sort A-Z" })
    );

    expect(workspace.actions.sortSubtreeAscending).toHaveBeenCalledWith(
      "project"
    );
  });

  it("disables subtree command re-entry while a page action is pending", async () => {
    let resolveExpand!: (outcome: NotesWorkspaceCommandOutcome) => void;
    const workspace = workspaceValue();
    workspace.actions.expandAll = vi.fn(
      () =>
        new Promise<NotesWorkspaceCommandOutcome>((resolve) => {
          resolveExpand = resolve;
        })
    );
    const user = userEvent.setup();
    renderZoomedOutline(workspace);
    const trigger = screen.getByRole("button", {
      name: "More actions for Project"
    });

    await user.click(trigger);
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Expand all"
      })
    );
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await user.click(trigger);
    const pendingCommand = within(await screen.findByRole("menu")).getByRole(
      "menuitem",
      { name: "Expand all" }
    );
    expect(pendingCommand).toHaveAttribute("data-disabled");
    await user.dblClick(pendingCommand);
    expect(workspace.actions.expandAll).toHaveBeenCalledOnce();

    await act(async () => {
      resolveExpand("committed");
      await Promise.resolve();
    });
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
      { title: "Plan 07/11/2026", note: "Context", imageOffsetUtf16: 0 },
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
      , imageOffsetUtf16: 0}
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
      { title: "Plan 07/12/2026", note: "Context", imageOffsetUtf16: 0 },
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
      , imageOffsetUtf16: 0}
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

  it("adds dates to an image description without changing the hidden filename", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue({
      nodeKind: "image",
      title: "diagram.png",
      note: "Context",
      attachments: [attachment({ id: "image-1", nodeId: "project" })]
    });
    render(zoomedOutline(workspace));

    await user.click(
      screen.getByRole("button", { name: "More actions for Image" })
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
      {
        title: "diagram.png",
        note: "Context 07/12/2026",
        imageOffsetUtf16: 0
      },
      "note"
    );
    expect(workspace.actions.updateNodeDraft).not.toHaveBeenCalledWith(
      "project",
      expect.objectContaining({ title: expect.stringContaining("07/12/2026") }),
      "title"
    );
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
      {
        title: "Plan 07/12/2026 next",
        note: "Context",
        imageOffsetUtf16: 0
      },
      "title"
    );
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledOnce();
  });

  it.each([
    ["disabled", { deletingNotesData: true }, "aria-disabled"],
    ["read-only", { libraryView: "archive" as const }, "aria-readonly"]
  ])("keeps %s title and note presentations noneditable", async (
    _label,
    mode,
    stateAttribute
  ) => {
    const user = userEvent.setup();
    const workspace = workspaceValue({
      ...mode,
      title: "Project 07/12/2026",
      note: "Page note 07/13/2026",
      childTitle: "Child 07/14/2026",
      childNote: "Child note 07/15/2026"
    });
    const { container } = render(zoomedOutline(workspace));

    const titlePresentation = screen.getByRole("group", {
      name: "Page title"
    });
    const notePresentation = screen.getByRole("group", {
      name: "Supporting note: Project 07/12/2026"
    });
    expect(titlePresentation).toHaveAttribute("tabindex", "-1");
    expect(notePresentation).toHaveAttribute("tabindex", "-1");
    expect(titlePresentation).toHaveAttribute(stateAttribute, "true");
    expect(notePresentation).toHaveAttribute(stateAttribute, "true");
    expect(
      screen.queryByRole("group", { name: "Edit page title" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Page title" })
    ).not.toBeInTheDocument();
    expect(getTextareaByName("Edit page title")).toHaveAttribute(
      "aria-hidden",
      "true"
    );

    expect(
      screen.queryByRole("button", { name: /^Edit date / })
    ).not.toBeInTheDocument();
    const pills = container.querySelectorAll(".notes-date-token");
    expect(pills.length).toBeGreaterThanOrEqual(2);
    await user.click(pills[0] as HTMLElement);
    fireEvent.pointerDown(titlePresentation);
    fireEvent.keyDown(titlePresentation, { key: "Enter" });
    expect(
      screen.queryByRole("dialog", { name: "Choose date" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Page title" })
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
      {
        title: "🚀 #today today and ",
        note: "Context",
        imageOffsetUtf16: 0
      },
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
          , imageOffsetUtf16: 0}
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
      {
        title: "Plan #tag",
        note: "Window 07-14-26 - 07-16-26 only",
        imageOffsetUtf16: 0
      },
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
          , imageOffsetUtf16: 0}
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
      {
        title: "Child 07/14/2026",
        note: "Follow up ",
        imageOffsetUtf16: 0
      },
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
      { title: "Project", note: "", imageOffsetUtf16: 0 },
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
          , imageOffsetUtf16: 0}
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

  it("collapses a revealed empty page note on ordinary blur", async () => {
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
      , imageOffsetUtf16: 0}
    });
    view.rerender(zoomedOutline(clearedWorkspace));

    const clearedNote = getTextareaByName("Supporting note: Project");
    expect(clearedNote).toHaveValue("");
    fireEvent.blur(clearedNote);
    await waitFor(() =>
      expect(
        queryTextareaByName("Supporting note: Project")
      ).not.toBeInTheDocument()
    );
    expect(clearedWorkspace.actions.flushNodeDraft).toHaveBeenCalledWith(
      "project"
    );
  });

  it("normalizes a whitespace-only page note before flushing it", async () => {
    const workspace = workspaceValue({
      draft: {
        title: "Project",
        note: " \t ",
        revision: 1,
        status: "pending"
      , imageOffsetUtf16: 0}
    });
    const view = render(zoomedOutline(workspace));
    const note = editTextareaByName("Supporting note: Project");

    fireEvent.blur(note);

    expect(workspace.actions.updateNodeDraft).toHaveBeenCalledWith(
      "project",
      { title: "Project", note: "", imageOffsetUtf16: 0 },
      "note"
    );
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith("project");
    view.rerender(
      zoomedOutline(
        workspaceValue({
          draft: {
            title: "Project",
            note: "",
            revision: 2,
            status: "pending"
          , imageOffsetUtf16: 0}
        })
      )
    );
    await waitFor(() =>
      expect(queryTextareaByName("Supporting note: Project")).not.toBeInTheDocument()
    );
  });

  it("keeps an empty page note mounted when its Add date picker owns blur", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue({ nodeKind: "image", note: "" });
    render(zoomedOutline(workspace));

    await user.click(screen.getByRole("button", { name: "More actions for Image" }));
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Add date"
      })
    );
    await screen.findByRole("dialog", { name: "Choose date" });
    const note = getTextareaByName("Supporting note: Image");
    vi.mocked(workspace.actions.flushNodeDraft).mockClear();
    vi.mocked(workspace.actions.updateNodeDraft).mockClear();
    fireEvent.blur(note);

    expect(queryTextareaByName("Supporting note: Image")).toBeInTheDocument();
    expect(workspace.actions.flushNodeDraft).not.toHaveBeenCalled();
    expect(workspace.actions.updateNodeDraft).not.toHaveBeenCalled();
  });

  it("keeps a blurred composing page note open until committed composition ends", async () => {
    const workspace = renderZoomedOutline(workspaceValue({ note: "" }));
    const title = editTextareaByName("Edit page title");
    fireEvent.keyDown(title, { key: "Enter", shiftKey: true });
    const note = getTextareaByName("Supporting note: Project");

    fireEvent.compositionStart(note);
    note.blur();
    expect(queryTextareaByName("Supporting note: Project")).toBeInTheDocument();

    fireEvent.compositionEnd(note, { target: { value: "Committed IME note" } });

    await waitFor(() =>
      expect(workspace.actions.updateNodeDraft).toHaveBeenLastCalledWith(
        "project",
        {
          title: "Project",
          note: "Committed IME note",
          imageOffsetUtf16: 0
        },
        "note"
      )
    );
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(workspace.actions.updateNodeDraft).mock.invocationCallOrder.at(-1)
    ).toBeLessThan(
      vi.mocked(workspace.actions.flushNodeDraft).mock.invocationCallOrder.at(-1) ??
        Number.POSITIVE_INFINITY
    );
    expect(queryTextareaByName("Supporting note: Project")).toBeInTheDocument();
  });

  it("collapses a blurred composing page note after an empty composition ends", async () => {
    const workspace = renderZoomedOutline(workspaceValue({ note: "" }));
    const title = editTextareaByName("Edit page title");
    fireEvent.keyDown(title, { key: "Enter", shiftKey: true });
    const emptyNote = getTextareaByName("Supporting note: Project");
    fireEvent.compositionStart(emptyNote);
    emptyNote.blur();
    fireEvent.compositionEnd(emptyNote, { target: { value: "" } });

    await waitFor(() =>
      expect(queryTextareaByName("Supporting note: Project")).not.toBeInTheDocument()
    );
    expect(workspace.actions.updateNodeDraft).toHaveBeenCalledWith(
      "project",
      { title: "Project", note: "", imageOffsetUtf16: 0 },
      "note"
    );
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledTimes(1);
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
        , imageOffsetUtf16: 0}
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

  it("surfaces a workspace write-failure banner and wires its retry action", async () => {
    const user = userEvent.setup();
    const retryLastFailedWrite = vi.fn().mockResolvedValue(undefined);
    const writeError = Object.assign(new Error("Draft save failed"), {
      operation: "write" as const,
      code: "internal" as const,
      retryable: true
    });
    renderZoomedOutline(
      workspaceValue({ writeError, retryLastFailedWrite })
    );

    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("editing commands are paused");
    await user.click(
      within(banner).getByRole("button", { name: "Retry save" })
    );
    expect(retryLastFailedWrite).toHaveBeenCalledTimes(1);
  });

  it("hides the write-failure banner when there is no write error", () => {
    renderZoomedOutline(workspaceValue());
    expect(
      screen.queryByRole("button", { name: "Retry save" })
    ).not.toBeInTheDocument();
  });

  it("keeps a damaged image header in recovery without an editable atom host", () => {
    renderZoomedOutline(
      workspaceValue({
        nodeKind: "image",
        title: "missing.png",
        attachments: []
      })
    );

    expect(screen.queryByRole("textbox", { name: "Image note" })).toBeNull();
    expect(screen.getByRole("alert", { name: "Image unavailable" })).toBeVisible();
  });
});
