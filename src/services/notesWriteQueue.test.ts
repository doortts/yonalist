import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotesWriteQueue } from "./notesWriteQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createNotesWriteQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes writes and does not start the second until the first settles", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const firstOperation = vi.fn(() => first.promise);
    const secondOperation = vi.fn(() => second.promise);
    const queue = createNotesWriteQueue();

    const firstCompletion = queue.enqueue(firstOperation);
    const secondCompletion = queue.enqueue(secondOperation);

    expect(firstOperation).toHaveBeenCalledOnce();
    expect(secondOperation).not.toHaveBeenCalled();

    first.resolve("first");
    await expect(firstCompletion).resolves.toBe("first");
    expect(secondOperation).toHaveBeenCalledOnce();

    second.resolve("second");
    await expect(secondCompletion).resolves.toBe("second");
  });

  it("continues after asynchronous rejection and a synchronous throw", async () => {
    const queue = createNotesWriteQueue();
    const rejected = queue.enqueue(async () => {
      throw new Error("disk full");
    });
    const thrown = queue.enqueue(() => {
      throw new Error("sync failure");
    });
    const recovered = queue.enqueue(async () => "saved");

    await expect(rejected).rejects.toThrow("disk full");
    await expect(thrown).rejects.toThrow("sync failure");
    await expect(recovered).resolves.toBe("saved");
  });

  it("coalesces a key to the latest operation after 300 ms", async () => {
    vi.useFakeTimers();
    const queue = createNotesWriteQueue();
    const first = vi.fn(async () => "first");
    const latest = vi.fn(async () => "latest");

    const firstCompletion = queue.enqueueDebounced("node", first);
    const latestCompletion = queue.enqueueDebounced("node", latest);

    await vi.advanceTimersByTimeAsync(299);
    expect(first).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
    await expect(firstCompletion).resolves.toBe("latest");
    await expect(latestCompletion).resolves.toBe("latest");
  });

  it("flushes a pending key once and cancels its timer", async () => {
    vi.useFakeTimers();
    const queue = createNotesWriteQueue();
    const operation = vi.fn(async () => "saved");
    const completion = queue.enqueueDebounced("node", operation);

    expect(queue.hasPending("node")).toBe(true);
    await queue.flush("node");

    expect(queue.hasPending("node")).toBe(false);
    expect(operation).toHaveBeenCalledOnce();
    await expect(completion).resolves.toBe("saved");
    await vi.advanceTimersByTimeAsync(300);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("flushes every pending key before it resolves", async () => {
    vi.useFakeTimers();
    const queue = createNotesWriteQueue();
    const first = vi.fn(async () => "first saved");
    const second = vi.fn(async () => "second saved");

    const firstCompletion = queue.enqueueDebounced("first", first);
    const secondCompletion = queue.enqueueDebounced("second", second);

    await queue.flush();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    await expect(firstCompletion).resolves.toBe("first saved");
    await expect(secondCompletion).resolves.toBe("second saved");
    await vi.advanceTimersByTimeAsync(300);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "asynchronous rejection",
      operation: () => Promise.reject(new Error("async failure")),
      message: "async failure"
    },
    {
      label: "synchronous throw",
      operation: () => {
        throw new Error("sync failure");
      },
      message: "sync failure"
    }
  ])(
    "settles every coalesced caller after $label and continues the queue",
    async ({ operation, message }) => {
      vi.useFakeTimers();
      const queue = createNotesWriteQueue();
      const superseded = queue.enqueueDebounced("node", async () => "stale");
      const latest = queue.enqueueDebounced("node", operation);
      const coalescedSettlements = Promise.allSettled([superseded, latest]);

      const flush = queue.flush("node");
      const later = queue.enqueue(async () => "recovered");

      await flush;
      const settlements = await coalescedSettlements;
      expect(settlements).toHaveLength(2);
      for (const settlement of settlements) {
        expect(settlement.status).toBe("rejected");
        expect(
          settlement.status === "rejected" ? settlement.reason : null
        ).toEqual(new Error(message));
      }
      await expect(later).resolves.toBe("recovered");
    }
  );

  it("keeps independent vault queues from blocking each other", async () => {
    const firstVaultWrite = deferred<void>();
    const firstVault = createNotesWriteQueue();
    const secondVault = createNotesWriteQueue();
    const blocked = firstVault.enqueue(() => firstVaultWrite.promise);
    const independentWrite = vi.fn(async () => "vault-b");

    await expect(secondVault.enqueue(independentWrite)).resolves.toBe(
      "vault-b"
    );
    expect(independentWrite).toHaveBeenCalledOnce();

    firstVaultWrite.resolve();
    await blocked;
  });
});
