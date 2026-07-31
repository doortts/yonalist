import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { MonacoOutlineSession } from "./session";

function node(id: string, text: string, parentId: string): NoteView {
  return {
    id,
    parentId,
    sortKey: 1_024,
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

function session(
  pageId: string,
  text: string,
  executeEditorBatch = vi.fn().mockResolvedValue(receipt())
) {
  let sequence = 0;
  return {
    executeEditorBatch,
    session: MonacoOutlineSession.create({
      pageId,
      nodes: [node("first", text, pageId)],
      persistence: { executeEditorBatch },
      allocateId: () => `${pageId}-inserted-${sequence++}`
    })
  };
}

function edit(
  model: monaco.editor.ITextModel,
  range: monaco.Range,
  text: string
): void {
  model.pushEditOperations([], [{ range, text }], () => null);
}

describe("native Monaco outline editing", () => {
  it("splits in the middle without moving identity into model text", async () => {
    const fixture = session("native-middle", "Changes appear instantly.");

    edit(
      fixture.session.model,
      new monaco.Range(1, 9, 1, 9),
      "\n"
    );

    expect(fixture.session.model.getValue()).toBe(
      "Changes \nappear instantly."
    );
    expect(fixture.session.metadata.current().lines.map(({ nodeId }) => nodeId))
      .toEqual(["first", "native-middle-inserted-0"]);
    await fixture.session.dispose();
  });

  it("keeps twenty Enter and Backspace transitions contiguous", async () => {
    const fixture = session("native-repeat", "alpha");
    const model = fixture.session.model;

    for (let index = 0; index < 20; index += 1) {
      const line = model.getLineCount();
      edit(
        model,
        new monaco.Range(
          line,
          model.getLineMaxColumn(line),
          line,
          model.getLineMaxColumn(line)
        ),
        "\n"
      );
    }
    expect(model.getLineCount()).toBe(21);
    expect(fixture.session.metadata.current().lines).toHaveLength(21);

    for (let index = 0; index < 20; index += 1) {
      const line = model.getLineCount();
      edit(
        model,
        new monaco.Range(
          line - 1,
          model.getLineMaxColumn(line - 1),
          line,
          1
        ),
        ""
      );
    }
    expect(model.getValue()).toBe("alpha");
    expect(model.getLineCount()).toBe(1);
    expect(fixture.session.metadata.current().lines.map(({ nodeId }) => nodeId))
      .toEqual(["first"]);
    await fixture.session.dispose();
  });

  it("coalesces successive text input without replacing the model", async () => {
    vi.useFakeTimers();
    const executeEditorBatch = vi.fn().mockResolvedValue(receipt());
    const fixture = session("native-text", "", executeEditorBatch);
    const model = fixture.session.model;

    for (const text of ["한", "글", "어"]) {
      edit(
        model,
        new monaco.Range(1, model.getLineMaxColumn(1), 1, model.getLineMaxColumn(1)),
        text
      );
    }
    expect(fixture.session.metrics.fullModelReplacementCount).toBe(0);

    await vi.advanceTimersByTimeAsync(300);
    await fixture.session.flush("navigation");
    expect(executeEditorBatch).toHaveBeenCalledOnce();
    expect(executeEditorBatch.mock.calls[0]?.[1]).toEqual([{
      kind: "updateText",
      id: "first",
      text: "한글어"
    }]);
    await fixture.session.dispose();
    vi.useRealTimers();
  });

  it("keeps injected bullets out of search and clipboard model text", async () => {
    const fixture = session("native-plain-text", "alpha");
    edit(
      fixture.session.model,
      new monaco.Range(1, 6, 1, 6),
      "\nbeta"
    );

    expect(fixture.session.model.findMatches(
      "\u2022",
      false,
      false,
      false,
      null,
      true
    )).toHaveLength(0);
    expect(fixture.session.model.getValueInRange(
      fixture.session.model.getFullModelRange()
    )).toBe("alpha\nbeta");
    await fixture.session.dispose();
  });
});
