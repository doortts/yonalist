import { act, fireEvent, render, screen } from "@testing-library/react";
import { OutlineTextField } from "./OutlineTextField";

interface CaretDocument {
  caretPositionFromPoint?: (
    x: number,
    y: number
  ) => { offsetNode: Node; offset: number } | null;
}

/** clientX doubles as the text offset the pointer is over. */
function caretPositionAt(root: HTMLElement, offset: number) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last: Text | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (remaining <= node.length) return { offsetNode: node, offset: remaining };
    remaining -= node.length;
    last = node;
  }
  return last ? { offsetNode: last, offset: last.length } : null;
}

function setup(value: string, markdown = false) {
  const { container } = render(
    <OutlineTextField
      markdown={markdown}
      value={value}
      aria-label="Row"
      onChange={vi.fn()}
    />
  );
  const presentation = screen.getByRole("group", { name: "Row" });
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  (document as CaretDocument).caretPositionFromPoint = (x) =>
    caretPositionAt(presentation, x);
  return { presentation, textarea };
}

function selectionOf(textarea: HTMLTextAreaElement) {
  return [
    textarea.selectionStart,
    textarea.selectionEnd,
    textarea.selectionDirection
  ];
}

const drag = (offset: number) => ({
  clientX: offset,
  clientY: 5,
  pointerId: 1,
  buttons: 1
});

afterEach(() => {
  delete (document as CaretDocument).caretPositionFromPoint;
});

describe("v2 outline resting drag selection", () => {
  it("selects characters while dragging on a row that was not focused", () => {
    const { presentation, textarea } = setup("hello world");

    fireEvent.pointerDown(presentation, drag(3));
    expect(textarea).toHaveFocus();
    expect(selectionOf(textarea)).toEqual([3, 3, "none"]);

    fireEvent.pointerMove(presentation, drag(8));
    expect(selectionOf(textarea)).toEqual([3, 8, "forward"]);
    expect(presentation.style.pointerEvents).toBe("auto");
    expect(textarea.style.pointerEvents).toBe("none");

    fireEvent.pointerMove(presentation, drag(1));
    expect(selectionOf(textarea)).toEqual([1, 3, "backward"]);
  });

  it("collapses toward the start when the pointer drags above the row", () => {
    const { presentation, textarea } = setup("hello world");

    fireEvent.pointerDown(presentation, drag(6));
    fireEvent.pointerMove(presentation, { ...drag(9), clientY: -20 });
    expect(selectionOf(textarea)).toEqual([0, 6, "backward"]);
  });

  it("ends the gesture on pointerup and restores the editing layers", () => {
    const { presentation, textarea } = setup("hello world");

    fireEvent.pointerDown(presentation, drag(3));
    fireEvent.pointerMove(presentation, drag(8));
    fireEvent.pointerUp(presentation, { ...drag(8), buttons: 0 });
    expect(presentation.style.pointerEvents).toBe("none");
    expect(textarea.style.pointerEvents).toBe("");

    fireEvent.pointerMove(presentation, drag(2));
    expect(selectionOf(textarea)).toEqual([3, 8, "forward"]);
  });

  it("aborts when the row selection gesture blurs the textarea mid-drag", () => {
    const { presentation, textarea } = setup("hello world");

    fireEvent.pointerDown(presentation, drag(3));
    fireEvent.pointerMove(presentation, drag(8));
    act(() => {
      textarea.blur();
    });

    fireEvent.pointerMove(presentation, drag(2));
    expect(selectionOf(textarea)).toEqual([3, 8, "forward"]);
  });

  it("keeps the collapsed caret for a plain click", () => {
    const { presentation, textarea } = setup("hello world");

    fireEvent.pointerDown(presentation, drag(4));
    fireEvent.pointerUp(presentation, { ...drag(4), buttons: 0 });
    expect(selectionOf(textarea)).toEqual([4, 4, "none"]);
  });

  it("anchors a Markdown drag on the raw source offset behind the rendered token", () => {
    const { presentation, textarea } = setup("a **bold** c", true);

    // rendered "a bold c": offset 2 is the "b" of the strong token
    fireEvent.pointerDown(presentation, drag(2));
    expect(selectionOf(textarea)).toEqual([4, 4, "none"]);

    // editing reveals the raw source in the span, so offset 8 is the "d" end
    expect(presentation).toHaveTextContent("a **bold** c");
    fireEvent.pointerMove(presentation, drag(8));
    expect(selectionOf(textarea)).toEqual([4, 8, "forward"]);
  });
});
