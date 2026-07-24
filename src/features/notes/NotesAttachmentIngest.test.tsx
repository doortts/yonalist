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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import type {
  NoteAttachment,
  NoteNode,
  PendingImageNodeByteItem
} from "../../domain/notes";
import { NotesAttachmentUiContext } from "./NotesAttachmentUiContext";
import type {
  NotesAttachmentUiBoundary,
  NotesNativeImageDropEvent
} from "./notesAttachmentController";
import { NotesDateTodayProvider } from "./NotesDatePickerIntegration";
import { NotesImageResidencyProvider } from "./NotesImageResidencyContext";
import { NotesOutlinePane } from "./NotesOutlinePane";
import {
  NotesActionsContext,
  NotesWorkspaceContext
} from "./NotesWorkspaceContext";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import type {
  NotesActionsSlice,
  UseNotesWorkspaceResult
} from "./useNotesWorkspace";
import {
  createNotesImageAtomEditorRegistry,
  type ImageAtomEditorSelectionAuthority,
  type NotesImageAtomEditorAuthority
} from "./notesImageAtomEditorRegistry";
import { ImageAtomEditor } from "./ImageAtomEditor";
import { NOTES_IMAGE_ATOM_CLIPBOARD_MIME } from "./notesImageAtomClipboard";
import type { NotesImageAtomCutAuthority } from "./notesWorkspaceTypes";

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
    createdAt: "2026-07-13T00:00:00Z",
    updatedAt: "2026-07-13T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    imageOffsetUtf16: 0,
    ...overrides,
    markerKind: overrides.markerKind ?? "bullet",
    markdownImageWidth: overrides.markdownImageWidth ?? null
  };
}

