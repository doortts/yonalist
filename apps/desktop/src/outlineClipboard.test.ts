import { describe, expect, it } from "vitest";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  normalizeSelectedRoots,
  outlineCutRefusal,
  serializeSelectedOutline,
  writeOutlineClipboardEvent
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

describe("outline clipboard", () => {
  it("short-circuits empty selections without traversing the outline", () => {
    const unreadableNodes = new Proxy([] as NoteView[], {
      get: () => {
        throw new Error("outline traversal is not allowed");
      }
    });

    expect(normalizeSelectedRoots(unreadableNodes, [])).toEqual([]);
    expect(serializeSelectedOutline(unreadableNodes, {}, [])).toBeNull();
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

  it("writes the identical structural value to plain text and Markdown", () => {
    const setData = vi.fn();

    expect(writeOutlineClipboardEvent({ setData }, "- Parent")).toBe(true);
    expect(setData).toHaveBeenNthCalledWith(1, "text/plain", "- Parent");
    expect(setData).toHaveBeenNthCalledWith(2, "text/markdown", "- Parent");
  });
});
