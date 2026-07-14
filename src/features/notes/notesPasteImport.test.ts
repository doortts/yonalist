import { describe, expect, it } from "vitest";
import {
  MAX_PASTE_IMPORT_DEPTH,
  MAX_PASTE_IMPORT_NODES,
  parsePastedOutline
} from "./notesPasteImport";

describe("parsePastedOutline", () => {
  it("returns null for a single line with no newline (not an import)", () => {
    expect(parsePastedOutline("Just one line")).toBeNull();
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

  it("rejects a paste with an oversized line", () => {
    const hugeLine = "a".repeat(100_001);
    expect(parsePastedOutline(`First\n${hugeLine}`)).toBeNull();
  });
});
