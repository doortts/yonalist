import { afterEach, describe, expect, it } from "vitest";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  buildOutlineClipboardFormats,
  normalizeSelectedRoots,
  outlineCutRefusal,
  writeOutlineClipboard,
  writeOutlineClipboardEvent,
  type OutlineClipboardNode
} from "./outlineClipboard";

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

const nodes = [
  node("parent", "page", "Parent", 1_024),
  node("child", "parent", "Child", 1_024),
  node("grandchild", "child", "Grandchild", 1_024),
  node("sibling", "page", "Sibling", 2_048),
  node("sibling-child", "sibling", "Nested", 1_024)
];

const IMAGE = {
  contentHash: "a".repeat(64),
  originalName: "photo.png",
  mimeType: "image/png",
  byteLength: 3,
  pixelWidth: 1,
  pixelHeight: 1,
  displayWidth: 320
};

function formats(
  source: readonly NoteView[],
  selectedIds: readonly string[],
  drafts: Readonly<Record<string, string>> = {},
  noteDrafts: Readonly<Record<string, string>> = {}
) {
  return buildOutlineClipboardFormats(
    source,
    drafts,
    noteDrafts,
    selectedIds,
    "session-1"
  );
}

function plain(
  source: readonly NoteView[],
  selectedIds: readonly string[],
  drafts: Readonly<Record<string, string>> = {},
  noteDrafts: Readonly<Record<string, string>> = {}
): string | undefined {
  return formats(source, selectedIds, drafts, noteDrafts)?.plain;
}

/** Every payload field spelled out, so a test overrides only what it means to. */
function payloadNode(
  text: string,
  extra: Partial<OutlineClipboardNode> = {}
): OutlineClipboardNode {
  return {
    text,
    note: "",
    marker: "bullet",
    completed: false,
    collapsed: false,
    starred: false,
    image: null,
    children: [],
    ...extra
  };
}

describe("outline clipboard", () => {
  it("short-circuits empty selections without traversing the outline", () => {
    const unreadableNodes = new Proxy([] as NoteView[], {
      get: () => {
        throw new Error("outline traversal is not allowed");
      }
    });

    expect(normalizeSelectedRoots(unreadableNodes, [])).toEqual([]);
    expect(formats(unreadableNodes, [])).toBeNull();
    expect(outlineCutRefusal(unreadableNodes, {}, {}, [])).toBeTruthy();
  });

  it("normalizes selected rows to forest roots in outline order", () => {
    expect(normalizeSelectedRoots(nodes, [
      "child",
      "sibling",
      "parent",
      "grandchild"
    ])).toEqual(["parent", "sibling"]);
  });

  it("serializes complete selected subtrees with draft titles and no internal fields", () => {
    const serialized = plain(
      nodes,
      ["parent", "child", "sibling"],
      { parent: "Draft parent", child: "line one\nline two" }
    );

    expect(serialized).toBe([
      "- Draft parent",
      "  - line one line two",
      "    - Grandchild",
      "- Sibling",
      "  - Nested"
    ].join("\n"));
    expect(serialized).not.toContain("page");
  });

  it("represents an empty title as one Markdown list marker", () => {
    expect(plain([node("empty", "page", "", 1_024)], ["empty"])).toBe("-");
  });

  it("blocks lossy Cut when a selected subtree has a note or embedded title newline", () => {
    expect(outlineCutRefusal(
      nodes.map((candidate) => candidate.id === "grandchild"
        ? { ...candidate, note: "Keep this context" }
        : candidate),
      {},
      {},
      ["parent"]
    )).toContain("supporting notes");
    expect(outlineCutRefusal(
      nodes,
      { child: "line one\nline two" },
      {},
      ["parent"]
    )).toContain("supporting notes");
    expect(outlineCutRefusal(
      nodes.map((candidate) => candidate.id === "child"
        ? { ...candidate, note: "   " }
        : candidate),
      {},
      {},
      ["parent"]
    )).toContain("supporting notes");
    expect(outlineCutRefusal(nodes, {}, {}, ["parent"])).toBeNull();
  });

  // An image node's title is its filename and its bytes live outside the text,
  // so serializing one yields `- photo.png` and the cut's delete would discard
  // the image with nothing on the clipboard to paste it back from.
  it("blocks Cut when an image node sits anywhere in a selected subtree", () => {
    const withDeepImage = nodes.map((candidate) => candidate.id === "grandchild"
      ? { ...candidate, kind: "image" as const, text: "photo.png" }
      : candidate);

    expect(outlineCutRefusal(withDeepImage, {}, {}, ["parent"]))
      .toContain("an image");
    expect(outlineCutRefusal(withDeepImage, {}, {}, ["child"]))
      .toContain("an image");
    // A sibling subtree that holds no image is still cuttable.
    expect(outlineCutRefusal(withDeepImage, {}, {}, ["sibling"])).toBeNull();
  });

  // The one image the clipboard can carry whole: its bytes go on the clipboard
  // instead of its filename, so the cut's delete loses nothing.
  it("allows Cut for a lone childless image", () => {
    const withDeepImage = nodes.map((candidate) => candidate.id === "grandchild"
      ? { ...candidate, kind: "image" as const, text: "photo.png" }
      : candidate);

    expect(outlineCutRefusal(withDeepImage, {}, {}, ["grandchild"])).toBeNull();
    // A note on it is still lost, and so is anything under or beside it.
    expect(outlineCutRefusal(
      withDeepImage.map((candidate) => candidate.id === "grandchild"
        ? { ...candidate, note: "Keep this context" }
        : candidate),
      {},
      {},
      ["grandchild"]
    )).toContain("supporting notes");
    expect(outlineCutRefusal(
      [...withDeepImage, node("caption", "grandchild", "Caption", 1_024)],
      {},
      {},
      ["grandchild"]
    )).toContain("an image");
    expect(outlineCutRefusal(withDeepImage, {}, {}, ["grandchild", "sibling"]))
      .toContain("an image");
  });

  it("names Move To as the lossless alternative in every Cut refusal", () => {
    const refusals = [
      outlineCutRefusal(
        nodes.map((candidate) => candidate.id === "grandchild"
          ? { ...candidate, kind: "image" as const }
          : candidate),
        {},
        {},
        ["parent"]
      ),
      outlineCutRefusal(
        nodes.map((candidate) => candidate.id === "grandchild"
          ? { ...candidate, note: "Keep this context" }
          : candidate),
        {},
        {},
        ["parent"]
      )
    ];

    for (const refusal of refusals) expect(refusal).toContain("Move To");
  });

  it("writes plain text, Markdown and the rich HTML from one copy", () => {
    const setData = vi.fn();
    const written = formats(nodes, ["sibling"])!;

    expect(writeOutlineClipboardEvent({ setData }, written)).toBe(true);
    expect(setData).toHaveBeenNthCalledWith(1, "text/plain", written.plain);
    expect(setData).toHaveBeenNthCalledWith(2, "text/markdown", written.plain);
    expect(setData).toHaveBeenNthCalledWith(3, "text/html", written.html);
  });

  it("reports a refused clipboard write rather than throwing", () => {
    expect(writeOutlineClipboardEvent({
      setData: () => {
        throw new Error("denied");
      }
    }, formats(nodes, ["sibling"])!)).toBe(false);
  });
});

