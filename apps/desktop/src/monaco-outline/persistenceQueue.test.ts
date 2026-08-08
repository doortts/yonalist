import type { IpcEditorCommand } from "../../../../packages/contracts/generated/IpcEditorCommand";
import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import {
  MonacoOutlinePersistenceQueue,
  type MonacoPersistencePort
} from "./persistenceQueue";

function receipt(revision: number): MutationReceipt {
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

function update(id: string, text: string): IpcEditorCommand {
  return { kind: "updateText", id, text };
}

function createPort(
  executeEditorBatch: MonacoPersistencePort["executeEditorBatch"]
): MonacoPersistencePort {
  return { executeEditorBatch };
}

describe("MonacoOutlinePersistenceQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces text updates by node and saves them after 300ms", async () => {
    const executeEditorBatch = vi.fn().mockResolvedValue(receipt(2));
    const queue = new MonacoOutlinePersistenceQueue(
      createPort(executeEditorBatch)
    );

    queue.enqueue([update("a", "A")], "text");
    queue.enqueue([update("a", "AB")], "text");
    queue.enqueue([update("b", "B")], "text");
    queue.enqueue([{ kind: "updateNote", id: "a", note: "N" }], "text");
    queue.enqueue([{ kind: "updateNote", id: "a", note: "NO" }], "text");

    await vi.advanceTimersByTimeAsync(299);
    expect(executeEditorBatch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await queue.flush("blur");

    expect(executeEditorBatch).toHaveBeenCalledOnce();
    expect(executeEditorBatch.mock.calls[0]?.[1]).toEqual([
      update("a", "AB"),
      update("b", "B"),
      { kind: "updateNote", id: "a", note: "NO" }
    ]);
    expect(queue.getSnapshot()).toEqual({ kind: "saved", pending: 0 });
  });

  it("persists pending text before a structural transition without waiting", async () => {
    const executeEditorBatch = vi.fn().mockResolvedValue(receipt(2));
    const queue = new MonacoOutlinePersistenceQueue(
      createPort(executeEditorBatch)
    );
    const split: IpcEditorCommand = {
      kind: "splitNode",
      id: "a",
      new_id: "b",
      parent_id: "page",
      before_id: null,
      prefix: "A",
      suffix: ""
    };

    queue.enqueue([update("a", "A")], "text");
    queue.enqueue([split], "structural");
    await queue.flush("navigation");

    expect(executeEditorBatch).toHaveBeenCalledOnce();
    expect(executeEditorBatch.mock.calls[0]?.[1]).toEqual([
      update("a", "A"),
      split
    ]);
  });

  it("retains a conflicting batch and retries with the same request id", async () => {
    const conflict = { code: "revision_conflict", message: "stale" };
    const executeEditorBatch = vi.fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(receipt(3));
    const queue = new MonacoOutlinePersistenceQueue(
      createPort(executeEditorBatch)
    );

    queue.enqueue([update("a", "A")], "structural");
    await expect(queue.flush("blur")).rejects.toBe(conflict);
    expect(queue.getSnapshot()).toEqual({
      kind: "conflict",
      pending: 1,
      message: "stale"
    });

    await queue.retry();

    expect(executeEditorBatch).toHaveBeenCalledTimes(2);
    expect(executeEditorBatch.mock.calls[1]?.[0])
      .toBe(executeEditorBatch.mock.calls[0]?.[0]);
    expect(executeEditorBatch.mock.calls[1]?.[1]).toEqual([
      update("a", "A")
    ]);
    expect(queue.getSnapshot()).toEqual({ kind: "saved", pending: 0 });
  });

  it("surfaces fatal failures without dropping unsaved commands", async () => {
    const fatal = { code: "invalid_command", message: "invalid split" };
    const queue = new MonacoOutlinePersistenceQueue(createPort(
      vi.fn().mockRejectedValue(fatal)
    ));

    queue.enqueue([update("a", "A")], "structural");
    await expect(queue.flush("close")).rejects.toBe(fatal);

    expect(queue.getSnapshot()).toEqual({
      kind: "fatal",
      pending: 1,
      message: "invalid split"
    });
  });
});
