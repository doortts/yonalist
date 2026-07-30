import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  allocateSiblingSortKey,
  applyRebalancedSortKeys,
  SORT_KEY_STEP
} from "./outlineSortKeys";

function node(id: string, sortKey: number): NoteView {
  return {
    id,
    parentId: "page",
    sortKey,
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

describe("optimistic outline sort keys", () => {
  it("keeps a held-Enter insertion run sparse without sibling rebalancing", () => {
    let nodes = [
      node("source", SORT_KEY_STEP),
      node("anchor", SORT_KEY_STEP * 2)
    ];

    for (let index = 0; index < 24; index += 1) {
      const allocation = allocateSiblingSortKey(nodes, "page", "anchor");
      expect(allocation.rebalancedSortKeys.size).toBe(0);
      nodes = [
        ...applyRebalancedSortKeys(
          nodes,
          allocation.rebalancedSortKeys
        ),
        node(`inserted-${index}`, allocation.sortKey)
      ];
    }
  });
});