function attachment(nodeId: string): NoteAttachment {
  return {
    id: `attachment-${nodeId}`,
    nodeId,
    sortKey: 1024,
    relativePath: `notes-assets/${"a".repeat(64)}.png`,
    contentHash: "a".repeat(64),
    originalName: "existing.png",
    mimeType: "image/png",
    byteSize: 1,
    intrinsicWidth: 320,
    intrinsicHeight: 200,
    displayWidth: 320,
    createdAt: "2026-07-13T00:00:00Z",
    updatedAt: "2026-07-13T00:00:00Z"
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function clipboardItem(
  type: string,
  file: File | null,
  kind: DataTransferItem["kind"] = type.startsWith("image/")
    ? "file"
    : "string"
): DataTransferItem {
  return {
    kind,
    type,
    getAsFile: vi.fn(() => file),
    getAsString: vi.fn(),
    webkitGetAsEntry: vi.fn()
  } as unknown as DataTransferItem;
}

function clipboardItems(
  entries: readonly DataTransferItem[]
): DataTransferItemList {
  return Object.assign([...entries], {
    add: vi.fn(),
    clear: vi.fn(),
    remove: vi.fn()
  }) as unknown as DataTransferItemList;
}

function createClipboardPasteEvent(
  target: Element,
  entries: readonly DataTransferItem[]
) {
  return createEvent.paste(target, {
    bubbles: true,
    cancelable: true,
    clipboardData: { items: clipboardItems(entries), getData: () => "" }
  });
}

function pasteClipboardItems(
  target: Element,
  entries: readonly DataTransferItem[]
) {
  const event = createClipboardPasteEvent(target, entries);
  fireEvent(target, event);
  return event;
}

function workspaceValue(options: {
  zoomRootId?: string | null;
  selectedId?: string | null;
  firstNodeKind?: NoteNode["nodeKind"];
  firstIsReadonly?: boolean;
  firstTitle?: string;
  firstImageOffsetUtf16?: number;
  secondNodeKind?: NoteNode["nodeKind"];
  attachments?: NoteAttachment[];
  notesByNodeId?: Readonly<Record<string, string>>;
  attachmentNodeId?: string;
  attachmentUploadError?: string;
  attachmentUploadRetryAttemptId?: string;
  libraryView?: UseNotesWorkspaceResult["libraryView"];
  deletingNotesData?: boolean;
  status?: "loading" | "ready" | "error";
  importDroppedImagePaths?:
    | ((nodeId: string, paths: readonly string[]) => Promise<void>)
    | null;
  importClipboardImages?:
    | ((
        nodeId: string,
        items: readonly PendingImageNodeByteItem[]
      ) => Promise<void>)
    | null
    | undefined;
  importSubtree?: UseNotesWorkspaceResult["actions"]["importSubtree"];
  retryImageUpload?: UseNotesWorkspaceResult["actions"]["retryImageUpload"];
  secondNoteText?: string;
} = {}): UseNotesWorkspaceResult {
  const state = normalizeWorkspace({
    nodes: [
      node({
        id: "first",
        nodeKind: options.firstNodeKind ?? "text",
        title: options.firstTitle ?? "First",
        note: options.notesByNodeId?.first ?? "",
        isReadonly: options.firstIsReadonly,
        isCollapsed: true,
        imageOffsetUtf16: options.firstImageOffsetUtf16 ?? 0
      }),
      node({
        id: "second",
        nodeKind: options.secondNodeKind ?? "text",
        sortKey: 2,
        title: "Second",
        note: options.notesByNodeId?.second ?? options.secondNoteText ?? ""
      }),
      node({
        id: "child",
        parentId: "first",
        title: "Child",
        note: options.notesByNodeId?.child ?? ""
      })
    ],
    attachmentsByNodeId: options.attachments
      ? { first: options.attachments }
      : options.attachmentNodeId === undefined
        ? {}
        : {
              [options.attachmentNodeId]: [attachment(options.attachmentNodeId)]
            }
  });
  state.zoomRootId = options.zoomRootId ?? null;
  state.selectedId = options.selectedId ?? null;
  state.status = options.status ?? "ready";
  const resolved = () => vi.fn().mockResolvedValue(undefined);
  const actions = {
    acknowledgeFocus: resolved(),
    focusNode: resolved(),
    createRoot: resolved(),
    createNextTextSibling: resolved(),
    splitNode: resolved(),
    createChild: resolved(),
    updateNode: resolved(),
    setReadonly: resolved(),
    materializeGithubNotification: resolved(),
    refreshMaterializedGithubNotifications: resolved(),
    markMaterializedGithubNotificationRead: resolved(),
    setGithubGroupCollapsed: resolved(),
    updateNodeDraft: vi.fn(),
    flushNodeDraft: vi.fn().mockResolvedValue(true),
    flushAllDrafts: vi.fn().mockResolvedValue(true),
    applyImageAtomEdit: resolved(),
    applyImageAtomPaste: resolved(),
    moveNode: resolved(),
    applyBatch: resolved(),
    importSubtree: options.importSubtree ?? resolved(),
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
    deleteNodes: resolved(),
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
    importDroppedImagePaths:
      options.importDroppedImagePaths === null
        ? undefined
        : (options.importDroppedImagePaths ??
          vi.fn().mockResolvedValue(undefined)),
    importClipboardImages:
      "importClipboardImages" in options
        ? (options.importClipboardImages ?? undefined)
        : resolved(),
    retryImageUpload: options.retryImageUpload ?? resolved(),
    loadAttachmentBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
    resizeImage: resolved(),
    removeImage: resolved(),
    undo: resolved(),
    redo: resolved(),
    setImageImportMaxDisplayWidth: vi.fn(),
    setSelectionAnchor: vi.fn(),
    extendSelectionTo: vi.fn(),
    toggleSelectionNode: vi.fn(),
    clearSelection: vi.fn()
  } as UseNotesWorkspaceResult["actions"];
  const editorAuthority = {} as NotesImageAtomEditorAuthority;
  const cutAuthority = {} as NotesImageAtomCutAuthority;

  return {
    state,
    actions,
    deletingNotesData: options.deletingNotesData ?? false,
    libraryView: options.libraryView ?? "all",
    activeTagFilters: [],
    tagSummaries: [],
    locallyExpandedNodeIds: new Set(),
    draftsByNodeId: {},
    writeError: null,
    attachmentUploadErrorsByNodeId: options.attachmentUploadError
      ? { first: options.attachmentUploadError }
      : {},
    attachmentUploadRetryAttemptIdsByNodeId:
      options.attachmentUploadRetryAttemptId
        ? { first: options.attachmentUploadRetryAttemptId }
        : {},
    retryFailedDraft: resolved(),
    retryLastFailedWrite: resolved(),
    captureActiveImageAtomEditorAuthority: vi.fn(() => editorAuthority),
    captureImageAtomCutAuthority: vi.fn(() => cutAuthority),
    applyImageAtomCutWithAuthority: vi.fn(
      (_authority, nodeId, selection) =>
        actions.applyImageAtomEdit(nodeId, selection, {
          kind: "remove",
          replacementText: ""
        })
    ),
    status: state.status,
    loading: state.status === "loading",
    error: state.error
  };
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

function renderPane(
  workspace: UseNotesWorkspaceResult,
  subscribeToImageDrop: NotesAttachmentUiBoundary["subscribeToImageDrop"],
  initialVaultRoot = "/vault",
  actionsSlice: NotesActionsSlice | null = null
) {
  const attachmentUi: NotesAttachmentUiBoundary = {
    openImageFiles: vi.fn().mockResolvedValue(null),
    saveImageFile: vi.fn().mockResolvedValue(null),
    subscribeToImageDrop
  };
  let vaultRoot = initialVaultRoot;
  const content = (value: UseNotesWorkspaceResult, currentVaultRoot: string) => (
    <NotesDateTodayProvider today={{ year: 2026, month: 7, day: 13 }}>
      <VaultRootContext.Provider value={currentVaultRoot}>
        <NotesAttachmentUiContext.Provider value={attachmentUi}>
          <NotesActionsContext.Provider value={actionsSlice}>
            <NotesWorkspaceContext.Provider value={value}>
              <NotesImageResidencyProvider scopeKey={currentVaultRoot}>
                <div className="feature-pane-slot">
                  <NotesOutlinePane />
                </div>
              </NotesImageResidencyProvider>
            </NotesWorkspaceContext.Provider>
          </NotesActionsContext.Provider>
        </NotesAttachmentUiContext.Provider>
      </VaultRootContext.Provider>
    </NotesDateTodayProvider>
  );
  const view = render(content(workspace, vaultRoot));
  return Object.assign(view, {
    rerenderWorkspace(value: UseNotesWorkspaceResult, nextVaultRoot = vaultRoot) {
      vaultRoot = nextVaultRoot;
      view.rerender(content(value, vaultRoot));
    }
  });
}

type ImportClipboardImagesAction = NonNullable<
  UseNotesWorkspaceResult["actions"]["importClipboardImages"]
>;

type PasteScopeTransition = (
  currentAction: ImportClipboardImagesAction,
  currentWorkspace: UseNotesWorkspaceResult
) => {
  workspace: UseNotesWorkspaceResult;
  vaultRoot: string;
};

const pasteScopeTransitions: readonly [string, PasteScopeTransition][] = [
  [
    "a vault root switch",
    (_currentAction, currentWorkspace) => ({
      workspace: currentWorkspace,
      vaultRoot: "/next-vault"
    })
  ],
  [
    "an Archive transition",
    (currentAction) => ({
      workspace: workspaceValue({
        libraryView: "archive",
        importClipboardImages: currentAction
      }),
      vaultRoot: "/vault"
    })
  ],
  [
    "a Trash transition",
    (currentAction) => ({
      workspace: workspaceValue({
        libraryView: "trash",
        importClipboardImages: currentAction
      }),
      vaultRoot: "/vault"
    })
  ],
  [
    "a loading transition",
    (currentAction) => ({
      workspace: workspaceValue({
        status: "loading",
        importClipboardImages: currentAction
      }),
      vaultRoot: "/vault"
    })
  ],
  [
    "a deleting transition",
    (currentAction) => ({
      workspace: workspaceValue({
        deletingNotesData: true,
        importClipboardImages: currentAction
      }),
      vaultRoot: "/vault"
    })
  ],
  [
    "an import action identity replacement",
    () => ({
      workspace: workspaceValue({
        importClipboardImages: vi.fn().mockResolvedValue(undefined)
      }),
      vaultRoot: "/vault"
    })
  ]
];

const elementFromPoint = vi.fn(
  (_x: number, _y: number): Element | null => null
);
const originalElementFromPoint = Object.getOwnPropertyDescriptor(
  document,
  "elementFromPoint"
);

describe("Notes image ingest", () => {
  beforeAll(() => {
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: elementFromPoint
    });
  });

  beforeEach(() => {
    capturedImageAtomEditorProps.clear();
    elementFromPoint.mockReset();
    elementFromPoint.mockReturnValue(null);
  });

  afterAll(() => {
    if (originalElementFromPoint) {
      Object.defineProperty(
        document,
        "elementFromPoint",
        originalElementFromPoint
      );
    } else {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
  });

  it("moves one insertion line across writable rows while a filename badge follows the pointer", async () => {
    let nativeDrop: ((event: NotesNativeImageDropEvent) => void) | undefined;
    const importDroppedImagePaths = vi.fn().mockResolvedValue(undefined);
    const workspace = workspaceValue({ importDroppedImagePaths });
    const subscribe = vi.fn().mockImplementation(async (listener) => {
      nativeDrop = listener;
      return vi.fn();
    });
    renderPane(workspace, subscribe);
    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());

    const firstRow = document.querySelector<HTMLElement>(
      '[data-outline-id="first"]'
    )!;
    const secondRow = document.querySelector<HTMLElement>(
      '[data-outline-id="second"]'
    )!;
    const firstTitle = within(firstRow).getByRole("group", {
      name: "Edit node title"
    });
    const secondTitle = secondRow.querySelector("textarea")!;
    act(() => secondTitle.focus());
    expect(secondTitle).toHaveFocus();
    secondTitle.setSelectionRange(1, 4);
    elementFromPoint.mockReturnValue(firstTitle);

    act(() =>
      nativeDrop?.({
        type: "enter",
        paths: ["/incoming/from-enter.png", "/incoming/second.webp"],
        position: { x: 110, y: 80 }
      })
    );
    expect(firstRow).toHaveAttribute("data-image-drop-active", "true");
    const firstMarker = within(firstRow.closest("li")!).getByTestId(
      "notes-image-drop-position"
    );
    expect(firstMarker).toBeVisible();
    expect(firstMarker.previousElementSibling).toBe(firstRow);
    const dragPreview = screen.getByTestId("notes-attachment-drag-preview");
    expect(dragPreview).toHaveTextContent("from-enter.png");
    expect(dragPreview).toHaveTextContent("+1");
    expect(dragPreview).toHaveStyle({ left: "124px", top: "94px" });

    elementFromPoint.mockReturnValue(secondTitle);
    act(() =>
      nativeDrop?.({ type: "over", position: { x: 220, y: 180 } })
    );
    expect(firstRow).not.toHaveAttribute("data-image-drop-active");
    expect(
      within(firstRow.closest("li")!).queryByTestId(
        "notes-image-drop-position"
      )
    ).toBeNull();
    expect(secondRow).toHaveAttribute("data-image-drop-active", "true");
    const secondMarker = within(secondRow.closest("li")!).getByTestId(
      "notes-image-drop-position"
    );
    expect(secondMarker).toBeVisible();
    expect(secondMarker.previousElementSibling).toBe(secondRow);
    expect(dragPreview).toHaveStyle({ left: "234px", top: "194px" });

    act(() =>
      nativeDrop?.({
        type: "drop",
        paths: ["/incoming/one.png", "/incoming/two.webp"],
        position: { x: 220, y: 180 }
      })
    );
    expect(importDroppedImagePaths).toHaveBeenCalledOnce();
    expect(importDroppedImagePaths).toHaveBeenCalledWith("second", [
      "/incoming/one.png",
      "/incoming/two.webp"
    ]);
    expect(secondRow).not.toHaveAttribute("data-image-drop-active");
    expect(
      screen.queryByTestId("notes-image-drop-position")
    ).toBeNull();
    expect(screen.queryByTestId("notes-attachment-drag-preview")).toBeNull();
    expect(document.activeElement).toBe(secondTitle);
    expect(secondTitle.selectionStart).toBe(1);
    expect(secondTitle.selectionEnd).toBe(4);
    expect(workspace.state.nodesById.first.isCollapsed).toBe(true);
  });

  it("appends a Finder image to a zoomed page from its blank outline surface", async () => {
    let nativeDrop: ((event: NotesNativeImageDropEvent) => void) | undefined;
    const importDroppedImagePaths = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn().mockImplementation(async (listener) => {
      nativeDrop = listener;
      return vi.fn();
    });
    renderPane(
      workspaceValue({ zoomRootId: "first", importDroppedImagePaths }),
      subscribe
    );
    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    const outline = document.querySelector<HTMLElement>(".notes-outline-rows")!;
    const header = document.querySelector<HTMLElement>(".notes-page-header")!;
    elementFromPoint.mockReturnValue(outline);

    act(() =>
      nativeDrop?.({
        type: "enter",
        paths: ["/incoming/blank-page.png"],
        position: { x: 300, y: 420 }
      })
    );

    expect(header).toHaveAttribute("data-image-drop-active", "true");
    expect(screen.getByTestId("notes-image-drop-position")).toBeVisible();

    // Native backends can lose the final hit-test position while completing
    // the drop; the last highlighted insertion target remains authoritative.
    elementFromPoint.mockReturnValue(null);
    act(() =>
      nativeDrop?.({
        type: "drop",
        paths: ["/incoming/blank-page.png"],
        position: { x: 300, y: 420 }
      })
    );

    expect(importDroppedImagePaths).toHaveBeenCalledWith("first", [
      "/incoming/blank-page.png"
    ]);
    expect(screen.queryByTestId("notes-image-drop-position")).toBeNull();
  });

  it("renders a failed Finder drop on an image row with the exact retry and no legacy attachment list", async () => {
    const user = userEvent.setup();
    let nativeDrop: ((event: NotesNativeImageDropEvent) => void) | undefined;
    const importDroppedImagePaths = vi.fn().mockResolvedValue(undefined);
    const retryImageUpload = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn().mockImplementation(async (listener) => {
      nativeDrop = listener;
      return vi.fn();
    });
    const view = renderPane(
      workspaceValue({
        firstNodeKind: "image",
        attachmentNodeId: "first",
        importDroppedImagePaths
      }),
      subscribe
    );
    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    const row = document.querySelector<HTMLElement>(
      '[data-outline-id="first"]'
    )!;
    elementFromPoint.mockReturnValue(row);

    act(() =>
      nativeDrop?.({
        type: "drop",
        paths: ["/incoming/failed.png"],
        position: { x: 20, y: 20 }
      })
    );
    expect(importDroppedImagePaths).toHaveBeenCalledWith("first", [
      "/incoming/failed.png"
    ]);

    view.rerenderWorkspace(
      workspaceValue({
        firstNodeKind: "image",
        attachmentNodeId: "first",
        attachmentUploadError: "Image upload failed: disk full",
        attachmentUploadRetryAttemptId: "finder-attempt",
        importDroppedImagePaths,
        retryImageUpload
      })
    );
    const failedRow = document.querySelector<HTMLElement>(
      '[data-outline-id="first"]'
    )!;
    const alert = within(failedRow).getByRole("alert", {
      name: "Image upload failed"
    });
    expect(alert).toHaveTextContent("disk full");
    expect(failedRow.querySelector(".notes-attachment-list")).toBeNull();
    expect(
      within(failedRow).getAllByRole("group", {
        name: "Image: existing.png"
      })
    ).toHaveLength(1);
    expect(
      within(failedRow).queryByRole("group", { name: "Image: First" })
    ).toBeNull();

    await user.click(
      within(alert).getByRole("button", { name: "Retry image upload" })
    );
    expect(retryImageUpload).toHaveBeenCalledWith("first", "finder-attempt");

    view.rerenderWorkspace(
      workspaceValue({
        firstNodeKind: "image",
        attachmentNodeId: "first",
        attachmentUploadError: "Image upload failed: disk full",
        attachmentUploadRetryAttemptId: "finder-attempt",
        importDroppedImagePaths,
        retryImageUpload,
        libraryView: "archive"
      })
    );
    const readOnlyAlert = within(
      document.querySelector<HTMLElement>('[data-outline-id="first"]')!
    ).getByRole("alert", { name: "Image upload failed" });
    expect(
      within(readOnlyAlert).queryByRole("button", {
        name: "Retry image upload"
      })
    ).toBeNull();
  });

  it("clears previews on outside hits, leave, and rejected imports", async () => {
    let nativeDrop: ((event: NotesNativeImageDropEvent) => void) | undefined;
    const importDroppedImagePaths = vi
      .fn()
      .mockRejectedValue(new Error("unsupported image batch"));
    const subscribe = vi.fn().mockImplementation(async (listener) => {
      nativeDrop = listener;
      return vi.fn();
    });
    renderPane(workspaceValue({ importDroppedImagePaths }), subscribe);
    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());

    const row = document.querySelector<HTMLElement>(
      '[data-outline-id="second"]'
    )!;
    const title = within(row).getByRole("group", {
      name: "Edit node title"
    });
    const outside = document.createElement("button");
    document.body.append(outside);
    elementFromPoint.mockReturnValue(title);
    act(() =>
      nativeDrop?.({
        type: "enter",
        paths: ["/incoming/vector.svg"],
        position: { x: 40, y: 60 }
      })
    );
    expect(row).toHaveAttribute("data-image-drop-active", "true");

    elementFromPoint.mockReturnValue(outside);
    act(() =>
      nativeDrop?.({ type: "over", position: { x: 4, y: 6 } })
    );
    expect(row).not.toHaveAttribute("data-image-drop-active");
    expect(screen.getByTestId("notes-attachment-drag-preview")).toBeVisible();

    elementFromPoint.mockReturnValue(title);
    act(() =>
      nativeDrop?.({ type: "over", position: { x: 40, y: 60 } })
    );
    act(() => nativeDrop?.({ type: "leave" }));
    expect(screen.queryByTestId("notes-image-drop-position")).toBeNull();
    expect(screen.queryByTestId("notes-attachment-drag-preview")).toBeNull();

    elementFromPoint.mockReturnValue(title);
    act(() =>
      nativeDrop?.({
        type: "drop",
        paths: ["/incoming/vector.svg", "/incoming/photo.png"],
        position: { x: 40, y: 60 }
      })
    );
    expect(screen.queryByTestId("notes-image-drop-position")).toBeNull();
    expect(screen.queryByTestId("notes-attachment-drag-preview")).toBeNull();
    expect(importDroppedImagePaths).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("alert", { name: "Image drop failed" })
    ).toHaveTextContent("unsupported image batch");
  });

  it("clears native drag UI when the Notes feature slot becomes hidden", async () => {
    let nativeDrop: ((event: NotesNativeImageDropEvent) => void) | undefined;
    const subscribe = vi.fn().mockImplementation(async (listener) => {
      nativeDrop = listener;
      return vi.fn();
    });
    renderPane(workspaceValue(), subscribe);
    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());

    const row = document.querySelector<HTMLElement>(
      '[data-outline-id="first"]'
    )!;
    const slot = row.closest<HTMLElement>(".feature-pane-slot")!;
    elementFromPoint.mockReturnValue(row);
    act(() =>
      nativeDrop?.({
        type: "enter",
        paths: ["/incoming/hidden-pane.png"],
        position: { x: 60, y: 80 }
      })
    );
    expect(screen.getByTestId("notes-attachment-drag-preview")).toBeVisible();
    const marker = within(row.closest("li")!).getByTestId(
      "notes-image-drop-position"
    );
    expect(marker).toBeVisible();
    expect(marker.previousElementSibling).toBe(row);

    act(() => {
      slot.hidden = true;
    });

    await waitFor(() => {
      expect(screen.queryByTestId("notes-attachment-drag-preview")).toBeNull();
      expect(screen.queryByTestId("notes-image-drop-position")).toBeNull();
    });

    act(() =>
      nativeDrop?.({
        type: "enter",
        paths: ["/incoming/still-hidden.png"],
        position: { x: 60, y: 80 }
      })
    );
    expect(screen.queryByTestId("notes-attachment-drag-preview")).toBeNull();
    expect(screen.queryByTestId("notes-image-drop-position")).toBeNull();
  });

  it("reports subscription failure without disabling the image picker", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue();
    renderPane(
      workspace,
      vi.fn().mockRejectedValue(new Error("native listener unavailable"))
    );

    expect(
      await screen.findByRole("alert", { name: "Image drop failed" })
    ).toHaveTextContent("native listener unavailable");
    await user.click(screen.getByRole("button", { name: "More actions for First" }));
    await user.click(await screen.findByRole("menuitem", { name: "Upload image" }));
    expect(workspace.actions.uploadImage).toHaveBeenCalledWith("first");
    expect(workspace.actions.importClipboardImages).toBeTypeOf("function");
  });

  it("unlistens on unmount and immediately disposes a late subscription", async () => {
    const immediateUnlisten = vi.fn();
    const mounted = renderPane(
      workspaceValue(),
      vi.fn().mockResolvedValue(immediateUnlisten)
    );
    await waitFor(() => expect(immediateUnlisten).not.toHaveBeenCalled());
    mounted.unmount();
    expect(immediateUnlisten).toHaveBeenCalledOnce();

    const pending = deferred<() => void>();
    const lateUnlisten = vi.fn();
    const late = renderPane(workspaceValue(), vi.fn().mockReturnValue(pending.promise));
    late.unmount();
    await act(async () => pending.resolve(lateUnlisten));
    expect(lateUnlisten).toHaveBeenCalledOnce();
  });

  it("absorbs rejected cleanup on unmount and late subscription disposal", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const immediateRejectionObserved = vi.fn();
    const lateRejectionObserved = vi.fn();
    const rejectingCleanup = (message: string, observed: () => void) =>
      ({
        then: (
          _resolve: (value: void) => void,
          reject: (reason: unknown) => void
        ) => {
          observed();
          reject(new Error(message));
        }
      }) as Promise<void>;
    const immediateUnlisten = vi.fn(() =>
      rejectingCleanup("immediate cleanup failed", immediateRejectionObserved)
    );
    const immediate = renderPane(
      workspaceValue(),
      vi.fn().mockResolvedValue(immediateUnlisten)
    );

    try {
      await waitFor(() => expect(immediateUnlisten).not.toHaveBeenCalled());
      immediate.unmount();
      await act(async () => Promise.resolve());

      const pending = deferred<() => Promise<void>>();
      const lateUnlisten = vi.fn(() =>
        rejectingCleanup("late cleanup failed", lateRejectionObserved)
      );
      const late = renderPane(
        workspaceValue(),
        vi.fn().mockReturnValue(pending.promise)
      );
      late.unmount();
      await act(async () => pending.resolve(lateUnlisten));
      await act(async () => Promise.resolve());

      expect(immediateUnlisten).toHaveBeenCalledOnce();
      expect(lateUnlisten).toHaveBeenCalledOnce();
      expect(immediateRejectionObserved).toHaveBeenCalledOnce();
      expect(lateRejectionObserved).toHaveBeenCalledOnce();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });

  it("pastes one ordered mixed-flavor batch into the closest row without changing editor state", async () => {
    const pendingImport = deferred<void>();
    let pasteEvent: Event | undefined;
    let preventedWhenImported = false;
    const importClipboardImages = vi.fn(() => {
      preventedWhenImported = pasteEvent?.defaultPrevented ?? false;
      return pendingImport.promise;
    });
    const workspace = workspaceValue({
      selectedId: "second",
      importClipboardImages
    });
    const rootIdsBefore = [...workspace.state.rootIds];
    const childIdsBefore = JSON.stringify(workspace.state.childIdsByParent);
    const nodeIdsBefore = Object.keys(workspace.state.nodesById);
    renderPane(workspace, vi.fn().mockResolvedValue(vi.fn()));
    const firstRow = document.querySelector<HTMLElement>(
      '[data-outline-id="first"]'
    )!;
    const title = firstRow.querySelector<HTMLTextAreaElement>(
      "textarea.notes-node-title"
    )!;
    act(() => {
      title.focus();
      title.setSelectionRange(1, 4);
    });
    const first = new File(["first"], "first.png", { type: "image/png" });
    const second = new File(["second"], "second.jpg", {
      type: "image/jpeg"
    });
    pasteEvent = createClipboardPasteEvent(title, [
      clipboardItem("text/plain", null),
      clipboardItem("image/png", first),
      clipboardItem("text/html", null),
      clipboardItem("image/jpeg", second)
    ]);

    fireEvent(title, pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(preventedWhenImported).toBe(true);
    expect(importClipboardImages).toHaveBeenCalledOnce();
    expect(importClipboardImages).toHaveBeenCalledWith("first", [
      { blob: first, originalName: "first.png", mimeType: "image/png" },
      { blob: second, originalName: "second.jpg", mimeType: "image/jpeg" }
    ]);
    expect(document.activeElement).toBe(title);
    expect(title.selectionStart).toBe(1);
    expect(title.selectionEnd).toBe(4);
    expect(workspace.state.selectedId).toBe("second");
    expect(workspace.state.nodesById.first.isCollapsed).toBe(true);
    expect(workspace.state.rootIds).toEqual(rootIdsBefore);
    expect(workspace.state.childIdsByParent).toEqual(
      JSON.parse(childIdsBefore)
    );
    expect(Object.keys(workspace.state.nodesById)).toEqual(nodeIdsBefore);

    await act(async () => pendingImport.resolve(undefined));
    expect(document.activeElement).toBe(title);
    expect(title.selectionStart).toBe(1);
    expect(title.selectionEnd).toBe(4);
  });

  it("leaves ordinary text paste browser-owned", () => {
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    const workspace = workspaceValue({ importClipboardImages });
    renderPane(workspace, vi.fn().mockResolvedValue(vi.fn()));
    const title = document.querySelector<HTMLTextAreaElement>(
      '[data-outline-id="first"] textarea.notes-node-title'
    )!;

    const event = pasteClipboardItems(title, [
      clipboardItem("text/plain", null),
      clipboardItem("text/html", null)
    ]);

    expect(event.defaultPrevented).toBe(false);
    expect(importClipboardImages).not.toHaveBeenCalled();
  });

  it("ignores an older paste rejection after a newer paste succeeds first", async () => {
    const firstImport = deferred<void>();
    const secondImport = deferred<void>();
    const importClipboardImages = vi
      .fn()
      .mockReturnValueOnce(firstImport.promise)
      .mockReturnValueOnce(secondImport.promise);
    renderPane(
      workspaceValue({ importClipboardImages }),
      vi.fn().mockResolvedValue(vi.fn())
    );
    const title = document.querySelector(
      '[data-outline-id="first"] textarea.notes-node-title'
    )!;

    pasteClipboardItems(title, [
      clipboardItem(
        "image/png",
        new File(["first"], "first.png", { type: "image/png" })
      )
    ]);
    pasteClipboardItems(title, [
      clipboardItem(
        "image/png",
        new File(["second"], "second.png", { type: "image/png" })
      )
    ]);
    expect(importClipboardImages).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondImport.resolve(undefined);
      await secondImport.promise;
    });
    firstImport.reject(new Error("stale first failure"));
    await act(async () => {
      await firstImport.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(
      screen.queryByRole("alert", { name: "Image paste failed" })
    ).toBeNull();
  });

  it("keeps a newer paste error when the older paste rejects last", async () => {
    const firstImport = deferred<void>();
    const secondImport = deferred<void>();
    const importClipboardImages = vi
      .fn()
      .mockReturnValueOnce(firstImport.promise)
      .mockReturnValueOnce(secondImport.promise);
    renderPane(
      workspaceValue({ importClipboardImages }),
      vi.fn().mockResolvedValue(vi.fn())
    );
    const title = document.querySelector(
      '[data-outline-id="first"] textarea.notes-node-title'
    )!;

    pasteClipboardItems(title, [
      clipboardItem(
        "image/png",
        new File(["first"], "first.png", { type: "image/png" })
      )
    ]);
    pasteClipboardItems(title, [
      clipboardItem(
        "image/png",
        new File(["second"], "second.png", { type: "image/png" })
      )
    ]);

    secondImport.reject(new Error("current second failure"));
    await act(async () => {
      await secondImport.promise.catch(() => undefined);
      await Promise.resolve();
    });
    expect(
      screen.getByRole("alert", { name: "Image paste failed" })
    ).toHaveTextContent("Image paste failed: current second failure");

    firstImport.reject(new Error("stale first failure"));
    await act(async () => {
      await firstImport.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(
      screen.getByRole("alert", { name: "Image paste failed" })
    ).toHaveTextContent("Image paste failed: current second failure");
    expect(
      screen.getAllByRole("alert", { name: "Image paste failed" })
    ).toHaveLength(1);
  });

  it("settles a paste rejection after unmount without an unhandled rejection", async () => {
    const pendingImport = deferred<void>();
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const importClipboardImages = vi.fn(() => pendingImport.promise);
    const view = renderPane(
      workspaceValue({ importClipboardImages }),
      vi.fn().mockResolvedValue(vi.fn())
    );
    const title = document.querySelector(
      '[data-outline-id="first"] textarea.notes-node-title'
    )!;

    try {
      pasteClipboardItems(title, [
        clipboardItem(
          "image/png",
          new File(["pending"], "pending.png", { type: "image/png" })
        )
      ]);
      expect(importClipboardImages).toHaveBeenCalledOnce();
      view.unmount();

      pendingImport.reject(new Error("late paste failure"));
      await act(async () => {
        await pendingImport.promise.catch(() => undefined);
        await Promise.resolve();
      });

      expect(unhandled).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("alert", { name: "Image paste failed" })
      ).toBeNull();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });

  it.each(pasteScopeTransitions)(
    "ignores a deferred paste rejection after %s",
    async (_label, transition) => {
      const pendingImport = deferred<void>();
      const importClipboardImages = vi.fn(() => pendingImport.promise);
      const initialWorkspace = workspaceValue({ importClipboardImages });
      const view = renderPane(
        initialWorkspace,
        vi.fn().mockResolvedValue(vi.fn())
      );
      const title = document.querySelector(
        '[data-outline-id="first"] textarea.notes-node-title'
      )!;
      pasteClipboardItems(title, [
        clipboardItem(
          "image/png",
          new File(["scoped"], "scoped.png", { type: "image/png" })
        )
      ]);
      expect(importClipboardImages).toHaveBeenCalledOnce();

      const next = transition(importClipboardImages, initialWorkspace);
      view.rerenderWorkspace(next.workspace, next.vaultRoot);
      pendingImport.reject(new Error("stale scoped failure"));
      await act(async () => {
        await pendingImport.promise.catch(() => undefined);
        await Promise.resolve();
      });

      expect(
        screen.queryByRole("alert", { name: "Image paste failed" })
      ).toBeNull();
    }
  );

  it("keeps a deferred rejection current across an ordinary same-scope rerender", async () => {
    const pendingImport = deferred<void>();
    const importClipboardImages = vi.fn(() => pendingImport.promise);
    const view = renderPane(
      workspaceValue({ importClipboardImages }),
      vi.fn().mockResolvedValue(vi.fn())
    );
    const title = document.querySelector(
      '[data-outline-id="first"] textarea.notes-node-title'
    )!;
    pasteClipboardItems(title, [
      clipboardItem(
        "image/png",
        new File(["current"], "current.png", { type: "image/png" })
      )
    ]);

    view.rerenderWorkspace(
      workspaceValue({ selectedId: "second", importClipboardImages })
    );
    pendingImport.reject(new Error("same scope failure"));
    await act(async () => {
      await pendingImport.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(
      screen.getByRole("alert", { name: "Image paste failed" })
    ).toHaveTextContent("Image paste failed: same scope failure");
  });

  it("preserves an alert on same-scope rerender and clears it on scope change", async () => {
    const importClipboardImages = vi
      .fn()
      .mockRejectedValue(new Error("visible current failure"));
    const view = renderPane(
      workspaceValue({ importClipboardImages }),
      vi.fn().mockResolvedValue(vi.fn())
    );
    const title = document.querySelector(
      '[data-outline-id="first"] textarea.notes-node-title'
    )!;
    pasteClipboardItems(title, [
      clipboardItem(
        "image/png",
        new File(["visible"], "visible.png", { type: "image/png" })
      )
    ]);
    expect(
      await screen.findByRole("alert", { name: "Image paste failed" })
    ).toHaveTextContent("Image paste failed: visible current failure");

    const sameScopeWorkspace = workspaceValue({
      selectedId: "second",
      importClipboardImages
    });
    view.rerenderWorkspace(sameScopeWorkspace);
    expect(
      screen.getByRole("alert", { name: "Image paste failed" })
    ).toHaveTextContent("Image paste failed: visible current failure");

    view.rerenderWorkspace(sameScopeWorkspace, "/next-vault");
    expect(
      screen.queryByRole("alert", { name: "Image paste failed" })
    ).toBeNull();
  });

  it("routes supporting-note, page-title, header, and attachment-area pastes", () => {
    const scenarios: Array<{
      name: string;
      options: Parameters<typeof workspaceValue>[0];
      selector: string;
      nodeId: string;
    }> = [
      {
        name: "supporting-note",
        options: { notesByNodeId: { second: "Details" } },
        selector: '[data-outline-id="second"] textarea.notes-node-note',
        nodeId: "second"
      },
      {
        name: "page-title",
        options: { zoomRootId: "first" },
        selector: ".notes-page-title",
        nodeId: "first"
      },
      {
        name: "page-header",
        options: { zoomRootId: "first" },
        selector: ".notes-page-header",
        nodeId: "first"
      },
      {
        name: "page-attachments",
        options: { zoomRootId: "first", attachmentNodeId: "first" },
        selector: ".notes-page-attachments",
        nodeId: "first"
      }
    ];

    for (const scenario of scenarios) {
      const importClipboardImages = vi.fn().mockResolvedValue(undefined);
      const workspace = workspaceValue({
        ...scenario.options,
        importClipboardImages
      });
      const view = renderPane(
        workspace,
        vi.fn().mockResolvedValue(vi.fn())
      );
      const target = document.querySelector(scenario.selector)!;
      const image = new File([scenario.name], `${scenario.name}.png`, {
        type: "image/png"
      });

      const event = pasteClipboardItems(target, [
        clipboardItem("image/png", image)
      ]);

      expect(event.defaultPrevented, scenario.name).toBe(true);
      expect(importClipboardImages, scenario.name).toHaveBeenCalledOnce();
      expect(importClipboardImages, scenario.name).toHaveBeenCalledWith(
        scenario.nodeId,
        [{ blob: image, originalName: image.name, mimeType: "image/png" }]
      );
      view.unmount();
    }
  });

  it("uses the selected writable note only when the paste target has no note", async () => {
    const selectedImport = vi.fn().mockResolvedValue(undefined);
    const selectedView = renderPane(
      workspaceValue({
        selectedId: "second",
        importClipboardImages: selectedImport
      }),
      vi.fn().mockResolvedValue(vi.fn())
    );
    const targetless = document.querySelector(".notes-outline-list")!;
    const selectedImage = new File(["selected"], "selected.png", {
      type: "image/png"
    });

    const selectedEvent = pasteClipboardItems(targetless, [
      clipboardItem("image/png", selectedImage)
    ]);

    expect(selectedEvent.defaultPrevented).toBe(true);
    expect(selectedImport).toHaveBeenCalledWith("second", [
      {
        blob: selectedImage,
        originalName: "selected.png",
        mimeType: "image/png"
      }
    ]);
    selectedView.unmount();

    const noTargetImport = vi.fn().mockResolvedValue(undefined);
    renderPane(
      workspaceValue({ importClipboardImages: noTargetImport }),
      vi.fn().mockResolvedValue(vi.fn())
    );
    const noTarget = document.querySelector(".notes-outline-list")!;
    const noTargetEvent = pasteClipboardItems(noTarget, [
      clipboardItem("image/png", selectedImage)
    ]);

    expect(noTargetEvent.defaultPrevented).toBe(true);
    expect(noTargetImport).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("alert", { name: "Image paste failed" })
    ).toHaveTextContent("Select a note before pasting images.");
  });

  it("reports one extraction error without saving a partial batch or changing state", async () => {
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    const workspace = workspaceValue({
      selectedId: "first",
      importClipboardImages
    });
    const selectedIdBefore = workspace.state.selectedId;
    const collapsedBefore = workspace.state.nodesById.first.isCollapsed;
    const structureBefore = JSON.stringify({
      rootIds: workspace.state.rootIds,
      childIdsByParent: workspace.state.childIdsByParent,
      nodeIds: Object.keys(workspace.state.nodesById)
    });
    renderPane(workspace, vi.fn().mockResolvedValue(vi.fn()));
    const title = document.querySelector<HTMLTextAreaElement>(
      '[data-outline-id="first"] textarea.notes-node-title'
    )!;
    act(() => {
      title.focus();
      title.setSelectionRange(0, 2);
    });
    const readable = new File(["readable"], "readable.png", {
      type: "image/png"
    });

    const event = pasteClipboardItems(title, [
      clipboardItem("image/png", readable),
      clipboardItem("image/jpeg", null)
    ]);

    expect(event.defaultPrevented).toBe(true);
    expect(importClipboardImages).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("alert", { name: "Image paste failed" })
    ).toHaveTextContent("An image could not be read from the clipboard.");
    expect(
      screen.getAllByRole("alert", { name: "Image paste failed" })
    ).toHaveLength(1);
    expect(document.activeElement).toBe(title);
    expect(title.selectionStart).toBe(0);
    expect(title.selectionEnd).toBe(2);
    expect(workspace.state.selectedId).toBe(selectedIdBefore);
    expect(workspace.state.nodesById.first.isCollapsed).toBe(collapsedBefore);
    expect(
      JSON.stringify({
        rootIds: workspace.state.rootIds,
        childIdsByParent: workspace.state.childIdsByParent,
        nodeIds: Object.keys(workspace.state.nodesById)
      })
    ).toBe(structureBefore);
  });

  it("passes unnamed and unsupported image MIME items once and absorbs rejection", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const importClipboardImages = vi
      .fn()
      .mockRejectedValue(new Error("HEIC is unsupported"));
    renderPane(
      workspaceValue({ importClipboardImages }),
      vi.fn().mockResolvedValue(vi.fn())
    );
    const title = document.querySelector(
      '[data-outline-id="first"] textarea.notes-node-title'
    )!;
    const png = new File(["png"], "", { type: "image/png" });
    const heic = new File(["heic"], "", { type: "image/heic" });

    try {
      const event = pasteClipboardItems(title, [
        clipboardItem("image/png", png),
        clipboardItem("image/heic", heic)
      ]);

      expect(event.defaultPrevented).toBe(true);
      expect(importClipboardImages).toHaveBeenCalledOnce();
      expect(importClipboardImages).toHaveBeenCalledWith("first", [
        {
          blob: png,
          originalName: "clipboard-image-1.png",
          mimeType: "image/png"
        },
        {
          blob: heic,
          originalName: "clipboard-image-2",
          mimeType: "image/heic"
        }
      ]);
      expect(
        await screen.findByRole("alert", { name: "Image paste failed" })
      ).toHaveTextContent("Image paste failed: HEIC is unsupported");
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });

  it("reports a synchronous clipboard import throw without escaping the event", () => {
    const importClipboardImages = vi.fn(() => {
      throw new Error("clipboard import crashed");
    });
    renderPane(
      workspaceValue({ importClipboardImages }),
      vi.fn().mockResolvedValue(vi.fn())
    );
    const title = document.querySelector(
      '[data-outline-id="first"] textarea.notes-node-title'
    )!;
    const image = new File(["png"], "image.png", { type: "image/png" });

    expect(() =>
      pasteClipboardItems(title, [clipboardItem("image/png", image)])
    ).not.toThrow();
    expect(
      screen.getByRole("alert", { name: "Image paste failed" })
    ).toHaveTextContent("Image paste failed: clipboard import crashed");
    expect(importClipboardImages).toHaveBeenCalledOnce();
  });

  it("blocks clipboard image writes in read-only and unavailable states", () => {
    const scenarios: Array<
      [string, Parameters<typeof workspaceValue>[0], boolean]
    > = [
      ["archive", { libraryView: "archive" }, false],
      ["trash", { libraryView: "trash" }, false],
      ["loading", { status: "loading" }, false],
      ["deleting", { deletingNotesData: true }, false],
      ["missing action", { importClipboardImages: null }, true]
    ];

    for (const [name, options, missingAction] of scenarios) {
      const importClipboardImages = vi.fn().mockResolvedValue(undefined);
      const workspace = workspaceValue({
        ...options,
        selectedId: "first",
        importClipboardImages: missingAction ? null : importClipboardImages
      });
      const view = renderPane(
        workspace,
        vi.fn().mockResolvedValue(vi.fn())
      );
      const content = document.querySelector(".notes-outline-content")!;
      const image = new File([name], `${name}.png`, { type: "image/png" });

      const event = pasteClipboardItems(content, [
        clipboardItem("image/png", image)
      ]);

      expect(event.defaultPrevented, name).toBe(true);
      expect(importClipboardImages, name).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("alert", { name: "Image paste failed" }),
        name
      ).toBeNull();
      view.unmount();
    }
  });

  it("blocks clipboard image writes when there is no active vault root", () => {
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    renderPane(
      workspaceValue({
        selectedId: "first",
        importClipboardImages
      }),
      vi.fn().mockResolvedValue(vi.fn()),
      ""
    );
    const content = document.querySelector(".notes-outline-content")!;
    const image = new File(["no-vault"], "no-vault.png", {
      type: "image/png"
    });

    const event = pasteClipboardItems(content, [
      clipboardItem("image/png", image)
    ]);

    expect(event.defaultPrevented).toBe(true);
    expect(importClipboardImages).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("alert", { name: "Image paste failed" })
    ).toBeNull();
  });

  it("blocks Finder image drops when there is no active vault root", async () => {
    let nativeDrop: ((event: NotesNativeImageDropEvent) => void) | undefined;
    const importDroppedImagePaths = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn().mockImplementation(async (listener) => {
      nativeDrop = listener;
      return vi.fn();
    });
    renderPane(
      workspaceValue({
        importDroppedImagePaths
      }),
      subscribe,
      ""
    );
    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    const row = document.querySelector<HTMLElement>(
      '[data-outline-id="first"]'
    )!;
    elementFromPoint.mockReturnValue(row);

    act(() =>
      nativeDrop?.({
        type: "enter",
        paths: ["/incoming/no-vault.png"],
        position: { x: 20, y: 20 }
      })
    );
    expect(row).not.toHaveAttribute("data-image-drop-active");
    expect(screen.queryByTestId("notes-image-drop-position")).toBeNull();

    act(() =>
      nativeDrop?.({
        type: "drop",
        paths: ["/incoming/no-vault.png"],
        position: { x: 20, y: 20 }
      })
    );

    expect(importDroppedImagePaths).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("alert", { name: "Image drop failed" })
    ).toBeNull();
  });

  it("replaces a drop error with one paste error instead of overlapping alerts", async () => {
    renderPane(
      workspaceValue(),
      vi.fn().mockRejectedValue(new Error("native listener unavailable"))
    );
    expect(
      await screen.findByRole("alert", { name: "Image drop failed" })
    ).toHaveTextContent("native listener unavailable");
    const title = document.querySelector(
      '[data-outline-id="first"] textarea.notes-node-title'
    )!;

    const event = pasteClipboardItems(title, [
      clipboardItem("image/png", null)
    ]);

    expect(event.defaultPrevented).toBe(true);
    expect(
      await screen.findByRole("alert", { name: "Image paste failed" })
    ).toHaveTextContent("An image could not be read from the clipboard.");
    expect(
      screen.queryByRole("alert", { name: "Image drop failed" })
    ).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("routes clipboard-only row and page-header paste without enabling drop UI", async () => {
    let nativeDrop: ((event: NotesNativeImageDropEvent) => void) | undefined;
    const subscribe = vi.fn().mockImplementation(async (listener) => {
      nativeDrop = listener;
      return vi.fn();
    });
    const rowImport = vi.fn().mockResolvedValue(undefined);
    const rowView = renderPane(
      workspaceValue({
        selectedId: "second",
        importDroppedImagePaths: null,
        importClipboardImages: rowImport
      }),
      subscribe
    );
    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    const firstRow = document.querySelector<HTMLElement>(
      '[data-outline-id="first"]'
    )!;
    const firstTitle = firstRow.querySelector("textarea.notes-node-title")!;
    expect(firstRow).toHaveAttribute("data-notes-attachment-target", "first");

    pasteClipboardItems(firstTitle, [
      clipboardItem(
        "image/png",
        new File(["row"], "row.png", { type: "image/png" })
      )
    ]);

    expect(rowImport).toHaveBeenCalledWith("first", [
      expect.objectContaining({ originalName: "row.png" })
    ]);
    elementFromPoint.mockReturnValue(firstRow);
    act(() =>
      nativeDrop?.({
        type: "enter",
        paths: ["/incoming/drop.png"],
        position: { x: 20, y: 20 }
      })
    );
    expect(firstRow).not.toHaveAttribute("data-image-drop-active");
    expect(
      screen.queryByTestId("notes-image-drop-position")
    ).toBeNull();
    rowView.unmount();

    const pageImport = vi.fn().mockResolvedValue(undefined);
    const pageView = renderPane(
      workspaceValue({
        zoomRootId: "first",
        selectedId: "second",
        importDroppedImagePaths: null,
        importClipboardImages: pageImport
      }),
      vi.fn().mockResolvedValue(vi.fn())
    );
    const header = document.querySelector<HTMLElement>(".notes-page-header")!;
    const pageTitle = header.querySelector("textarea.notes-page-title")!;
    expect(header).toHaveAttribute("data-notes-attachment-target", "first");

    pasteClipboardItems(pageTitle, [
      clipboardItem(
        "image/png",
        new File(["page"], "page.png", { type: "image/png" })
      )
    ]);

    expect(pageImport).toHaveBeenCalledWith("first", [
      expect.objectContaining({ originalName: "page.png" })
    ]);
    expect(header).not.toHaveAttribute("data-image-drop-active");
    expect(
      screen.queryByTestId("notes-image-drop-position")
    ).toBeNull();
    pageView.unmount();
  });

  it("exposes targets only for active writable rows and a writable page header", async () => {
    let nativeDrop: ((event: NotesNativeImageDropEvent) => void) | undefined;
    const subscribe = vi.fn().mockImplementation(async (listener) => {
      nativeDrop = listener;
      return vi.fn();
    });
    const active = renderPane(workspaceValue(), subscribe);
    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    expect(
      document.querySelectorAll("[data-notes-attachment-target]")
    ).toHaveLength(2);
    const transitions: Array<
      [string, Parameters<typeof workspaceValue>[0]]
    > = [
      ["archive", { libraryView: "archive" }],
      ["trash", { libraryView: "trash" }],
      ["loading", { status: "loading" }],
      ["deleting", { deletingNotesData: true }]
    ];
    for (const [label, blockedOptions] of transitions) {
      const firstRow = document.querySelector<HTMLElement>(
        '[data-outline-id="first"]'
      )!;
      elementFromPoint.mockReturnValue(firstRow);
      act(() =>
        nativeDrop?.({
          type: "enter",
          paths: ["/incoming/one.png"],
          position: { x: 20, y: 20 }
        })
      );
      expect(firstRow, label).toHaveAttribute(
        "data-image-drop-active",
        "true"
      );
      expect(
        screen.getByTestId("notes-image-drop-position"),
        label
      ).toBeVisible();

      active.rerenderWorkspace(workspaceValue(blockedOptions));
      expect(
        document.querySelector("[data-notes-attachment-target]"),
        label
      ).toBeNull();
      expect(
        document.querySelector("[data-image-drop-active='true']"),
        label
      ).toBeNull();
      expect(
        screen.queryByTestId("notes-image-drop-position"),
        label
      ).toBeNull();

      active.rerenderWorkspace(workspaceValue());
      expect(
        document.querySelectorAll("[data-notes-attachment-target]"),
        label
      ).toHaveLength(2);
      expect(
        document.querySelector("[data-image-drop-active='true']"),
        label
      ).toBeNull();
      expect(
        screen.queryByTestId("notes-image-drop-position"),
        label
      ).toBeNull();
    }
    active.unmount();

    const zoomedSubscribe = vi.fn().mockResolvedValue(vi.fn());
    const zoomed = renderPane(
      workspaceValue({ zoomRootId: "first" }),
      zoomedSubscribe
    );
    await waitFor(() => expect(zoomedSubscribe).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("heading", { name: "First", level: 1 }).closest("header")
    ).toHaveAttribute("data-notes-attachment-target", "first");
    zoomed.unmount();

    for (const blocked of [
      workspaceValue({ libraryView: "archive" }),
      workspaceValue({ libraryView: "trash" }),
      workspaceValue({ status: "loading" }),
      workspaceValue({ deletingNotesData: true })
    ]) {
      const blockedPane = renderPane(
        blocked,
        vi.fn().mockResolvedValue(vi.fn())
      );
      expect(
        document.querySelector("[data-notes-attachment-target]")
      ).toBeNull();
      blockedPane.unmount();
    }
  });
});