describe("outline clipboard plain text", () => {
  // Only a to-do row gets a box, the rule the PDF export prints by: a completed
  // plain bullet is still a bullet.
  it("boxes to-do rows by their tick and leaves plain bullets alone", () => {
    const rows = [
      node("open", "page", "Open", 1_024, { marker: "todo" }),
      node("done", "page", "Done", 2_048, {
        marker: "todo",
        completed: true
      }),
      node("bullet", "page", "Bullet", 3_072, { completed: true }),
      node("blank", "page", "", 4_096, { marker: "todo" })
    ];

    expect(plain(rows, rows.map((row) => row.id))).toBe([
      "- [ ] Open",
      "- [x] Done",
      "- Bullet",
      "- [ ]"
    ].join("\n"));
  });

  it("writes a note one level in, before the row's children", () => {
    const rows = [
      node("parent", "page", "Parent", 1_024, {
        note: "first line\n\nthird line"
      }),
      node("child", "parent", "Child", 1_024)
    ];

    expect(plain(rows, ["parent"])).toBe([
      "- Parent",
      "  > first line",
      "  >",
      "  > third line",
      "  - Child"
    ].join("\n"));
  });

  it("keeps an image row as its file name for an outside app", () => {
    expect(plain(
      [node("image", "page", "photo.png", 1_024, {
        kind: "image",
        image: IMAGE
      })],
      ["image"]
    )).toBe("- photo.png");
  });

  it("serializes every feature at once across depths", () => {
    const rows = [
      node("task", "page", "Ship it", 1_024, {
        marker: "todo",
        note: "with a caveat",
        starred: true
      }),
      node("done", "task", "Draft", 1_024, {
        marker: "todo",
        completed: true
      }),
      node("image", "task", "photo.png", 2_048, {
        kind: "image",
        image: IMAGE
      }),
      node("caption", "image", "Caption", 1_024, { note: "line\nline" })
    ];

    expect(plain(rows, ["task"])).toBe([
      "- [ ] Ship it",
      "  > with a caveat",
      "  - [x] Draft",
      "  - photo.png",
      "    - Caption",
      "      > line",
      "      > line"
    ].join("\n"));
  });
});

