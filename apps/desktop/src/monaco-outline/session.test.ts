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
});
