import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NotesStore } from "./notesStore";
import { appApi } from "./test/appApiFixture";

const picker = vi.hoisted(() => ({
  pickExportPath: vi.fn()
}));

vi.mock("./exportPicker", () => picker);

import { NotesExportMenu } from "./NotesExportMenu";

async function readyStore() {
  const api = appApi();
  const store = new NotesStore(api);
  await act(() => store.bootstrap());
  return { api, store };
}

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Export as" }));
  return screen.findByRole("menu", { name: "Export notes" });
}

describe("NotesExportMenu", () => {
  beforeEach(() => {
    picker.pickExportPath.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes the four existing export labels and disables only missing selection targets", async () => {
    const { store } = await readyStore();
    const rendered = render(
      <NotesExportMenu
        store={store}
        currentRoot={{ id: "page-1", title: "Today" }}
        selectedNode={{ id: "bullet-1", title: "First thought" }}
      />
    );

    const exportButton = screen.getByRole("button", { name: "Export as" });
    expect(exportButton).toHaveAttribute("title", "Export as");
    expect(exportButton).toHaveAttribute("data-tooltip", "Export as");

    let menu = await openMenu();
    for (const label of [
      "Selected node as Markdown",
      "Selected node as PDF",
      "Current page as Markdown",
      "Current page as PDF"
    ]) {
      expect(within(menu).getByRole("menuitem", { name: label })).toBeEnabled();
    }

    fireEvent.click(screen.getByRole("button", { name: "Export as" }));
    rendered.rerender(
      <NotesExportMenu
        store={store}
        currentRoot={{ id: "page-1", title: "Today" }}
        selectedNode={null}
      />
    );
    menu = await openMenu();
    expect(within(menu).getByRole("menuitem", {
      name: "Selected node as Markdown"
    })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", {
      name: "Current page as Markdown"
    })).toBeEnabled();
  });

  it("flushes before the picker and sends no IPC after cancellation", async () => {
    const { api, store } = await readyStore();
    const events: string[] = [];
    vi.spyOn(store, "flushAllDrafts").mockImplementation(async () => {
      events.push("flush");
    });
    picker.pickExportPath.mockImplementation(async () => {
      events.push("dialog");
      return null;
    });
    render(
      <NotesExportMenu
        store={store}
        currentRoot={{ id: "page-1", title: "Today" }}
        selectedNode={null}
      />
    );

    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", {
      name: "Current page as Markdown"
    }));

    await waitFor(() => expect(events).toEqual(["flush", "dialog"]));
    expect(api.exportNotes).not.toHaveBeenCalled();
  });

  it("suppresses duplicate starts and exports with the post-flush revision", async () => {
    const { api, store } = await readyStore();
    let releaseFlush!: () => void;
    vi.spyOn(store, "flushAllDrafts").mockImplementation(() =>
      new Promise<void>((resolve) => {
        releaseFlush = resolve;
      })
    );
    picker.pickExportPath.mockResolvedValue("C:\\exports\\Today.md");
    vi.mocked(api.exportNotes).mockResolvedValue({
      revision: 7,
      rootNodeId: "page-1",
      format: "markdown",
      destinationPath: "C:\\exports\\Today.md"
    });
    render(
      <NotesExportMenu
        store={store}
        currentRoot={{ id: "page-1", title: "Today" }}
        selectedNode={null}
      />
    );

    const menu = await openMenu();
    const action = within(menu).getByRole("menuitem", {
      name: "Current page as Markdown"
    });
    fireEvent.click(action);
    fireEvent.click(action);
    releaseFlush();

    await waitFor(() => expect(api.exportNotes).toHaveBeenCalledOnce());
    expect(api.exportNotes).toHaveBeenCalledWith({
      sessionId: "session-1",
      baseRevision: 7,
      rootNodeId: "page-1",
      format: "markdown",
      destinationPath: "C:\\exports\\Today.md",
      overwrite: false
    });
  });

  it("confirms a structured destination conflict and retries after a fresh flush", async () => {
    const { api, store } = await readyStore();
    const flush = vi.spyOn(store, "flushAllDrafts").mockResolvedValue();
    picker.pickExportPath.mockResolvedValue("C:\\exports\\Today.pdf");
    vi.mocked(api.exportNotes)
      .mockRejectedValueOnce({
        code: "destination_exists",
        message: "Destination already exists.",
        retryable: true
      })
      .mockResolvedValueOnce({
        revision: 7,
        rootNodeId: "page-1",
        format: "pdf",
        destinationPath: "C:\\exports\\Today.pdf"
      });
    render(
      <NotesExportMenu
        store={store}
        currentRoot={{ id: "page-1", title: "Today" }}
        selectedNode={null}
      />
    );

    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", {
      name: "Current page as PDF"
    }));

    const dialog = await screen.findByRole("alertdialog", {
      name: "Replace existing export?"
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace" }));

    await waitFor(() => expect(api.exportNotes).toHaveBeenCalledTimes(2));
    expect(flush).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.exportNotes).mock.calls[1][0]).toMatchObject({
      format: "pdf",
      overwrite: true
    });
    expect(screen.getByRole("status")).toHaveTextContent("Exported PDF.");
  });

  it("preserves prior feedback when the destination picker is cancelled", async () => {
    const { api, store } = await readyStore();
    picker.pickExportPath
      .mockResolvedValueOnce("C:\\exports\\Today.md")
      .mockResolvedValueOnce(null);
    vi.mocked(api.exportNotes).mockResolvedValue({
      revision: 7,
      rootNodeId: "page-1",
      format: "markdown",
      destinationPath: "C:\\exports\\Today.md"
    });
    render(
      <NotesExportMenu
        store={store}
        currentRoot={{ id: "page-1", title: "Today" }}
        selectedNode={null}
      />
    );

    let menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", {
      name: "Current page as Markdown"
    }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Exported Markdown."
      );
    });

    menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", {
      name: "Current page as Markdown"
    }));
    await waitFor(() => expect(picker.pickExportPath).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status")).toHaveTextContent("Exported Markdown.");
  });

  it("offers Retry only for retryable backend failures", async () => {
    const { api, store } = await readyStore();
    picker.pickExportPath.mockResolvedValue("C:\\exports\\Today.md");
    vi.mocked(api.exportNotes).mockRejectedValue({
      code: "invalid_destination",
      message: "Unsafe destination.",
      retryable: false
    });
    render(
      <NotesExportMenu
        store={store}
        currentRoot={{ id: "page-1", title: "Today" }}
        selectedNode={null}
      />
    );

    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", {
      name: "Current page as Markdown"
    }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unsafe destination."
    );
    expect(screen.queryByRole("button", { name: "Retry" }))
      .not.toBeInTheDocument();
  });

  it("keeps confirmed overwrite intent when a retryable replacement fails", async () => {
    const { api, store } = await readyStore();
    picker.pickExportPath.mockResolvedValue("C:\\exports\\Today.pdf");
    vi.mocked(api.exportNotes)
      .mockRejectedValueOnce({
        code: "destination_exists",
        message: "Destination already exists.",
        retryable: true
      })
      .mockRejectedValueOnce({
        code: "export_failed",
        message: "Temporary write failure.",
        retryable: true
      })
      .mockResolvedValueOnce({
        revision: 7,
        rootNodeId: "page-1",
        format: "pdf",
        destinationPath: "C:\\exports\\Today.pdf"
      });
    render(
      <NotesExportMenu
        store={store}
        currentRoot={{ id: "page-1", title: "Today" }}
        selectedNode={null}
      />
    );

    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", {
      name: "Current page as PDF"
    }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Replace existing export?"
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(api.exportNotes).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.exportNotes).mock.calls[2][0].overwrite).toBe(true);
  });
});
