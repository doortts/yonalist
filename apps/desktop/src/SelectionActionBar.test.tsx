import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectionActionBar } from "./SelectionActionBar";

describe("SelectionActionBar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the existing selection toolbar contract and routes implemented actions", () => {
    const onClear = vi.fn();
    const onComplete = vi.fn();
    const onCopy = vi.fn();
    const onCut = vi.fn();
    const onDelete = vi.fn();
    render(
      <SelectionActionBar
        count={3}
        allCompleted={false}
        canCut
        canIndent
        canOutdent
        canMoveUp
        canMoveDown
        canDuplicate
        busy={false}
        onClear={onClear}
        onComplete={onComplete}
        onCopy={onCopy}
        onCut={onCut}
        onIndent={vi.fn()}
        onOutdent={vi.fn()}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={onDelete}
        trailingAction={<button type="button">Export</button>}
      />
    );

    expect(screen.getByRole("toolbar", {
      name: "Actions for 3 selected notes"
    })).toHaveClass("notes-selection-action-bar");
    // The count reads from the status bar now; the bar keeps it only in the
    // label that names what the buttons act on.
    expect(screen.queryByText("3 selected")).toBeNull();
    // Dismissing the band is the last thing you reach for, so it sits at the
    // pill's far end -- behind the actions, and behind Export, which is the
    // one control the pill borrows from the toolbar it no longer replaces.
    expect(screen.getAllByRole("button").slice(-2).map(
      (button) => button.textContent
    )).toEqual(["Export", "Clear selection"]);
    for (const name of ["Complete", "Delete"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Cut" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onCopy).toHaveBeenCalledOnce();
    expect(onCut).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("labels aggregate uncompletion and explains a lossy Cut", () => {
    render(
      <SelectionActionBar
        count={2}
        allCompleted
        canCut={false}
        canIndent={false}
        canOutdent={false}
        canMoveUp={false}
        canMoveDown={false}
        canDuplicate={false}
        busy={false}
        onClear={vi.fn()}
        onComplete={vi.fn()}
        onCopy={vi.fn()}
        onCut={vi.fn()}
        onIndent={vi.fn()}
        onOutdent={vi.fn()}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Uncomplete" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: "Cut" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });

  it("keeps structural actions reachable from More in a compact window", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }));
    const onIndent = vi.fn();
    render(
      <SelectionActionBar
        count={2}
        allCompleted={false}
        canCut
        canIndent
        canOutdent
        canMoveUp
        canMoveDown
        canDuplicate
        busy={false}
        onClear={vi.fn()}
        onComplete={vi.fn()}
        onCopy={vi.fn()}
        onCut={vi.fn()}
        onIndent={onIndent}
        onOutdent={vi.fn()}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: "Indent" }))
      .not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Indent" }));

    expect(onIndent).toHaveBeenCalledOnce();
  });
});
