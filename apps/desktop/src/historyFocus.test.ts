import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { PaneFocusSnapshot } from "./appNavigation";
import { resolveHistoryFocus } from "./historyFocus";

function bullet(
  id: string,
  sortKey: number,
  text: string,
  parentId = "page-1"
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

function caretOn(nodeId: string, offset: number): PaneFocusSnapshot {
  return {
    nodeId,
    field: "title",
    selectionStart: offset,
    selectionEnd: offset
  };
}

const first = bullet("bullet-1", 1_024, "First thought");
const created = bullet("bullet-new", 1_536, "");

describe("resolveHistoryFocus", () => {
  it("leaves a surviving row alone", () => {
    const focus = caretOn("bullet-1", 3);
    expect(resolveHistoryFocus(focus, [first], [first])).toBe(focus);
  });

  it("moves to the end of the previous sibling when the row is gone", () => {
    expect(resolveHistoryFocus(
      caretOn("bullet-new", 0), [first, created], [first]
    )).toEqual(caretOn("bullet-1", "First thought".length));
  });

  it("moves to the parent when the row had no previous sibling", () => {
    const parent = bullet("parent", 1_024, "Parent", "page-1");
    const child = bullet("child", 1_024, "", "parent");
    expect(resolveHistoryFocus(
      caretOn("child", 0), [parent, child], [parent]
    )).toEqual(caretOn("parent", "Parent".length));
  });

  it("skips a previous sibling that history removed as well", () => {
    const second = bullet("bullet-2", 1_280, "Second thought");
    expect(resolveHistoryFocus(
      caretOn("bullet-new", 0), [first, second, created], [first]
    )).toEqual(caretOn("bullet-1", "First thought".length));
  });

  it("treats a tombstoned row as gone", () => {
    expect(resolveHistoryFocus(
      caretOn("bullet-new", 0),
      [first, created],
      [first, { ...created, deleted: true }]
    )).toEqual(caretOn("bullet-1", "First thought".length));
  });

  it("gives up when nothing was focused", () => {
    expect(resolveHistoryFocus(null, [first], [first])).toBeNull();
  });

  it("gives up when the row was never in the outline", () => {
    expect(resolveHistoryFocus(caretOn("stranger", 0), [first], [first]))
      .toBeNull();
  });
});
