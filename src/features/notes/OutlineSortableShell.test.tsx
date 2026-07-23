import { fireEvent, render, screen } from "@testing-library/react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  OutlineSortableHandle,
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
    onKeyDown: vi.fn()
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

function shell(editor: React.ReactElement) {
  return (
    <OutlineSortableShell
      nodeId="node-a"
      disabled={false}
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
  );
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
});
