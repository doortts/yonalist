import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { MonacoOutlineSession } from "./session";

const NODE_COUNT = 5_000;

function node(index: number): NoteView {
  return {
    id: `node-${index}`,
    parentId: "performance-page",
    sortKey: (index + 1) * 1_024,
    kind: "bullet",
    image: null,
    text: `line ${index}`,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

function receipt(): MutationReceipt {
  return {
    revision: 2,
    changedNodes: [],
    deletedIds: [],
    history: {
      canUndo: false,
      canRedo: false,
      undoDepth: 0,
      redoDepth: 0
    }
  };
}

describe("Monaco outline bounded performance", () => {
  it("applies 200 edits and 100 splits without a full-model replacement", async () => {
    let allocated = 0;
    const session = MonacoOutlineSession.create({
      pageId: "performance-page",
      nodes: Array.from({ length: NODE_COUNT }, (_, index) => node(index)),
      persistence: {
        executeEditorBatch: vi.fn().mockResolvedValue(receipt())
      },
      allocateId: () => `inserted-${allocated++}`
    });

    for (let index = 0; index < 200; index += 1) {
      const column = session.model.getLineMaxColumn(index + 1);
      session.model.pushEditOperations([], [{
        range: new monaco.Range(index + 1, column, index + 1, column),
        text: "!"
      }], () => null);
    }
    for (let index = 0; index < 100; index += 1) {
      const lineNumber = index * 2 + 1;
      const column = session.model.getLineMaxColumn(lineNumber);
      session.model.pushEditOperations([], [{
        range: new monaco.Range(
          lineNumber,
          column,
          lineNumber,
          column
        ),
        text: "\n"
      }], () => null);
    }

    expect(session.model.getLineCount()).toBe(5_100);
    expect(session.metadata.current().lines).toHaveLength(5_100);
    expect(session.metrics.fullModelReplacementCount).toBe(0);
    expect(session.metrics.maxDecorationLinesPerEdit)
      .toBeLessThanOrEqual(3);
    await session.dispose();
  }, 20_000);
});
