import { describe, expect, it } from "vitest";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { buildOutlineClipboardFormats } from "./outlineClipboard";
import {
  extractOutlinePayload,
  flattenPastedOutline,
  parsePastedOutline,
  pastedOutlineFromPayload
} from "./outlinePaste";

describe("parsePastedOutline", () => {
  it("parses deterministic Markdown clipboard text with hierarchy and empty rows", () => {
    expect(parsePastedOutline([
      "- Parent",
      "  - Child",
      "    -",
      "- Sibling"
    ].join("\n"))).toEqual([
      {
        title: "Parent",
        children: [{
          title: "Child",
          children: [{ title: "", children: [] }]
        }]
      },
      { title: "Sibling", children: [] }
    ]);
  });

  it("parses indented multiline plain text and clamps indentation jumps", () => {
    expect(parsePastedOutline("Parent\n        Child\nSibling")).toEqual([
      {
        title: "Parent",
        children: [{ title: "Child", children: [] }]
      },
      { title: "Sibling", children: [] }
    ]);
  });

  it("leaves single-line and mixed malformed Markdown to ordinary text paste", () => {
    expect(parsePastedOutline("ordinary text")).toBeNull();
    expect(parsePastedOutline("- Parent\n child")).toBeNull();
  });
});

describe("the Markdown task list a paste reads back", () => {
  it("reads every box shape, ticked and open, as a to-do row", () => {
    expect(parsePastedOutline([
      "- [ ] Open",
      "- [x] Done",
      "- [X] Shouted",
      "- [ ]",
      "- Plain"
    ].join("\n"))).toEqual([
      { title: "Open", marker: "todo", completed: false, children: [] },
      { title: "Done", marker: "todo", completed: true, children: [] },
      { title: "Shouted", marker: "todo", completed: true, children: [] },
      { title: "", marker: "todo", completed: false, children: [] },
      { title: "Plain", children: [] }
    ]);
  });

  // The accepted cost of the Markdown convention (design D2): outside text
  // written as a task list imports as one, and a literal `[ ] x` title we wrote
  // ourselves comes back a to-do. The rich payload is what keeps our own
  // round trip exact; only the plain-text path pays this.
  it("cannot tell an outside task list from a literal box title", () => {
    expect(parsePastedOutline("- [ ] x\n- y")).toEqual([
      { title: "x", marker: "todo", completed: false, children: [] },
      { title: "y", children: [] }
    ]);
  });

  it("leaves a box that is not the whole prefix as ordinary title text", () => {
    expect(parsePastedOutline("- [z] Bracketed\n- [ ]extra")).toEqual([
      { title: "[z] Bracketed", children: [] },
      { title: "[ ]extra", children: [] }
    ]);
  });

  // The bare pair is a typing shortcut, not Markdown: GFM wants a character
  // between the brackets, so a paste keeps the characters it was given.
  it("leaves a bare bracket pair in the title it was pasted in", () => {
    expect(parsePastedOutline("- [] means empty\n- next")).toEqual([
      { title: "[] means empty", children: [] },
      { title: "next", children: [] }
    ]);
  });
});

describe("the note lines a paste reads back", () => {
  it("gathers the quoted lines one level in as the row's note", () => {
    expect(parsePastedOutline([
      "- Parent",
      "  > first line",
      "  >",
      "  > third line",
      "  - Child"
    ].join("\n"))).toEqual([{
      title: "Parent",
      note: "first line\n\nthird line",
      children: [{ title: "Child", children: [] }]
    }]);
  });

  it("keeps a Markdown-looking note line inside the note", () => {
    expect(parsePastedOutline([
      "- Parent",
      "  > - [ ] fake",
      "- Sibling"
    ].join("\n"))).toEqual([
      { title: "Parent", note: "- [ ] fake", children: [] },
      { title: "Sibling", children: [] }
    ]);
  });

  it("keeps a title that opens with a quote mark a title", () => {
    expect(parsePastedOutline("- > quoted title\n- Sibling")).toEqual([
      { title: "> quoted title", children: [] },
      { title: "Sibling", children: [] }
    ]);
  });

  it("gives each row its own note, boxes and all", () => {
    expect(parsePastedOutline([
      "- [x] Parent",
      "  > parent note",
      "  - Child",
      "    > child note"
    ].join("\n"))).toEqual([{
      title: "Parent",
      marker: "todo",
      completed: true,
      note: "parent note",
      children: [{ title: "Child", note: "child note", children: [] }]
    }]);
  });

  it("leaves a quote at the wrong depth to ordinary text paste", () => {
    expect(parsePastedOutline("- Parent\n> quote")).toBeNull();
    expect(parsePastedOutline("- Parent\n    > too deep")).toBeNull();
  });
});

