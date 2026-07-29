import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { OutlineIndex } from "./outlineIndex";

function node(
  id: string,
  parentId: string | null,
  sortKey: number
): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: parentId === null ? "page" : "bullet",
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

describe("OutlineIndex", () => {
  it("indexes lookup, visible position, hierarchy, depth, and siblings in one pass", () => {
    const nodes = [
      node("parent", "page", 1_024),
      node("child", "parent", 1_024),
      node("grandchild", "child", 1_024),
      node("sibling", "page", 2_048)
    ];
    const index = new OutlineIndex(nodes);

    expect(index.node("child")?.id).toBe("child");
    expect(index.positionOf("grandchild")).toBe(2);
    expect(index.depthOf("grandchild", "page")).toBe(2);
    expect(index.isDescendant("grandchild", "parent")).toBe(true);
    expect(index.hasChildren("parent")).toBe(true);
    expect(index.childrenOf("page").map((candidate) => candidate.id))
      .toEqual(["parent", "sibling"]);
    expect(index.firstChildId("parent")).toBe("child");
    expect(index.nextSiblingId("parent")).toBe("sibling");
    expect(index.nextSiblingId("sibling")).toBeNull();
  });

  it("terminates safely when malformed parent links form a cycle", () => {
    const index = new OutlineIndex([
      node("a", "b", 1_024),
      node("b", "a", 1_024)
    ]);

    expect(index.depthOf("a", "page")).toBe(2);
    expect(index.isDescendant("a", "missing")).toBe(false);
  });

  it("handles a deeply nested outline without recursive stack growth", () => {
    const nodes: NoteView[] = [];
    let parentId = "page";
    for (let depth = 0; depth < 10_000; depth += 1) {
      const id = `node-${depth}`;
      nodes.push(node(id, parentId, 1_024));
      parentId = id;
    }
    const index = new OutlineIndex(nodes);

    expect(index.depthOf("node-9999", "page")).toBe(9_999);
    expect(index.depthOf("node-9999", "page")).toBe(9_999);
    expect(index.isDescendant("node-9999", "node-5000")).toBe(true);
  });
});
