import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NotesImageMenu } from "./NotesImageMenu";

function callbacks() {
  return {
    onShowFullScreen: vi.fn(),
    onViewOriginal: vi.fn(),
    onDownload: vi.fn(),
    onDelete: vi.fn(),
    onOpenSettings: vi.fn()
  };
}

describe("NotesImageMenu", () => {
  it("offers every image command and dispatches the selected action", async () => {
    const user = userEvent.setup();
    const actions = callbacks();
    render(
      <NotesImageMenu originalName="diagram.png" {...actions} />
    );

    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );

    expect(screen.getByRole("menuitem", { name: "Show full-screen" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "View original" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Download" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeVisible();

    await user.click(screen.getByRole("menuitem", { name: "Show full-screen" }));
    expect(actions.onShowFullScreen).toHaveBeenCalledOnce();
  });

  it("supports keyboard navigation and closes after each command", async () => {
    const user = userEvent.setup();
    const actions = callbacks();
    render(<NotesImageMenu originalName="diagram.png" {...actions} />);

    const trigger = screen.getByRole("button", {
      name: "Image actions for diagram.png"
    });
    trigger.focus();
    await user.keyboard("{Enter}{ArrowDown}{Enter}");

    expect(actions.onViewOriginal).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menuitem", { name: "View original" })).toBeNull();
  });

  it.each([
    ["Download", "onDownload"],
    ["Delete", "onDelete"],
    ["Settings", "onOpenSettings"]
  ] as const)("dispatches %s", async (label, callbackName) => {
    const user = userEvent.setup();
    const actions = callbacks();
    render(<NotesImageMenu originalName="diagram.png" {...actions} />);

    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );
    await user.click(screen.getByRole("menuitem", { name: label }));

    expect(actions[callbackName]).toHaveBeenCalledOnce();
  });

  it("disables unavailable actions without hiding the menu", async () => {
    const user = userEvent.setup();
    render(
      <NotesImageMenu
        originalName="diagram.png"
        onShowFullScreen={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );

    expect(screen.getByRole("menuitem", { name: "View original" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(screen.getByRole("menuitem", { name: "Download" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });
});
