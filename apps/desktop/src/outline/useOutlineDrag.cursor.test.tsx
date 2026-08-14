import { act, fireEvent, render, screen } from "@testing-library/react";
import type { UseOutlineDragInput } from "./outlineDragEngine";
import { useOutlineDrag } from "./useOutlineDrag";

const DRAGGING_CLASS = "is-outline-dragging";

const input: UseOutlineDragInput = {
  enabled: true,
  nodes: [],
  visibleNodes: [],
  outlineRootId: "page-1",
  selection: {
    selectedIds: [],
    selectedRootIds: []
  } as unknown as UseOutlineDragInput["selection"],
  moveNodes: async () => {},
  labelForId: (id) => id
};

function Harness() {
  const drag = useOutlineDrag(input);
  const props = drag.rowProps("bullet-1");
  return (
    <div className="notes-outline" data-outline-root-id="page-1">
      <button type="button" onPointerDown={props.onDragHandlePointerDown}>
        bullet
      </button>
    </div>
  );
}

async function pressHandle() {
  render(<Harness />);
  const handle = screen.getByRole("button", { name: "bullet" });
  await act(async () => {
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 0,
      clientY: 0
    });
  });
  return handle;
}

async function dragPast() {
  const handle = await pressHandle();
  await act(async () => {
    fireEvent.pointerMove(window, {
      pointerId: 1,
      buttons: 1,
      clientX: 20,
      clientY: 0
    });
  });
  return handle;
}

describe("useOutlineDrag body cursor class", () => {
  afterEach(() => document.body.classList.remove(DRAGGING_CLASS));

  it("marks the body once the pointer travels past the activation distance", async () => {
    await dragPast();
    expect(document.body).toHaveClass(DRAGGING_CLASS);
  });

  it("unmarks the body when the pointer is released", async () => {
    await dragPast();
    await act(async () => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });
    expect(document.body).not.toHaveClass(DRAGGING_CLASS);
  });

  it("unmarks the body when the gesture is cancelled", async () => {
    await dragPast();
    await act(async () => {
      fireEvent.pointerCancel(window, { pointerId: 1 });
    });
    expect(document.body).not.toHaveClass(DRAGGING_CLASS);
  });

  it("leaves the body alone for a click that never moves", async () => {
    await pressHandle();
    await act(async () => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });
    expect(document.body).not.toHaveClass(DRAGGING_CLASS);
  });
});
