import { describe, expect, it } from "vitest";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "../notesStore";
import { isEmptyBullet, nextSiblingId } from "./outlinePasteGesture";

function node(
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
    text: "",
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false,
    ...extra
  };
}

/** The snapshot is all either helper reads. */
function stub(
  nodes: readonly NoteView[],
  drafts: Record<string, string> = {},
  noteDrafts: Record<string, string> = {}
): NotesStore {
  return {
    getSnapshot: () => ({ nodes, drafts, noteDrafts })
  } as unknown as NotesStore;
}

const IMAGE = {
  contentHash: "a".repeat(64),
  originalName: "photo.png",
  mimeType: "image/png",
  byteLength: 3,
  pixelWidth: 1,
  pixelHeight: 1,
  displayWidth: 320
};

describe("isEmptyBullet", () => {
  const blank = node("blank", "page", 1_024);

  it("reads the blank row Enter just made as empty", () => {
    expect(isEmptyBullet(stub([blank]), blank)).toBe(true);
    // Whitespace is nothing typed: the paste still replaces the row.
    expect(isEmptyBullet(
      stub([{ ...blank, text: "   \t" }]),
      { ...blank, text: "   \t" }
    )).toBe(true);
  });

  // The draft is what the row shows; the committed text can still be behind it
  // either way, so both overlays are read before the committed field.
  it("takes both draft overlays over the committed row", () => {
    expect(isEmptyBullet(stub([blank], { blank: "typed" }), blank)).toBe(false);
    expect(isEmptyBullet(stub([blank], {}, { blank: "a note" }), blank))
      .toBe(false);
    // A draft that empties a row with text in it makes the row empty again.
    const typed = { ...blank, text: "committed" };
    expect(isEmptyBullet(stub([typed], { blank: "" }), typed)).toBe(true);
  });

  it("keeps a row that carries anything at all", () => {
    const box = { ...blank, marker: "todo" as const };
    const picture = { ...blank, kind: "image" as const, image: IMAGE };
    const noted = { ...blank, note: "context" };
    const parent = { ...blank, id: "parent" };

    expect(isEmptyBullet(stub([box]), box)).toBe(false);
    expect(isEmptyBullet(stub([picture]), picture)).toBe(false);
    expect(isEmptyBullet(stub([noted]), noted)).toBe(false);
    expect(isEmptyBullet(
      stub([parent, node("child", "parent", 1_024)]),
      parent
    )).toBe(false);
    // A deleted child is not a child: the row is empty again.
    expect(isEmptyBullet(
      stub([parent, node("child", "parent", 1_024, { deleted: true })]),
      parent
    )).toBe(true);
  });
});

describe("nextSiblingId", () => {
  const first = node("first", "page", 1_024);
  const second = node("second", "page", 2_048);

  it("names the row a paste has to land before", () => {
    const store = stub([second, first]);

    expect(nextSiblingId(store, first)).toBe("second");
  });

  it("answers null at the end of the run", () => {
    expect(nextSiblingId(stub([first, second]), second)).toBeNull();
  });

  it("skips a deleted sibling and rows under another parent", () => {
    const store = stub([
      first,
      node("gone", "page", 1_536, { deleted: true }),
      node("elsewhere", "other", 1_536),
      second
    ]);

    expect(nextSiblingId(store, first)).toBe("second");
  });

  // Two rows can share a sortKey until the next rebalance, so the id breaks the
  // tie and both the bytes and the outline land in the same place.
  it("breaks a sortKey tie by id", () => {
    const tied = node("b", "page", 1_024);
    const store = stub([tied, node("a", "page", 1_024)]);

    expect(nextSiblingId(store, { ...tied, id: "a" })).toBe("b");
    expect(nextSiblingId(store, tied)).toBeNull();
  });
});