type ClipboardEntry = {
  kind: "file" | "string";
  type: string;
  getAsFile: () => File | null;
};

function pngFile(name: string): File {
  return new File(["png-bytes"], name, { type: "image/png" });
}

function pasteEventInit(entries: readonly ClipboardEntry[], text = "") {
  const items = Object.assign(
    entries.map((entry) => ({
      kind: entry.kind,
      type: entry.type,
      getAsFile: entry.getAsFile,
      getAsString: vi.fn(),
      webkitGetAsEntry: vi.fn()
    })),
    { add: vi.fn(), clear: vi.fn(), remove: vi.fn() }
  );
  return {
    clipboardData: {
      items,
      getData: (format: string) => (format === "text/plain" ? text : "")
    }
  };
}

function textPasteEventInit(text: string) {
  return pasteEventInit([], text);
}

function titleTextarea(id: string): HTMLTextAreaElement {
  return document
    .querySelector(`[data-outline-id="${id}"]`)!
    .querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Edit node title"]'
    )!;
}

function noteTextarea(id: string, label: string): HTMLTextAreaElement {
  return document
    .querySelector(`[data-outline-id="${id}"]`)!
    .querySelector<HTMLTextAreaElement>(
      `textarea[aria-label="Supporting note: ${label}"]`
    )!;
}

