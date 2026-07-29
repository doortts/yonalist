import { describe, expect, it } from "vitest";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  planSelectionDuplicate,
  planSelectionIndent,
  planSelectionOutdent,
  planSelectionReorder
} from "./selectionMoves";

function node(
  id: string,
  parentId: string,
  sortKey: number
): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: "bullet", image: null,
    text: id,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

describe("selection move plans", () => {
  const siblings = [
    node("a", "page", 1),
    node("b", "page", 2),
    node("c", "page", 3),
    node("d", "page", 4)
  ];

  it("indents every selected root below the preceding outside sibling", () => {
    expect(planSelectionIndent(
      siblings,
      siblings.map(({ id }) => id),
      ["b", "c"]
    )).toEqual({
      available: true,
      moves: [
        { id: "b", parentId: "a", beforeId: null },
        { id: "c", parentId: "a", beforeId: null }
      ]
    });
    expect(planSelectionIndent(siblings, ["a", "b"], ["a", "b"]).available)
      .toBe(false);
  });

  it("outdents selected roots after their parent without reversing order", () => {
    const nested = [
      node("parent", "page", 1),
      node("x", "parent", 1),
      node("y", "parent", 2),
      node("after", "page", 2)
    ];
    expect(planSelectionOutdent(nested, ["x", "y"], "page")).toEqual({
      available: true,
      moves: [
        { id: "x", parentId: "page", beforeId: "after" },
        { id: "y", parentId: "page", beforeId: "after" }
      ]
    });
  });

  it("reorders a contiguous selected sibling block by one outside sibling", () => {
    expect(planSelectionReorder(siblings, ["b", "c"], "up")).toEqual({
      available: true,
      moves: [
        { id: "b", parentId: "page", beforeId: "a" },
        { id: "c", parentId: "page", beforeId: "a" }
      ]
    });
    expect(planSelectionReorder(siblings, ["b", "c"], "down")).toEqual({
      available: true,
      moves: [
        { id: "b", parentId: "page", beforeId: null },
        { id: "c", parentId: "page", beforeId: null }
      ]
    });
  });

  it("duplicates same-parent roots immediately after the final original root", () => {
    expect(planSelectionDuplicate(siblings, ["b", "c"])).toEqual({
      available: true,
      parentId: "page",
      beforeId: "d"
    });
    expect(planSelectionDuplicate([
      ...siblings,
      node("nested", "a", 1)
    ], ["b", "nested"]).available).toBe(false);
  });
});
