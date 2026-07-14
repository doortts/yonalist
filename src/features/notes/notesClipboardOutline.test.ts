import { describe, expect, it } from "vitest";
import {
  serializeNotesClipboardOutline,
  type NotesClipboardOutlineNode
} from "./notesClipboardOutline";
import {
  MAX_PASTE_IMPORT_DEPTH,
  MAX_PASTE_IMPORT_FIELD_UTF8_BYTES,
  MAX_PASTE_IMPORT_NODES,
  parsePastedOutline
} from "./notesPasteImport";

function outlineNode(
  title: string,
  children: readonly NotesClipboardOutlineNode[] = []
): NotesClipboardOutlineNode {
  return { title, children };
}

describe("serializeNotesClipboardOutline", () => {
  it("serializes every supplied subtree in deterministic preorder regardless of collapsed state", () => {
    const forest = [
      {
        id: "root-secret-id",
        title: "부모 😀",
        note: "supporting note must not leak",
        isCollapsed: true,
        createdAt: "2026-07-15T00:00:00Z",
        vaultPath: "/private/vault",
        attachmentPath: "attachments/private.png",
        children: [
          {
            id: "child-secret-id",
            title: "First child",
            children: [outlineNode("Grandchild")]
          },
          outlineNode("")
        ]
      },
      outlineNode("Sibling", [outlineNode("마지막")])
    ];

    const serialized = serializeNotesClipboardOutline(forest);

    expect(serialized).toBe(
      [
        "- 부모 😀",
        "  - First child",
        "    - Grandchild",
        "  -",
        "- Sibling",
        "  - 마지막"
      ].join("\n")
    );
    expect(serialized).not.toContain("root-secret-id");
    expect(serialized).not.toContain("supporting note");
    expect(serialized).not.toContain("2026-07-15");
    expect(serialized).not.toContain("/private/vault");
    expect(serialized).not.toContain("attachments/private.png");
  });

  it("flattens each CRLF, CR, and LF in a title to one ASCII space without changing other whitespace", () => {
    expect(
      serializeNotesClipboardOutline([
        outlineNode("first\r\nsecond\rthird\nfour\n\nfifth  \tend")
      ])
    ).toBe("- first second third four  fifth  \tend");
  });

  it("round-trips multiple roots, empty titles, Unicode, and hierarchy through the paste parser", () => {
    const forest = [
      outlineNode("Parent", [
        outlineNode(""),
        outlineNode("자식", [outlineNode("café")])
      ]),
      outlineNode("- literal dash title")
    ];

    const serialized = serializeNotesClipboardOutline(forest);

    expect(serialized).not.toBeNull();
    expect(parsePastedOutline(serialized!)).toEqual(forest);
  });

  it("serializes a flat forest at the node cap and rejects the next node", () => {
    const atCap = Array.from({ length: MAX_PASTE_IMPORT_NODES }, (_, index) =>
      outlineNode(`node-${index}`)
    );

    const serialized = serializeNotesClipboardOutline(atCap);

    expect(serialized).not.toBeNull();
    expect(parsePastedOutline(serialized!)).toHaveLength(
      MAX_PASTE_IMPORT_NODES
    );
    expect(
      serializeNotesClipboardOutline([...atCap, outlineNode("overflow")])
    ).toBeNull();
  });

  it("rejects an over-cap forest before reading or scheduling any node", () => {
    const roots = new Proxy([] as NotesClipboardOutlineNode[], {
      get(_target, property) {
        if (property === "length") {
          return MAX_PASTE_IMPORT_NODES + 1;
        }
        throw new Error(`read over-cap root ${String(property)}`);
      }
    });

    expect(() => serializeNotesClipboardOutline(roots)).not.toThrow();
    expect(serializeNotesClipboardOutline(roots)).toBeNull();
  });

  it("rejects over-cap children before reading or scheduling the wide level", () => {
    const children = new Proxy([] as NotesClipboardOutlineNode[], {
      get(_target, property) {
        if (property === "length") {
          return MAX_PASTE_IMPORT_NODES;
        }
        throw new Error(`read over-cap child ${String(property)}`);
      }
    });

    expect(() =>
      serializeNotesClipboardOutline([outlineNode("root", children)])
    ).not.toThrow();
    expect(
      serializeNotesClipboardOutline([outlineNode("root", children)])
    ).toBeNull();
  });

  it("accepts the maximum depth and rejects a forest one level deeper", () => {
    const buildChain = (levels: number): NotesClipboardOutlineNode => {
      let current = outlineNode(`level-${levels - 1}`);
      for (let depth = levels - 2; depth >= 0; depth -= 1) {
        current = outlineNode(`level-${depth}`, [current]);
      }
      return current;
    };

    const atCap = serializeNotesClipboardOutline([
      buildChain(MAX_PASTE_IMPORT_DEPTH)
    ]);

    expect(atCap).not.toBeNull();
    expect(parsePastedOutline(atCap!)).not.toBeNull();
    expect(
      serializeNotesClipboardOutline([
        buildChain(MAX_PASTE_IMPORT_DEPTH + 1)
      ])
    ).toBeNull();
  });

  it("enforces the paste field byte cap after newline flattening", () => {
    expect(
      serializeNotesClipboardOutline([
        outlineNode("a".repeat(MAX_PASTE_IMPORT_FIELD_UTF8_BYTES))
      ])
    ).not.toBeNull();
    expect(
      serializeNotesClipboardOutline([
        outlineNode("a".repeat(MAX_PASTE_IMPORT_FIELD_UTF8_BYTES + 1))
      ])
    ).toBeNull();
    expect(
      serializeNotesClipboardOutline([
        outlineNode("😀".repeat(MAX_PASTE_IMPORT_FIELD_UTF8_BYTES / 4))
      ])
    ).not.toBeNull();
    expect(
      serializeNotesClipboardOutline([
        outlineNode("😀".repeat(MAX_PASTE_IMPORT_FIELD_UTF8_BYTES / 4 + 1))
      ])
    ).toBeNull();
  });

  it("rejects an empty forest", () => {
    expect(serializeNotesClipboardOutline([])).toBeNull();
  });
});
