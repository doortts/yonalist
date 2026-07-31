import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import {
  MonacoOutlineSession,
  type MonacoOutlineSessionInput
} from "./session";

function node(id: string, text: string, parentId = "page"): NoteView {
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

function receipt(revision = 2): MutationReceipt {
  return {
    revision,
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

function createSession(
  pageId: string,
  nodes: readonly NoteView[],
  executeEditorBatch = vi.fn().mockResolvedValue(receipt()),
  allocatedIds: readonly string[] = ["inserted"]
): {
  readonly session: MonacoOutlineSession;
  readonly executeEditorBatch: ReturnType<typeof vi.fn>;
} {
  const ids = [...allocatedIds];
  const input: MonacoOutlineSessionInput = {
    pageId,
    nodes,
    persistence: { executeEditorBatch },
    allocateId: () => ids.shift() ?? `${pageId}-generated`
  };
  return {
    session: MonacoOutlineSession.create(input),
    executeEditorBatch
  };
}

describe("MonacoOutlineSession", () => {
  it("uses Monaco as text authority and never rehydrates after a local edit", async () => {
    const { session, executeEditorBatch } = createSession(
      "authority",
      [node("first", "Changes appear instantly.", "authority")]
    );

    session.model.pushEditOperations(
      [],
      [{ range: new monaco.Range(1, 9, 1, 9), text: "\n" }],
      () => null
    );

    expect(session.model.getValue()).toBe("Changes \nappear instantly.");
    expect(session.metadata.current().lines).toHaveLength(2);
    expect(executeEditorBatch).not.toHaveBeenCalled();
    await session.flush("navigation");
    expect(executeEditorBatch).toHaveBeenCalledOnce();
    await session.dispose();
  });

  it("restores exact line identities through native undo and redo", async () => {
    const { session } = createSession(
      "undo-redo",
      [node("first", "alpha", "undo-redo")],
      vi.fn().mockResolvedValue(receipt()),
      ["inserted"]
    );
    session.model.pushEditOperations(
      [],
      [{ range: new monaco.Range(1, 3, 1, 3), text: "\n" }],
      () => null
    );
    const insertedId = session.metadata.current().lines[1]?.nodeId;

    await session.model.undo();
    expect(session.metadata.current().lines.map(({ nodeId }) => nodeId))
      .toEqual(["first"]);

    await session.model.redo();
    expect(session.metadata.current().lines.map(({ nodeId }) => nodeId))
      .toEqual(["first", insertedId]);
    await session.dispose();
  });

  it("creates one stable empty bullet without placeholder text", async () => {
    const { session, executeEditorBatch } = createSession(
      "empty",
      [],
      vi.fn().mockResolvedValue(receipt()),
      ["empty-node"]
    );

    session.ensureEditableLine();
    expect(session.model.getValue()).toBe("");
    expect(session.metadata.current().lines.map(({ nodeId }) => nodeId))
      .toEqual(["empty-node"]);

    await session.flush("navigation");
    expect(executeEditorBatch.mock.calls[0]?.[1]).toEqual([{
      kind: "createNode",
      id: "empty-node",
      parent_id: "empty",
      before_id: null,
      text: ""
    }]);
    await session.dispose();
  });

  it("creates a first child as one model-owned command and undo step", async () => {
    const { session, executeEditorBatch } = createSession(
      "first-child",
      [
        node("parent", "parent", "first-child"),
        node("existing", "existing", "parent"),
        node("sibling", "sibling", "first-child")
      ],
      vi.fn().mockResolvedValue(receipt()),
      ["inserted-child"]
    );

    expect(session.createFirstChild("parent")).toBe("inserted-child");
    expect(session.model.getValue()).toBe("parent\n\nexisting\nsibling");
    expect(session.metadata.current().lines.map(
      ({ nodeId, parentId, depth }) => ({ nodeId, parentId, depth })
    )).toEqual([
      { nodeId: "parent", parentId: "first-child", depth: 0 },
      { nodeId: "inserted-child", parentId: "parent", depth: 1 },
      { nodeId: "existing", parentId: "parent", depth: 1 },
      { nodeId: "sibling", parentId: "first-child", depth: 0 }
    ]);
    expect(session.model.getAllDecorations().map((decoration) => ({
      lineNumber: decoration.range.startLineNumber,
      nodeId: (
        decoration.options.before?.attachedData as
          { readonly nodeId?: string } | undefined
      )?.nodeId
    }))).toEqual([
      { lineNumber: 1, nodeId: "parent" },
      { lineNumber: 2, nodeId: "inserted-child" },
      { lineNumber: 3, nodeId: "existing" },
      { lineNumber: 4, nodeId: "sibling" }
    ]);

    await session.flush("navigation");
    expect(executeEditorBatch.mock.calls[0]?.[1]).toEqual([{
      kind: "createNode",
      id: "inserted-child",
      parent_id: "parent",
      before_id: "existing",
      text: ""
    }]);
    await session.model.undo();
    expect(session.metadata.current().lines.map(({ nodeId }) => nodeId))
      .toEqual(["parent", "existing", "sibling"]);
    await session.dispose();
  });

  it("updates a zoomed title through the canonical model", async () => {
    const { session, executeEditorBatch } = createSession(
      "title-edit",
      [node("first", "before", "title-edit")]
    );

    session.updateNodeText("first", "after");
    expect(session.textForNode("first")).toBe("after");
    await session.flush("navigation");
    expect(executeEditorBatch.mock.calls[0]?.[1]).toEqual([{
      kind: "updateText",
      id: "first",
      text: "after"
    }]);
    await session.dispose();
  });

  it("observes an actual whole-model flush instead of a constant metric", async () => {
    const { session } = createSession(
      "flush-metric",
      [node("first", "before", "flush-metric")]
    );

    expect(session.metrics.fullModelReplacementCount).toBe(0);
    session.model.setValue("after");
    expect(session.metrics.fullModelReplacementCount).toBe(1);
    await session.dispose();
  });

  it("reports editor and listener lifetimes without retaining their objects", async () => {
    const { session } = createSession(
      "diagnostics",
      [node("first", "before", "diagnostics")]
    );
    const editor = {
      getModel: () => session.model,
      hasTextFocus: () => false
    } as unknown as monaco.editor.ICodeEditor;

    expect(session.diagnostics()).toEqual({
      boundEditors: 0,
      metadataListeners: 0,
      forwardTransitions: 0,
      reverseTransitions: 0,
      metadataVersions: 1,
      modelDecorations: 1,
      pendingPersistenceCommands: 0,
      persistenceKind: "saved",
      fullModelReplacementCount: 0,
      maxDecorationLinesPerEdit: 0
    });

    const unbind = session.bindEditor(editor);
    const unsubscribe = session.subscribeMetadata(() => undefined);
    expect(session.diagnostics()).toEqual(expect.objectContaining({
      boundEditors: 1,
      metadataListeners: 1
    }));

    unsubscribe();
    unbind();
    expect(session.diagnostics()).toEqual(expect.objectContaining({
      boundEditors: 0,
      metadataListeners: 0
    }));
    await session.dispose();
  });

  it("prunes unreachable metadata when an undone edit gets a new branch", async () => {
    const { session } = createSession(
      "prune-diagnostics",
      [node("first", "before", "prune-diagnostics")]
    );
    const endColumn = session.model.getLineMaxColumn(1);
    session.model.pushEditOperations([], [{
      range: new monaco.Range(1, endColumn, 1, endColumn),
      text: "!"
    }], () => null);
    expect(session.diagnostics()).toEqual(expect.objectContaining({
      forwardTransitions: 1,
      reverseTransitions: 1,
      metadataVersions: 2
    }));

    await session.model.undo();
    session.model.pushEditOperations([], [{
      range: new monaco.Range(1, endColumn, 1, endColumn),
      text: "?"
    }], () => null);

    expect(session.diagnostics()).toEqual(expect.objectContaining({
      forwardTransitions: 1,
      reverseTransitions: 1,
      metadataVersions: 2
    }));
    await session.dispose();
  });
});
