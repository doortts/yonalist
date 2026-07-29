import { describe, expect, it } from "vitest";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  canCutSelectedOutline,
  normalizeSelectedRoots,
  serializeSelectedOutline,
  writeOutlineClipboardEvent
} from "./outlineClipboard";

function node(
  id: string,
  parentId: string,
  text: string,
  sortKey: number
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
    deleted: false
  };
}

const nodes = [
  node("parent", "page", "Parent", 1_024),
  node("child", "parent", "Child", 1_024),
  node("grandchild", "child", "Grandchild", 1_024),
  node("sibling", "page", "Sibling", 2_048),
  node("sibling-child", "sibling", "Nested", 1_024)
];

describe("outline clipboard", () => {
  it("normalizes selected rows to forest roots in outline order", () => {
    expect(normalizeSelectedRoots(nodes, [
      "child",
      "sibling",
      "parent",
      "grandchild"
    ])).toEqual(["parent", "sibling"]);
  });

  it("serializes complete selected subtrees with draft titles and no internal fields", () => {
    const serialized = serializeSelectedOutline(
      nodes,
      { parent: "Draft parent", child: "line one\nline two" },
      ["parent", "child", "sibling"]
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
    expect(serializeSelectedOutline(
      [node("empty", "page", "", 1_024)],
      {},
      ["empty"]
    )).toBe("-");
  });

  it("blocks lossy Cut when a selected subtree has a note or embedded title newline", () => {
    expect(canCutSelectedOutline(
      nodes.map((candidate) => candidate.id === "grandchild"
        ? { ...candidate, note: "Keep this context" }
        : candidate),
      {},
      {},
      ["parent"]
    )).toBe(false);
    expect(canCutSelectedOutline(
      nodes,
      { child: "line one\nline two" },
      {},
      ["parent"]
    )).toBe(false);
    expect(canCutSelectedOutline(
      nodes.map((candidate) => candidate.id === "child"
        ? { ...candidate, note: "   " }
        : candidate),
      {},
      {},
      ["parent"]
    )).toBe(false);
    expect(canCutSelectedOutline(nodes, {}, {}, ["parent"])).toBe(true);
  });

  it("writes the identical structural value to plain text and Markdown", () => {
    const setData = vi.fn();

    expect(writeOutlineClipboardEvent({ setData }, "- Parent")).toBe(true);
    expect(setData).toHaveBeenNthCalledWith(1, "text/plain", "- Parent");
    expect(setData).toHaveBeenNthCalledWith(2, "text/markdown", "- Parent");
  });
});
