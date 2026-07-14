import { describe, expect, it, vi } from "vitest";
import {
  MAX_PASTE_IMPORT_DEPTH,
  MAX_PASTE_IMPORT_NODES,
  parsePastedOutline
} from "./notesPasteImport";

describe("parsePastedOutline", () => {
  it("returns null for a single line with no newline (not an import)", () => {
    expect(parsePastedOutline("Just one line")).toBeNull();
  });

  it("recognizes one Markdown item, including an empty title, as a structural import", () => {
    expect(parsePastedOutline("- One item")).toEqual([
      { title: "One item", children: [] }
    ]);
    expect(parsePastedOutline("-")).toEqual([{ title: "", children: [] }]);
  });

  it("parses a Markdown list with two-space depth, empty items, and Unicode", () => {
    expect(
      parsePastedOutline(
        [
          "- 부모 😀",
          "  - Child",
          "    - café",
          "  -",
          "- Sibling"
        ].join("\n")
      )
    ).toEqual([
      {
        title: "부모 😀",
        children: [
          {
            title: "Child",
            children: [{ title: "café", children: [] }]
          },
          { title: "", children: [] }
        ]
      },
      { title: "Sibling", children: [] }
    ]);
  });

  it.each([
    ["odd spaces", "- Root\n   - Child"],
    ["tab indentation", "- Root\n\t- Child"],
    ["mixed Markdown and legacy lines", "- Root\n  Child"]
  ])("rejects malformed Markdown indentation: %s", (_case, text) => {
    expect(parsePastedOutline(text)).toBeNull();
  });

  it("returns null when only one non-blank line survives blank skipping", () => {
    expect(parsePastedOutline("Just one line\n\n   \n")).toBeNull();
  });

  it("parses a flat multi-line paste into sibling roots", () => {
    expect(parsePastedOutline("First\nSecond\nThird")).toEqual([
      { title: "First", children: [] },
      { title: "Second", children: [] },
      { title: "Third", children: [] }
    ]);
  });

  it("parses tab-indented lines into a nested tree", () => {
    const text = ["Parent", "\tChild A", "\tChild B", "\t\tGrandchild"].join(
      "\n"
    );
    expect(parsePastedOutline(text)).toEqual([
      {
        title: "Parent",
        children: [
          { title: "Child A", children: [] },
          {
            title: "Child B",
            children: [{ title: "Grandchild", children: [] }]
          }
        ]
      }
    ]);
  });

  it("parses 2-space-indented lines into a nested tree", () => {
    const text = ["Parent", "  Child A", "  Child B", "    Grandchild"].join(
      "\n"
    );
    expect(parsePastedOutline(text)).toEqual([
      {
        title: "Parent",
        children: [
          { title: "Child A", children: [] },
          {
            title: "Child B",
            children: [{ title: "Grandchild", children: [] }]
          }
        ]
      }
    ]);
  });

  it("treats the first line's indent as the baseline (depth 0)", () => {
    // The whole paste is indented (e.g. copied from inside another node);
    // the first line still becomes depth 0, and siblings measured relative
    // to it stay flat.
    const text = ["\t\tFirst", "\t\tSecond", "\t\t\tThird"].join("\n");
    expect(parsePastedOutline(text)).toEqual([
      {
        title: "First",
        children: []
      },
      {
        title: "Second",
        children: [{ title: "Third", children: [] }]
      }
    ]);
  });

  it("clamps a line that is less indented than the baseline to depth 0", () => {
    const text = ["\tFirst", "Second"].join("\n");
    expect(parsePastedOutline(text)).toEqual([
      { title: "First", children: [] },
      { title: "Second", children: [] }
    ]);
  });

  it("clamps a large indent jump to one level deeper than its nearest shallower predecessor", () => {
    const text = ["Root", "\t\t\t\t\tDeepChild", "\tShallowChild"].join("\n");
    expect(parsePastedOutline(text)).toEqual([
      {
        title: "Root",
        children: [
          { title: "DeepChild", children: [] },
          { title: "ShallowChild", children: [] }
        ]
      }
    ]);
  });

  it("skips blank lines rather than emitting empty nodes", () => {
    const text = ["First", "", "   ", "\t", "Second"].join("\n");
    expect(parsePastedOutline(text)).toEqual([
      { title: "First", children: [] },
      { title: "Second", children: [] }
    ]);
  });

  it("trims trailing whitespace from each line's content", () => {
    const text = "First   \nSecond\t";
    expect(parsePastedOutline(text)).toEqual([
      { title: "First", children: [] },
      { title: "Second", children: [] }
    ]);
  });

  it("normalizes CRLF and CR line endings", () => {
    expect(parsePastedOutline("First\r\nSecond\rThird")).toEqual([
      { title: "First", children: [] },
      { title: "Second", children: [] },
      { title: "Third", children: [] }
    ]);
  });

  it("rejects a paste over the node-count cap", () => {
    const lines = Array.from(
      { length: MAX_PASTE_IMPORT_NODES + 1 },
      (_unused, index) => `line-${index}`
    );
    expect(parsePastedOutline(lines.join("\n"))).toBeNull();
  });

  it("bounds line collection instead of splitting an over-cap clipboard into an unbounded array", () => {
    const split = vi.spyOn(String.prototype, "split");
    const text = `${"line\n".repeat(MAX_PASTE_IMPORT_NODES)}overflow`;

    expect(parsePastedOutline(text)).toBeNull();
    expect(
      split.mock.instances.some((instance) => String(instance) === text)
    ).toBe(false);
  });

  it("applies the node-count cap to Markdown lists", () => {
    const lines = Array.from(
      { length: MAX_PASTE_IMPORT_NODES + 1 },
      (_unused, index) => `- line-${index}`
    );
    expect(parsePastedOutline(lines.join("\n"))).toBeNull();
  });

  it("accepts a paste right at the node-count cap", () => {
    const lines = Array.from(
      { length: MAX_PASTE_IMPORT_NODES },
      (_unused, index) => `line-${index}`
    );
    const result = parsePastedOutline(lines.join("\n"));
    expect(result).not.toBeNull();
    expect(result).toHaveLength(MAX_PASTE_IMPORT_NODES);
  });

  it("rejects a paste that nests deeper than the depth cap", () => {
    const lines = ["Root"];
    for (let depth = 1; depth <= MAX_PASTE_IMPORT_DEPTH + 1; depth += 1) {
      lines.push(`${"\t".repeat(depth)}line-${depth}`);
    }
    expect(parsePastedOutline(lines.join("\n"))).toBeNull();
  });

  it("accepts a tree whose deepest node sits at treeDepth MAX_PASTE_IMPORT_DEPTH - 1, matching the backend's 64-level max", () => {
    // `treeDepth` is 0-indexed (roots = 0); the backend counts roots as depth
    // 1 and rejects `depth > 64` (src-tauri/src/notes/types.rs:558), i.e. it
    // accepts 0-indexed depths 0..63. This tree's deepest line lands at
    // treeDepth 63 (MAX_PASTE_IMPORT_DEPTH - 1) and must still parse.
    const lines = ["Root"];
    for (let depth = 1; depth < MAX_PASTE_IMPORT_DEPTH; depth += 1) {
      lines.push(`${"\t".repeat(depth)}line-${depth}`);
    }
    const result = parsePastedOutline(lines.join("\n"));
    expect(result).not.toBeNull();
  });

  it("rejects a tree whose deepest node sits at treeDepth MAX_PASTE_IMPORT_DEPTH, one level past the backend's 64-level max", () => {
    // One level deeper than the previous case: the deepest line now lands at
    // treeDepth 64 (MAX_PASTE_IMPORT_DEPTH), which the backend would reject
    // (depth 65 in its 1-indexed counting). The parser must reject it too,
    // rather than let it through only to have IPC silently drop the paste.
    const lines = ["Root"];
    for (let depth = 1; depth <= MAX_PASTE_IMPORT_DEPTH; depth += 1) {
      lines.push(`${"\t".repeat(depth)}line-${depth}`);
    }
    expect(parsePastedOutline(lines.join("\n"))).toBeNull();
  });

  it("rejects a paste with an oversized line", () => {
    const hugeLine = "a".repeat(100_001);
    expect(parsePastedOutline(`First\n${hugeLine}`)).toBeNull();
  });
});
