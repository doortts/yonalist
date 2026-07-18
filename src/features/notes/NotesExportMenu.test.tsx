import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import type {
  NoteId,
  NoteNode,
  NotesStore,
  NotesWorkspace
} from "../../domain/notes";
import {
  NotesExportConflictError,
  type NotesExportFormat,
  type NotesExportRequest,
  type NotesExportResult
} from "../../domain/notesExport";
import { NotesLibraryPane } from "./NotesLibraryPane";
import { NotesImageResidencyProvider } from "./NotesImageResidencyContext";
import { NotesOutlinePane } from "./NotesOutlinePane";
import { NotesWorkspaceContext } from "./NotesWorkspaceContext";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import type {
  NotesLibraryView,
  UseNotesWorkspaceResult
} from "./useNotesWorkspace";
import { useNotesWorkspace } from "./useNotesWorkspace";

const exportServiceMock = vi.hoisted(() => ({
  saveNotesExport: vi.fn(),
  renderMarkdownExport: vi.fn(),
  renderPdfExport: vi.fn()
}));

vi.mock("../../services/notesExport", () => exportServiceMock);

import { NotesExportMenu } from "./NotesExportMenu";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function exportResult(format: NotesExportFormat): NotesExportResult {
  return {
    destination: `/exports/result.${format === "markdown" ? "md" : "pdf"}`,
    format
  };
}

function renderExportMenu(
  overrides: Partial<ComponentProps<typeof NotesExportMenu>> = {},
  vaultPath = "/vault"
) {
  const onFlushDrafts = vi.fn().mockResolvedValue(true);
  const props: ComponentProps<typeof NotesExportMenu> = {
    selectedNodeId: "selected",
    selectedNodeTitle: "Selected title",
    zoomRootId: "page",
    zoomRootTitle: "Page title",
    onFlushDrafts,
    ...overrides
  };

  const rendered = render(
    <VaultRootContext.Provider value={vaultPath}>
      <NotesExportMenu {...props} />
    </VaultRootContext.Provider>
  );

  return {
    onFlushDrafts,
    props,
    unmount: rendered.unmount,
    rerenderExportMenu(
      nextOverrides: Partial<ComponentProps<typeof NotesExportMenu>>,
      nextVaultPath = vaultPath
    ) {
      rendered.rerender(
        <VaultRootContext.Provider value={nextVaultPath}>
          <NotesExportMenu {...props} {...nextOverrides} />
        </VaultRootContext.Provider>
      );
    }
  };
}

async function openExportMenu(user = userEvent.setup()) {
  await user.click(screen.getByRole("button", { name: "Export" }));
  return screen.findByRole("menu");
}

function findTitleTextarea(value: string) {
  return Array.from(
    document.querySelectorAll<HTMLTextAreaElement>(
      'textarea[aria-label="Edit node title"]'
    )
  ).find((input) => input.value === value);
}

function note(
  id: NoteId,
  title: string,
  parentId: NoteId | null,
  nodeKind: NoteNode["nodeKind"] = "text"
): NoteNode {
  return {
    id,
    nodeKind,
    parentId,
    sortKey: 1,
    title,
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
    imageOffsetUtf16: 0
  };
}

function repository(overrides: Partial<NotesStore> = {}): NotesStore {
  const empty = vi.fn().mockResolvedValue({ nodes: [] });
  const initialHistoryState = {
    canUndo: false,
    canRedo: false,
    historyEpoch: "history-epoch",
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: []
  };
  return {
    initialize: vi.fn().mockResolvedValue(initialHistoryState),
    loadWorkspace: vi.fn().mockResolvedValue({
      nodes: [
        note("page", "Page title", null),
        note("selected", "Selected title", "page")
      ]
    }),
    createNode: empty,
    updateNode: empty,
    splitNode: empty,
    moveNode: empty,
    applyBatch: empty,
    importSubtree: empty,
    toggleComplete: empty,
    toggleCollapsed: empty,
    toggleStar: empty,
    duplicateNode: empty,
    removeEmptyNode: empty,
    softDeleteNode: empty,
    restoreNode: empty,
    archiveNode: empty,
    unarchiveNode: empty,
    undo: vi.fn().mockResolvedValue({
      kind: "entryMissing",
      canUndo: false,
      canRedo: false,
      historyEpoch: "history-epoch",
      nextUndoEntryId: null,
      nextRedoEntryId: null,
      prunedEntryIds: []
    }),
    redo: vi.fn().mockResolvedValue({
      kind: "entryMissing",
      canUndo: false,
      canRedo: false,
      historyEpoch: "history-epoch",
      nextUndoEntryId: null,
      nextRedoEntryId: null,
      prunedEntryIds: []
    }),
    clearHistory: vi.fn().mockResolvedValue({
      ...initialHistoryState,
      historyReset: true
    }),
    pruneHistoryEntries: vi.fn().mockResolvedValue(initialHistoryState),
    prepareNavigation: vi.fn().mockResolvedValue(initialHistoryState),
    closeHistorySession: vi.fn().mockResolvedValue(undefined),
    importAttachmentPaths: empty,
    importAttachmentBytes: empty,
    emptyTrash: empty,
    search: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
    listTagsWithCounts: vi.fn().mockResolvedValue([]),
    deleteDatabase: vi.fn().mockResolvedValue({ attachmentCleanupFailed: false }),
    ...overrides
  };
}

