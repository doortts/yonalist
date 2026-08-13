import {
  focusOutlineEditor,
  focusOutlineEditorAt
} from "./outlineFocus";
import { registerOutlinePane } from "./outlinePaneRegistry";

function editor(scope: HTMLElement, nodeId: string, value: string) {
  const textarea = document.createElement("textarea");
  textarea.dataset.nodeId = nodeId;
  textarea.value = value;
  scope.append(textarea);
  return textarea;
}

describe("pane-scoped outline focus", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("focuses only the matching editor inside the requested split pane", () => {
    const firstScope = document.createElement("section");
    const secondScope = document.createElement("section");
    document.body.append(firstScope, secondScope);
    const first = editor(firstScope, "shared", "First");
    const second = editor(secondScope, "shared", "Second");

    expect(focusOutlineEditor(secondScope, "shared", "end")).toBe(true);

    expect(second).toHaveFocus();
    expect(second.selectionStart).toBe(6);
    expect(second.selectionEnd).toBe(6);
    expect(first).not.toHaveFocus();
  });

  it("places boundary carets and preserves a clamped source offset", () => {
    const scope = document.createElement("section");
    document.body.append(scope);
    const source = editor(scope, "source", "12345678");
    const target = editor(scope, "target", "abc");
    source.focus();
    source.setSelectionRange(5, 5);

    expect(focusOutlineEditor(scope, "target", "preserve")).toBe(true);
    expect(target.selectionStart).toBe(3);
    expect(target.selectionEnd).toBe(3);

    expect(focusOutlineEditor(scope, "target", "start")).toBe(true);
    expect(target.selectionStart).toBe(0);
    expect(target.selectionEnd).toBe(0);
  });

  it("returns false without changing focus when the pane has no matching row", () => {
    const scope = document.createElement("section");
    const outside = document.createElement("button");
    document.body.append(scope, outside);
    outside.focus();

    expect(focusOutlineEditor(scope, "missing", "start")).toBe(false);
    expect(outside).toHaveFocus();
  });

  it("places a caret at an exact clamped UTF-16 join offset", () => {
    const scope = document.createElement("section");
    document.body.append(scope);
    const target = editor(scope, "target", "alphabeta");

    expect(focusOutlineEditorAt(scope, "target", 5)).toBe(true);
    expect(target).toHaveFocus();
    expect(target.selectionStart).toBe(5);
    expect(target.selectionEnd).toBe(5);

    expect(focusOutlineEditorAt(scope, "target", 99)).toBe(true);
    expect(target.selectionStart).toBe(9);
    expect(target.selectionEnd).toBe(9);
  });

  it("reveals a row outside the rendered window before focusing it", async () => {
    const scope = document.createElement("section");
    document.body.append(scope);
    let revealed: HTMLTextAreaElement | null = null;
    registerOutlinePane(scope, {
      visibleNodes: [],
      selectedIds: () => [],
      replaceSelection: () => undefined,
      reveal: (nodeId) => {
        if (nodeId !== "offscreen") return false;
        revealed = editor(scope, nodeId, "windowed");
        return true;
      }
    });

    // No frames at all for the whole wait: an occluded or backgrounded window
    // paints none, and the revealed row still has to take the caret there.
    const frames = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation(() => 0);
    try {
      expect(focusOutlineEditor(scope, "offscreen", "end")).toBe(true);
      expect(revealed).not.toHaveFocus();

      await new Promise((resolve) => setTimeout(resolve));

      expect(revealed).toHaveFocus();
      expect(revealed!.selectionStart).toBe(8);
    } finally {
      frames.mockRestore();
    }
  });

  it("lets a newer focus request cancel a pending reveal retry", () => {
    vi.useFakeTimers();
    const scope = document.createElement("section");
    document.body.append(scope);
    let older: HTMLTextAreaElement | null = null;
    registerOutlinePane(scope, {
      visibleNodes: [],
      selectedIds: () => [],
      replaceSelection: () => undefined,
      reveal: (nodeId) => {
        if (nodeId !== "older") return false;
        // The row mounts right away but the caret only lands a tick later,
        // which is the window a newer request can arrive in.
        older = editor(scope, nodeId, "older");
        return true;
      }
    });
    const newer = editor(scope, "newer", "newer");

    expect(focusOutlineEditor(scope, "older", "end")).toBe(true);
    expect(older).not.toHaveFocus();
    expect(focusOutlineEditor(scope, "newer", "end")).toBe(true);
    expect(newer).toHaveFocus();

    vi.runAllTimers();

    expect(newer).toHaveFocus();
    expect(older).not.toHaveFocus();
  });

  it("refuses to reveal a node the pane does not hold", () => {
    const scope = document.createElement("section");
    document.body.append(scope);
    registerOutlinePane(scope, {
      visibleNodes: [],
      reveal: () => false,
      selectedIds: () => [],
      replaceSelection: () => undefined
    });

    expect(focusOutlineEditor(scope, "missing", "start")).toBe(false);
  });

  it("focuses image primary content without applying textarea selection", () => {
    const scope = document.createElement("section");
    document.body.append(scope);
    const image = document.createElement("div");
    image.tabIndex = 0;
    image.dataset.nodeId = "image";
    image.dataset.outlineField = "image";
    scope.append(image);

    expect(focusOutlineEditor(scope, "image", "end")).toBe(true);
    expect(image).toHaveFocus();
  });

  it("prevents browser ancestor scrolling and reveals only the local outline", () => {
    const outer = document.createElement("div");
    const scope = document.createElement("section");
    const rows = document.createElement("div");
    rows.className = "notes-outline-rows";
    outer.append(scope);
    scope.append(rows);
    document.body.append(outer);
    const target = editor(rows, "target", "");
    outer.scrollTop = 75;
    rows.scrollTop = 40;
    vi.spyOn(rows, "getBoundingClientRect").mockReturnValue({
      top: 10,
      bottom: 110
    } as DOMRect);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 110,
      bottom: 138
    } as DOMRect);
    const focus = vi.spyOn(target, "focus");

    expect(focusOutlineEditor(scope, "target", "start")).toBe(true);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(rows.scrollTop).toBe(68);
    expect(outer.scrollTop).toBe(75);
  });

  it("re-reveals the caret after a deletion shifts the layout", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
      (callback) => {
        frames.push(callback);
        return frames.length;
      }
    );
    const scope = document.createElement("section");
    const rows = document.createElement("div");
    rows.className = "notes-outline-rows";
    scope.append(rows);
    document.body.append(scope);
    const target = editor(rows, "target", "");
    rows.scrollTop = 120;
    const rowsRect = vi.spyOn(rows, "getBoundingClientRect");
    const targetRect = vi.spyOn(target, "getBoundingClientRect");
    rowsRect.mockReturnValue({ top: 10, bottom: 110 } as DOMRect);
    targetRect.mockReturnValue({ top: 40, bottom: 68 } as DOMRect);

    expect(focusOutlineEditor(scope, "target", "start")).toBe(true);
    expect(rows.scrollTop).toBe(120);

    targetRect.mockReturnValue({ top: -18, bottom: 10 } as DOMRect);
    frames.forEach((callback) => callback(0));
    expect(rows.scrollTop).toBe(92);
  });
});
