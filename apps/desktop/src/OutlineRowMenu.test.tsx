import {
  fireEvent, render, screen, waitFor, within
} from "@testing-library/react";
import { App } from "./App";
import { appApi } from "./test/appApiFixture";
import { menuPlacement } from "./useMenuDismiss";

async function openMenu(row: string, name: string) {
  const trigger = await screen.findByRole("button", {
    name: `Actions for ${row}`
  });
  fireEvent.click(trigger);
  const menu = await screen.findByRole("menu", { name });
  const items = () => within(menu).getAllByRole("menuitem");
  await waitFor(() => expect(items()[0]).toHaveFocus());
  const labels = () => items().map(
    (entry) => entry.querySelector("span")?.textContent
  );
  // Looked up by label rather than by index, so reordering the menu does not
  // silently repoint these assertions at a different command.
  const item = (label: string) => {
    const found = items()[labels().indexOf(label)];
    if (!found) throw new Error(`no menu item labelled ${label}`);
    return found;
  };
  return { trigger, menu, items, labels, item };
}

async function openRowMenu() {
  render(<App api={appApi()} />);
  return openMenu("First thought", "Row actions");
}

/** Two rows selected by a shift range, then the first row's own menu. */
async function openSelectionMenu() {
  render(<App api={appApi()} />);
  const first = await screen.findByDisplayValue("First thought");
  fireEvent.pointerDown(first);
  fireEvent.pointerDown(screen.getByDisplayValue("Second thought"), {
    shiftKey: true
  });
  await screen.findByRole("toolbar", { name: "Actions for 2 selected notes" });
  return openMenu("First thought", "Selection actions");
}

describe("OutlineRowMenu shell", () => {
  it("marks the trigger as a menu button and reflects the open state", async () => {
    render(<App api={appApi()} />);
    const trigger = await screen.findByRole("button", {
      name: "Actions for First thought"
    });

    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);

    expect(await screen.findByRole("menu", { name: "Row actions" })).toBeVisible();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("focuses the first item when the menu opens", async () => {
    const { items } = await openRowMenu();

    expect(items()[0]).toHaveTextContent("Add note");
    expect(items()[0]).toHaveFocus();
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const { trigger, menu } = await openRowMenu();

    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Row actions" }))
        .not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it("closes on an outside pointerdown but stays open for an inside one", async () => {
    const { menu } = await openRowMenu();

    fireEvent.pointerDown(menu);
    expect(screen.getByRole("menu", { name: "Row actions" })).toBeVisible();

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Row actions" }))
        .not.toBeInTheDocument();
    });
  });

  it("roves with the arrow keys, wraps at both ends, and jumps with Home/End",
    async () => {
      const { menu, items } = await openRowMenu();
      const last = items().length - 1;

      fireEvent.keyDown(menu, { key: "ArrowDown" });
      expect(items()[1]).toHaveFocus();

      fireEvent.keyDown(menu, { key: "ArrowUp" });
      expect(items()[0]).toHaveFocus();

      fireEvent.keyDown(menu, { key: "ArrowUp" });
      expect(items()[last]).toHaveFocus();

      fireEvent.keyDown(menu, { key: "ArrowDown" });
      expect(items()[0]).toHaveFocus();

      fireEvent.keyDown(menu, { key: "End" });
      expect(items()[last]).toHaveFocus();

      fireEvent.keyDown(menu, { key: "Home" });
      expect(items()[0]).toHaveFocus();
    });

  it("still closes when an item runs", async () => {
    const { items } = await openRowMenu();

    fireEvent.click(items().find((item) => item.textContent === "Star")!);

    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Row actions" }))
        .not.toBeInTheDocument();
    });
  });
});

