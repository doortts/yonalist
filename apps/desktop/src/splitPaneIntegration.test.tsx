import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { appApi } from "./test/appApiFixture";

describe("split pane integration", () => {
  it("opens, resizes, focuses, and closes a second outline pane", async () => {
    render(<App api={appApi()} />);
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
});
