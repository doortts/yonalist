import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_DEBOUNCE_LATENCY_MS,
  createNotesWriteQueue
} from "./notesWriteQueue";

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

  it("caps continuous typing at the max latency and flushes the latest payload", async () => {
    vi.useFakeTimers();
    const queue = createNotesWriteQueue();
    const executed: string[] = [];
    const makeOp = (label: string) =>
      vi.fn(async () => {
        executed.push(label);
        return label;
      });

    // Type continuously every 250ms. Without a cap the timer would keep being
    // re-armed and never fire; with the 2s ceiling it must flush by t=2000.
    let lastCompletion: Promise<string> | undefined;
    let lastLabel = "";
    for (let t = 0; t < MAX_DEBOUNCE_LATENCY_MS; t += 250) {
      lastLabel = `t=${t}`;
      lastCompletion = queue.enqueueDebounced("node", makeOp(lastLabel));
      // Assert nothing has fired yet on any tick strictly before the cap.
      expect(executed).toEqual([]);
      await vi.advanceTimersByTimeAsync(250);
    }

    // We have advanced to exactly t=2000; the cap forced exactly one flush of
    // the most recent operation (enqueued at t=1750).
    expect(executed).toEqual(["t=1750"]);
    expect(lastLabel).toBe("t=1750");
    await expect(lastCompletion).resolves.toBe("t=1750");

    // Continued typing keeps typing past the cap without a second flush at
    // t=2000 itself (the window is fresh again).
    await vi.advanceTimersByTimeAsync(1000);
    expect(executed).toEqual(["t=1750"]);
  });

  it("still fires a single debounced write at the default 300ms", async () => {
    vi.useFakeTimers();
    const queue = createNotesWriteQueue();
    const operation = vi.fn(async () => "saved");

    const completion = queue.enqueueDebounced("node", operation);

    await vi.advanceTimersByTimeAsync(299);
    expect(operation).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledOnce();
    await expect(completion).resolves.toBe("saved");
  });

  it("resolves every superseded waiter with the executed operation value", async () => {
    vi.useFakeTimers();
    const queue = createNotesWriteQueue();

    const first = queue.enqueueDebounced("node", async () => "v1");
    const second = queue.enqueueDebounced("node", async () => "v2");
    const latest = queue.enqueueDebounced("node", async () => "v3");

    await vi.advanceTimersByTimeAsync(300);

    await expect(first).resolves.toBe("v3");
    await expect(second).resolves.toBe("v3");
    await expect(latest).resolves.toBe("v3");
  });

  it("opens a fresh window and cap after a cap-triggered flush", async () => {
    vi.useFakeTimers();
    const queue = createNotesWriteQueue();
    const executed: string[] = [];
    const makeOp = (label: string) =>
      vi.fn(async () => {
        executed.push(label);
        return label;
      });

    // First window: continuous typing hits the cap at t=2000.
    for (let t = 0; t < MAX_DEBOUNCE_LATENCY_MS; t += 250) {
      queue.enqueueDebounced("node", makeOp(`a-${t}`));
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(executed).toEqual(["a-1750"]);
    expect(queue.hasPending("node")).toBe(false);

    // Continue typing without pause: a brand-new window must start (its first
    // enqueue does NOT flush immediately even though 2s of wall time elapsed),
    // and its own fresh cap fires exactly one more flush at t=4000.
    for (let t = 0; t < MAX_DEBOUNCE_LATENCY_MS; t += 250) {
      queue.enqueueDebounced("node", makeOp(`b-${t}`));
      // No premature flush from a reused stale window.
      expect(executed).toEqual(["a-1750"]);
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(executed).toEqual(["a-1750", "b-1750"]);
  });

  it("force-drains a partially elapsed window immediately on flush(key)", async () => {
    vi.useFakeTimers();
    const queue = createNotesWriteQueue();
    const operation = vi.fn(async () => "saved");

    queue.enqueueDebounced("node", async () => "stale");
    await vi.advanceTimersByTimeAsync(150);
    const completion = queue.enqueueDebounced("node", operation);

    await queue.flush("node");

    expect(operation).toHaveBeenCalledOnce();
    expect(queue.hasPending("node")).toBe(false);
    await expect(completion).resolves.toBe("saved");

    // No further work is scheduled after a forced drain.
    await vi.advanceTimersByTimeAsync(MAX_DEBOUNCE_LATENCY_MS);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("force-drains every partially elapsed window on flush()", async () => {
    vi.useFakeTimers();
    const queue = createNotesWriteQueue();
    const first = vi.fn(async () => "first saved");
    const second = vi.fn(async () => "second saved");

    const firstCompletion = queue.enqueueDebounced("first", first);
    await vi.advanceTimersByTimeAsync(150);
    const secondCompletion = queue.enqueueDebounced("second", second);

    await queue.flush();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(queue.hasPending("first")).toBe(false);
    expect(queue.hasPending("second")).toBe(false);
    await expect(firstCompletion).resolves.toBe("first saved");
    await expect(secondCompletion).resolves.toBe("second saved");
  });

  it("caps a custom delay longer than the max latency", async () => {
    vi.useFakeTimers();
    const queue = createNotesWriteQueue();
    const operation = vi.fn(async () => "saved");

    const completion = queue.enqueueDebounced("node", operation, 5000);

    await vi.advanceTimersByTimeAsync(MAX_DEBOUNCE_LATENCY_MS - 1);
    expect(operation).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledOnce();
    await expect(completion).resolves.toBe("saved");
  });
});
