import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { capturePane, zoomEntryFocus } from "./appNavigation";
import { registerOutlinePane } from "./outline/outlinePaneRegistry";

function paneFixture(): string {
  return `
    <section data-outline-pane-id="primary">
      <div data-outline-id="primary-selected" data-selected="true"></div>
    </section>
    <section data-outline-pane-id="secondary">
      <div data-outline-id="secondary-selected" data-selected="true"></div>
      <textarea
        data-node-id="secondary-focused"
        data-outline-field="title"
      >text</textarea>
    </section>
  `;
}

describe("app navigation", () => {
  it("captures selection and focus only from the requested split pane", () => {
    document.body.innerHTML = paneFixture();
    const editor = document.querySelector<HTMLTextAreaElement>(
      "[data-node-id='secondary-focused']"
    )!;
    editor.focus();
    editor.setSelectionRange(2, 4);

    expect(capturePane("secondary")).toEqual({
      paneId: "secondary",
      selectedIds: ["secondary-selected"],
      focus: {
        nodeId: "secondary-focused",
        field: "title",
        selectionStart: 2,
        selectionEnd: 4
      }
    });
  });

  // The pane renders only the rows near the viewport, so the mounted rows are a
  // window onto the band and never the band itself.
  it("takes the band from the pane rather than from the mounted rows", () => {
    document.body.innerHTML = paneFixture();
    const scope = document.querySelector<HTMLElement>(
      "[data-outline-pane-id='primary']"
    )!;
    registerOutlinePane(scope, {
      visibleNodes: [],
      reveal: () => false,
      selectedIds: () => ["above-window", "primary-selected", "below-window"],
      replaceSelection: () => undefined
    });

    expect(capturePane("primary").selectedIds).toEqual([
      "above-window",
      "primary-selected",
      "below-window"
    ]);
  });
});

function child(
  id: string,
  parentId: string,
  sortKey: number,
  text: string
): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: "bullet",
    image: null,
    text,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

describe("the caret on the way into a zoomed row", () => {
  const root = child("root-row", "page", 1_024, "Groceries");

  it("ends the row's own title when nothing is under it", () => {
    expect(zoomEntryFocus("root-row", [root], {})).toEqual({
      nodeId: "root-row",
      field: "title",
      selectionStart: 9,
      selectionEnd: 9
    });
  });

  it("ends the one child a row has", () => {
    const nodes = [root, child("only", "root-row", 2_048, "Milk")];

    expect(zoomEntryFocus("root-row", nodes, {})).toEqual({
      nodeId: "only",
      field: "title",
      selectionStart: 4,
      selectionEnd: 4
    });
  });

  it("measures the end against the draft the field is showing", () => {
    const nodes = [root, child("only", "root-row", 2_048, "Milk")];

    expect(zoomEntryFocus("root-row", nodes, { only: "Milk and eggs" }))
      .toEqual({
        nodeId: "only",
        field: "title",
        selectionStart: 13,
        selectionEnd: 13
      });
  });

  it("leads the first child when a row has several", () => {
    // Out of sort order on purpose: the first child is the one the reader sees
    // first, not the one the array happens to hold first.
    const nodes = [
      root,
      child("second", "root-row", 4_096, "Eggs"),
      child("first", "root-row", 2_048, "Milk")
    ];

    expect(zoomEntryFocus("root-row", nodes, {})).toEqual({
      nodeId: "first",
      field: "title",
      selectionStart: 0,
      selectionEnd: 0
    });
  });

  it("stays on the row when the pane has not loaded it yet", () => {
    expect(zoomEntryFocus("root-row", [], {})).toEqual({
      nodeId: "root-row",
      field: "title",
      selectionStart: 0,
      selectionEnd: 0
    });
  });
});