function idleSubscribe() {
  return vi.fn().mockResolvedValue(vi.fn());
}

describe("clipboard Notes image paste ingest", () => {
  it("imports pasted image files on the title field and prevents the default paste", () => {
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    renderPane(workspaceValue({ importClipboardImages }), idleSubscribe());
    const file = pngFile("title-shot.png");

    const notPrevented = fireEvent.paste(
      titleTextarea("first"),
      pasteEventInit([
        { kind: "file", type: "image/png", getAsFile: () => file }
      ])
    );

    expect(notPrevented).toBe(false);
    expect(importClipboardImages).toHaveBeenCalledOnce();
    expect(importClipboardImages).toHaveBeenCalledWith("first", [
      { blob: file, originalName: "title-shot.png", mimeType: "image/png" }
    ]);
  });

  it("imports pasted image files on the note field and prevents the default paste", () => {
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    renderPane(
      workspaceValue({ importClipboardImages, secondNoteText: "existing" }),
      idleSubscribe()
    );
    const file = pngFile("note-shot.png");

    const notPrevented = fireEvent.paste(
      noteTextarea("second", "Second"),
      pasteEventInit([
        { kind: "file", type: "image/png", getAsFile: () => file }
      ])
    );

    expect(notPrevented).toBe(false);
    expect(importClipboardImages).toHaveBeenCalledOnce();
    expect(importClipboardImages).toHaveBeenCalledWith("second", [
      { blob: file, originalName: "note-shot.png", mimeType: "image/png" }
    ]);
  });

  it("leaves a text-only paste to the browser without importing", () => {
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    renderPane(workspaceValue({ importClipboardImages }), idleSubscribe());

    const notPrevented = fireEvent.paste(
      titleTextarea("first"),
      pasteEventInit([
        { kind: "string", type: "text/plain", getAsFile: () => null }
      ])
    );

    expect(notPrevented).toBe(true);
    expect(importClipboardImages).not.toHaveBeenCalled();
  });

  it("falls back to the browser when clipboard extraction reports a hard error", () => {
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    renderPane(workspaceValue({ importClipboardImages }), idleSubscribe());

    const notPrevented = fireEvent.paste(
      titleTextarea("first"),
      pasteEventInit([
        { kind: "string", type: "image/png", getAsFile: () => null }
      ])
    );

    expect(notPrevented).toBe(true);
    expect(importClipboardImages).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("recovers when reading a clipboard image throws", () => {
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    renderPane(workspaceValue({ importClipboardImages }), idleSubscribe());

    const notPrevented = fireEvent.paste(
      titleTextarea("first"),
      pasteEventInit([
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => {
            throw new Error("clipboard unreadable");
          }
        }
      ])
    );

    expect(notPrevented).toBe(true);
    expect(importClipboardImages).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("does not import while the workspace is gated by a busy load", () => {
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    renderPane(
      workspaceValue({ importClipboardImages, status: "loading" }),
      idleSubscribe()
    );
    const file = pngFile("blocked.png");

    const notPrevented = fireEvent.paste(
      titleTextarea("first"),
      pasteEventInit([
        { kind: "file", type: "image/png", getAsFile: () => file }
      ])
    );

    expect(notPrevented).toBe(true);
    expect(importClipboardImages).not.toHaveBeenCalled();
  });

  it("does not import when the clipboard capability is absent", () => {
    renderPane(
      workspaceValue({ importClipboardImages: undefined }),
      idleSubscribe()
    );
    const file = pngFile("no-capability.png");

    const notPrevented = fireEvent.paste(
      titleTextarea("first"),
      pasteEventInit([
        { kind: "file", type: "image/png", getAsFile: () => file }
      ])
    );

    expect(notPrevented).toBe(true);
  });
});

describe("paste import of indented plain text (plan Phase 4.4b)", () => {
  it("imports a multi-line indented paste as children of the current node and prevents the default paste", () => {
    const importSubtree = vi.fn().mockResolvedValue("committed");
    renderPane(workspaceValue({ importSubtree }), idleSubscribe());

    const notPrevented = fireEvent.paste(
      titleTextarea("second"),
      textPasteEventInit("Parent\n\tChild")
    );

    expect(notPrevented).toBe(false);
    expect(importSubtree).toHaveBeenCalledOnce();
    expect(importSubtree).toHaveBeenCalledWith("second", null, [
      {
        title: "Parent",
        children: [{ title: "Child", children: [] }]
      }
    ]);
  });

  it("imports after the current node's existing children rather than before them", () => {
    const importSubtree = vi.fn().mockResolvedValue("committed");
    renderPane(workspaceValue({ importSubtree }), idleSubscribe());

    // "first" already has one child ("child"); the import should land after it.
    const notPrevented = fireEvent.paste(
      titleTextarea("first"),
      textPasteEventInit("Alpha\nBeta")
    );

    expect(notPrevented).toBe(false);
    expect(importSubtree).toHaveBeenCalledWith("first", "child", [
      { title: "Alpha", children: [] },
      { title: "Beta", children: [] }
    ]);
  });

  it("leaves a single-line paste to the default browser paste (not an import)", () => {
    const importSubtree = vi.fn().mockResolvedValue("committed");
    renderPane(workspaceValue({ importSubtree }), idleSubscribe());

    const notPrevented = fireEvent.paste(
      titleTextarea("second"),
      textPasteEventInit("Just one line")
    );

    expect(notPrevented).toBe(true);
    expect(importSubtree).not.toHaveBeenCalled();
  });

  it("lets a pasted clipboard image take precedence over structural text import", () => {
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    const importSubtree = vi.fn().mockResolvedValue("committed");
    renderPane(
      workspaceValue({ importClipboardImages, importSubtree }),
      idleSubscribe()
    );
    const file = pngFile("both.png");

    const notPrevented = fireEvent.paste(
      titleTextarea("second"),
      pasteEventInit(
        [{ kind: "file", type: "image/png", getAsFile: () => file }],
        "Parent\n\tChild"
      )
    );

    expect(notPrevented).toBe(false);
    expect(importClipboardImages).toHaveBeenCalledOnce();
    expect(importSubtree).not.toHaveBeenCalled();
  });

  it("does not import a subtree while the workspace is gated by a busy load", () => {
    const importSubtree = vi.fn().mockResolvedValue("committed");
    renderPane(
      workspaceValue({ importSubtree, status: "loading" }),
      idleSubscribe()
    );

    const notPrevented = fireEvent.paste(
      titleTextarea("second"),
      textPasteEventInit("Parent\n\tChild")
    );

    expect(notPrevented).toBe(true);
    expect(importSubtree).not.toHaveBeenCalled();
  });

  it("does not import a subtree when pasted into the note body (Workflowy semantics: notes are free multi-line text)", () => {
    const importSubtree = vi.fn().mockResolvedValue("committed");
    renderPane(
      workspaceValue({ importSubtree, secondNoteText: "existing" }),
      idleSubscribe()
    );

    const notPrevented = fireEvent.paste(
      noteTextarea("second", "Second"),
      textPasteEventInit("Parent\n\tChild")
    );

    // Subtree import is a title-only affordance; the note body always falls
    // through to the default browser text paste, unprevented.
    expect(notPrevented).toBe(true);
    expect(importSubtree).not.toHaveBeenCalled();
  });

  it("still lets a pasted clipboard image take precedence over default paste on the note body", () => {
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    const importSubtree = vi.fn().mockResolvedValue("committed");
    renderPane(
      workspaceValue({
        importClipboardImages,
        importSubtree,
        secondNoteText: "existing"
      }),
      idleSubscribe()
    );
    const file = pngFile("note-body-image.png");

    const notPrevented = fireEvent.paste(
      noteTextarea("second", "Second"),
      pasteEventInit(
        [{ kind: "file", type: "image/png", getAsFile: () => file }],
        "Parent\n\tChild"
      )
    );

    expect(notPrevented).toBe(false);
    expect(importClipboardImages).toHaveBeenCalledOnce();
    expect(importSubtree).not.toHaveBeenCalled();
  });

  it("renders a valid image row as one editor while damaged image rows remain recovery-only", () => {
    const valid = workspaceValue({
      firstNodeKind: "image",
      attachmentNodeId: "first"
    });
    const view = renderPane(valid, idleSubscribe());

    const row = document.querySelector<HTMLElement>('[data-outline-id="first"]')!;
    const editor = within(row).getByRole("textbox", { name: "Image note" });
    expect(editor.querySelectorAll("[data-image-atom-region]")).toHaveLength(3);
    expect(within(editor).getByRole("group", { name: "Image: existing.png" })).toBeVisible();

    view.rerenderWorkspace(workspaceValue({ firstNodeKind: "image" }));
    const damagedRow = document.querySelector<HTMLElement>('[data-outline-id="first"]')!;
    expect(within(damagedRow).queryByRole("textbox", { name: "Image note" })).toBeNull();
    expect(within(damagedRow).getByRole("alert", { name: "Image unavailable" })).toBeVisible();
  });

  it("commits an image atom cut through a writable outline row", async () => {
    const workspace = workspaceValue({
      firstNodeKind: "image",
      attachmentNodeId: "first"
    });
    const applyImageAtomEdit = vi.fn().mockResolvedValue("committed");
    workspace.actions.applyImageAtomEdit = applyImageAtomEdit;
    renderPane(workspace, idleSubscribe());

    expect(
      within(document.querySelector<HTMLElement>('[data-outline-id="first"]')!)
        .getByRole("textbox", { name: "Image note" })
        .querySelectorAll("[data-image-atom-region]")
    ).toHaveLength(3);
    const props = capturedImageAtomEditorProps.get("first")!;
    const selection = { anchorUtf16: 0, focusUtf16: 1 };
    const selectionAuthority = {} as ImageAtomEditorSelectionAuthority;

    await expect(props.loadAttachmentBytes!("first")).resolves.toEqual(
      new Uint8Array([1]),
    );
    expect(workspace.actions.loadAttachmentBytes).toHaveBeenCalledWith("first");
    await expect(
      props.onAtomCut!({ selection, selectionAuthority })
    ).resolves.toBe(true);
    expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith("first");
    expect(workspace.captureActiveImageAtomEditorAuthority).toHaveBeenCalledWith(
      "first",
      selectionAuthority
    );
    expect(workspace.captureImageAtomCutAuthority).toHaveBeenCalledWith(
      "first",
      expect.any(Object)
    );
    expect(workspace.applyImageAtomCutWithAuthority).toHaveBeenCalledWith(
      expect.any(Object),
      "first",
      selection
    );
    expect(applyImageAtomEdit).toHaveBeenCalledOnce();
    expect(applyImageAtomEdit).toHaveBeenCalledWith("first", selection, {
      kind: "remove",
      replacementText: ""
    });
  });

  it("keeps readonly image text and copy parity while protecting atom mutations", () => {
    const workspace = workspaceValue({
      firstNodeKind: "image",
      firstIsReadonly: true,
      attachmentNodeId: "first"
    });
    renderPane(workspace, idleSubscribe());

    const row = document.querySelector<HTMLElement>(
      '[data-outline-id="first"]'
    )!;
    const props = capturedImageAtomEditorProps.get("first")!;
    expect(props.readOnly).not.toBe(true);
    expect(props.onDraftChange).toBeTypeOf("function");
    expect(row).not.toHaveAttribute("data-notes-attachment-target");
    expect(props.atomReadOnly).toBe(true);
    expect(props.onEnter).toBeTypeOf("function");
    expect(props.onSupportingNote).toBeTypeOf("function");
    expect(props.onUnhandledKeyDown).toBeTypeOf("function");
    expect(props.onFocusLeave).toBeTypeOf("function");
    expect(props.onAtomDelete).toBeUndefined();
    expect(props.onImageAtomPaste).toBeTypeOf("function");
    expect(props.onAtomCut).toBeUndefined();
    expect(props.onRemoveImage).toBeUndefined();
    expect(props.loadAttachmentBytes).toBeTypeOf("function");
  });

  it.each(["failed", "skipped"] as const)(
    "returns false when an outline-row image atom cut is %s",
    async (outcome) => {
      const workspace = workspaceValue({
        firstNodeKind: "image",
        attachmentNodeId: "first"
      });
      const applyImageAtomEdit = vi.fn().mockResolvedValue(outcome);
      workspace.actions.applyImageAtomEdit = applyImageAtomEdit;
      renderPane(workspace, idleSubscribe());
      const props = capturedImageAtomEditorProps.get("first")!;
      const selection = { anchorUtf16: 1, focusUtf16: 0 };
      const selectionAuthority = {} as ImageAtomEditorSelectionAuthority;

      await expect(
        props.onAtomCut!({ selection, selectionAuthority })
      ).resolves.toBe(false);
      expect(applyImageAtomEdit).toHaveBeenCalledOnce();
      expect(applyImageAtomEdit).toHaveBeenCalledWith("first", selection, {
        kind: "remove",
        replacementText: ""
      });
    }
  );

  it("returns false without applying an outline-row cut when the real editor flush is cancelled", async () => {
    vi.useFakeTimers();
    try {
      const workspace = workspaceValue({
        firstNodeKind: "image",
        attachmentNodeId: "first"
      });
      const applyImageAtomEdit = vi.fn().mockResolvedValue("committed");
      workspace.actions.applyImageAtomEdit = applyImageAtomEdit;
      renderPane(workspace, idleSubscribe());
      const editor = within(
        document.querySelector<HTMLElement>('[data-outline-id="first"]')!
      ).getByRole("textbox", { name: "Image note" });
      const props = capturedImageAtomEditorProps.get("first")!;

      fireEvent.compositionStart(editor);
      const cutting = props.onAtomCut!({
        selection: { anchorUtf16: 0, focusUtf16: 1 },
        selectionAuthority: {} as ImageAtomEditorSelectionAuthority
      });
      await act(async () => vi.advanceTimersByTimeAsync(1_000));

      await expect(cutting).resolves.toBe(false);
      expect(applyImageAtomEdit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not expose image atom cut dependencies on a read-only outline row", () => {
    const workspace = workspaceValue({
      firstNodeKind: "image",
      attachmentNodeId: "first",
      libraryView: "archive"
    });
    renderPane(workspace, idleSubscribe());

    const props = capturedImageAtomEditorProps.get("first")!;
    expect(props.readOnly).toBe(true);
    expect(props.loadAttachmentBytes).toBeUndefined();
    expect(props.onAtomCut).toBeUndefined();
  });

  it("does not expose image atom cut dependencies on a disabled outline row", () => {
    const workspace = workspaceValue({
      firstNodeKind: "image",
      attachmentNodeId: "first",
      deletingNotesData: true
    });
    renderPane(workspace, idleSubscribe());

    const props = capturedImageAtomEditorProps.get("first")!;
    expect(props.disabled).toBe(true);
    expect(props.loadAttachmentBytes).toBeUndefined();
    expect(props.onAtomCut).toBeUndefined();
  });

  it.each([
    ["image only", "", 0, true, true],
    ["text before", "before", 6, false, true],
    ["text after", "after", 0, true, false],
    ["text on both sides", "beforeafter", 6, false, false]
  ])(
    "marks only empty same-bullet image rows for %s",
    (_label, title, imageOffsetUtf16, beforeEmpty, afterEmpty) => {
      renderPane(
        workspaceValue({
          firstNodeKind: "image",
          firstTitle: title,
          firstImageOffsetUtf16: imageOffsetUtf16,
          attachmentNodeId: "first"
        }),
        idleSubscribe()
      );

      const row = document.querySelector<HTMLElement>(
        '[data-outline-id="first"]'
      )!;
      expectImageAtomEmptyRegions(
        within(row).getByRole("textbox", { name: "Image note" }),
        beforeEmpty,
        afterEmpty
      );
    }
  );

  it("opens an existing-date picker from a row image atom", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue({
      firstNodeKind: "image",
      firstTitle: "Before 07/12/2026 after",
      attachmentNodeId: "first"
    });
    renderPane(workspace, idleSubscribe());

    const row = document.querySelector<HTMLElement>('[data-outline-id="first"]')!;
    await user.click(
      within(row).getByRole("button", { name: "Edit date 07/12/2026" })
    );

    expect(
      await screen.findByRole("dialog", { name: "Choose date" })
    ).toBeVisible();
  });

  it("gives a focused editor paste ownership over a later mounted editor", () => {
    const registry = createNotesImageAtomEditorRegistry();
    const authority = {} as ImageAtomEditorSelectionAuthority;
    const firstClaim = vi.fn(() => true);
    const secondClaim = vi.fn(() => true);
    const first = {
      nodeId: "first",
      flush: vi.fn().mockResolvedValue("flushed" as const),
      flushAndGetSelection: vi.fn().mockResolvedValue({ anchorUtf16: 0, focusUtf16: 0 }),
      flushAndGetSelectionSnapshot: vi.fn().mockResolvedValue({
        selection: { anchorUtf16: 0, focusUtf16: 0 },
        authority
      }),
      isSelectionAuthorityCurrent: vi.fn((candidate) => candidate === authority),
      claimPaste: firstClaim
    };
    const second = {
      nodeId: "second",
      flush: vi.fn().mockResolvedValue("flushed" as const),
      flushAndGetSelection: vi.fn().mockResolvedValue({ anchorUtf16: 0, focusUtf16: 0 }),
      flushAndGetSelectionSnapshot: vi.fn().mockResolvedValue({
        selection: { anchorUtf16: 0, focusUtf16: 0 },
        authority
      }),
      isSelectionAuthorityCurrent: vi.fn((candidate) => candidate === authority),
      claimPaste: secondClaim
    };
    registry.register(second);
    registry.register(first);

    expect(registry.claimPaste({} as ClipboardEvent)).toBe(true);
    expect(firstClaim).toHaveBeenCalledOnce();
    expect(secondClaim).not.toHaveBeenCalled();
  });

  it("registers actual focused editors so a later mounted editor cannot steal paste", () => {
    const registry = createNotesImageAtomEditorRegistry();
    const workspace = workspaceValue();
    const firstPaste = vi.fn(() => true);
    const secondPaste = vi.fn(() => true);
    const registerActiveEditor = (editor: Parameters<typeof registry.register>[0]) =>
      registry.register(editor);
    render(
      <NotesImageResidencyProvider scopeKey="actual-focused-editor">
        <NotesWorkspaceContext.Provider value={workspace}>
          <ImageAtomEditor
            nodeId="first"
            draft={{ title: "first", note: "", imageOffsetUtf16: 0 }}
            attachment={attachment("first")}
            onDraftChange={vi.fn()}
            onImageAtomPaste={firstPaste}
            registerActiveEditor={registerActiveEditor}
          />
          <ImageAtomEditor
            nodeId="second"
            draft={{ title: "second", note: "", imageOffsetUtf16: 0 }}
            attachment={attachment("second")}
            onDraftChange={vi.fn()}
            onImageAtomPaste={secondPaste}
            registerActiveEditor={registerActiveEditor}
          />
        </NotesWorkspaceContext.Provider>
      </NotesImageResidencyProvider>
    );

    fireEvent.focus(screen.getAllByRole("textbox", { name: "Image note" })[0]!);
    expect(registry.claimPaste({} as ClipboardEvent)).toBe(true);
    expect(firstPaste).toHaveBeenCalledOnce();
    expect(secondPaste).not.toHaveBeenCalled();
  });

  it("moves paste ownership to an editor whose non-control atom body receives focus", () => {
    const registry = createNotesImageAtomEditorRegistry();
    const firstPaste = vi.fn(() => true);
    const secondPaste = vi.fn(() => true);
    const registerActiveEditor = (editor: Parameters<typeof registry.register>[0]) =>
      registry.register(editor);
    render(
      <NotesImageResidencyProvider scopeKey="focused-atom-body-editor">
        <NotesWorkspaceContext.Provider value={workspaceValue()}>
          <ImageAtomEditor
            nodeId="first"
            draft={{ title: "first", note: "", imageOffsetUtf16: 0 }}
            attachment={attachment("first")}
            onDraftChange={vi.fn()}
            onImageAtomPaste={firstPaste}
            registerActiveEditor={registerActiveEditor}
          />
          <ImageAtomEditor
            nodeId="second"
            draft={{ title: "second", note: "", imageOffsetUtf16: 0 }}
            attachment={attachment("second")}
            onDraftChange={vi.fn()}
            onImageAtomPaste={secondPaste}
            registerActiveEditor={registerActiveEditor}
          />
        </NotesWorkspaceContext.Provider>
      </NotesImageResidencyProvider>
    );

    const editors = screen.getAllByRole("textbox", { name: "Image note" });
    const bodies = screen.getAllByRole("group", { name: "Image: existing.png" });
    fireEvent.focus(editors[0]!);
    fireEvent.blur(editors[0]!, { relatedTarget: bodies[1] });
    fireEvent.focus(bodies[1]!);

    expect(registry.claimPaste({} as ClipboardEvent)).toBe(true);
    expect(firstPaste).not.toHaveBeenCalled();
    expect(secondPaste).toHaveBeenCalledOnce();
  });

  it("asks the active-editor bridge to claim paste before reading clipboard items", () => {
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    const claimPaste = vi.fn((event: ClipboardEvent) => {
      event.preventDefault();
      return true;
    });
    const workspace = workspaceValue({ importClipboardImages });
    renderPane(workspace, idleSubscribe(), "/vault", {
      ...workspace,
      claimActiveImageAtomPaste: claimPaste
    });
    const target = document.querySelector(".notes-outline-list")!;
    const clipboardData = Object.defineProperty(
      { getData: () => "" },
      "items",
      {
        get() {
          throw new Error("pane inspected clipboard items before editor claim");
        }
      }
    );
    const event = createEvent.paste(target, {
      bubbles: true,
      cancelable: true,
      clipboardData
    });

    fireEvent(target, event);

    expect(claimPaste).toHaveBeenCalledOnce();
    expect(claimPaste.mock.calls[0]?.[0]).toBe(event);
    expect(event.defaultPrevented).toBe(true);
    expect(importClipboardImages).not.toHaveBeenCalled();
  });

  it("fails closed for a marked atom paste when carrier extraction throws", () => {
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    const workspace = workspaceValue({
      firstNodeKind: "image",
      attachmentNodeId: "first",
      importClipboardImages
    });
    renderPane(workspace, idleSubscribe());
    const editor = screen.getByRole("textbox", { name: "Image note" });
    fireEvent.focus(editor);
    const clipboardData = Object.defineProperty(
      {
        getData: () => "",
        types: [NOTES_IMAGE_ATOM_CLIPBOARD_MIME]
      },
      "items",
      {
        get() {
          throw new Error("clipboard carrier access failed");
        }
      }
    );
    const event = createEvent.paste(editor, {
      bubbles: true,
      cancelable: true,
      clipboardData
    });

    fireEvent(editor, event);

    expect(event.defaultPrevented).toBe(true);
    expect(importClipboardImages).not.toHaveBeenCalled();
  });

  it("fails closed for an invalid marked atom paste without invoking global import", async () => {
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    const workspace = workspaceValue({
      firstNodeKind: "image",
      attachmentNodeId: "first",
      importClipboardImages
    });
    renderPane(workspace, idleSubscribe());
    const editor = screen.getByRole("textbox", { name: "Image note" });
    fireEvent.focus(editor);
    const event = createEvent.paste(editor, {
      bubbles: true,
      cancelable: true,
      clipboardData: {
        items: clipboardItems([]),
        getData(type: string) {
          return type === NOTES_IMAGE_ATOM_CLIPBOARD_MIME ? "not-valid-json" : "";
        }
      }
    });

    fireEvent(editor, event);
    await act(async () => undefined);

    expect(event.defaultPrevented).toBe(true);
    expect(importClipboardImages).not.toHaveBeenCalled();
    expect(workspace.actions.applyImageAtomPaste).not.toHaveBeenCalled();
  });

  it("keeps an unreadable external image paste editor-owned", async () => {
    const importClipboardImages = vi.fn().mockResolvedValue(undefined);
    const workspace = workspaceValue({
      firstNodeKind: "image",
      attachmentNodeId: "first",
      importClipboardImages
    });
    renderPane(workspace, idleSubscribe());
    const editor = screen.getByRole("textbox", { name: "Image note" });
    fireEvent.focus(editor);
    const event = createEvent.paste(editor, {
      bubbles: true,
      cancelable: true,
      clipboardData: {
        items: clipboardItems([clipboardItem("image/png", null)]),
        getData: () => ""
      }
    });

    fireEvent(editor, event);
    await act(async () => undefined);

    expect(event.defaultPrevented).toBe(true);
    expect(importClipboardImages).not.toHaveBeenCalled();
  });

  it("routes the valid image-menu removal through one atom edit, not row deletion", async () => {
    const user = userEvent.setup();
    const workspace = workspaceValue({
      firstNodeKind: "image",
      attachmentNodeId: "first"
    });
    const applyImageAtomEdit = vi.fn().mockResolvedValue("committed");
    const deleteNode = vi.fn().mockResolvedValue("committed");
    workspace.actions.applyImageAtomEdit = applyImageAtomEdit;
    workspace.actions.deleteNode = deleteNode;
    renderPane(workspace, idleSubscribe());

    await user.click(
      within(document.querySelector<HTMLElement>('[data-outline-id="first"]')!).getByRole(
        "button",
        { name: "Image actions for existing.png" }
      )
    );
    await user.click(screen.getByRole("menuitem", { name: "Remove image" }));

    expect(applyImageAtomEdit).toHaveBeenCalledOnce();
    expect(applyImageAtomEdit).toHaveBeenCalledWith(
      "first",
      { anchorUtf16: 0, focusUtf16: 1 },
      { kind: "remove", replacementText: "" }
    );
    expect(workspace.actions.removeImage).not.toHaveBeenCalled();
    expect(deleteNode).not.toHaveBeenCalled();
  });

  it("keeps multiple and invalid-metadata image rows in recovery", async () => {
    const user = userEvent.setup();
    const first = attachment("first");
    const invalid = { ...attachment("first"), intrinsicWidth: 0 } as NoteAttachment;
    const view = renderPane(
      workspaceValue({ firstNodeKind: "image", attachments: [first, attachment("first")] }),
      idleSubscribe()
    );
    let row = document.querySelector<HTMLElement>('[data-outline-id="first"]')!;
    expect(within(row).queryByRole("textbox", { name: "Image note" })).toBeNull();
    await user.click(
      within(row).getByRole("button", { name: "Image actions for existing.png" })
    );
    expect(screen.queryByRole("menuitem", { name: "Remove image" })).toBeNull();
    await user.keyboard("{Escape}");

    view.rerenderWorkspace(
      workspaceValue({ firstNodeKind: "image", attachments: [invalid] })
    );
    row = document.querySelector<HTMLElement>('[data-outline-id="first"]')!;
    expect(within(row).queryByRole("textbox", { name: "Image note" })).toBeNull();
    await user.click(
      within(row).getByRole("button", { name: "Image actions for existing.png" })
    );
    expect(screen.queryByRole("menuitem", { name: "Remove image" })).toBeNull();
  });

  it("promotes a native image selection across rows once without starting row drag", () => {
    const workspace = workspaceValue({
      firstNodeKind: "image",
      attachmentNodeId: "first"
    });
    const clearNativeSelection = vi.spyOn(window.getSelection()!, "removeAllRanges");
    const originalElementFromPoint = Object.getOwnPropertyDescriptor(
      document,
      "elementFromPoint"
    );
    renderPane(workspace, idleSubscribe());
    const first = document.querySelector<HTMLElement>('[data-outline-id="first"]')!;
    const second = document.querySelector<HTMLElement>('[data-outline-id="second"]')!;
    const editor = within(first).getByRole("textbox", { name: "Image note" });
    const before = editor.querySelector<HTMLElement>('[data-image-atom-region="before"]')!;

    try {
      fireEvent.pointerDown(before, { button: 0, buttons: 1, pointerId: 7 });
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: vi.fn(() => second.querySelector("textarea"))
      });
      fireEvent.pointerMove(before, {
        buttons: 1,
        pointerId: 7,
        clientX: 12,
        clientY: 24
      });

      expect(workspace.actions.setSelectionAnchor).toHaveBeenCalledWith("first");
      expect(workspace.actions.extendSelectionTo).toHaveBeenCalledWith("second");
      expect(clearNativeSelection).toHaveBeenCalledOnce();
      expect(first).not.toHaveAttribute("data-dragging", "true");
    } finally {
      clearNativeSelection.mockRestore();
      if (originalElementFromPoint) {
        Object.defineProperty(
          document,
          "elementFromPoint",
          originalElementFromPoint
        );
      } else {
        Reflect.deleteProperty(document, "elementFromPoint");
      }
    }
  });
});
