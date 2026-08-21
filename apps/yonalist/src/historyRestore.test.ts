import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { PaneFocusSnapshot } from "./appNavigation";
import { liveHistorySelection, resolveHistoryFocus } from "./historyRestore";

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

  // Same rule the live outline follows: a picture row takes focus but holds no
  // caret, so a step that lands one there leaves the typist with nowhere to type.
  it("skips a previous sibling that cannot hold a caret", () => {
    const shot: NoteView = {
      ...bullet("shot", 1_280, "shot.png"),
      kind: "image",
      image: {
        contentHash: "a".repeat(64),
        originalName: "shot.png",
        mimeType: "image/png",
        byteLength: 3,
        pixelWidth: 640,
        pixelHeight: 480,
        displayWidth: 320
      }
    };
    expect(resolveHistoryFocus(
      caretOn("bullet-new", 0), [first, shot, created], [first, shot]
    )).toEqual(caretOn("bullet-1", "First thought".length));
  });

  // Same last resort the emptied-row path takes: the page title always has one.
  it("falls through to the page title when no sibling holds a caret", () => {
    const shot: NoteView = {
      ...bullet("shot", 1_280, "shot.png"),
      kind: "image",
      image: {
        contentHash: "a".repeat(64),
        originalName: "shot.png",
        mimeType: "image/png",
        byteLength: 3,
        pixelWidth: 640,
        pixelHeight: 480,
        displayWidth: 320
      }
    };
    expect(resolveHistoryFocus(
      caretOn("bullet-new", 0), [shot, created], [shot]
    )).toEqual(caretOn("page-1", 0));
  });

  it("gives up when the only parent left holds no caret", () => {
    const shot: NoteView = {
      ...bullet("shot", 1_024, "shot.png"),
      kind: "image",
      image: {
        contentHash: "a".repeat(64),
        originalName: "shot.png",
        mimeType: "image/png",
        byteLength: 3,
        pixelWidth: 640,
        pixelHeight: 480,
        displayWidth: 320
      }
    };
    const inside = bullet("inside", 1_024, "", "shot");
    expect(resolveHistoryFocus(
      caretOn("inside", 0), [shot, inside], [shot]
    )).toBeNull();
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

describe("liveHistorySelection", () => {
  const second = bullet("bullet-2", 2_048, "Second thought");

  it("keeps a band whose rows all came back, in the order it recorded", () => {
    expect(liveHistorySelection(
      ["bullet-1", "bullet-2"], [second, first]
    )).toEqual(["bullet-1", "bullet-2"]);
  });

  // A step can hand back part of what it took, and a band holding the rest
  // would have the selection counting a row the store does not have.
  it("drops the rows the step did not hand back", () => {
    expect(liveHistorySelection(
      ["bullet-1", "bullet-2"], [first]
    )).toEqual(["bullet-1"]);
  });

  it("treats a tombstoned row as one that did not come back", () => {
    expect(liveHistorySelection(
      ["bullet-1", "bullet-2"], [first, { ...second, deleted: true }]
    )).toEqual(["bullet-1"]);
  });

  it("empties a band none of whose rows came back", () => {
    expect(liveHistorySelection(["bullet-1"], [])).toEqual([]);
  });
});