function RealWorkspacePane({
  store,
  onWorkspace
}: {
  store: NotesStore;
  onWorkspace(workspace: UseNotesWorkspaceResult): void;
}) {
  const workspace = useNotesWorkspace({
    vaultRoot: "/vault",
    repository: store
  });
  onWorkspace(workspace);
  return (
    <NotesWorkspaceContext.Provider value={workspace}>
      <NotesOutlinePane />
    </NotesWorkspaceContext.Provider>
  );
}

function renderRealWorkspacePane(
  store: NotesStore,
  onWorkspace: (workspace: UseNotesWorkspaceResult) => void
) {
  render(
    <VaultRootContext.Provider value="/vault">
      <RealWorkspacePane store={store} onWorkspace={onWorkspace} />
    </VaultRootContext.Provider>
  );
}

function RealWorkspaceExportMenu({
  store,
  onWorkspace
}: {
  store: NotesStore;
  onWorkspace(workspace: UseNotesWorkspaceResult): void;
}) {
  const workspace = useNotesWorkspace({
    vaultRoot: "/vault",
    repository: store
  });
  onWorkspace(workspace);
  return (
    <NotesExportMenu
      selectedNodeId="selected"
      selectedNodeTitle={
        workspace.draftsByNodeId.selected?.title ??
        workspace.state.nodesById.selected?.title
      }
      zoomRootId="page"
      zoomRootTitle={
        workspace.draftsByNodeId.page?.title ??
        workspace.state.nodesById.page?.title
      }
      loading={workspace.loading}
      onFlushDrafts={workspace.actions.flushAllDrafts}
    />
  );
}

function renderRealWorkspaceExportMenu(
  store: NotesStore,
  onWorkspace: (workspace: UseNotesWorkspaceResult) => void
) {
  render(
    <VaultRootContext.Provider value="/vault">
      <RealWorkspaceExportMenu store={store} onWorkspace={onWorkspace} />
    </VaultRootContext.Provider>
  );
}

interface WorkspaceOptions {
  deletingNotesData?: boolean;
  draftTitle?: string;
  libraryView?: NotesLibraryView;
  pageDraftTitle?: string;
  pageNodeKind?: NoteNode["nodeKind"];
  selectedId?: NoteId | null;
  selectedNodeKind?: NoteNode["nodeKind"];
  status?: UseNotesWorkspaceResult["state"]["status"];
  zoomRootId?: NoteId | null;
}

function workspaceValue(
  options: WorkspaceOptions = {}
): UseNotesWorkspaceResult {
  const pageTitle =
    options.pageNodeKind === "image" ? "page-private.png" : "Page title";
  const selectedTitle =
    options.selectedNodeKind === "image"
      ? "selected-private.png"
      : "Selected title";
  const state = normalizeWorkspace({
    nodes: [
      note("page", pageTitle, null, options.pageNodeKind),
      note("selected", selectedTitle, "page", options.selectedNodeKind)
    ]
  });
  state.selectedId = options.selectedId ?? "selected";
  state.zoomRootId = options.zoomRootId ?? "page";
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
    updateNodeDraft: vi.fn(),
    flushNodeDraft: vi.fn().mockResolvedValue(true),
    flushAllDrafts: vi.fn().mockResolvedValue(true),
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
    setSelectionAnchor: vi.fn(),
    extendSelectionTo: vi.fn(),
    toggleSelectionNode: vi.fn(),
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
    draftsByNodeId: {
      ...(options.draftTitle === undefined
        ? {}
        : {
            selected: {
              title: options.draftTitle,
              note: "",
              revision: 1,
              status: "pending" as const
            }
          }),
      ...(options.pageDraftTitle === undefined
        ? {}
        : {
            page: {
              title: options.pageDraftTitle,
              note: "",
              revision: 2,
              status: "pending" as const
            }
          })
    },
    writeError: null,
    retryFailedDraft: resolved(),
    retryLastFailedWrite: resolved(),
    status: state.status,
    loading: state.status === "loading",
    error: null
  };
}

function renderNotesPanes(
  options: WorkspaceOptions = {},
  vaultPath = "/vault"
) {
  const workspace = workspaceValue(options);
  render(
    <VaultRootContext.Provider value={vaultPath}>
      <NotesImageResidencyProvider scopeKey={vaultPath}>
        <NotesWorkspaceContext.Provider value={workspace}>
          <div data-testid="notes-middle-pane">
            <NotesLibraryPane />
          </div>
          <div data-testid="notes-detail-pane">
            <NotesOutlinePane />
          </div>
        </NotesWorkspaceContext.Provider>
      </NotesImageResidencyProvider>
    </VaultRootContext.Provider>
  );
  return workspace;
}

