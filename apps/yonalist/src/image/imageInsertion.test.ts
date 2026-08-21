import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { imageInsertionAnchor } from "./imageInsertion";
import { OutlineIndex } from "../outline/outlineIndex";

function node(
  id: string,
  parentId: string,
  sortKey: number,
  overrides: Partial<NoteView> = {}
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
    ...overrides
  };
}

describe("image insertion anchors", () => {
  const nodes = [
    node("first", "page", 1_024),
    node("child", "first", 1_024),
    node("second", "page", 2_048)
  ];
  const index = new OutlineIndex(nodes);

  it("places a row batch after the target with one stable sibling anchor", () => {
    expect(imageInsertionAnchor("first", "page", index)).toEqual({
      parentId: "page",
      beforeId: "second"
    });
  });

  it("places page and zoomed-image drops at the first child", () => {
    expect(imageInsertionAnchor("page", "page", index)).toEqual({
      parentId: "page",
      beforeId: "first"
    });
    const image = node("image", "page", 3_072, {
      kind: "image",
      image: {
        contentHash: "a".repeat(64),
        originalName: "cat.png",
        mimeType: "image/png",
        byteLength: 1,
        pixelWidth: 1,
        pixelHeight: 1,
        displayWidth: 320
      }
    });
    const zoomed = new OutlineIndex([
      image,
      node("image-child", "image", 1_024)
    ]);

    expect(imageInsertionAnchor("image", "image", zoomed)).toEqual({
      parentId: "image",
      beforeId: "image-child"
    });
  });

  it("rejects stale and deleted row targets", () => {
    expect(imageInsertionAnchor("missing", "page", index)).toBeNull();
    const deleted = new OutlineIndex([
      node("deleted", "page", 1_024, { deleted: true })
    ]);
    expect(imageInsertionAnchor("deleted", "page", deleted)).toBeNull();
  });
});
