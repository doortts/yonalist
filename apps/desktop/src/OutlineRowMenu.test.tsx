import {
  fireEvent, render, screen, waitFor, within
} from "@testing-library/react";
import { App } from "./App";
import { appApi } from "./test/appApiFixture";
import { menuPlacement } from "./useMenuDismiss";

async function openRowMenu() {
  render(<App api={appApi()} />);
  const trigger = await screen.findByRole("button", {
    name: "Actions for First thought"
  });
  fireEvent.click(trigger);
  const menu = await screen.findByRole("menu", { name: "Row actions" });
  const items = () => within(menu).getAllByRole("menuitem");
  await waitFor(() => expect(items()[0]).toHaveFocus());
  return { trigger, menu, items };
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
