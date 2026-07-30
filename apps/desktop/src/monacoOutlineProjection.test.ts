import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { OutlineIndex } from "./outlineIndex";
import {
  buildMonacoOutlineProjection,
  planMonacoProjectionEdit
} from "./monacoOutlineProjection";

function textNode(
  id: string,
  parentId: string,
  sortKey: number,
  text: string
): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: "bullet",
    image: null,
    text,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

function imageNode(
  id: string,
  parentId: string,
  sortKey: number,
  name: string
): NoteView {
  return {
    ...textNode(id, parentId, sortKey, name),
    kind: "image",
    image: {
      contentHash: "a".repeat(64),
      originalName: name,
      mimeType: "image/png",
      byteLength: 128,
      pixelWidth: 16,
      pixelHeight: 16,
      displayWidth: 160
    }
  };
}

describe("Monaco outline projection", () => {
  it("maps visible node identity, draft text, hierarchy, and image editability", () => {
    const nodes = [
      textNode("parent", "page", 1_024, "Confirmed"),
      textNode("child", "parent", 1_024, "Child"),
      imageNode("image", "page", 2_048, "diagram.png")
    ];
    const index = new OutlineIndex(nodes);
    const projection = buildMonacoOutlineProjection(
      nodes,
      index,
      "page",
      (id) => id === "parent" ? "Draft" : index.node(id)?.text ?? ""
    );

    expect(projection.value).toBe("Draft\nChild\ndiagram.png");
    expect(projection.lines).toEqual([
      { nodeId: "parent", text: "Draft", depth: 0, editable: true },
      { nodeId: "child", text: "Child", depth: 1, editable: true },
      { nodeId: "image", text: "diagram.png", depth: 0, editable: false }
    ]);
    expect(projection.lineByNodeId.get("parent")).toBe(1);
    expect(projection.lineByNodeId.get("child")).toBe(2);
    expect(projection.lineByNodeId.get("image")).toBe(3);
    expect(projection.nodeIdByLine).toEqual([
      "parent",
      "child",
      "image"
    ]);
  });

  it("plans one bounded edit when a line changes", () => {
    const previous = projection(["Alpha", "Gamma"]);
    const next = projection(["Alpine", "Gamma"]);

    expect(planMonacoProjectionEdit(previous, next)).toEqual({
      startLineNumber: 1,
      startColumn: 4,
      endLineNumber: 1,
      endColumn: 6,
      text: "ine"
    });
  });

  it("plans one bounded edit when a line is inserted", () => {
    const previous = projection(["Alpha", "Gamma"]);
    const next = projection(["Alpha", "Beta", "Gamma"]);

    expect(planMonacoProjectionEdit(previous, next)).toEqual({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 1,
      text: "Beta\n"
    });
  });

  it("plans one bounded edit when a line is removed", () => {
    const previous = projection(["Alpha", "Beta", "Gamma"]);
    const next = projection(["Alpha", "Gamma"]);

    expect(planMonacoProjectionEdit(previous, next)).toEqual({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 1,
      text: ""
    });
  });

  it("handles empty projections and identity-only changes", () => {
    const empty = projection([]);
    const inserted = projection(["Alpha"]);
    const renamedIdentity = projection(["Alpha"], "replacement");

    expect(planMonacoProjectionEdit(empty, inserted)).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
      text: "Alpha"
    });
    expect(planMonacoProjectionEdit(inserted, empty)).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 6,
      text: ""
    });
    expect(planMonacoProjectionEdit(inserted, renamedIdentity)).toBeNull();
    expect(renamedIdentity.nodeIdByLine).toEqual(["replacement-0"]);
  });
});

function projection(
  texts: readonly string[],
  idPrefix = "node"
) {
  const nodes = texts.map((text, index) =>
    textNode(`${idPrefix}-${index}`, "page", (index + 1) * 1_024, text)
  );
  const outlineIndex = new OutlineIndex(nodes);
  return buildMonacoOutlineProjection(
    nodes,
    outlineIndex,
    "page",
    (id) => outlineIndex.node(id)?.text ?? ""
  );
}
