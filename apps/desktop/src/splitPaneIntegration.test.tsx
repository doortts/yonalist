import {
  act, fireEvent, render, screen, waitFor, within
} from "@testing-library/react";
import { App } from "./App";
import { appApi, receipt, snapshot } from "./test/appApiFixture";

describe("split pane integration", () => {
  it("opens, resizes, focuses, and closes a second outline pane", async () => {
    const notesApi = appApi();
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");

    fireEvent.click(screen.getAllByRole("button", {
      name: "Zoom to item"
    })[0], { shiftKey: true });

    expect(screen.getAllByRole("region", {
      name: "Notes outline"
    })).toHaveLength(2);
    const splitTitle = screen.getAllByDisplayValue(
      "First thought"
    )[1] as HTMLTextAreaElement;
    expect(splitTitle).toHaveAttribute("aria-label", "Page title");
    splitTitle.focus();
    splitTitle.setSelectionRange(2, 4);
    expect(splitTitle).toHaveFocus();

    const exportButtons = await screen.findAllByRole("button", {
      name: "Export"
    });
    fireEvent.click(exportButtons[1]);
    const secondaryMenu = await screen.findByRole("menu", {
      name: "Export notes"
    });
    fireEvent.click(within(secondaryMenu).getByRole("menuitem", {
      name: "Current page as Markdown"
    }));
    await waitFor(() => expect(notesApi.exportNotes).toHaveBeenCalledWith(
      expect.objectContaining({
        rootNodeId: "bullet-1",
        format: "markdown"
      })
    ));

    const divider = screen.getByRole("separator", { name: "Resize split" });
    expect(divider).toHaveAttribute("aria-valuenow", "50");
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider).toHaveAttribute("aria-valuenow", "52");

    fireEvent.click(screen.getByRole("button", { name: "Close split" }));
    await waitFor(() => expect(screen.getAllByRole("region", {
      name: "Notes outline"
    })).toHaveLength(1));
  });

  it("zooms into and out of a row with Workflowy keyboard shortcuts", async () => {
    const { container } = render(<App api={appApi()} />);
    const first = await screen.findByDisplayValue("First thought");

    // The heading remounts per target, so each step reads it again.
    const pageTitle = () => container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Page title"]'
    )!;
    fireEvent.keyDown(first, { key: ".", altKey: true });
    await waitFor(() => expect(pageTitle()).toHaveValue("First thought"));

    fireEvent.keyDown(pageTitle(), { key: ",", altKey: true });
    await waitFor(() => expect(pageTitle()).toHaveValue("Today"));
  });

  it("zooms a bullet without querying the workspace", async () => {
    const notesApi = appApi();
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");

    fireEvent.click(screen.getAllByRole("button", { name: "Zoom to item" })[0]);

    expect(screen.getByDisplayValue("First thought")).toHaveAttribute(
      "aria-label",
      "Page title"
    );
    expect(notesApi.queryViewport).not.toHaveBeenCalled();
  });

  it("sums both panes into the status bar count and drops a closed pane", async () => {
    const notesApi = appApi();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [
          ...snapshot.viewport!.nodes,
          {
            ...snapshot.viewport!.nodes[1]!,
            id: "bullet-1-child",
            parentId: "bullet-1",
            text: "Nested thought"
          }
        ]
      }
    });
    render(<App api={notesApi} />);
    const first = await screen.findByDisplayValue("First thought");
    const statusBar = screen.getByLabelText("Status bar");

    fireEvent.click(screen.getAllByRole("button", {
      name: "Zoom to item"
    })[0], { shiftKey: true });
    const secondary = screen.getAllByRole("region", { name: "Notes outline" })[1]!;

    // Both panes hold their own band at once, so neither pane's number alone
    // describes what is selected.
    fireEvent.pointerDown(first, { button: 0, pointerId: 51, ctrlKey: true });
    expect(await within(statusBar).findByText("1 selected")).toBeVisible();
    fireEvent.pointerDown(
      within(secondary).getByDisplayValue("Nested thought"),
      { button: 0, pointerId: 52, ctrlKey: true }
    );
    expect(await within(statusBar).findByText("2 selected")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close split" }));

    expect(await within(statusBar).findByText("1 selected")).toBeVisible();
  });

  it("keeps repeated Enter focus in the right pane while Add child commits", async () => {
    const notesApi = appApi();
    let resolveCreate!: (value: ReturnType<typeof receipt>) => void;
    notesApi.execute = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveCreate = resolve;
      }))
      .mockImplementation(() => new Promise(() => undefined));
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");

    fireEvent.click(screen.getAllByRole("button", {
      name: "Zoom to item"
    })[0], { shiftKey: true });
    const panes = screen.getAllByRole("region", { name: "Notes outline" });
    const secondary = panes[1]!;
    fireEvent.click(within(secondary).getByRole("button", {
      name: "Add child"
    }));

    const focusedBlank = () => {
      const active = document.activeElement as HTMLElement | null;
      expect(secondary).toContainElement(active);
      expect(active).toBeInstanceOf(HTMLTextAreaElement);
      expect((active as HTMLTextAreaElement).value).toBe("");
      return active as HTMLTextAreaElement;
    };
    let latestBlank = await waitFor(focusedBlank);
    for (let index = 0; index < 4; index += 1) {
      const previousBlank = latestBlank;
      fireEvent.keyDown(latestBlank, {
        key: "Enter",
        repeat: index > 0
      });
      latestBlank = await waitFor(() => {
        const active = focusedBlank();
        const blanks = [...secondary.querySelectorAll<HTMLTextAreaElement>(
          "textarea.notes-node-title"
        )].filter((editor) => editor.value === "");
        expect(blanks).toHaveLength(index + 2);
        expect(active).not.toBe(previousBlank);
        return active;
      });
    }

    await waitFor(() => {
      const blanks = [...secondary.querySelectorAll<HTMLTextAreaElement>(
        "textarea.notes-node-title"
      )].filter((editor) => editor.value === "");
      expect(blanks).toHaveLength(5);
      expect(blanks[4]).toBe(latestBlank);
    });
    await act(async () => {
      resolveCreate(receipt("First thought"));
      await Promise.resolve();
    });

    await waitFor(() => expect(latestBlank).toHaveFocus());
    expect(panes[0]).not.toContainElement(
      document.activeElement as HTMLElement | null
    );
  });
});
