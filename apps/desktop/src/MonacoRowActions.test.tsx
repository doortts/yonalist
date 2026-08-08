import { act, fireEvent, render, screen } from "@testing-library/react";

import { MonacoRowActions } from "./MonacoRowActions";
import type { OutlineRowActionTarget } from "./monaco-outline/rowActions";

function tracker(initial: OutlineRowActionTarget | null) {
  let target = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current: () => target,
    set(next: OutlineRowActionTarget | null) {
      target = next;
      for (const listener of listeners) listener();
    }
  };
}

const picture: OutlineRowActionTarget = {
  nodeId: "image-1",
  lineNumber: 4,
  title: "cat.png",
  top: 75
};

describe("MonacoRowActions", () => {
  it("names the trigger after the row and opens the upload item", () => {
    const onPickImage = vi.fn();
    const rows = tracker({
      nodeId: "bullet-1",
      lineNumber: 1,
      title: "First thought",
      top: 0
    });

    render(
      <MonacoRowActions
        rows={rows}
        onPickImage={onPickImage}
        onDismiss={vi.fn()}
      />
    );

    const trigger = screen.getByRole("button", {
      name: "Actions for First thought"
    });
    expect(trigger).toHaveClass("notes-bullet-menu-trigger");
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(trigger);

    expect(screen.getByRole("menu")).toHaveClass("notes-bullet-menu");
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload image" }));

    expect(onPickImage).toHaveBeenCalledWith("bullet-1");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("draws nothing while no row is hovered or focused", () => {
    const rows = tracker(null);

    render(
      <MonacoRowActions
        rows={rows}
        onPickImage={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("follows the tracked row and picks that row's node", () => {
    const onPickImage = vi.fn();
    const rows = tracker({
      nodeId: "bullet-1",
      lineNumber: 1,
      title: "First thought",
      top: 0
    });
    render(
      <MonacoRowActions
        rows={rows}
        onPickImage={onPickImage}
        onDismiss={vi.fn()}
      />
    );

    act(() => rows.set(picture));

    const trigger = screen.getByRole("button", { name: "Actions for cat.png" });
    expect(trigger.parentElement).toHaveStyle({ top: "75px" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload image" }));

    expect(onPickImage).toHaveBeenCalledWith("image-1");
  });

  it("holds the open menu still while the editor takes the focus back", () => {
    const rows = tracker(picture);
    const onDismiss = vi.fn();
    render(
      <MonacoRowActions
        rows={rows}
        onPickImage={vi.fn()}
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole("button", {
      name: "Actions for cat.png"
    }));
    // Opening the menu moves focus out of the editor, which drops the caret
    // target: the menu the user is reading must not vanish with it.
    act(() => rows.set(null));
    expect(screen.getByRole("menu")).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Upload image" }))
      .toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
