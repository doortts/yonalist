import type { IpcMarkerKind } from "../../../../packages/contracts/generated/IpcMarkerKind";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { isOrdered, orderedNumbers, orderedStart } from "./outlineOrdered";

function node(
  id: string,
  parentId: string,
  sortKey: number,
  marker: IpcMarkerKind
): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: "bullet",
    image: null,
    text: id,
    note: "",
    marker,
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

const ordered = (start: number): IpcMarkerKind => ({ ordered: { start } });

describe("ordered markers", () => {
  it("reads the start off the marker only when the row carries one", () => {
    expect(orderedStart(ordered(3))).toBe(3);
    expect(orderedStart("bullet")).toBeNull();
    expect(orderedStart("todo")).toBeNull();
    expect(isOrdered(ordered(1))).toBe(true);
    expect(isOrdered("todo")).toBe(false);
  });

  it("counts a run up from the number its first row was typed with", () => {
    const numbers = orderedNumbers([
      node("a", "page", 1_024, ordered(3)),
      node("b", "page", 2_048, ordered(9)),
      node("c", "page", 3_072, ordered(9))
    ]);

    expect([...numbers]).toEqual([["a", 3], ["b", 4], ["c", 5]]);
  });

  // A row's own descendants stand between it and its next sibling in the list
  // the outline renders, so the run has to be read off the siblings alone.
  it("keeps a run going across a numbered row's own children", () => {
    const numbers = orderedNumbers([
      node("a", "page", 1_024, ordered(1)),
      node("a-kid", "a", 1_024, "bullet"),
      node("b", "page", 2_048, ordered(1))
    ]);

    expect(numbers.get("b")).toBe(2);
    expect(numbers.has("a-kid")).toBe(false);
  });

  it("starts a new run after anything that is not a numbered sibling", () => {
    const numbers = orderedNumbers([
      node("a", "page", 1_024, ordered(1)),
      node("plain", "page", 2_048, "bullet"),
      node("b", "page", 3_072, ordered(5)),
      node("c", "page", 4_096, ordered(1))
    ]);

    expect(numbers.get("a")).toBe(1);
    expect(numbers.get("b")).toBe(5);
    expect(numbers.get("c")).toBe(6);
  });

  it("numbers by sibling order rather than the order it was handed", () => {
    const numbers = orderedNumbers([
      node("second", "page", 2_048, ordered(1)),
      node("first", "page", 1_024, ordered(7))
    ]);

    expect(numbers.get("first")).toBe(7);
    expect(numbers.get("second")).toBe(8);
  });

  it("leaves a deleted row out of the run it used to stand in", () => {
    const gone = node("gone", "page", 2_048, ordered(1));
    const numbers = orderedNumbers([
      node("a", "page", 1_024, ordered(1)),
      { ...gone, deleted: true },
      node("b", "page", 3_072, ordered(1))
    ]);

    expect(numbers.get("b")).toBe(2);
    expect(numbers.has("gone")).toBe(false);
  });
});
