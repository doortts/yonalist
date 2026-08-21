import { describe, expect, it } from "vitest";
import type { IpcImportImage } from "../../../../packages/contracts/generated/IpcImportImage";
import type { IpcImportNode } from "../../../../packages/contracts/generated/IpcImportNode";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { validatePreviewBatch } from "./previewValidation";

const page: NoteView = {
  id: "page",
  parentId: null,
  sortKey: 1_024,
  kind: "bullet", image: null,
  text: "Today",
  note: "",
  marker: "bullet",
  collapsed: false,
  completed: false,
  starred: false,
  deleted: false
};
const outside: NoteView = { ...page, id: "outside", parentId: "page" };

const IMAGE: IpcImportImage = {
  contentHash: "a".repeat(64),
  originalName: "photo.png",
  mimeType: "image/png",
  byteLength: 3,
  pixelWidth: 40,
  pixelHeight: 30,
  displayWidth: 320
};

/** The store holds exactly the fixture image, as it would after a copy. */
const holdsImage = (contentHash: string, byteLength: number) =>
  contentHash === IMAGE.contentHash && byteLength === IMAGE.byteLength;

function importing(nodes: readonly IpcImportNode[]) {
  return () => validatePreviewBatch([page, outside], {
    kind: "importNodes",
    parent_id: "page",
    before_id: null,
    nodes: [...nodes]
  }, holdsImage);
}

function importingImage(image: Partial<IpcImportImage>) {
  // An image row's text is its file name, so the two move together here.
  const merged = { ...IMAGE, ...image };
  return importing([{
    id: "pasted",
    parentId: "page",
    text: merged.originalName,
    image: merged
  }]);
}

describe("preview import validation", () => {
  it("accepts a rich paste the desktop would accept", () => {
    expect(importing([
      { id: "root", parentId: "page", text: "Parent", note: "Context" },
      { id: "child", parentId: "root", text: "photo.png", image: IMAGE }
    ])()).toBeUndefined();
  });

  // notes-core answers DomainError::InvalidImage for each of these, so a paste
  // that reaches the desktop refused must not land in the browser preview.
  it("refuses an image name that is empty, oversized or control-bearing", () => {
    expect(importingImage({ originalName: "" })).toThrow("invalid");
    expect(importingImage({ originalName: "x".repeat(1_025) }))
      .toThrow("invalid");
    expect(importingImage({ originalName: "x".repeat(1_024) })).not.toThrow();
    expect(importingImage({ originalName: "photo\u0000.png" }))
      .toThrow("invalid");
  });

  it("refuses pixel dimensions outside the decodable range", () => {
    expect(importingImage({ pixelWidth: 0 })).toThrow("invalid");
    expect(importingImage({ pixelHeight: 0 })).toThrow("invalid");
    expect(importingImage({ pixelWidth: 8_000, pixelHeight: 5_001 }))
      .toThrow("invalid");
    expect(importingImage({ pixelWidth: 8_000, pixelHeight: 5_000 }))
      .not.toThrow();
  });

  it("refuses a display width below the readable minimum", () => {
    expect(importingImage({ displayWidth: 119 })).toThrow("invalid");
    expect(importingImage({ displayWidth: 120 })).not.toThrow();
  });

  it("refuses a byte length outside the supported range", () => {
    expect(importingImage({ byteLength: 0 })).toThrow("invalid");
    // A length the store does not hold is stale rather than malformed.
    expect(importingImage({ byteLength: 20 * 1_024 * 1_024 + 1 }))
      .toThrow("invalid");
  });

  it("refuses a batch outside the import bounds", () => {
    expect(importing([])).toThrow("1 to 2000 nodes");
    expect(importing(Array.from({ length: 2_001 }, (_, index) => ({
      id: `row-${index}`,
      parentId: "page",
      text: "Row"
    })))).toThrow("1 to 2000 nodes");
    const chain = Array.from({ length: 65 }, (_, depth) => ({
      id: `row-${depth}`,
      parentId: depth === 0 ? "page" : `row-${depth - 1}`,
      text: "Row"
    }));
    expect(importing(chain)).toThrow("too deep");
    expect(importing(chain.slice(0, 64))).not.toThrow();
  });

  // The conversion counts depth from the import's own parent, so a row hung off
  // some other existing node is rejected before the root count can even reach
  // zero -- the `no root` guard behind it mirrors Rust and stays unreachable.
  it("refuses a batch that plants no row under the import parent", () => {
    expect(importing([{ id: "orphan", parentId: "outside", text: "Row" }]))
      .toThrow("must precede");
  });

  // notes-core answers "only bullet titles can be merged", and this backend has
  // to answer the same: it drops the previous row outright rather than soft
  // deleting it, so a picture waved through here loses an attachment the real
  // backend would have kept.
  it("refuses a backward merge onto a picture the way notes-core does", () => {
    const shot: NoteView = {
      ...outside,
      id: "shot",
      kind: "image",
      text: "photo.png",
      sortKey: 1_024,
      image: { ...IMAGE, displayWidth: 320 }
    };
    const below: NoteView = {
      ...outside,
      id: "below",
      text: "beta",
      sortKey: 2_048
    };
    const merging = (previousId: string) => () => validatePreviewBatch(
      [page, shot, below],
      {
        kind: "mergeNodeBackward",
        id: "below",
        previous_id: previousId,
        previous_text: "photo.png",
        current_text: "beta"
      },
      holdsImage
    );
    expect(merging("shot")).toThrow("invalid");
    // A bullet behind the caret is still the merge this backend performs.
    const bullet: NoteView = {
      ...below,
      id: "shot",
      text: "alpha",
      sortKey: 1_024
    };
    expect(() => validatePreviewBatch(
      [page, bullet, below],
      {
        kind: "mergeNodeBackward",
        id: "below",
        previous_id: "shot",
        previous_text: "alpha",
        current_text: "beta"
      },
      holdsImage
    )).not.toThrow();
  });
});
