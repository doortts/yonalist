import {
  act,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function workspaceValue(options: {
  zoomRootId?: string | null;
  libraryView?: UseNotesWorkspaceResult["libraryView"];
  deletingNotesData?: boolean;
  status?: "loading" | "ready" | "error";
  importDroppedImagePaths?: (
    nodeId: string,
    paths: readonly string[]
  ) => Promise<void>;
  importClipboardImages?:
    | ((
        nodeId: string,
        items: readonly PendingNoteAttachmentByteItem[]
      ) => Promise<void>)
    | undefined;
  importSubtree?: UseNotesWorkspaceResult["actions"]["importSubtree"];
  secondNoteText?: string;
} = {}): UseNotesWorkspaceResult {
  const state = normalizeWorkspace({
    nodes: [
      node({ id: "first", title: "First", isCollapsed: true }),
      node({
        id: "second",
        sortKey: 2,
        title: "Second",
        note: options.secondNoteText ?? ""
      }),
      node({ id: "child", parentId: "first", title: "Child" })
    ],
    attachmentsByNodeId: {}
  });
  state.zoomRootId = options.zoomRootId ?? null;
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
      options.importDroppedImagePaths ?? vi.fn().mockResolvedValue(undefined),
    importClipboardImages:
      "importClipboardImages" in options
        ? options.importClipboardImages
        : resolved(),
    retryImageUpload: resolved(),
    loadAttachmentBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
    resizeImage: resolved(),
    removeImage: resolved(),
    undo: resolved(),
    redo: resolved(),
    setImageImportMaxDisplayWidth: vi.fn(),
    setSelectionAnchor: vi.fn(),
    extendSelectionTo: vi.fn(),
    clearSelection: vi.fn()
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
  subscribeToImageDrop: NotesAttachmentUiBoundary["subscribeToImageDrop"]
) {
  const attachmentUi: NotesAttachmentUiBoundary = {
    openImageFiles: vi.fn().mockResolvedValue(null),
    subscribeToImageDrop
  };
  const content = (value: UseNotesWorkspaceResult) => (
    <NotesDateTodayProvider today={{ year: 2026, month: 7, day: 13 }}>
      <VaultRootContext.Provider value="/vault">
        <NotesAttachmentUiContext.Provider value={attachmentUi}>
          <NotesWorkspaceContext.Provider value={value}>
            <NotesOutlinePane />
          </NotesWorkspaceContext.Provider>
        </NotesAttachmentUiContext.Provider>
      </VaultRootContext.Provider>
    </NotesDateTodayProvider>
  );
  const view = render(content(workspace));
  return Object.assign(view, {
    rerenderWorkspace(value: UseNotesWorkspaceResult) {
      view.rerender(content(value));
    }
  });
}

const elementFromPoint = vi.fn(
  (_x: number, _y: number): Element | null => null
);
const originalElementFromPoint = Object.getOwnPropertyDescriptor(
  document,
  "elementFromPoint"
);

describe("native Notes image drop ingest", () => {
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
    const noteTextarea = document
      .querySelector('[data-outline-id="second"]')!
      .querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Supporting note: Second"]'
      )!;

    const notPrevented = fireEvent.paste(
      noteTextarea,
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
});
