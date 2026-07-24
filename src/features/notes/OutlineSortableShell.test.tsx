import { fireEvent, render, screen } from "@testing-library/react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  createOutlineSortableController,
  OutlineSortableHandle,
  OutlineSortableRuntime,
  OutlineSortableShell,
  useOutlineSortableHandle
} from "./OutlineSortableShell";

const sortable = vi.hoisted(() => ({
  attributes: {
    role: "button",
    "aria-roledescription": "sortable note",
    tabIndex: 0
  },
  listeners: {
    onKeyDown: vi.fn(),
    onPointerDown: vi.fn(),
  },
  setActivatorNodeRef: vi.fn(),
  setNodeRef: vi.fn(),
  isDragging: true,
  transform: { x: 4, y: 8, scaleX: 1, scaleY: 1 },
  transition: "transform 100ms"
}));

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: vi.fn(() => sortable)
}));

function shellWithController(
  editor: React.ReactElement,
  controller: ReturnType<typeof createOutlineSortableController>,
  disabled: boolean,
) {
  return (
    <>
      <OutlineSortableRuntime
        controller={controller}
        nodeId="node-a"
        disabled={disabled}
        suppressDragPresentation={false}
      />
      <OutlineSortableShell
        controller={controller}
        nodeId="node-a"
        disabled={disabled}
        depth={2}
        suppressDragPresentation={false}
        className="notes-node"
        completed
        markerKind="todo"
        emptyBullet={false}
        guideEndId="node-b"
        selected
        rangeSelected={false}
        attachmentTargetId="node-a"
        imageDropActive
        editor={editor}
      />
    </>
  );
}

function shell(editor: React.ReactElement) {
  return shellWithController(editor, createOutlineSortableController(), false);
}

describe("OutlineSortableShell", () => {
  it("keeps sortable root presentation in the shell and listeners in the handle", () => {
    const onKeyDown = vi.fn(
      (_event: ReactKeyboardEvent<HTMLButtonElement>) => undefined
    );
    render(
      shell(
        <OutlineSortableHandle
          enabled
          type="button"
          aria-label="Zoom into node"
          onKeyDown={onKeyDown}
        />
      )
    );

    const root = document.querySelector<HTMLElement>('[data-outline-id="node-a"]');
    const handle = screen.getByRole("button", { name: "Zoom into node" });
    expect(root).toHaveClass("notes-node");
    expect(root).toHaveAttribute("data-dragging", "true");
    expect(root).toHaveAttribute("data-selected", "true");
    expect(root?.style.transform).toContain("translate3d(4px, 8px, 0)");
    expect(handle).toHaveAttribute("aria-roledescription", "sortable note");

    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(sortable.listeners.onKeyDown).toHaveBeenCalledOnce();
    expect(onKeyDown).toHaveBeenCalledOnce();
  });

  it("throws when the handle hook is used outside a sortable shell", () => {
    function Outside() {
      useOutlineSortableHandle();
      return null;
    }

    expect(() => render(<Outside />)).toThrow(
      "OutlineSortableHandle requires OutlineSortableShell."
    );
  });

  it("blocks only sortable listeners when the shell becomes disabled", () => {
    const ownKeyDown = vi.fn();
    const ownPointerDown = vi.fn();
    const controller = createOutlineSortableController();
    const editor = (
      <OutlineSortableHandle
        enabled
        type="button"
        aria-label="Zoom into node"
        onKeyDown={ownKeyDown}
        onPointerDown={ownPointerDown}
      />
    );
    const view = render(shellWithController(editor, controller, false));
    sortable.listeners.onKeyDown.mockClear();
    sortable.listeners.onPointerDown.mockClear();
    view.rerender(shellWithController(editor, controller, true));

    const handle = screen.getByRole("button", { name: "Zoom into node" });
    expect(handle).not.toHaveAttribute("aria-roledescription");
    expect(handle).not.toHaveAttribute("tabindex");
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    fireEvent.pointerDown(handle);

    expect(sortable.listeners.onKeyDown).not.toHaveBeenCalled();
    expect(sortable.listeners.onPointerDown).not.toHaveBeenCalled();
    expect(ownKeyDown).toHaveBeenCalledOnce();
    expect(ownPointerDown).toHaveBeenCalledOnce();
  });

  it("reactivates sortable listeners after an initially disabled mount", () => {
    const ownKeyDown = vi.fn();
    const controller = createOutlineSortableController();
    const editor = (
      <OutlineSortableHandle
        enabled
        type="button"
        aria-label="Zoom into node"
        onKeyDown={ownKeyDown}
      />
    );
    const view = render(shellWithController(editor, controller, true));
    sortable.listeners.onKeyDown.mockClear();
    sortable.listeners.onPointerDown.mockClear();

    view.rerender(shellWithController(editor, controller, false));

    const handle = screen.getByRole("button", { name: "Zoom into node" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    fireEvent.pointerDown(handle);

    expect(sortable.listeners.onKeyDown).toHaveBeenCalledOnce();
    expect(sortable.listeners.onPointerDown).toHaveBeenCalledOnce();
    expect(ownKeyDown).toHaveBeenCalledOnce();
  });

  it("rebinds the shell root and handle after a controller replacement", () => {
    const firstController = createOutlineSortableController();
    const secondController = createOutlineSortableController();
    const ownKeyDown = vi.fn();
    const editor = (
      <OutlineSortableHandle
        enabled
        type="button"
        aria-label="Zoom into node"
        onKeyDown={ownKeyDown}
      />
    );
    const view = render(shellWithController(editor, firstController, false));
    const root = document.querySelector<HTMLElement>(
      '[data-outline-id="node-a"]',
    );

    view.rerender(shellWithController(editor, secondController, true));
    sortable.listeners.onKeyDown.mockClear();

    expect(firstController.snapshot.root).toBeNull();
    expect(secondController.snapshot.root).toBe(root);
    fireEvent.keyDown(screen.getByRole("button", { name: "Zoom into node" }), {
      key: "ArrowDown",
    });
    expect(sortable.listeners.onKeyDown).not.toHaveBeenCalled();
    expect(ownKeyDown).toHaveBeenCalledOnce();
  });
});
