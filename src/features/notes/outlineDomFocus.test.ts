import { afterEach, describe, expect, it, vi } from "vitest";
import { focusOutlineEditorDom } from "./outlineDomFocus";

function buildPane(
  rows: readonly {
    id: string;
    title?: string;
    liveTitle?: string;
    note?: string;
  }[],
): HTMLElement {
  const pane = document.createElement("section");
  pane.className = "notes-outline";
  for (const row of rows) {
    const shell = document.createElement("div");
    shell.setAttribute("data-outline-id", row.id);
    const titleValue = row.title ?? row.liveTitle;
    if (titleValue !== undefined) {
      const title = document.createElement("div");
      title.setAttribute("data-notes-bullet-title", "");
      title.tabIndex = 0;
      title.textContent = titleValue;
      shell.appendChild(title);
    }
    if (row.note !== undefined) {
      const note = document.createElement("textarea");
      note.className = "notes-node-note";
      note.value = row.note;
      shell.appendChild(note);
    }
    pane.appendChild(shell);
  }
  document.body.appendChild(pane);
  return pane;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("focusOutlineEditorDom", () => {
  it("focuses only the exact escaped row id inside the owning pane", () => {
    const escapedId = 'row"] [data-x="trap';
    const firstPane = buildPane([{ id: escapedId, title: "first" }]);
    const secondPane = buildPane([{ id: escapedId, title: "second" }]);
    const firstTitle = firstPane.querySelector<HTMLDivElement>(
      "[data-notes-bullet-title]",
    )!;
    const secondTitle = secondPane.querySelector<HTMLDivElement>(
      "[data-notes-bullet-title]",
    )!;
    secondTitle.focus();

    expect(
      focusOutlineEditorDom(firstPane, escapedId, "title", "start"),
    ).toBe(true);

    expect(document.activeElement).toBe(firstTitle);
    expect(document.activeElement).not.toBe(secondTitle);
  });

  it("focuses the title editor and collapses the caret to the end", () => {
    const pane = buildPane([{ id: "a", title: "hello" }]);
    const editor = pane.querySelector<HTMLDivElement>(
      "[data-notes-bullet-title]",
    )!;

    expect(focusOutlineEditorDom(pane, "a", "title", "end")).toBe(true);

    expect(document.activeElement).toBe(editor);
    expect(document.getSelection()?.anchorOffset).toBe(5);
    expect(document.getSelection()?.focusOffset).toBe(5);
  });

  it("focuses the live title editor and restores its plain-text range", () => {
    const pane = buildPane([{ id: "a", liveTitle: "hello" }]);
    const editor = pane.querySelector<HTMLDivElement>(
      "[data-notes-bullet-title]",
    )!;

    expect(
      focusOutlineEditorDom(pane, "a", "title", { start: 1, end: 4 }),
    ).toBe(true);

    expect(document.activeElement).toBe(editor);
    const selection = document.getSelection()!;
    expect(selection.anchorNode).toBe(editor.firstChild);
    expect(selection.anchorOffset).toBe(1);
    expect(selection.focusNode).toBe(editor.firstChild);
    expect(selection.focusOffset).toBe(4);
  });

  it("collapses the caret to the start", () => {
    const pane = buildPane([{ id: "a", title: "hello" }]);
    const editor = pane.querySelector<HTMLDivElement>(
      "[data-notes-bullet-title]",
    )!;

    expect(focusOutlineEditorDom(pane, "a", "title", "start")).toBe(true);

    expect(document.activeElement).toBe(editor);
    expect(document.getSelection()?.anchorOffset).toBe(0);
    expect(document.getSelection()?.focusOffset).toBe(0);
  });

  it("applies a normalized explicit range clamped to the value length", () => {
    const pane = buildPane([{ id: "a", title: "hello" }]);

    expect(
      focusOutlineEditorDom(pane, "a", "title", {
        start: Number.MAX_SAFE_INTEGER,
        end: 1,
      }),
    ).toBe(true);

    expect(document.getSelection()?.anchorOffset).toBe(1);
    expect(document.getSelection()?.focusOffset).toBe(5);
  });

  it("focuses the supporting note textarea", () => {
    const pane = buildPane([{ id: "a", title: "title", note: "note body" }]);
    const note = pane.querySelector<HTMLTextAreaElement>(
      "textarea.notes-node-note",
    )!;

    expect(focusOutlineEditorDom(pane, "a", "note", "start")).toBe(true);

    expect(document.activeElement).toBe(note);
  });

  it("keeps the existing selection when no edge is requested", () => {
    const pane = buildPane([{ id: "a", title: "hello" }]);
    const editor = pane.querySelector<HTMLDivElement>(
      "[data-notes-bullet-title]",
    )!;
    editor.focus();
    const range = document.createRange();
    range.setStart(editor.firstChild!, 2);
    range.setEnd(editor.firstChild!, 4);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(focusOutlineEditorDom(pane, "a", "title", null)).toBe(true);

    expect(document.activeElement).toBe(editor);
    expect(selection.anchorOffset).toBe(2);
    expect(selection.focusOffset).toBe(4);
  });

  it("returns false when the row or requested field is not mounted", () => {
    const pane = buildPane([{ id: "a", title: "hello" }]);

    expect(focusOutlineEditorDom(pane, "missing", "title", "end")).toBe(false);
    expect(focusOutlineEditorDom(pane, "a", "note", "end")).toBe(false);
  });

  it("returns false when the browser refuses focus", () => {
    const pane = buildPane([{ id: "a", title: "hello" }]);
    const editor = pane.querySelector<HTMLDivElement>(
      "[data-notes-bullet-title]",
    )!;
    vi.spyOn(editor, "focus").mockImplementation(() => undefined);

    expect(focusOutlineEditorDom(pane, "a", "title", "end")).toBe(false);
  });
});
