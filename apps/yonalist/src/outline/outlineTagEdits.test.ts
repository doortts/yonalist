import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import {
  addTag, outlineTagKey, parseSingleTag, planTagEdits, removeTag, tagsIn,
  type OutlineTag
} from "./outlineTagEdits";

function bullet(extra: Partial<NoteView> = {}): NoteView {
  return {
    id: "a",
    parentId: "page-1",
    sortKey: 1024,
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

/** The tokenizer is the only way a tag is ever spelled, tests included. */
function tag(raw: string): OutlineTag {
  const parsed = parseSingleTag(raw);
  if (!parsed) throw new Error(`not one tag: ${raw}`);
  return parsed;
}

describe("parseSingleTag", () => {
  it("accepts one complete # tag", () => {
    expect(parseSingleTag("#shop")).toMatchObject({
      prefix: "#", normalized: "shop", raw: "#shop"
    });
  });

  it("accepts one complete @ tag", () => {
    expect(parseSingleTag("@ada")).toMatchObject({
      prefix: "@", normalized: "ada", raw: "@ada"
    });
  });

  it("rejects two tags", () => {
    expect(parseSingleTag("#shop #home")).toBeNull();
  });

  it("rejects bare text and a lone prefix", () => {
    expect(parseSingleTag("shop")).toBeNull();
    expect(parseSingleTag("#")).toBeNull();
    expect(parseSingleTag("")).toBeNull();
  });

  it("rejects a tag with anything else around it", () => {
    expect(parseSingleTag("buy #shop")).toBeNull();
    expect(parseSingleTag("#shop!")).toBeNull();
  });
});

describe("addTag", () => {
  it("appends after exactly one space", () => {
    expect(addTag("buy milk", tag("#shop"))).toBe("buy milk #shop");
  });

  it("writes the bare token into an empty title", () => {
    expect(addTag("", tag("#shop"))).toBe("#shop");
  });

  it("does not double the space on a title that already ends in one", () => {
    expect(addTag("buy milk ", tag("#shop"))).toBe("buy milk #shop");
  });

  it("leaves a title that already carries the tag alone", () => {
    expect(addTag("buy milk #shop", tag("#shop"))).toBe("buy milk #shop");
  });

  it("treats a case-only variant as the same tag", () => {
    expect(addTag("buy milk #Shop", tag("#shop"))).toBe("buy milk #Shop");
  });

  // The title holds the decomposed spelling, the chooser hands over the
  // composed one. `notes_tags` keys both to one row, so add has to as well.
  it("treats an NFD variant as the same tag as its NFC spelling", () => {
    const decomposed = `morning #cafe${"\u0301"}`;

    expect(addTag(decomposed, tag("#caf\u00e9"))).toBe(decomposed);
  });

  it("keeps # and @ of the same body apart", () => {
    expect(addTag("ping #ada", tag("@ada"))).toBe("ping #ada @ada");
  });
});

describe("removeTag", () => {
  it("takes the tag and one leading space, leaving the rest intact", () => {
    expect(removeTag("buy milk #shop today", tag("#shop")))
      .toBe("buy milk today");
  });

  it("takes the trailing space when the tag opens the text", () => {
    expect(removeTag("#shop buy milk", tag("#shop"))).toBe("buy milk");
  });

  it("empties a text that was only the tag", () => {
    expect(removeTag("#shop", tag("#shop"))).toBe("");
  });

  it("takes exactly one adjacent space and no more", () => {
    expect(removeTag("a  #shop  b", tag("#shop"))).toBe("a   b");
  });

  it("strips every occurrence, case variants included", () => {
    expect(removeTag("#Shop buy milk #shop now", tag("#shop")))
      .toBe("buy milk now");
  });

  it("leaves a text without the tag untouched", () => {
    expect(removeTag("buy milk #home", tag("#shop"))).toBe("buy milk #home");
  });
});

describe("tagsIn", () => {
  it("unions the tags of every title and note, deduped by normal form", () => {
    const found = tagsIn([
      bullet({ id: "a", text: "buy milk #shop", note: "before @ada" }),
      bullet({ id: "b", text: "call #Shop", note: "" })
    ]).map(outlineTagKey);

    expect(found).toEqual(["#shop", "@ada"]);
  });

  // An image node's title is its filename and the write is refused, so a tag
  // only it carries would be offered for a removal that could never run.
  it("ignores image nodes", () => {
    expect(tagsIn([
      bullet({ id: "i", kind: "image", text: "shot.png", note: "at #shop" })
    ])).toEqual([]);
  });
});

describe("planTagEdits", () => {
  const TREE: readonly NoteView[] = [
    bullet({ id: "a", text: "buy milk" }),
    bullet({ id: "b", text: "call mum #shop", note: "ask about #shop hours" }),
    bullet({ id: "i", kind: "image", text: "shot.png", note: "" })
  ];

  it("adds the tag to every row that does not already carry it", () => {
    expect(planTagEdits(TREE, {}, {}, ["a", "b"], tag("#shop"), "add"))
      .toEqual([{ id: "a", text: "buy milk #shop" }]);
  });

  it("counts a tag living only in the note as already carried", () => {
    const nodes = [bullet({ id: "a", text: "buy milk", note: "at #shop" })];

    expect(planTagEdits(nodes, {}, {}, ["a"], tag("#shop"), "add")).toEqual([]);
  });

  it("removes from the title and the note in one edit", () => {
    expect(planTagEdits(TREE, {}, {}, ["b"], tag("#shop"), "remove"))
      .toEqual([{ id: "b", text: "call mum", note: "ask about hours" }]);
  });

  // notes-core rejects `updateText` on an image node with "image filenames
  // cannot be changed as bullet text", which fails the whole batch.
  it("skips image nodes in both directions", () => {
    expect(planTagEdits(TREE, {}, {}, ["i"], tag("#shop"), "add")).toEqual([]);
    expect(planTagEdits(
      [bullet({ id: "i", kind: "image", text: "a.png", note: "at #shop" })],
      {}, {}, ["i"], tag("#shop"), "remove"
    )).toEqual([]);
  });

  it("reads the draft a row is still holding rather than its saved text", () => {
    expect(planTagEdits(TREE, { a: "buy bread" }, {}, ["a"], tag("#shop"), "add"))
      .toEqual([{ id: "a", text: "buy bread #shop" }]);
  });

  it("ignores ids that are not in the outline", () => {
    expect(planTagEdits(TREE, {}, {}, ["gone"], tag("#shop"), "add")).toEqual([]);
  });
});
