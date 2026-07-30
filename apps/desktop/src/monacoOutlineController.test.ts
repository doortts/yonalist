import type { MonacoOutlineProjection } from "./monacoOutlineProjection";
import { MonacoOutlineController } from "./monacoOutlineController";

describe("Monaco outline controller", () => {
  it("publishes a same-line edit to the node currently owning that line", () => {
    const drafts: Array<{ nodeId: string; text: string }> = [];
    const controller = new MonacoOutlineController(
      projection([
        ["first", "First", true],
        ["inserted", "Inserted", true],
        ["second", "Second", true]
      ]),
      (nodeId, text) => drafts.push({ nodeId, text })
    );

    const result = controller.applyContentChange(
      [{
        startLineNumber: 3,
        endLineNumber: 3,
        text: "!"
      }],
      () => "Second!"
    );

    expect(result).toBe("draft");
    expect(drafts).toEqual([{ nodeId: "second", text: "Second!" }]);
  });

  it("rejects edits to an image line and classifies line changes as structural", () => {
    const drafts: Array<{ nodeId: string; text: string }> = [];
    const controller = new MonacoOutlineController(
      projection([
        ["text", "Text", true],
        ["image", "diagram.png", false]
      ]),
      (nodeId, text) => drafts.push({ nodeId, text })
    );

    expect(controller.applyContentChange(
      [{ startLineNumber: 2, endLineNumber: 2, text: "x" }],
      () => "xdiagram.png"
    )).toBe("rejected");
    expect(controller.applyContentChange(
      [{ startLineNumber: 1, endLineNumber: 1, text: "\n" }],
      () => "Text"
    )).toBe("structural");
    expect(controller.applyContentChange(
      [{ startLineNumber: 1, endLineNumber: 2, text: "" }],
      () => "Text"
    )).toBe("structural");
    expect(drafts).toEqual([]);
  });

  it("defers IME drafts until composition finishes", () => {
    const drafts: Array<{ nodeId: string; text: string }> = [];
    const controller = new MonacoOutlineController(
      projection([["korean", "", true]]),
      (nodeId, text) => drafts.push({ nodeId, text })
    );

    controller.beginComposition();
    expect(controller.applyContentChange(
      [{ startLineNumber: 1, endLineNumber: 1, text: "ㅎ" }],
      () => "ㅎ"
    )).toBe("deferred");
    expect(controller.applyContentChange(
      [{ startLineNumber: 1, endLineNumber: 1, text: "한" }],
      () => "한"
    )).toBe("deferred");
    expect(drafts).toEqual([]);

    controller.endComposition(() => "한");

    expect(drafts).toEqual([{ nodeId: "korean", text: "한" }]);
  });

  it("uses the replacement projection after structural reconciliation", () => {
    const drafts: Array<{ nodeId: string; text: string }> = [];
    const controller = new MonacoOutlineController(
      projection([["before", "Same", true]]),
      (nodeId, text) => drafts.push({ nodeId, text })
    );
    controller.setProjection(projection([["after", "Same", true]]));

    controller.applyContentChange(
      [{ startLineNumber: 1, endLineNumber: 1, text: "!" }],
      () => "Same!"
    );

    expect(drafts).toEqual([{ nodeId: "after", text: "Same!" }]);
  });
});

function projection(
  lines: ReadonlyArray<readonly [
    nodeId: string,
    text: string,
    editable: boolean
  ]>
): MonacoOutlineProjection {
  return {
    lines: lines.map(([nodeId, text, editable]) => ({
      nodeId,
      text,
      depth: 0,
      editable
    })),
    value: lines.map(([, text]) => text).join("\n"),
    lineByNodeId: new Map(
      lines.map(([nodeId], index) => [nodeId, index + 1])
    ),
    nodeIdByLine: lines.map(([nodeId]) => nodeId)
  };
}
