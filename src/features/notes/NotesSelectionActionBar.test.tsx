import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotesSelectionActionSnapshot } from "./notesSelectionActions";
import {
  NotesSelectionActionBar,
  type NotesSelectionActionBarAction
} from "./NotesSelectionActionBar";

function mockCompactViewport(compact: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(max-width: 720px)" ? compact : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    }))
  );
}

function snapshot(
  overrides: Partial<NotesSelectionActionSnapshot> = {}
): NotesSelectionActionSnapshot {
  const eligible = (nodeIds: readonly string[] = ["one", "two"]) => ({
    eligible: true as const,
    nodeIds
  });
  return {
    selection: { anchorId: "one", headId: "two" },
    selectedNodeIds: ["one", "two"],
    structuralRootIds: ["one", "two"],
    completion: "mixed",
    deleteFocusNodeId: "three",
    eligibility: {
      copy: eligible(),
      cut: eligible(),
      delete: eligible(),
      duplicate: eligible(),
      indent: eligible(),
      outdent: eligible(),
      moveUp: {
        ...eligible(),
        target: { parentId: null, afterId: null }
      },
      moveDown: {
        ...eligible(),
        target: { parentId: null, afterId: "three" }
      },
      moveTo: eligible()
    },
    ...overrides
  };
}

function renderBar(
  props: Partial<React.ComponentProps<typeof NotesSelectionActionBar>> = {}
) {
  const onAction = vi.fn<(action: NotesSelectionActionBarAction) => void>();
  const onClearSelection = vi.fn();
  const onReturnFocus = vi.fn();
  render(
    <NotesSelectionActionBar
      snapshot={snapshot()}
      onAction={onAction}
      onClearSelection={onClearSelection}
      onReturnFocus={onReturnFocus}
      {...props}
    />
  );
  return { onAction, onClearSelection, onReturnFocus };
}

