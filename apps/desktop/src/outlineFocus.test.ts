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
      reveal: (nodeId) => {
        if (nodeId !== "offscreen") return false;
        revealed = editor(scope, nodeId, "windowed");
        return true;
      }
    });

    expect(focusOutlineEditor(scope, "offscreen", "end")).toBe(true);
    expect(revealed).not.toHaveFocus();

    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(revealed).toHaveFocus();
    expect(revealed!.selectionStart).toBe(8);
  });

  it("refuses to reveal a node the pane does not hold", () => {
    const scope = document.createElement("section");
    document.body.append(scope);
    registerOutlinePane(scope, { visibleNodes: [], reveal: () => false });

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
});
