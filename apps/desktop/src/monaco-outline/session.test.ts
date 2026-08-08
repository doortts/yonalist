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
    expect(session.model.getAllDecorations()).toEqual([]);

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

  it("outdents a node and adopts its following siblings as children", async () => {
    const { session, executeEditorBatch } = createSession(
      "outdent",
      [
        node("parent", "Parent", "outdent"),
        node("first", "First", "parent"),
        node("second", "Second", "parent"),
        node("third", "Third", "parent")
      ]
    );
    const editor = {
      getModel: () => session.model,
      hasTextFocus: () => true,
      invokeWithinContext: (
        callback: (accessor: { get(service: unknown): unknown }) => unknown
      ) => callback({ get: () => ({ pushElement: vi.fn() }) })
    } as unknown as monaco.editor.ICodeEditor;
    const unbind = session.bindEditor(editor);

    session.outdent("first");

    expect(session.metadata.current().lines).toMatchObject([
      { nodeId: "parent", depth: 0 },
      { nodeId: "first", parentId: "outdent", depth: 0 },
      { nodeId: "second", parentId: "first", depth: 1 },
      { nodeId: "third", parentId: "first", depth: 1 }
    ]);
    await session.flush("navigation");
    expect(executeEditorBatch.mock.calls[0]?.[1]).toEqual([
      {
        kind: "outdent",
        id: "first",
        new_parent_id: "outdent",
        before_id: null
      },
      { kind: "moveNode", id: "second", parent_id: "first", before_id: null },
      { kind: "moveNode", id: "third", parent_id: "first", before_id: null }
    ]);
    unbind();
    await session.dispose();
  });

  it("toggles collapse as one persisted metadata edit and skips leaves", async () => {
    const { session, executeEditorBatch } = createSession(
      "collapse",
      [
        node("parent", "Parent", "collapse"),
        node("child", "Child", "parent")
      ]
    );
    const editor = {
      getModel: () => session.model,
      hasTextFocus: () => true,
      invokeWithinContext: (
        callback: (accessor: { get(service: unknown): unknown }) => unknown
      ) => callback({ get: () => ({ pushElement: vi.fn() }) })
    } as unknown as monaco.editor.ICodeEditor;
    const unbind = session.bindEditor(editor);

    session.toggleCollapsed("parent");
    expect(session.metadata.current().lines[0]?.collapsed).toBe(true);
    await session.flush("navigation");
    expect(executeEditorBatch.mock.calls[0]?.[1]).toEqual([
      { kind: "setCollapsed", id: "parent", collapsed: true }
    ]);

    session.toggleCollapsed("child");
    expect(session.metadata.current().lines[1]?.collapsed).toBe(false);

    session.toggleCollapsed("parent");
    expect(session.metadata.current().lines[0]?.collapsed).toBe(false);
    unbind();
    await session.dispose();
  });

  it("toggles completion as one persisted metadata edit", async () => {
    const { session, executeEditorBatch } = createSession(
      "complete",
      [node("first", "Task", "complete")]
    );
    const editor = {
      getModel: () => session.model,
      hasTextFocus: () => true,
      invokeWithinContext: (
        callback: (accessor: { get(service: unknown): unknown }) => unknown
      ) => callback({ get: () => ({ pushElement: vi.fn() }) })
    } as unknown as monaco.editor.ICodeEditor;
    const unbind = session.bindEditor(editor);

    session.toggleCompleted("first");
    expect(session.metadata.current().lines[0]?.completed).toBe(true);
    await session.flush("navigation");
    expect(executeEditorBatch.mock.calls[0]?.[1]).toEqual([
      { kind: "setCompleted", id: "first", completed: true }
    ]);

    session.toggleCompleted("first");
    expect(session.metadata.current().lines[0]?.completed).toBe(false);
    unbind();
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

  it("hydrates note runs and image captions as their own lines", async () => {
    const { session } = createSession("rich", [
      { ...node("first", "alpha", "rich"), note: "a\nb" },
      {
        ...node("picture", "caption", "rich"),
        kind: "image",
        image: {
          contentHash: "hash",
          originalName: "shot.png",
          mimeType: "image/png",
          byteLength: 128,
          pixelWidth: 10,
          pixelHeight: 10,
          displayWidth: 10
        }
      }
    ]);

    expect(session.model.getValue()).toBe("alpha\na\nb\ncaption");
    expect(session.metadata.current().lines.map(
      ({ nodeId, kind, depth }) => ({ nodeId, kind, depth })
    )).toEqual([
      { nodeId: "first", kind: "text", depth: 0 },
      { nodeId: "first", kind: "note", depth: 0 },
      { nodeId: "first", kind: "note", depth: 0 },
      { nodeId: "picture", kind: "image", depth: 0 }
    ]);
    expect(session.metadata.current().noteRangeByNodeId.get("first"))
      .toEqual([2, 3]);
    await session.dispose();
  });

  it("creates an empty note run as one command and undo step", async () => {
    const { session, executeEditorBatch } = createSession("note-create", [
      node("first", "alpha", "note-create"),
      node("second", "beta", "note-create")
    ]);

    expect(session.createNote("first")).toBe(2);
    expect(session.model.getValue()).toBe("alpha\n\nbeta");
    expect(session.metadata.current().lines.map(({ nodeId, kind }) => (
      `${nodeId}:${kind}`
    ))).toEqual(["first:text", "first:note", "second:text"]);

    await session.flush("navigation");
    expect(executeEditorBatch.mock.calls[0]?.[1]).toEqual([
      { kind: "updateNote", id: "first", note: "" }
    ]);

    await session.model.undo();
    expect(session.model.getValue()).toBe("alpha\nbeta");
    expect(session.metadata.current().lines.map(({ nodeId }) => nodeId))
      .toEqual(["first", "second"]);
    await session.dispose();
  });

  it("removes a note run as one command and undo step", async () => {
    const { session, executeEditorBatch } = createSession("note-remove", [
      { ...node("first", "alpha", "note-remove"), note: "kept" },
      node("second", "beta", "note-remove")
    ]);

    expect(session.removeNote("first")).toBe(true);
    expect(session.model.getValue()).toBe("alpha\nbeta");
    expect(session.metadata.current().lines).toHaveLength(2);

    await session.flush("navigation");
    expect(executeEditorBatch.mock.calls[0]?.[1]).toEqual([
      { kind: "updateNote", id: "first", note: "" }
    ]);

    await session.model.undo();
    expect(session.model.getValue()).toBe("alpha\nkept\nbeta");
    expect(session.metadata.current().lines).toHaveLength(3);
    await session.dispose();
  });
});