function node(
  id: string,
  parentId: string,
  text: string,
  sortKey: number,
  extra: Partial<NoteView> = {}
): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: "bullet", image: null,
    text,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false,
    ...extra
  };
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

const FIXTURE = [
  node("task", "page", "Ship it", 1_024, {
    marker: "todo",
    note: "first line\n\nthird line",
    collapsed: true,
    starred: true
  }),
  node("done", "task", "Draft", 1_024, { marker: "todo", completed: true }),
  node("photo", "task", "photo.png", 2_048, { kind: "image", image: IMAGE }),
  node("caption", "photo", "Caption", 1_024, { note: "one line" })
];

describe("the copy a paste reads back", () => {
  const built = buildOutlineClipboardFormats(
    { nodes: FIXTURE, drafts: {}, noteDrafts: {} },
    ["task"]
  )!;

  it("recovers the payload from the HTML byte for byte", () => {
    expect(extractOutlinePayload(built.html)).toEqual(built.payload);
  });

  it("recovers title, marker, tick and note from the plain text alone", () => {
    // The image degrades to its file name here: only the payload carries the
    // hash, so a plain-text round trip brings the row back as a bullet.
    expect(parsePastedOutline(built.plain)).toEqual([{
      title: "Ship it",
      marker: "todo",
      completed: false,
      note: "first line\n\nthird line",
      children: [
        { title: "Draft", marker: "todo", completed: true, children: [] },
        {
          title: "photo.png",
          children: [{ title: "Caption", note: "one line", children: [] }]
        }
      ]
    }]);
  });

  it("flattens the payload into import nodes that carry every field", () => {
    let next = 0;
    const { nodes } = flattenPastedOutline(
      pastedOutlineFromPayload(extractOutlinePayload(built.html)!),
      "caret",
      () => `new-${next += 1}`
    );

    expect(nodes).toEqual([
      {
        id: "new-1",
        parentId: "caret",
        text: "Ship it",
        note: "first line\n\nthird line",
        marker: "todo",
        completed: false,
        // A subtree cut while collapsed comes back collapsed, not thrown open.
        collapsed: true,
        starred: true,
        image: undefined
      },
      expect.objectContaining({
        id: "new-2",
        parentId: "new-1",
        text: "Draft",
        collapsed: false,
        starred: false
      }),
      expect.objectContaining({
        id: "new-3",
        parentId: "new-1",
        text: "photo.png",
        image: IMAGE
      }),
      expect.objectContaining({ id: "new-4", parentId: "new-3", text: "Caption" })
    ]);
  });
});

/** The comment a copy writes, rebuilt around whatever JSON a test wants inside. */
function carrier(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return `<!--yonalist-outline-clipboard:${btoa(binary)}--><ul><li>x</li></ul>`;
}

const PAYLOAD = {
  kind: "yonalist-outline-clipboard",
  version: 1,
  nodes: [{
    text: "Row",
    note: "",
    marker: "bullet",
    completed: false,
    collapsed: false,
    starred: false,
    image: null,
    children: []
  }]
};

