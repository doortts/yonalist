import { describe, expect, it } from "vitest";
import {
  guideBandAt, guideOwnerId, guideTargets, planGuideToggle,
  type GuideNode, type GuidePending
} from "./outlineGuideToggle";

interface FakeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly collapsed: boolean;
}

/** A tree the guide helpers can read without the store's `NoteView` payload. */
function fakeIndex(nodes: readonly FakeNode[]) {
  return {
    node: (id: string) => nodes.find((node) => node.id === id),
    childrenOf: (parentId: string): readonly GuideNode[] =>
      nodes.filter((node) => node.parentId === parentId)
  };
}

const tree = fakeIndex([
  { id: "a", parentId: null, collapsed: false },
  { id: "b", parentId: "a", collapsed: false },
  { id: "c", parentId: "b", collapsed: false },
  { id: "d", parentId: "b", collapsed: false },
  { id: "e", parentId: "d", collapsed: false },
  { id: "leaf", parentId: "a", collapsed: false }
]);

describe("guideBandAt", () => {
  it("names the stripe the pointer sits on", () => {
    expect(guideBandAt(61, 61, 36)).toBe(0);
    expect(guideBandAt(97, 61, 36)).toBe(1);
    expect(guideBandAt(133, 61, 36)).toBe(2);
  });

  it("misses between the stripes and left of the first one", () => {
    expect(guideBandAt(79, 61, 36)).toBeNull();
    expect(guideBandAt(40, 61, 36)).toBeNull();
  });

  it("reads the narrow-width geometry off the same arguments", () => {
    expect(guideBandAt(98, 70, 28)).toBe(1);
  });
});

describe("guideOwnerId", () => {
  it("walks up to the ancestor that owns the stripe", () => {
    expect(guideOwnerId(tree, "e", 3, 0)).toBe("a");
    expect(guideOwnerId(tree, "e", 3, 1)).toBe("b");
    expect(guideOwnerId(tree, "e", 3, 2)).toBe("d");
  });

  // A row paints no stripe for its own depth, so there is nothing to own there.
  it("refuses a stripe the row never paints", () => {
    expect(guideOwnerId(tree, "e", 3, 3)).toBeNull();
    expect(guideOwnerId(tree, "a", 0, 0)).toBeNull();
  });
});

describe("guideTargets", () => {
  it("collects every descendant that has children of its own", () => {
    expect(guideTargets(tree, "a").map((node) => node.id)).toEqual(["b", "d"]);
  });

  it("returns nothing when the range holds no collapsible row", () => {
    expect(guideTargets(tree, "d")).toEqual([]);
  });
});

describe("planGuideToggle", () => {
  const targets: readonly GuideNode[] = [
    { id: "b", collapsed: false },
    { id: "d", collapsed: true }
  ];

  it("collapses the whole range while any of it is open", () => {
    const plan = planGuideToggle(targets, null);
    expect(plan.changes).toEqual([{ id: "b", collapsed: true }]);
    expect(plan.pending?.applied).toBe(true);
  });

  it("opens the whole range once all of it is closed", () => {
    const plan = planGuideToggle(
      [{ id: "b", collapsed: true }, { id: "d", collapsed: true }],
      null
    );
    expect(plan.changes).toEqual([
      { id: "b", collapsed: false },
      { id: "d", collapsed: false }
    ]);
    expect(plan.pending?.applied).toBe(false);
  });

  // The second click owes the user the shape they were holding, not a blanket.
  it("restores the shape the blanket click replaced", () => {
    const first = planGuideToggle(targets, null);
    const closed = targets.map((node) => ({ id: node.id, collapsed: true }));
    const second = planGuideToggle(closed, first.pending);
    expect(second.changes).toEqual([{ id: "b", collapsed: false }]);
    expect(second.pending).toBeNull();
  });

  // Once the user reopens a row inside the range by hand, the saved shape is
  // no longer the one they were holding, so the next click starts over.
  it("drops a snapshot the range no longer matches", () => {
    const first = planGuideToggle(targets, null);
    const touched = [
      { id: "b", collapsed: false },
      { id: "d", collapsed: true }
    ];
    const second = planGuideToggle(touched, first.pending);
    expect(second.changes).toEqual([{ id: "b", collapsed: true }]);
    expect(second.pending?.applied).toBe(true);
  });

  it("keeps the current state for a row the snapshot never saw", () => {
    const pending: GuidePending = {
      applied: true,
      snapshot: new Map([["b", false]])
    };
    const plan = planGuideToggle(
      [{ id: "b", collapsed: true }, { id: "new", collapsed: true }],
      pending
    );
    expect(plan.changes).toEqual([{ id: "b", collapsed: false }]);
  });

  it("plans nothing for an empty range", () => {
    expect(planGuideToggle([], null)).toEqual({ changes: [], pending: null });
  });
});
