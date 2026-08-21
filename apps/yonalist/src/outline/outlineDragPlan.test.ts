import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { planCrossPaneDrop, planOutlineDrop } from "./outlineDragPlan";

function node(
  id: string,
  parentId = "page",
  sortKey = 1024
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

describe("outline drag projection", () => {
  it("moves upward before the hovered root and downward after it", () => {
    const nodes = [
      node("a", "page", 1024),
      node("b", "page", 2048),
      node("c", "page", 3072)
    ];

    expect(planOutlineDrop({
      nodes,
      visibleNodes: nodes,
      selectedRootIds: ["c"],
      activeId: "c",
      overId: "a",
      horizontalOffset: 0,
      outlineRootId: "page"
    })).toMatchObject({
      parentId: "page",
      beforeId: "a",
      depth: 0,
      moves: [{ id: "c", parentId: "page", beforeId: "a" }]
    });
    expect(planOutlineDrop({
      nodes,
      visibleNodes: nodes,
      selectedRootIds: ["a"],
      activeId: "a",
      overId: "c",
      horizontalOffset: 0,
      outlineRootId: "page"
    })).toMatchObject({
      parentId: "page",
      beforeId: null,
      depth: 0,
      moves: [{ id: "a", parentId: "page", beforeId: null }]
    });
  });

  it("projects horizontal motion into a valid parent depth", () => {
    const nodes = [
      node("active", "page", 1024),
      node("parent", "page", 2048),
      node("child", "parent", 1024)
    ];

    expect(planOutlineDrop({
      nodes,
      visibleNodes: nodes,
      selectedRootIds: ["active"],
      activeId: "active",
      overId: "parent",
      horizontalOffset: 36,
      outlineRootId: "page"
    })).toMatchObject({
      parentId: "parent",
      beforeId: null,
      depth: 1
    });
  });

  it("moves a normalized selected forest in visible order", () => {
    const nodes = [
      node("a", "page", 1024),
      node("a-child", "a"),
      node("b", "page", 2048),
      node("tail", "page", 3072)
    ];

    expect(planOutlineDrop({
      nodes,
      visibleNodes: nodes,
      selectedRootIds: ["a", "b"],
      activeId: "a-child",
      overId: "tail",
      horizontalOffset: 0,
      outlineRootId: "page"
    })?.moves).toEqual([
      { id: "a", parentId: "page", beforeId: null },
      { id: "b", parentId: "page", beforeId: null }
    ]);
  });

  it("rejects a drop into the selected forest and suppresses no-ops", () => {
    const nodes = [
      node("a", "page", 1024),
      node("a-child", "a"),
      node("b", "page", 2048)
    ];

    expect(planOutlineDrop({
      nodes,
      visibleNodes: nodes,
      selectedRootIds: ["a"],
      activeId: "a",
      overId: "a-child",
      horizontalOffset: 0,
      outlineRootId: "page"
    })).toBeNull();
    expect(planOutlineDrop({
      nodes,
      visibleNodes: nodes,
      selectedRootIds: ["a"],
      activeId: "a",
      overId: "a",
      horizontalOffset: 0,
      outlineRootId: "page"
    })).toBeNull();
  });

  it("projects a source outside the destination pane at its zoom boundary", () => {
    const nodes = [
      node("source", "page", 1024),
      node("destination", "page", 2048),
      node("child", "destination", 1024)
    ];

    expect(planCrossPaneDrop({
      nodes,
      visibleNodes: [nodes[2]],
      selectedRootIds: ["source"],
      overId: "child",
      horizontalOffset: 0,
      outlineRootId: "destination"
    })).toEqual({
      parentId: "destination",
      beforeId: "child",
      previewBeforeId: "child",
      depth: 0,
      moves: [{
        id: "source",
        parentId: "destination",
        beforeId: "child"
      }]
    });
  });

  it("supports an empty destination and rejects a descendant destination", () => {
    const nodes = [
      node("source", "page", 1024),
      node("descendant", "source", 1024),
      node("destination", "page", 2048)
    ];

    expect(planCrossPaneDrop({
      nodes,
      visibleNodes: [],
      selectedRootIds: ["source"],
      overId: null,
      horizontalOffset: 0,
      outlineRootId: "destination"
    })).toMatchObject({
      parentId: "destination",
      beforeId: null,
      previewBeforeId: null
    });
    expect(planCrossPaneDrop({
      nodes,
      visibleNodes: [],
      selectedRootIds: ["source"],
      overId: null,
      horizontalOffset: 0,
      outlineRootId: "descendant"
    })).toBeNull();
  });
});
