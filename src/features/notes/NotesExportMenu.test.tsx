import {
  act,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import type { NoteId, NoteNode } from "../../domain/notes";
import {
  NotesExportConflictError,
  type NotesExportFormat,
  type NotesExportRequest,
  type NotesExportResult
} from "../../domain/notesExport";
import { NotesLibraryPane } from "./NotesLibraryPane";
import { NotesOutlinePane } from "./NotesOutlinePane";
import { NotesWorkspaceContext } from "./NotesWorkspaceContext";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import type {
  NotesLibraryView,
  UseNotesWorkspaceResult
} from "./useNotesWorkspace";

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
  const onFlushNodeDraft = vi.fn().mockResolvedValue(undefined);
  const props: ComponentProps<typeof NotesExportMenu> = {
    selectedNodeId: "selected",
    selectedNodeTitle: "Selected title",
    zoomRootId: "page",
    zoomRootTitle: "Page title",
    onFlushNodeDraft,
    ...overrides
  };

  render(
    <VaultRootContext.Provider value={vaultPath}>
      <NotesExportMenu {...props} />
    </VaultRootContext.Provider>
  );

  return { onFlushNodeDraft, props };
}

async function openExportMenu(user = userEvent.setup()) {
  await user.click(screen.getByRole("button", { name: "Export" }));
  return screen.findByRole("menu");
}

function note(id: NoteId, title: string, parentId: NoteId | null): NoteNode {
  return {
    id,
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
    deletedAt: null
  };
}

interface WorkspaceOptions {
  deletingNotesData?: boolean;
  draftTitle?: string;
  libraryView?: NotesLibraryView;
  selectedId?: NoteId | null;
  status?: UseNotesWorkspaceResult["state"]["status"];
  zoomRootId?: NoteId | null;
}

function workspaceValue(
  options: WorkspaceOptions = {}
): UseNotesWorkspaceResult {
  const state = normalizeWorkspace({
    nodes: [
      note("page", "Page title", null),
      note("selected", "Selected title", "page")
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
    splitNode: resolved(),
    createChild: resolved(),
    updateNode: resolved(),
    updateNodeDraft: vi.fn(),
    flushNodeDraft: resolved(),
    moveNode: resolved(),
    toggleComplete: resolved(),
    toggleCollapsed: resolved(),
    toggleStar: resolved(),
    duplicateNode: resolved(),
    removeEmptyNode: resolved(),
    deleteNode: resolved(),
    restoreNode: resolved(),
    emptyTrash: resolved(),
    selectLibraryView: resolved(),
    selectTag: resolved(),
    searchNotes: vi.fn().mockResolvedValue([]),
    openSearchResult: resolved(),
    deleteAllNotesData: resolved(),
    zoomTo: resolved()
  } as UseNotesWorkspaceResult["actions"];

  return {
    state,
    actions,
    deletingNotesData: options.deletingNotesData ?? false,
    libraryView: options.libraryView ?? "all",
    activeTag: null,
    tags: [],
    locallyExpandedNodeIds: new Set(),
    draftsByNodeId:
      options.draftTitle === undefined
        ? {}
        : {
            selected: {
              title: options.draftTitle,
              note: "",
              revision: 1,
              status: "pending"
            }
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
      <NotesWorkspaceContext.Provider value={workspace}>
        <div data-testid="notes-middle-pane">
          <NotesLibraryPane />
        </div>
        <div data-testid="notes-detail-pane">
          <NotesOutlinePane />
        </div>
      </NotesWorkspaceContext.Provider>
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

  it("uses an accessible Export icon trigger and exposes exactly four commands", async () => {
    const user = userEvent.setup();
    renderExportMenu();

    const trigger = screen.getByRole("button", { name: "Export" });
    await user.hover(trigger);
    expect(
      await screen.findByText("Export", { selector: ".tooltip-popup" })
    ).toBeVisible();

    const menu = await openExportMenu(user);
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
      const { onFlushNodeDraft } = renderExportMenu();

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
      expect(onFlushNodeDraft).toHaveBeenCalledWith(nodeId);
      expect(onFlushNodeDraft.mock.invocationCallOrder[0]).toBeLessThan(
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
    "retries a $format conflict once with the matching renderer and exact captured request",
    async ({ command, format, destination }) => {
      const user = userEvent.setup();
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
      renderExportMenu();

      const menu = await openExportMenu(user);
      await user.click(within(menu).getByRole("menuitem", { name: command }));
      const dialog = await screen.findByRole("alertdialog", {
        name: "Replace existing export?"
      });
      await user.click(
        within(dialog).getByRole("button", { name: "Replace" })
      );

      await waitFor(() => {
        expect(expectedRenderer).toHaveBeenCalledTimes(1);
      });
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
      expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith("selected");
      expect(exportServiceMock.saveNotesExport).toHaveBeenCalledWith(
        expect.objectContaining({ rootNodeId: "selected" })
      );
    });
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
      expect(workspace.actions.flushNodeDraft).toHaveBeenCalledWith("selected");
      expect(exportServiceMock.saveNotesExport).toHaveBeenCalledWith(
        expect.objectContaining({ defaultFileName: "Renamed draft" })
      );
    });
  });

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