describe("NotesSelectionActionBar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("names the selection and keeps the primary actions in the approved order", () => {
    mockCompactViewport(false);
    renderBar();

    const toolbar = screen.getByRole("toolbar", {
      name: "Actions for 2 selected notes"
    });
    expect(
      within(toolbar).getByText("2 selected", { selector: "span" })
    ).toHaveAccessibleName("2 notes selected");
    expect(
      within(toolbar).getAllByRole("button").map((button) => button.ariaLabel)
    ).toEqual([
      "Clear selection",
      "Complete",
      "Move To",
      "Move up",
      "Move down",
      "Indent",
      "Outdent",
      "Duplicate",
      "Tags",
      "More actions",
      "Delete"
    ]);
  });

  it("uses Uncomplete only when every selected row is complete", () => {
    mockCompactViewport(false);
    renderBar({ snapshot: snapshot({ completion: "all" }) });

    expect(screen.getByRole("button", { name: "Uncomplete" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Complete" })
    ).not.toBeInTheDocument();
  });

  it("exposes an explicit reason and ignores unavailable actions", async () => {
    mockCompactViewport(false);
    const unavailableReason = "The selection is already first.";
    const value = snapshot();
    const { onAction } = renderBar({
      snapshot: {
        ...value,
        eligibility: {
          ...value.eligibility,
          moveUp: { eligible: false, reason: unavailableReason }
        }
      }
    });
    const user = userEvent.setup();

    const moveUp = screen.getByRole("button", { name: "Move up" });
    expect(moveUp).toHaveAttribute("aria-disabled", "true");
    expect(moveUp).toHaveAttribute("title", unavailableReason);
    const reasonId = moveUp.getAttribute("aria-describedby");
    expect(reasonId).not.toBeNull();
    expect(document.getElementById(reasonId!)).toHaveTextContent(
      unavailableReason
    );

    await user.click(moveUp);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("guards a pending command against double submission", async () => {
    mockCompactViewport(false);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onAction = vi.fn(() => pending);
    renderBar({ onAction });
    const user = userEvent.setup();

    const complete = screen.getByRole("button", { name: "Complete" });
    await user.click(complete);
    await user.click(complete);

    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.getByRole("toolbar")).toHaveAttribute("aria-busy", "true");
    finish();
  });

  it("renders one polite region for status or error feedback", () => {
    mockCompactViewport(false);
    renderBar({ status: "Copied", error: "Clipboard unavailable" });

    const regions = screen.getAllByRole("status");
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveAttribute("aria-live", "polite");
    expect(regions[0]).toHaveTextContent("Clipboard unavailable");
    expect(regions[0]).toHaveAttribute("data-kind", "error");
  });

  it("uses one roving tab stop and handles arrows, Home, and End", () => {
    mockCompactViewport(false);
    renderBar();
    const toolbar = screen.getByRole("toolbar");
    const clear = screen.getByRole("button", { name: "Clear selection" });
    const complete = screen.getByRole("button", { name: "Complete" });
    const deleteButton = screen.getByRole("button", { name: "Delete" });

    expect(
      within(toolbar)
        .getAllByRole("button")
        .filter((button) => button.tabIndex === 0)
    ).toEqual([clear]);

    clear.focus();
    fireEvent.keyDown(clear, { key: "ArrowRight" });
    expect(complete).toHaveFocus();
    fireEvent.keyDown(complete, { key: "End" });
    expect(deleteButton).toHaveFocus();
    fireEvent.keyDown(deleteButton, { key: "ArrowRight" });
    expect(clear).toHaveFocus();
    fireEvent.keyDown(clear, { key: "Home" });
    expect(clear).toHaveFocus();
    fireEvent.keyDown(clear, { key: "ArrowLeft" });
    expect(deleteButton).toHaveFocus();
  });

  it("clears and returns row focus on Escape and returns focus on Shift+F6", () => {
    mockCompactViewport(false);
    const { onClearSelection, onReturnFocus } = renderBar();
    const complete = screen.getByRole("button", { name: "Complete" });

    fireEvent.keyDown(complete, { key: "Escape" });
    expect(onClearSelection).toHaveBeenCalledOnce();
    expect(onReturnFocus).toHaveBeenCalledOnce();

    fireEvent.keyDown(complete, { key: "F6", shiftKey: true });
    expect(onClearSelection).toHaveBeenCalledOnce();
    expect(onReturnFocus).toHaveBeenCalledTimes(2);
  });

  it("exposes a toolbar ref that hands F6 focus to the roving item", () => {
    mockCompactViewport(false);
    const toolbarRef = createRef<HTMLDivElement>();
    render(
      <NotesSelectionActionBar
        ref={toolbarRef}
        snapshot={snapshot()}
        onAction={vi.fn()}
        onClearSelection={vi.fn()}
        onReturnFocus={vi.fn()}
      />
    );

    toolbarRef.current?.focus();
    expect(screen.getByRole("button", { name: "Clear selection" }))
      .toHaveFocus();
  });

  it("keeps structural actions direct above 720px and only Copy/Cut in More", async () => {
    mockCompactViewport(false);
    renderBar();
    const user = userEvent.setup();

    expect(screen.getByRole("button", { name: "Move up" })).toHaveClass(
      "notes-selection-action-wide"
    );
    await user.click(screen.getByRole("button", { name: "More actions" }));

    const menu = await screen.findByRole("menu", {
      name: "More selection actions"
    });
    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual(["Copy", "Cut"]);
  });

  it("moves structural actions into More at or below 720px", async () => {
    mockCompactViewport(true);
    renderBar();
    const user = userEvent.setup();

    expect(
      screen.queryByRole("button", { name: "Move up" })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More actions" }));

    const menu = await screen.findByRole("menu", {
      name: "More selection actions"
    });
    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual([
      "Move up",
      "Move down",
      "Indent",
      "Outdent",
      "Duplicate",
      "Copy",
      "Cut"
    ]);
  });

  it("moves focus into More and returns it to the trigger on Escape", async () => {
    mockCompactViewport(false);
    renderBar();
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "More actions" });

    trigger.focus();
    await user.keyboard("{Enter}");
    const copy = await screen.findByRole("menuitem", { name: "Copy" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(copy).toHaveFocus();
    expect(copy).toHaveAttribute("tabindex", "0");

    await user.keyboard("{ArrowDown}");
    const cut = screen.getByRole("menuitem", { name: "Cut" });
    expect(cut).toHaveFocus();
    expect(cut).toHaveAttribute("tabindex", "0");
    expect(copy).toHaveAttribute("tabindex", "-1");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("restores More focus before invoking and allows later survivor focus", async () => {
    mockCompactViewport(false);
    const user = userEvent.setup();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let focusAtInvocation: Element | null = null;
    const onAction = vi.fn(async () => {
      focusAtInvocation = document.activeElement;
      await pending;
      screen.getByRole("button", { name: "Surviving row" }).focus();
    });
    render(
      <>
        <NotesSelectionActionBar
          snapshot={snapshot()}
          onAction={onAction}
          onClearSelection={vi.fn()}
          onReturnFocus={vi.fn()}
        />
        <button type="button">Surviving row</button>
      </>
    );
    const trigger = screen.getByRole("button", { name: "More actions" });

    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Cut" }));

    expect(onAction).toHaveBeenCalledWith("cut");
    expect(focusAtInvocation).toBe(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    finish();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Surviving row" }))
        .toHaveFocus()
    );
  });

  it("returns to the selection head with Shift+F6 from inside More", async () => {
    mockCompactViewport(false);
    const { onClearSelection, onReturnFocus } = renderBar();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    const copy = await screen.findByRole("menuitem", { name: "Copy" });
    fireEvent.keyDown(copy, { key: "F6", shiftKey: true });

    expect(onReturnFocus).toHaveBeenCalledOnce();
    expect(onClearSelection).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes More when Tab moves focus outside the menu", async () => {
    mockCompactViewport(false);
    const user = userEvent.setup();
    render(
      <>
        <NotesSelectionActionBar
          snapshot={snapshot()}
          onAction={vi.fn()}
          onClearSelection={vi.fn()}
          onReturnFocus={vi.fn()}
        />
        <button type="button">After toolbar</button>
      </>
    );

    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: "Copy" }))
      .toHaveFocus();
    await user.tab();

    expect(screen.getByRole("button", { name: "After toolbar" }))
      .toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps a CSS 720px fallback and standalone toolbar/chooser presentation", () => {
    const styles = readFileSync(
      join(process.cwd(), "src/features/notes/notes.css"),
      "utf8"
    );

    expect(styles).toMatch(/\.notes-selection-action-bar\s*\{/u);
    expect(styles).toMatch(/\.notes-selection-action-menu\s*\{/u);
    expect(styles).toMatch(/\.notes-selection-chooser\.modal\.modal\s*\{/u);
    expect(styles).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.notes-selection-wide-actions\s*\{[\s\S]*?display:\s*none;/u
    );
  });
});
