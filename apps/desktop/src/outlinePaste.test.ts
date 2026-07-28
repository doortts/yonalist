import { describe, expect, it } from "vitest";
import { parsePastedOutline } from "./outlinePaste";

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
