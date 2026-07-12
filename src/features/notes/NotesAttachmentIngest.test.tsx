import {
  act,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import type { NoteNode } from "../../domain/notes";
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
} = {}): UseNotesWorkspaceResult {
  const state = normalizeWorkspace({
    nodes: [
      node({ id: "first", title: "First", isCollapsed: true }),
      node({ id: "second", sortKey: 2, title: "Second" }),
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
    importClipboardImages: resolved(),
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