describe("OutlineRowMenu items", () => {
  it("renders today's row items with the four new ones before Delete",
    async () => {
      const { labels } = await openRowMenu();

      expect(labels()).toEqual([
        "Add note", "To-do", "Duplicate", "Upload image", "Complete", "Star",
        "Move up", "Move down", "Indent", "Outdent", "Copy", "Cut", "Delete"
      ]);
    });

  it("says Delete rather than Move to Trash", async () => {
    const { labels } = await openRowMenu();

    expect(labels()).toContain("Delete");
    expect(labels()).not.toContain("Move to Trash");
  });

  it("renders the documented selection commands in order", async () => {
    const { labels } = await openSelectionMenu();

    expect(labels()).toEqual([
      "Complete", "Move up", "Move down", "Indent", "Outdent", "Duplicate",
      "Copy", "Cut", "Delete"
    ]);
  });

  it("puts the platform's shortcut hint in the menu's third column",
    async () => {
      const { item } = await openRowMenu();
      const hint = (label: string) => item(label)
        .querySelector(".notes-bullet-menu-shortcut")
        ?.textContent;

      expect(hint("Complete")).toBe("Ctrl+Enter");
      expect(hint("Delete")).toBe("Ctrl+Shift+Backspace");
      expect(hint("Move up")).toBe("Alt+Shift+↑");
      expect(hint("Outdent")).toBe("Shift+Tab");
      expect(hint("Star")).toBeUndefined();
    });

  it("switches the hints to the mac bindings on a mac", async () => {
    Object.defineProperty(globalThis.navigator, "platform", {
      value: "MacIntel",
      configurable: true
    });
    try {
      const { item } = await openRowMenu();

      expect(item("Complete").querySelector(".notes-bullet-menu-shortcut"))
        .toHaveTextContent("⌘↩");
      expect(item("Complete"))
        .toHaveAttribute("aria-keyshortcuts", "Meta+Enter");
    } finally {
      Object.defineProperty(globalThis.navigator, "platform", {
        value: "",
        configurable: true
      });
    }
  });
});

describe("OutlineRowMenu disabled items", () => {
  // The first row has no preceding sibling and sits at the outline root, so
  // its move commands are exactly the unavailable plans from selectionMoves.
  it("dims an unavailable item and explains why", async () => {
    const { item } = await openRowMenu();

    expect(item("Move up")).toHaveAttribute("data-disabled", "true");
    expect(item("Move up")).toHaveAttribute("aria-disabled", "true");
    expect(item("Move up")).toHaveAccessibleDescription(
      "The selection is already at that boundary."
    );
    expect(item("Outdent")).toHaveAccessibleDescription(
      "The selection cannot move outside this outline."
    );
  });

  it("stays put when an unavailable item is clicked", async () => {
    const { item } = await openRowMenu();

    fireEvent.click(item("Move up"));

    expect(screen.getByRole("menu", { name: "Row actions" })).toBeVisible();
  });

  it("still roves onto an unavailable item so its reason can be read",
    async () => {
      const { menu, items, labels, item } = await openRowMenu();
      const steps = labels().indexOf("Move up");

      for (let step = 0; step < steps; step += 1) {
        fireEvent.keyDown(menu, { key: "ArrowDown" });
      }

      expect(items()[steps]).toBe(item("Move up"));
      expect(item("Move up")).toHaveFocus();
      expect(item("Move up")).toHaveAttribute("data-disabled", "true");
    });
});

// jsdom has no layout, so the flip and clamp decisions live in a pure
// function and are checked here with measured rectangles instead.
describe("menuPlacement", () => {
  const bounds = { top: 100, bottom: 700, left: 0, right: 800 };

  it("keeps the menu below the trigger when it fits", () => {
    expect(menuPlacement(
      { top: 200, left: 40, width: 220, height: 300 },
      bounds
    )).toEqual({ insetBlockStart: 28, insetInlineStart: 0 });
  });

  it("flips above the trigger when the bottom would overflow", () => {
    expect(menuPlacement(
      { top: 500, left: 40, width: 220, height: 300 },
      bounds
    ).insetBlockStart).toBe(-304);
  });

  it("stays below when there is no room above either", () => {
    expect(menuPlacement(
      { top: 660, left: 40, width: 220, height: 600 },
      bounds
    ).insetBlockStart).toBe(28);
  });

  it("shifts left by the overflow instead of spilling past the viewport", () => {
    expect(menuPlacement(
      { top: 200, left: 700, width: 220, height: 300 },
      bounds
    ).insetInlineStart).toBe(-120);
  });

  it("never shifts the menu past the left edge", () => {
    expect(menuPlacement(
      { top: 200, left: 40, width: 900, height: 300 },
      bounds
    ).insetInlineStart).toBe(-40);
  });
});
