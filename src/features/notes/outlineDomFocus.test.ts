import { afterEach, describe, expect, it } from "vitest";
import { focusOutlineEditorDom } from "./outlineDomFocus";

function buildPane(
  rows: readonly {
    id: string;
    title?: string;
    note?: string;
  }[],
): HTMLElement {
  const pane = document.createElement("section");
  pane.className = "notes-outline";
  for (const row of rows) {
    const shell = document.createElement("div");
    shell.setAttribute("data-outline-id", row.id);
    if (row.title !== undefined) {
      const title = document.createElement("textarea");
      title.className = "notes-node-title";
      title.value = row.title;
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
});

describe("focusOutlineEditorDom", () => {
  it("focuses the title textarea and collapses the caret to the end", () => {
    const pane = buildPane([{ id: "a", title: "hello" }]);
    const textarea = pane.querySelector<HTMLTextAreaElement>(
      "textarea.notes-node-title",
    )!;

    expect(focusOutlineEditorDom(pane, "a", "title", "end")).toBe(true);

    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(5);
    expect(textarea.selectionEnd).toBe(5);
  });

  it("collapses the caret to the start for edge 'start'", () => {
    const pane = buildPane([{ id: "a", title: "hello" }]);
    const textarea = pane.querySelector<HTMLTextAreaElement>(
      "textarea.notes-node-title",
    )!;

    expect(focusOutlineEditorDom(pane, "a", "title", "start")).toBe(true);

    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(0);
  });

  it("applies an explicit range clamped to the value length", () => {
    const pane = buildPane([{ id: "a", title: "hello" }]);
    const textarea = pane.querySelector<HTMLTextAreaElement>(
      "textarea.notes-node-title",
    )!;

    // A history selection replay can carry Number.MAX_SAFE_INTEGER for "end".
    expect(
      focusOutlineEditorDom(pane, "a", "title", {
        start: 1,
        end: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(true);

    expect(textarea.selectionStart).toBe(1);
    expect(textarea.selectionEnd).toBe(5);
  });

  it("focuses the note textarea when field is 'note'", () => {
    const pane = buildPane([{ id: "a", title: "title", note: "note body" }]);
    const note = pane.querySelector<HTMLTextAreaElement>(
      "textarea.notes-node-note",
    )!;

    expect(focusOutlineEditorDom(pane, "a", "note", "start")).toBe(true);

    expect(document.activeElement).toBe(note);
  });

  it("leaves the existing selection untouched when edge is null", () => {
    const pane = buildPane([{ id: "a", title: "hello" }]);
    const textarea = pane.querySelector<HTMLTextAreaElement>(
      "textarea.notes-node-title",
    )!;
    textarea.setSelectionRange(2, 4);

    expect(focusOutlineEditorDom(pane, "a", "title", null)).toBe(true);

    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(4);
  });

  it("returns false when the row is not mounted", () => {
    const pane = buildPane([{ id: "a", title: "hello" }]);

    expect(focusOutlineEditorDom(pane, "missing", "title", "end")).toBe(false);
  });

  it("returns false when the requested field is absent", () => {
    // A row whose note field has not been opened has no note textarea.
    const pane = buildPane([{ id: "a", title: "hello" }]);

    expect(focusOutlineEditorDom(pane, "a", "note", "end")).toBe(false);
  });
});
