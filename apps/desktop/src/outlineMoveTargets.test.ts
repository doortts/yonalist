import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  OUTLINE_MOVE_TOP_LEVEL, outlineMoveInsertion, outlineMoveTargets
} from "./outlineMoveTargets";

const ROOT = "page-1";

function bullet(
  id: string,
  parentId: string | null,
  sortKey: number,
  extra: Partial<NoteView> = {}
): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: "bullet",
    image: null,
    text: id,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false,
    ...extra
  };
}

// page-1 > a, b, c ; a > x, y ; b > z(deleted)
const TREE: readonly NoteView[] = [
  bullet("a", ROOT, 1024),
  bullet("b", ROOT, 2048),
  bullet("c", ROOT, 3072),
  bullet("x", "a", 1024),
  bullet("y", "a", 2048),
  bullet("z", "b", 1024, { deleted: true })
];

function labels(targets: readonly { readonly label: string }[]) {
  return targets.map((target) => target.label);
}

describe("outlineMoveTargets", () => {
  it("leads with the synthetic top-level destination", () => {
    const targets = outlineMoveTargets(TREE, [], ROOT);

    expect(targets[0]).toEqual({
      id: null,
      label: OUTLINE_MOVE_TOP_LEVEL,
      depth: 0
    });
    expect(targets[0].label).toBe("Top level");
  });

  it("lists the rest in outline order with depth reflecting nesting", () => {
    const targets = outlineMoveTargets(TREE, [], ROOT);

    expect(targets.map((target) => [target.id, target.depth])).toEqual([
      [null, 0], ["a", 1], ["x", 2], ["y", 2], ["b", 1], ["c", 1]
    ]);
  });

  it("drops the moving roots and everything beneath them", () => {
    const targets = outlineMoveTargets(TREE, ["a"], ROOT);

    expect(targets.map((target) => target.id)).toEqual([null, "b", "c"]);
  });

  it("drops several moving roots at once", () => {
    const targets = outlineMoveTargets(TREE, ["a", "b"], ROOT);

    expect(targets.map((target) => target.id)).toEqual([null, "c"]);
  });

  it("never offers a deleted node as a destination", () => {
    expect(outlineMoveTargets(TREE, [], ROOT).map((target) => target.id))
      .not.toContain("z");
  });

  it("falls back to the app's untitled label for an empty title", () => {
    const nodes = [bullet("a", ROOT, 1024, { text: "" })];

    expect(labels(outlineMoveTargets(nodes, [], ROOT))).toEqual([
      "Top level", "Untitled"
    ]);
  });

  // An image node takes children in this model — Tab under one and a drop onto
  // one both work in v2 — so refusing it here would make Move To weaker than
  // the gestures it replaces. Its title is the filename.
  it("offers an image node as a destination under its filename", () => {
    const nodes = [bullet("i", ROOT, 1024, { kind: "image", text: "shot.png" })];

    expect(labels(outlineMoveTargets(nodes, [], ROOT))).toEqual([
      "Top level", "shot.png"
    ]);
  });

  it("lists a zoomed outline from the zoom root down", () => {
    const targets = outlineMoveTargets(TREE, [], "a");

    expect(targets.map((target) => [target.id, target.depth])).toEqual([
      [null, 0], ["x", 1], ["y", 1]
    ]);
  });
});

describe("outlineMoveInsertion", () => {
  it("appends every root at the bottom of the destination, order kept", () => {
    expect(outlineMoveInsertion("c", ["a", "b"], ROOT)).toEqual([
      { id: "a", parentId: "c", beforeId: null },
      { id: "b", parentId: "c", beforeId: null }
    ]);
  });

  it("resolves the top-level destination to the outline root", () => {
    expect(outlineMoveInsertion(null, ["x"], ROOT)).toEqual([
      { id: "x", parentId: ROOT, beforeId: null }
    ]);
  });
});
