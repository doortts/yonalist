import { describe, expect, it } from "vitest";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { widenOutlineSelection } from "./outlineWidenSelection";

function bullet(id: string, parentId: string): NoteView {
  return {
    id,
    parentId,
    sortKey: 1_024,
    kind: "bullet",
    image: null,
    text: id,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

/**
 *  A
 *    A1
 *      A1a
 *      A1b
 *    A2
 *  B
 *  C
 */
const visible = [
  bullet("A", "page"),
  bullet("A1", "A"),
  bullet("A1a", "A1"),
  bullet("A1b", "A1"),
  bullet("A2", "A"),
  bullet("B", "page"),
  bullet("C", "page")
];

const widen = (roots: readonly string[], from = "A1a") =>
  widenOutlineSelection(visible, roots, from, "page");

describe("widening a band one rung at a time", () => {
  it("takes the row itself, children and all, before its siblings", () => {
    expect(widen([])).toEqual(["A1a"]);
    expect(widen(["A1a"])).toEqual(["A1a", "A1b"]);
  });

  it("takes the parent once the band holds every one of its children", () => {
    expect(widen(["A1a", "A1b"])).toEqual(["A1"]);
  });

  it("takes the parent's siblings from the parent", () => {
    expect(widen(["A1"])).toEqual(["A1", "A2"]);
  });

  it("climbs to the top and then has nowhere left to go", () => {
    expect(widen(["A1", "A2"])).toEqual(["A"]);
    expect(widen(["A"])).toEqual(["A", "B", "C"]);
    expect(widen(["A", "B", "C"])).toBeNull();
  });

  // An only child is already every child its parent has, so the rung above it is
  // the parent's -- no press is spent on siblings it does not have.
  it("goes straight to the parent from an only child", () => {
    const line = [bullet("A", "page"), bullet("A1", "A"), bullet("B", "page")];
    expect(widenOutlineSelection(line, [], "A1", "page")).toEqual(["A1"]);
    expect(widenOutlineSelection(line, ["A1"], "A1", "page")).toEqual(["A"]);
  });

  // A band drawn by the mouse can hold roots at different depths. The shallowest
  // one names the rung: widening from the deepest would give rows back.
  it("widens from the shallowest root a mixed band holds", () => {
    expect(widen(["A1a", "A1b", "A2"])).toEqual(["A1", "A2"]);
  });

  // The rows a collapsed parent hides are not on screen, so they are not the
  // siblings this rung is counting.
  it("counts only the rows the outline is showing", () => {
    const shown = [bullet("A", "page"), bullet("A1", "A"), bullet("B", "page")];
    expect(widenOutlineSelection(shown, ["A"], "A", "page")).toEqual(["A", "B"]);
  });
});
