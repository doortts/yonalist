import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NotesImageMenu } from "./NotesImageMenu";

const notesStyles = readFileSync(
  join(process.cwd(), "src/features/notes/notes.css"),
  "utf8"
);

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
    expect(screen.getAllByRole("menuitem")).toHaveLength(5);

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
    await user.tab();
    expect(trigger).toHaveFocus();

    await user.keyboard("{Enter}");
    const firstItem = await screen.findByRole("menuitem", {
      name: "Show full-screen"
    });
    await waitFor(() => expect(firstItem).toHaveFocus());

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "View original" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(actions.onViewOriginal).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menuitem", { name: "View original" })).toBeNull();
  });

  it("restores the image-actions trigger when Escape closes the menu", async () => {
    const user = userEvent.setup();
    render(<NotesImageMenu originalName="diagram.png" {...callbacks()} />);

    const trigger = screen.getByRole("button", {
      name: "Image actions for diagram.png"
    });
    await user.click(trigger);
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(trigger).toHaveFocus());
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

  it("uses a caller-provided destructive action label", async () => {
    const user = userEvent.setup();
    render(
      <NotesImageMenu
        originalName="diagram.png"
        deleteLabel="Discard image"
        {...callbacks()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );

    expect(screen.getByRole("menuitem", { name: "Discard image" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("does not pass trigger or command pointer-down events to the outline row", async () => {
    const user = userEvent.setup();
    const onParentPointerDown = vi.fn();
    render(
      <div onPointerDown={onParentPointerDown}>
        <NotesImageMenu originalName="diagram.png" {...callbacks()} />
      </div>
    );

    const trigger = screen.getByRole("button", {
      name: "Image actions for diagram.png"
    });
    fireEvent.pointerDown(trigger);
    expect(onParentPointerDown).not.toHaveBeenCalled();

    await user.click(trigger);
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Download" }));
    expect(onParentPointerDown).not.toHaveBeenCalled();
  });

  it("uses an accent focus ring and disables its transition for reduced motion", () => {
    expect(notesStyles).toMatch(
      /\.notes-image-menu-trigger:focus-visible\s*{[^}]*outline:\s*2px solid var\(--accent\);[^}]*outline-offset:\s*-1px;/s
    );
    expect(notesStyles).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*\.notes-image-menu-trigger\s*{[^}]*transition:\s*none;/s
    );
  });
});
