import {
  act, fireEvent, render, screen, waitFor, within
} from "@testing-library/react";
import { App } from "./App";
import { appApi, receipt } from "./test/appApiFixture";

// These suites cover the React outline surface; pin the opt-out query
// now that the Monaco surface is the default.
window.history.replaceState(null, "", "/?outline=react");

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

    fireEvent.keyDown(first, { key: ".", altKey: true });
    const zoomTitle = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Page title"]'
    )!;
    await waitFor(() => expect(zoomTitle).toHaveValue("First thought"));

    fireEvent.keyDown(zoomTitle, { key: ",", altKey: true });
    expect(await screen.findByDisplayValue("Today")).toHaveAttribute(
      "aria-label",
      "Page title"
    );
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