describe("extractOutlinePayload", () => {
  it("refuses markup that carries no payload of ours", () => {
    expect(extractOutlinePayload("")).toBeNull();
    expect(extractOutlinePayload("<ul><li>Somewhere else</li></ul>")).toBeNull();
  });

  it("refuses a payload from a version this build cannot read", () => {
    expect(extractOutlinePayload(carrier({ ...PAYLOAD, version: 2 }))).toBeNull();
    expect(extractOutlinePayload(carrier({ ...PAYLOAD, kind: "other" })))
      .toBeNull();
  });

  it("refuses corrupt base64 and truncated JSON without throwing", () => {
    expect(extractOutlinePayload("<!--yonalist-outline-clipboard:!!!-->"))
      .toBeNull();
    expect(extractOutlinePayload("<!--yonalist-outline-clipboard:eyJraW-->"))
      .toBeNull();
    expect(extractOutlinePayload(
      `<!--yonalist-outline-clipboard:${btoa('{"kind":"yonalist-outl')}-->`
    )).toBeNull();
  });

  it("refuses a node missing a field or carrying the wrong type", () => {
    const [row] = PAYLOAD.nodes;
    for (const broken of [
      { ...row, text: 7 },
      { ...row, note: null },
      { ...row, marker: "star" },
      { ...row, completed: "yes" },
      { ...row, children: null },
      { ...row, image: { contentHash: "a".repeat(64) } },
      { ...row, text: "x".repeat(100_001) }
    ]) {
      expect(extractOutlinePayload(carrier({ ...PAYLOAD, nodes: [broken] })))
        .toBeNull();
    }
  });

  // The other side reads these as u32/u64, so a number that is not a whole
  // count is refused here rather than by serde after the row has already been
  // through the preview's own bounds.
  it("refuses an image measurement that is not a whole count", () => {
    const [row] = PAYLOAD.nodes;
    for (const image of [
      { ...IMAGE, byteLength: -5 },
      { ...IMAGE, byteLength: 0 },
      { ...IMAGE, byteLength: 1.5 },
      { ...IMAGE, pixelWidth: -5 },
      { ...IMAGE, pixelWidth: 0 },
      { ...IMAGE, pixelHeight: 1.5 },
      { ...IMAGE, pixelHeight: Number.NaN },
      { ...IMAGE, displayWidth: -1 },
      { ...IMAGE, displayWidth: Number.NaN },
      { ...IMAGE, displayWidth: 320.5 }
    ]) {
      expect(extractOutlinePayload(carrier({
        ...PAYLOAD,
        nodes: [{ ...row, image }]
      }))).toBeNull();
    }
    expect(extractOutlinePayload(carrier({
      ...PAYLOAD,
      nodes: [{ ...row, image: IMAGE }]
    }))).not.toBeNull();
  });

  // A copy can never write one, and accepting it would preventDefault a paste
  // that then imports nothing instead of falling through to the text.
  it("refuses a payload carrying no rows at all", () => {
    expect(extractOutlinePayload(carrier({ ...PAYLOAD, nodes: [] }))).toBeNull();
  });

  it("refuses a payload past the bounds an import accepts", () => {
    const [row] = PAYLOAD.nodes;
    const nest = (depth: number): unknown => depth === 0
      ? row
      : { ...row, children: [nest(depth - 1)] };

    expect(extractOutlinePayload(carrier({
      ...PAYLOAD,
      nodes: Array.from({ length: 2_001 }, () => row)
    }))).toBeNull();
    expect(extractOutlinePayload(carrier({ ...PAYLOAD, nodes: [nest(64)] })))
      .toBeNull();
    expect(extractOutlinePayload(carrier({ ...PAYLOAD, nodes: [nest(63)] })))
      .not.toBeNull();
  });

  // Whatever the clipboard hands over is someone else's JSON: the fields are
  // copied out by name, so a smuggled key reaches neither the tree nor
  // `Object.prototype`.
  it("leaves a smuggled prototype key on the floor", () => {
    // A computed key is the one that survives as an own property, which is
    // what a hostile clipboard would put in the JSON.
    expect(extractOutlinePayload(carrier({
      ["__proto__"]: { polluted: true },
      nodes: []
    }))).toBeNull();
    const extracted = extractOutlinePayload(carrier({
      ...PAYLOAD,
      nodes: [{ ...PAYLOAD.nodes[0], ["__proto__"]: { polluted: true } }]
    }));

    expect(extracted).toEqual(PAYLOAD);
    expect(Object.getPrototypeOf(extracted!.nodes[0])).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