describe("the rich outline clipboard payload", () => {
  it("carries every field of the selected tree without any node id", () => {
    const rows = [
      node("task", "page", "Ship it", 1_024, {
        marker: "todo",
        note: "with a caveat",
        starred: true,
        collapsed: true
      }),
      node("image", "task", "photo.png", 1_024, {
        kind: "image",
        image: IMAGE
      })
    ];

    const built = formats(rows, ["task"])!;

    expect(built.payload).toEqual({
      kind: "yonalist-outline-clipboard",
      version: 1,
      sessionId: "session-1",
      nodes: [payloadNode("Ship it", {
        note: "with a caveat",
        marker: "todo",
        starred: true,
        collapsed: true,
        children: [payloadNode("photo.png", { image: IMAGE })]
      })]
    });
    expect(JSON.stringify(built.payload)).not.toContain("task");
  });

  it("takes both draft overlays over the committed row", () => {
    const built = formats(
      nodes,
      ["parent"],
      { parent: "Draft title" },
      { parent: "Draft note" }
    )!;

    expect(built.payload.nodes[0]).toEqual(expect.objectContaining({
      text: "Draft title",
      note: "Draft note"
    }));
    expect(built.plain).toContain("- Draft title\n  > Draft note");
  });

  it("refuses a selection outside the bounds a paste accepts", () => {
    const chain = Array.from({ length: 65 }, (_, depth) =>
      node(`row-${depth}`, depth === 0 ? "page" : `row-${depth - 1}`,
        `Row ${depth}`, 1_024));
    const wide = [
      node("wide", "page", "Wide", 1_024),
      ...Array.from({ length: 2_000 }, (_, index) =>
        node(`flat-${index}`, "wide", `Flat ${index}`, index))
    ];

    expect(formats(chain, ["row-0"])).toBeNull();
    expect(formats(chain.slice(0, 64), ["row-0"])).not.toBeNull();
    expect(formats(wide, ["wide"])).toBeNull();
    expect(formats(wide.slice(0, 2_000), ["wide"])).not.toBeNull();
    expect(formats(
      [node("long", "page", "x".repeat(100_001), 1_024)],
      ["long"]
    )).toBeNull();
    expect(formats(
      [node("noted", "page", "Noted", 1_024, { note: "x".repeat(100_001) })],
      ["noted"]
    )).toBeNull();
  });
});

describe("the outline clipboard HTML carrier", () => {
  const MARKER = "<!--yonalist-outline-clipboard:";

  it("leads with the payload comment and round-trips it byte for byte", () => {
    const built = formats(nodes, ["parent", "sibling"])!;

    expect(built.html.startsWith(MARKER)).toBe(true);
    const encoded = built.html.slice(MARKER.length, built.html.indexOf("-->"));
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
    );
    expect(JSON.parse(decoded)).toEqual(built.payload);
  });

  it("renders a readable list with escaped titles beside the payload", () => {
    const rows = [
      node("markup", "page", "<b>&</b> 표", 1_024, { marker: "todo" }),
      node("child", "markup", "Child", 1_024)
    ];

    const built = formats(rows, ["markup"])!;

    expect(built.html.slice(built.html.indexOf("-->") + 3)).toBe(
      "<ul><li>[ ] &lt;b&gt;&amp;&lt;/b&gt; 표<ul><li>Child</li></ul></li></ul>"
    );
    // The comment carries the title unescaped, so a paste reads it back exact.
    expect(built.payload.nodes[0].text).toBe("<b>&</b> 표");
  });

  // A rich-text target reads the markup and nothing else, so a note missing
  // from it is a note that target loses.
  it("renders a note after its title, before the children", () => {
    const rows = [
      node("parent", "page", "Parent", 1_024, { note: "first <b>\nsecond" }),
      node("child", "parent", "Child", 1_024)
    ];

    const built = formats(rows, ["parent"])!;

    expect(built.html.slice(built.html.indexOf("-->") + 3)).toBe(
      "<ul><li>Parent<blockquote>first &lt;b&gt;<br>second</blockquote>" +
      "<ul><li>Child</li></ul></li></ul>"
    );
  });
});

/** jsdom has no ClipboardItem, so the async write contract is read off this one. */
class FakeClipboardItem {
  constructor(readonly data: Record<string, Blob>) {}
}

describe("the asynchronous outline clipboard write", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("puts all three formats in one clipboard item", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    Object.defineProperty(navigator, "clipboard", {
      value: { write, writeText: vi.fn() },
      configurable: true
    });
    const built = formats(nodes, ["parent"])!;

    await writeOutlineClipboard(built);

    const item = write.mock.calls[0]![0]![0] as FakeClipboardItem;
    expect(Object.keys(item.data))
      .toEqual(["text/plain", "text/markdown", "text/html"]);
    expect(await item.data["text/html"]!.text()).toBe(built.html);
  });

  it("falls back to plain text when the item write is refused", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    Object.defineProperty(navigator, "clipboard", {
      value: {
        write: vi.fn().mockRejectedValue(new Error("denied")),
        writeText
      },
      configurable: true
    });
    const built = formats(nodes, ["parent"])!;

    await writeOutlineClipboard(built);

    expect(writeText).toHaveBeenCalledWith(built.plain);
  });
});