describe("NotesExportMenu", () => {
  beforeEach(() => {
    exportServiceMock.saveNotesExport.mockReset();
    exportServiceMock.renderMarkdownExport.mockReset();
    exportServiceMock.renderPdfExport.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses an accessible Export icon trigger and exposes exactly four commands", async () => {
    const user = userEvent.setup();
    renderExportMenu();

    const trigger = screen.getByRole("button", { name: "Export" });
    await user.hover(trigger);
    expect(await screen.findByRole("tooltip", { name: "Export" })).toBeVisible();

    const menu = await openExportMenu(user);
    expect(menu).toHaveAccessibleName("Export");
    expect(menu).not.toHaveAttribute("aria-label");
    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual([
      "Selected node as Markdown",
      "Selected node as PDF",
      "Current page as Markdown",
      "Current page as PDF"
    ]);
  });

  it.each([
    {
      command: "Selected node as Markdown",
      format: "markdown" as const,
      nodeId: "selected",
      title: "Selected title"
    },
    {
      command: "Selected node as PDF",
      format: "pdf" as const,
      nodeId: "selected",
      title: "Selected title"
    },
    {
      command: "Current page as Markdown",
      format: "markdown" as const,
      nodeId: "page",
      title: "Page title"
    },
    {
      command: "Current page as PDF",
      format: "pdf" as const,
      nodeId: "page",
      title: "Page title"
    }
  ])(
    "maps $command to its target, format, and title-derived filename",
    async ({ command, format, nodeId, title }) => {
      const user = userEvent.setup();
      exportServiceMock.saveNotesExport.mockResolvedValue(exportResult(format));
      const { onFlushDrafts } = renderExportMenu();

      const menu = await openExportMenu(user);
      await user.click(within(menu).getByRole("menuitem", { name: command }));

      await waitFor(() => {
        expect(exportServiceMock.saveNotesExport).toHaveBeenCalledWith({
          vaultPath: "/vault",
          rootNodeId: nodeId,
          format,
          defaultFileName: title
        });
      });
      expect(onFlushDrafts).toHaveBeenCalledWith();
      expect(onFlushDrafts.mock.invocationCallOrder[0]).toBeLessThan(
        exportServiceMock.saveNotesExport.mock.invocationCallOrder[0]
      );
    }
  );

  it("disables selected commands without a selected node", async () => {
    renderExportMenu({ selectedNodeId: null, selectedNodeTitle: undefined });
    const menu = await openExportMenu();

    expect(
      within(menu).getByRole("menuitem", {
        name: "Selected node as Markdown"
      })
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      within(menu).getByRole("menuitem", { name: "Selected node as PDF" })
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("disables current-page commands while the workspace is unzoomed", async () => {
    renderExportMenu({ zoomRootId: null, zoomRootTitle: undefined });
    const menu = await openExportMenu();

    expect(
      within(menu).getByRole("menuitem", {
        name: "Current page as Markdown"
      })
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      within(menu).getByRole("menuitem", { name: "Current page as PDF" })
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("disables the trigger and closes its menu when all targets disappear", async () => {
    const user = userEvent.setup();
    const rendered = renderExportMenu();
    await openExportMenu(user);

    rendered.rerenderExportMenu({
      selectedNodeId: null,
      selectedNodeTitle: undefined,
      zoomRootId: null,
      zoomRootTitle: undefined
    });

    const trigger = screen.getByRole("button", { name: "Export" });
    expect(trigger).toBeDisabled();
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    );
    await user.click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps save-dialog cancellation silent", async () => {
    const user = userEvent.setup();
    exportServiceMock.saveNotesExport.mockResolvedValue(null);
    renderExportMenu();

    const menu = await openExportMenu(user);
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Selected node as Markdown"
      })
    );

    await waitFor(() => expect(exportServiceMock.saveNotesExport).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("blocks save and retains retry when the draft flush returns false", async () => {
    const user = userEvent.setup();
    const onFlushDrafts = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    exportServiceMock.saveNotesExport.mockResolvedValue(
      exportResult("markdown")
    );
    renderExportMenu({ onFlushDrafts });

    const menu = await openExportMenu(user);
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Selected node as Markdown"
      })
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Save this note before exporting.");
    expect(exportServiceMock.saveNotesExport).not.toHaveBeenCalled();
    expect(exportServiceMock.renderMarkdownExport).not.toHaveBeenCalled();
    expect(exportServiceMock.renderPdfExport).not.toHaveBeenCalled();

    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(onFlushDrafts).toHaveBeenCalledTimes(2);
      expect(exportServiceMock.saveNotesExport).toHaveBeenCalledOnce();
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Exported Markdown."
    );
  });

  it("blocks export when the real workspace retains a rejected draft write", async () => {
    const user = userEvent.setup();
    const store = repository({
      updateNode: vi.fn().mockRejectedValue(new Error("disk full"))
    });
    let currentWorkspace: UseNotesWorkspaceResult | undefined;
    renderRealWorkspacePane(store, (workspace) => {
      currentWorkspace = workspace;
    });
    await waitFor(() => expect(currentWorkspace?.status).toBe("ready"));
    await act(async () => {
      await currentWorkspace?.actions.focusNode("selected");
    });
    act(() => {
      currentWorkspace?.actions.updateNodeDraft("selected", {
        title: "Unsaved title",
        note: ""
      });
    });

    const menu = await openExportMenu(user);
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Selected node as Markdown"
      })
    );

    const exportControl = screen
      .getByRole("button", { name: "Export" })
      .closest<HTMLElement>(".notes-export-control");
    expect(exportControl).not.toBeNull();
    expect(await within(exportControl!).findByRole("alert")).toHaveTextContent(
      "Save this note before exporting."
    );
    expect(store.updateNode).toHaveBeenCalled();
    expect(currentWorkspace?.draftsByNodeId.selected).toMatchObject({
      title: "Unsaved title",
      status: "failed"
    });
    expect(exportServiceMock.saveNotesExport).not.toHaveBeenCalled();
    expect(exportServiceMock.renderMarkdownExport).not.toHaveBeenCalled();
    expect(exportServiceMock.renderPdfExport).not.toHaveBeenCalled();
  });

  it("serializes export behind an autosave started by its own draft flush", async () => {
    const user = userEvent.setup();
    const childWrite = deferred<NotesWorkspace>();
    const updatedWorkspace = {
      nodes: [
        note("page", "Page title", null),
        { ...note("selected", "Edited child", "page"), note: "Latest note" }
      ]
    };
    const store = repository({
      updateNode: vi.fn().mockReturnValue(childWrite.promise),
      undo: vi.fn().mockResolvedValue({
        workspace: updatedWorkspace,
        replayedEntryId: null,
        canUndo: false,
        canRedo: true
      }),
      redo: vi.fn().mockResolvedValue({
        workspace: updatedWorkspace,
        replayedEntryId: null,
        canUndo: true,
        canRedo: false
      })
    });
    exportServiceMock.saveNotesExport.mockResolvedValue(exportResult("markdown"));
    let currentWorkspace: UseNotesWorkspaceResult | undefined;
    renderRealWorkspaceExportMenu(store, (workspace) => {
      currentWorkspace = workspace;
    });
    await waitFor(() => expect(currentWorkspace?.status).toBe("ready"));

    const menu = await openExportMenu(user);

    act(() => {
      currentWorkspace?.actions.updateNodeDraft("selected", {
        title: "Edited child",
        note: ""
      });
    });

    fireEvent.click(
      within(menu).getByRole("menuitem", {
        name: "Current page as Markdown"
      })
    );

    expect(screen.getByText("Exporting...")).toBeInTheDocument();
    // The draft flush that gates the export is a silent (non-structural) write:
    // it must stay out of the loading state even while in flight.
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());
    expect(currentWorkspace?.status).toBe("ready");
    expect(store.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "selected",
        title: "Edited child",
        note: "",
        imageOffsetUtf16: 0
      },
      expect.objectContaining({ commandKind: "text" })
    );
    expect(exportServiceMock.saveNotesExport).not.toHaveBeenCalled();

    await act(async () => childWrite.resolve(updatedWorkspace));

    await waitFor(() => expect(exportServiceMock.saveNotesExport).toHaveBeenCalledOnce());
    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(currentWorkspace?.state.nodesById.selected?.title).toBe("Edited child");
    expect(vi.mocked(store.updateNode).mock.invocationCallOrder[0]).toBeLessThan(
      exportServiceMock.saveNotesExport.mock.invocationCallOrder[0]
    );
  });

  it("rejects already-open toolbar commands when unrelated loading starts", async () => {
    const user = userEvent.setup();
    const rendered = renderExportMenu();
    const menu = await openExportMenu(user);

    rendered.rerenderExportMenu({ loading: true });

    const markdown = within(menu).getByRole("menuitem", {
      name: "Selected node as Markdown"
    });
    const pdf = within(menu).getByRole("menuitem", {
      name: "Selected node as PDF"
    });
    expect(markdown).toHaveAttribute("aria-disabled", "true");
    expect(pdf).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(markdown);
    fireEvent.click(pdf);

    expect(rendered.onFlushDrafts).not.toHaveBeenCalled();
    expect(exportServiceMock.saveNotesExport).not.toHaveBeenCalled();
    expect(exportServiceMock.renderMarkdownExport).not.toHaveBeenCalled();
    expect(exportServiceMock.renderPdfExport).not.toHaveBeenCalled();
  });

  it("aborts a parent export when a pending child draft cannot be saved", async () => {
    const user = userEvent.setup();
    const store = repository({
      updateNode: vi.fn().mockRejectedValue(new Error("disk full"))
    });
    let currentWorkspace: UseNotesWorkspaceResult | undefined;
    renderRealWorkspacePane(store, (workspace) => {
      currentWorkspace = workspace;
    });
    await waitFor(() => expect(currentWorkspace?.status).toBe("ready"));

    const childTitle = findTitleTextarea("Selected title");
    expect(childTitle).toBeDefined();
    fireEvent.change(childTitle!, { target: { value: "Unsaved child" } });

    await user.click(
      screen.getByRole("button", { name: "More actions for Page title" })
    );
    let menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Export subtree" }));
    menu = await screen.findByRole("menu");
    await user.click(
      within(menu).getByRole("menuitem", { name: "Export subtree as PDF" })
    );

    const exportControl = screen
      .getByRole("button", { name: "Export" })
      .closest<HTMLElement>(".notes-export-control");
    expect(exportControl).not.toBeNull();
    expect(await within(exportControl!).findByRole("alert")).toHaveTextContent(
      "Save this note before exporting."
    );
    expect(store.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "selected",
        title: "Unsaved child",
        note: "",
        imageOffsetUtf16: 0
      },
      expect.objectContaining({
        historyEpoch: "history-epoch",
        commandKind: "text"
      })
    );
    expect(exportServiceMock.saveNotesExport).not.toHaveBeenCalled();
    expect(exportServiceMock.renderPdfExport).not.toHaveBeenCalled();
  });

  it("exposes a busy state and prevents duplicate export commands", async () => {
    const user = userEvent.setup();
    const pending = deferred<NotesExportResult | null>();
    exportServiceMock.saveNotesExport.mockReturnValue(pending.promise);
    renderExportMenu();

    const trigger = screen.getByRole("button", { name: "Export" });
    const menu = await openExportMenu(user);
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Selected node as Markdown"
      })
    );

    expect(await screen.findByRole("status")).toHaveTextContent("Exporting");
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("aria-busy", "true");
    await user.click(trigger);
    expect(exportServiceMock.saveNotesExport).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve(exportResult("markdown")));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Exported Markdown."
    );
  });

  it("does not start a native export when unmounted during draft flushing", async () => {
    const user = userEvent.setup();
    const flush = deferred<boolean>();
    const rendered = renderExportMenu({
      onFlushDrafts: vi.fn().mockReturnValue(flush.promise)
    });

    const menu = await openExportMenu(user);
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Selected node as Markdown"
      })
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Exporting");

    rendered.unmount();
    await act(async () => flush.resolve(true));

    expect(exportServiceMock.saveNotesExport).not.toHaveBeenCalled();
    expect(exportServiceMock.renderMarkdownExport).not.toHaveBeenCalled();
    expect(exportServiceMock.renderPdfExport).not.toHaveBeenCalled();
  });

  it("does not start a native export after the vault changes during draft flushing", async () => {
    const user = userEvent.setup();
    const flush = deferred<boolean>();
    const rendered = renderExportMenu({
      onFlushDrafts: vi.fn().mockReturnValue(flush.promise)
    });

    const menu = await openExportMenu(user);
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Selected node as Markdown"
      })
    );
    expect(await screen.findByText("Exporting...")).toBeInTheDocument();

    rendered.rerenderExportMenu({}, "/other-vault");
    await act(async () => flush.resolve(true));

    expect(exportServiceMock.saveNotesExport).not.toHaveBeenCalled();
    expect(exportServiceMock.renderMarkdownExport).not.toHaveBeenCalled();
    expect(exportServiceMock.renderPdfExport).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("suppresses a late native success after export becomes unavailable", async () => {
    const user = userEvent.setup();
    const pending = deferred<NotesExportResult | null>();
    exportServiceMock.saveNotesExport.mockReturnValue(pending.promise);
    const rendered = renderExportMenu();

    const menu = await openExportMenu(user);
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Selected node as Markdown"
      })
    );
    await waitFor(() =>
      expect(exportServiceMock.saveNotesExport).toHaveBeenCalledOnce()
    );

    rendered.rerenderExportMenu({ disabled: true });
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    await waitFor(() =>
      expect(screen.queryByText("Exporting...")).not.toBeInTheDocument()
    );

    await act(async () => pending.resolve(exportResult("markdown")));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("cancels a native export when a scope transition starts loading", async () => {
    const user = userEvent.setup();
    const pending = deferred<NotesExportResult | null>();
    exportServiceMock.saveNotesExport.mockReturnValue(pending.promise);
    const rendered = renderExportMenu();

    const menu = await openExportMenu(user);
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Selected node as Markdown"
      })
    );
    await waitFor(() =>
      expect(exportServiceMock.saveNotesExport).toHaveBeenCalledOnce()
    );

    rendered.rerenderExportMenu({ loading: true });
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    await waitFor(() =>
      expect(screen.queryByText("Exporting...")).not.toBeInTheDocument()
    );

    await act(async () => pending.resolve(exportResult("markdown")));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("suppresses a late native error after export becomes unavailable", async () => {
    const user = userEvent.setup();
    const pending = deferred<NotesExportResult | null>();
    exportServiceMock.saveNotesExport.mockReturnValue(pending.promise);
    const rendered = renderExportMenu();

    const menu = await openExportMenu(user);
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Selected node as Markdown"
      })
    );
    await waitFor(() =>
      expect(exportServiceMock.saveNotesExport).toHaveBeenCalledOnce()
    );

    rendered.rerenderExportMenu({ disabled: true });
    await act(async () => pending.reject(new Error("late failure")));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("suppresses a late conflict after export becomes unavailable", async () => {
    const user = userEvent.setup();
    const pending = deferred<NotesExportResult | null>();
    const request: NotesExportRequest = {
      vaultPath: "/vault",
      rootNodeId: "selected",
      destination: "/exports/selected.md",
      overwrite: false
    };
    exportServiceMock.saveNotesExport.mockReturnValue(pending.promise);
    const rendered = renderExportMenu();

    const menu = await openExportMenu(user);
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Selected node as Markdown"
      })
    );
    await waitFor(() =>
      expect(exportServiceMock.saveNotesExport).toHaveBeenCalledOnce()
    );

    rendered.rerenderExportMenu({ disabled: true });
    await act(async () =>
      pending.reject(new NotesExportConflictError(request.destination, request))
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("opens overwrite confirmation with the captured destination and cancels without writing", async () => {
    const user = userEvent.setup();
    const request: NotesExportRequest = {
      vaultPath: "/vault",
      rootNodeId: "selected",
      destination: "/exports/Selected title.md",
      overwrite: false
    };
    exportServiceMock.saveNotesExport.mockRejectedValue(
      new NotesExportConflictError(request.destination, request)
    );
    renderExportMenu();

    const menu = await openExportMenu(user);
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Selected node as Markdown"
      })
    );

    const dialog = await screen.findByRole("alertdialog", {
      name: "Replace existing export?"
    });
    expect(dialog).toHaveClass("notes-export-confirm-dialog");
    expect(dialog).toHaveTextContent(request.destination);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(exportServiceMock.renderMarkdownExport).not.toHaveBeenCalled();
    expect(exportServiceMock.renderPdfExport).not.toHaveBeenCalled();
    expect(request.overwrite).toBe(false);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each([
    {
      command: "Selected node as Markdown",
      format: "markdown" as const,
      destination: "/exports/selected.md"
    },
    {
      command: "Selected node as PDF",
      format: "pdf" as const,
      destination: "/exports/selected.pdf"
    }
  ])(
    "revalidates drafts before replacing a $format conflict with the exact captured request",
    async ({ command, format, destination }) => {
      const user = userEvent.setup();
      const overwriteFlush = deferred<boolean>();
      const onFlushDrafts = vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockReturnValueOnce(overwriteFlush.promise);
      const request: NotesExportRequest = {
        vaultPath: "/captured-vault",
        rootNodeId: "captured-node",
        destination,
        overwrite: false
      };
      exportServiceMock.saveNotesExport.mockRejectedValue(
        new NotesExportConflictError(destination, request)
      );
      const expectedResult = { destination, format };
      const expectedRenderer =
        format === "markdown"
          ? exportServiceMock.renderMarkdownExport
          : exportServiceMock.renderPdfExport;
      const otherRenderer =
        format === "markdown"
          ? exportServiceMock.renderPdfExport
          : exportServiceMock.renderMarkdownExport;
      expectedRenderer.mockResolvedValue(expectedResult);
      renderExportMenu({ onFlushDrafts });

      const menu = await openExportMenu(user);
      await user.click(within(menu).getByRole("menuitem", { name: command }));
      const dialog = await screen.findByRole("alertdialog", {
        name: "Replace existing export?"
      });
      await user.click(
        within(dialog).getByRole("button", { name: "Replace" })
      );

      expect(onFlushDrafts).toHaveBeenCalledTimes(2);
      expect(expectedRenderer).not.toHaveBeenCalled();

      await act(async () => overwriteFlush.resolve(true));
      await waitFor(() => {
        expect(expectedRenderer).toHaveBeenCalledTimes(1);
      });
      expect(onFlushDrafts.mock.invocationCallOrder[1]).toBeLessThan(
        expectedRenderer.mock.invocationCallOrder[0]
      );
      expect(expectedRenderer).toHaveBeenCalledWith({
        ...request,
        overwrite: true
      });
      expect(otherRenderer).not.toHaveBeenCalled();
      expect(request).toEqual({
        vaultPath: "/captured-vault",
        rootNodeId: "captured-node",
        destination,
        overwrite: false
      });
    }
  );

  it("aborts replacement when the current draft barrier fails and retries the captured overwrite", async () => {
    const user = userEvent.setup();
    const onFlushDrafts = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const request: NotesExportRequest = {
      vaultPath: "/captured-vault",
      rootNodeId: "captured-node",
      destination: "/exports/selected.md",
      overwrite: false
    };
    exportServiceMock.saveNotesExport.mockRejectedValue(
      new NotesExportConflictError(request.destination, request)
    );
    exportServiceMock.renderMarkdownExport.mockResolvedValue({
      destination: request.destination,
      format: "markdown"
    });
    renderExportMenu({ onFlushDrafts });

    const menu = await openExportMenu(user);
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Selected node as Markdown"
      })
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Replace existing export?"
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Replace" })
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Save this note before exporting.");
    expect(onFlushDrafts).toHaveBeenCalledTimes(2);
    expect(exportServiceMock.renderMarkdownExport).not.toHaveBeenCalled();
    expect(exportServiceMock.renderPdfExport).not.toHaveBeenCalled();

    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(onFlushDrafts).toHaveBeenCalledTimes(3);
      expect(exportServiceMock.renderMarkdownExport).toHaveBeenCalledOnce();
    });
    expect(exportServiceMock.renderMarkdownExport).toHaveBeenCalledWith({
      ...request,
      overwrite: true
    });
    expect(request.overwrite).toBe(false);
  });

  it("shows a Notes-local accessible error and retries the failed operation", async () => {
    const user = userEvent.setup();
    exportServiceMock.saveNotesExport
      .mockRejectedValueOnce(new Error("Unsupported glyph U+1F642."))
      .mockResolvedValueOnce(exportResult("pdf"));
    renderExportMenu();

    const menu = await openExportMenu(user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Selected node as PDF" })
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Unsupported glyph U+1F642.");
    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(exportServiceMock.saveNotesExport).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Exported PDF."
    );
  });

  it("announces a concise success status", async () => {
    const user = userEvent.setup();
    exportServiceMock.saveNotesExport.mockResolvedValue(exportResult("markdown"));
    renderExportMenu();

    const menu = await openExportMenu(user);
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Current page as Markdown"
      })
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Exported Markdown."
    );
  });

  it("supports keyboard focus, Escape dismissal, and trigger focus restoration", async () => {
    const user = userEvent.setup();
    renderExportMenu();
    const trigger = screen.getByRole("button", { name: "Export" });
    trigger.focus();

    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(
        within(menu).getByRole("menuitem", {
          name: "Selected node as Markdown"
        })
      ).toHaveFocus();
    });

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("integrates only in the Notes detail chrome and uses workspace selection", async () => {
    const user = userEvent.setup();
    exportServiceMock.saveNotesExport.mockResolvedValue(exportResult("markdown"));
    const workspace = renderNotesPanes();
    const flushAllDrafts = vi.mocked(workspace.actions.flushAllDrafts);
    const detailPane = screen.getByTestId("notes-detail-pane");
    const middlePane = screen.getByTestId("notes-middle-pane");
    const trigger = within(detailPane).getByRole("button", { name: "Export" });

    expect(trigger.closest(".notes-outline-toolbar")).not.toBeNull();
    expect(within(middlePane).queryByRole("button", { name: "Export" })).toBeNull();

    await user.click(trigger);
    const menu = await screen.findByRole("menu");
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Selected node as Markdown"
      })
    );

    await waitFor(() => {
      expect(flushAllDrafts).toHaveBeenCalledWith();
      expect(exportServiceMock.saveNotesExport).toHaveBeenCalledWith(
        expect.objectContaining({ rootNodeId: "selected" })
      );
    });
  });

  it.each([
    {
      command: "Selected node as Markdown",
      accessibleFilename: "selected-draft-private.png",
      filename: "selected-private.png",
      options: {
        selectedNodeKind: "image" as const,
        draftTitle: "selected-draft-private.png"
      },
      rootNodeId: "selected"
    },
    {
      command: "Current page as Markdown",
      accessibleFilename: "page-draft-private.png",
      filename: "page-private.png",
      options: {
        pageNodeKind: "image" as const,
        pageDraftTitle: "page-draft-private.png"
      },
      rootNodeId: "page"
    }
  ])(
    "uses Image for an image-node $command save name and generic body presentation",
    async ({ accessibleFilename, command, filename, options, rootNodeId }) => {
      const user = userEvent.setup();
      exportServiceMock.saveNotesExport.mockResolvedValue(
        exportResult("markdown")
      );
      renderNotesPanes(options);
      const detailPane = screen.getByTestId("notes-detail-pane");

      await user.click(
        within(detailPane).getByRole("button", { name: "Export" })
      );
      const menu = await screen.findByRole("menu");
      await user.click(within(menu).getByRole("menuitem", { name: command }));

      await waitFor(() =>
        expect(exportServiceMock.saveNotesExport).toHaveBeenCalledWith(
          expect.objectContaining({
            rootNodeId,
            defaultFileName: "Image"
          })
        )
      );
      const imageBody = within(detailPane).getByRole("group", {
        name: `Image: ${accessibleFilename}`
      });
      expect(imageBody).not.toHaveTextContent(filename);
      expect(imageBody).toHaveAccessibleName(`Image: ${accessibleFilename}`);
    }
  );

  it("uses Image for image-node row and library export save names", async () => {
    const user = userEvent.setup();
    exportServiceMock.saveNotesExport.mockResolvedValue(
      exportResult("markdown")
    );
    renderNotesPanes({ selectedNodeKind: "image" });

    await user.click(
      screen.getByRole("button", {
        name: "More actions for selected-private.png"
      })
    );
    let menu = await screen.findByRole("menu");
    await user.click(
      within(menu).getByRole("menuitem", { name: "Export subtree" })
    );
    await user.click(
      within(menu).getByRole("menuitem", { name: "Export subtree as Markdown" })
    );
    await waitFor(() =>
      expect(exportServiceMock.saveNotesExport).toHaveBeenLastCalledWith(
        expect.objectContaining({
          rootNodeId: "selected",
          defaultFileName: "Image"
        })
      )
    );

    const library = screen.getByTestId("notes-middle-pane");
    await user.click(
      within(library).getByRole("button", { name: "Page actions for Page title" })
    );
    menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Export" }));
    await user.click(
      within(menu).getByRole("menuitem", { name: "Export as Markdown" })
    );
    await waitFor(() =>
      expect(exportServiceMock.saveNotesExport).toHaveBeenLastCalledWith(
        expect.objectContaining({
          rootNodeId: "page",
          defaultFileName: "Page title"
        })
      )
    );
  });

  it("uses Image for a library image-page export save name", async () => {
    const user = userEvent.setup();
    exportServiceMock.saveNotesExport.mockResolvedValue(
      exportResult("markdown")
    );
    renderNotesPanes({ pageNodeKind: "image", zoomRootId: null });
    const library = screen.getByTestId("notes-middle-pane");

    await user.click(
      within(library).getByRole("button", {
        name: "Page actions for Image: page-private.png"
      })
    );
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Export" }));
    await user.click(
      within(menu).getByRole("menuitem", { name: "Export as Markdown" })
    );

    await waitFor(() =>
      expect(exportServiceMock.saveNotesExport).toHaveBeenCalledWith(
        expect.objectContaining({
          rootNodeId: "page",
          defaultFileName: "Image"
        })
      )
    );
    expect(library.textContent).not.toContain("page-private.png");
  });

  it("routes a row subtree export through the shared guarded controller", async () => {
    const user = userEvent.setup();
    exportServiceMock.saveNotesExport.mockResolvedValue(exportResult("markdown"));
    const workspace = renderNotesPanes();
    const flushAllDrafts = vi.mocked(workspace.actions.flushAllDrafts);

    await user.click(
      screen.getByRole("button", {
        name: "More actions for Selected title"
      })
    );
    const menu = await screen.findByRole("menu");
    await user.click(
      within(menu).getByRole("menuitem", { name: "Export subtree" })
    );
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Export subtree as Markdown"
      })
    );

    await waitFor(() => {
      expect(workspace.actions.flushAllDrafts).toHaveBeenCalledWith();
      expect(exportServiceMock.saveNotesExport).toHaveBeenCalledWith({
        vaultPath: "/vault",
        rootNodeId: "selected",
        format: "markdown",
        defaultFileName: "Selected title"
      });
    });
    expect(flushAllDrafts.mock.invocationCallOrder[0]).toBeLessThan(
      exportServiceMock.saveNotesExport.mock.invocationCallOrder[0]
    );
  });

  it("blocks a row subtree export when its draft save barrier fails", async () => {
    const user = userEvent.setup();
    const workspace = renderNotesPanes();
    vi.mocked(workspace.actions.flushAllDrafts).mockResolvedValue(false);

    await user.click(
      screen.getByRole("button", {
        name: "More actions for Selected title"
      })
    );
    const menu = await screen.findByRole("menu");
    await user.click(
      within(menu).getByRole("menuitem", { name: "Export subtree" })
    );
    await user.click(
      within(menu).getByRole("menuitem", { name: "Export subtree as PDF" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Save this note before exporting."
    );
    expect(exportServiceMock.saveNotesExport).not.toHaveBeenCalled();
    expect(exportServiceMock.renderPdfExport).not.toHaveBeenCalled();
  });

  it("uses the live target draft title for the default filename", async () => {
    const user = userEvent.setup();
    exportServiceMock.saveNotesExport.mockResolvedValue(exportResult("markdown"));
    const workspace = renderNotesPanes({ draftTitle: "Renamed draft" });

    await user.click(screen.getByRole("button", { name: "Export" }));
    const menu = await screen.findByRole("menu");
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Selected node as Markdown"
      })
    );

    await waitFor(() => {
      expect(workspace.actions.flushAllDrafts).toHaveBeenCalledWith();
      expect(exportServiceMock.saveNotesExport).toHaveBeenCalledWith(
        expect.objectContaining({ defaultFileName: "Renamed draft" })
      );
    });
  });

  it("uses the live current-page draft title for the PDF filename", async () => {
    const user = userEvent.setup();
    exportServiceMock.saveNotesExport.mockResolvedValue(exportResult("pdf"));
    const workspace = renderNotesPanes({
      pageDraftTitle: "Renamed page draft"
    });

    await user.click(screen.getByRole("button", { name: "Export" }));
    const menu = await screen.findByRole("menu");
    await user.click(
      within(menu).getByRole("menuitem", {
        name: "Current page as PDF"
      })
    );

    await waitFor(() => {
      expect(workspace.actions.flushAllDrafts).toHaveBeenCalledWith();
      expect(exportServiceMock.saveNotesExport).toHaveBeenCalledWith(
        expect.objectContaining({
          rootNodeId: "page",
          format: "pdf",
          defaultFileName: "Renamed page draft"
        })
      );
    });
  });

  it.each([
    {
      target: "row",
      options: { draftTitle: "" },
      trigger: "More actions for Selected title",
      format: "markdown" as const,
      rootNodeId: "selected",
      command: "Export subtree as Markdown"
    },
    {
      target: "page",
      options: { pageDraftTitle: "" },
      trigger: "More actions for Page title",
      format: "pdf" as const,
      rootNodeId: "page",
      command: "Export subtree as PDF"
    }
  ])(
    "passes a blank live $target draft title through to export",
    async ({ options, trigger, format, rootNodeId, command }) => {
      const user = userEvent.setup();
      exportServiceMock.saveNotesExport.mockResolvedValue(exportResult(format));
      renderNotesPanes(options);

      await user.click(screen.getByRole("button", { name: trigger }));
      const menu = await screen.findByRole("menu");
      await user.click(
        within(menu).getByRole("menuitem", { name: "Export subtree" })
      );
      await user.click(within(menu).getByRole("menuitem", { name: command }));

      await waitFor(() =>
        expect(exportServiceMock.saveNotesExport).toHaveBeenCalledWith(
          expect.objectContaining({
            rootNodeId,
            format,
            defaultFileName: ""
          })
        )
      );
    }
  );

  it.each([
    { label: "Trash", options: { libraryView: "trash" as const }, vault: "/vault" },
    { label: "loading", options: { status: "loading" as const }, vault: "/vault" },
    {
      label: "Notes data deletion",
      options: { deletingNotesData: true },
      vault: "/vault"
    },
    { label: "missing vault", options: {}, vault: "" }
  ])("disables export during $label", ({ options, vault }) => {
    renderNotesPanes(options, vault);
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
  });
});
