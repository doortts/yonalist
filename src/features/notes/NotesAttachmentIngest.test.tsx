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
  PendingNoteAttachmentByteItem
} from "../../domain/notes";
import { NotesAttachmentUiContext } from "./NotesAttachmentUiContext";
import type {
  NotesAttachmentUiBoundary,
  NotesNativeImageDropEvent
} from "./notesAttachmentController";
import { NotesDateTodayProvider } from "./NotesDatePickerIntegration";
import { NotesOutlinePane } from "./NotesOutlinePane";
import { NotesWorkspaceContext } from "./NotesWorkspaceContext";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import type { UseNotesWorkspaceResult } from "./useNotesWorkspace";

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
    createdAt: "2026-07-13T00:00:00Z",
    updatedAt: "2026-07-13T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    ...overrides
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
    clipboardData: { items: clipboardItems(entries) }
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
  notesByNodeId?: Readonly<Record<string, string>>;
  attachmentNodeId?: string;
  libraryView?: UseNotesWorkspaceResult["libraryView"];
  deletingNotesData?: boolean;
  status?: "loading" | "ready" | "error";
  importDroppedImagePaths?:
    | ((nodeId: string, paths: readonly string[]) => Promise<void>)
    | null;
  importClipboardImages?:
    | ((
        nodeId: string,
        items: readonly PendingNoteAttachmentByteItem[]
      ) => Promise<void>)
    | null;
} = {}): UseNotesWorkspaceResult {
  const state = normalizeWorkspace({
    nodes: [
      node({
        id: "first",
        title: "First",
        note: options.notesByNodeId?.first ?? "",
        isCollapsed: true
      }),
      node({
        id: "second",
        sortKey: 2,
        title: "Second",
        note: options.notesByNodeId?.second ?? ""
      }),
      node({
        id: "child",
        parentId: "first",
        title: "Child",
        note: options.notesByNodeId?.child ?? ""
      })
    ],
    attachmentsByNodeId:
      options.attachmentNodeId === undefined
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
    splitNode: resolved(),
    createChild: resolved(),
    updateNode: resolved(),
    updateNodeDraft: vi.fn(),
    flushNodeDraft: vi.fn().mockResolvedValue(true),
    flushAllDrafts: vi.fn().mockResolvedValue(true),
    moveNode: resolved(),
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
    uploadImage: resolved(),
    importDroppedImagePaths:
      options.importDroppedImagePaths === null
        ? undefined
        : (options.importDroppedImagePaths ?? vi.fn().mockResolvedValue(undefined)),
    importClipboardImages:
      options.importClipboardImages === null
        ? undefined
        : (options.importClipboardImages ?? resolved()),
    retryImageUpload: resolved(),
    loadAttachmentBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
    resizeImage: resolved(),
    removeImage: resolved(),
    undo: resolved(),
    redo: resolved(),
    setImageImportMaxDisplayWidth: vi.fn()
  } as UseNotesWorkspaceResult["actions"];

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
    attachmentUploadErrorsByNodeId: {},
    attachmentUploadRetryAttemptIdsByNodeId: {},
    retryFailedDraft: resolved(),
    retryLastFailedWrite: resolved(),
    status: state.status,
    loading: state.status === "loading",
    error: state.error
  };
}

function renderPane(
  workspace: UseNotesWorkspaceResult,
  subscribeToImageDrop: NotesAttachmentUiBoundary["subscribeToImageDrop"],
  initialVaultRoot = "/vault"
) {
  const attachmentUi: NotesAttachmentUiBoundary = {
    openImageFiles: vi.fn().mockResolvedValue(null),
    subscribeToImageDrop
  };
  let vaultRoot = initialVaultRoot;
  const content = (value: UseNotesWorkspaceResult, currentVaultRoot: string) => (
    <NotesDateTodayProvider today={{ year: 2026, month: 7, day: 13 }}>
      <VaultRootContext.Provider value={currentVaultRoot}>
        <NotesAttachmentUiContext.Provider value={attachmentUi}>
          <NotesWorkspaceContext.Provider value={value}>
            <NotesOutlinePane />
          </NotesWorkspaceContext.Provider>
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

  it("moves one preview across writable rows and imports authoritative drop paths", async () => {
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
        paths: ["/incoming/from-enter.png"],
        position: { x: 110, y: 80 }
      })
    );
    expect(firstRow).toHaveAttribute("data-image-drop-active", "true");
    expect(
      within(firstRow).getByTestId("notes-image-drop-placeholder")
    ).toBeVisible();

    elementFromPoint.mockReturnValue(secondTitle);
    act(() =>
      nativeDrop?.({ type: "over", position: { x: 220, y: 180 } })
    );
    expect(firstRow).not.toHaveAttribute("data-image-drop-active");
    expect(
      within(firstRow).queryByTestId("notes-image-drop-placeholder")
    ).toBeNull();
    expect(secondRow).toHaveAttribute("data-image-drop-active", "true");

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
      screen.queryByTestId("notes-image-drop-placeholder")
    ).toBeNull();
    expect(document.activeElement).toBe(secondTitle);
    expect(secondTitle.selectionStart).toBe(1);
    expect(secondTitle.selectionEnd).toBe(4);
    expect(workspace.state.nodesById.first.isCollapsed).toBe(true);
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

    elementFromPoint.mockReturnValue(title);
    act(() =>
      nativeDrop?.({ type: "over", position: { x: 40, y: 60 } })
    );
    act(() => nativeDrop?.({ type: "leave" }));
    expect(screen.queryByTestId("notes-image-drop-placeholder")).toBeNull();

    elementFromPoint.mockReturnValue(title);
    act(() =>
      nativeDrop?.({
        type: "drop",
        paths: ["/incoming/vector.svg", "/incoming/photo.png"],
        position: { x: 40, y: 60 }
      })
    );
    expect(screen.queryByTestId("notes-image-drop-placeholder")).toBeNull();
    expect(importDroppedImagePaths).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("alert", { name: "Image drop failed" })
    ).toHaveTextContent("unsupported image batch");
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
      screen.queryByTestId("notes-image-drop-placeholder")
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
      screen.queryByTestId("notes-image-drop-placeholder")
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
        screen.getByTestId("notes-image-drop-placeholder"),
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
        screen.queryByTestId("notes-image-drop-placeholder"),
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
        screen.queryByTestId("notes-image-drop-placeholder"),
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
