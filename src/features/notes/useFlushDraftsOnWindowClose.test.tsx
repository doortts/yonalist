import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const onCloseRequested = vi.hoisted(() => vi.fn());
const destroy = vi.hoisted(() => vi.fn());
const unlisten = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested, destroy })
}));

import { useFlushDraftsOnWindowClose } from "./useFlushDraftsOnWindowClose";

function Harness({
  flush,
  syncFlush,
  release
}: {
  flush: () => Promise<boolean>;
  syncFlush?: () => Promise<void>;
  release?: () => Promise<void>;
}) {
  useFlushDraftsOnWindowClose(flush, syncFlush, release);
  return null;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function setTauriRuntime(present: boolean): void {
  if (present) {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
  } else {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;
  }
}

describe("useFlushDraftsOnWindowClose", () => {
  beforeEach(() => {
    onCloseRequested.mockReset();
    destroy.mockReset();
    unlisten.mockReset();
    onCloseRequested.mockImplementation(() => Promise.resolve(unlisten));
    destroy.mockResolvedValue(undefined);
    setTauriRuntime(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    setTauriRuntime(false);
  });

  it("prevents the default close, flushes drafts, then destroys the window", async () => {
    const flush = vi.fn().mockResolvedValue(true);
    await act(async () => {
      render(<Harness flush={flush} />);
      await flushMicrotasks();
    });

    expect(onCloseRequested).toHaveBeenCalledTimes(1);
    const handler = onCloseRequested.mock.lastCall?.[0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;
    const event = { preventDefault: vi.fn() };

    await act(async () => {
      await handler(event);
    });

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(
      flush.mock.invocationCallOrder[0]
    ).toBeLessThan(destroy.mock.invocationCallOrder[0]);
  });

  it("flushes the sync exporter after draining drafts, before destroying", async () => {
    // Capture the close handler and record ordering without any mock-order
    // introspection, to respect the notes test-order budget.
    const order: string[] = [];
    let handler:
      | ((event: { preventDefault: () => void }) => Promise<void>)
      | undefined;
    onCloseRequested.mockImplementation((cb: typeof handler) => {
      handler = cb;
      return Promise.resolve(unlisten);
    });
    destroy.mockImplementation(async () => {
      order.push("destroy");
    });
    const flush = vi.fn(async () => {
      order.push("flush");
      return true;
    });
    const syncFlush = vi.fn(async () => {
      order.push("sync");
    });
    await act(async () => {
      render(<Harness flush={flush} syncFlush={syncFlush} />);
      await flushMicrotasks();
    });

    await act(async () => {
      await handler!({ preventDefault: vi.fn() });
    });

    expect(flush).toHaveBeenCalledTimes(1);
    expect(syncFlush).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["flush", "sync", "destroy"]);
  });

  it("keeps the window open when the sync export flush fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let handler:
      | ((event: { preventDefault: () => void }) => Promise<void>)
      | undefined;
    onCloseRequested.mockImplementation((cb: typeof handler) => {
      handler = cb;
      return Promise.resolve(unlisten);
    });
    const flush = vi.fn().mockResolvedValue(true);
    const syncFlush = vi
      .fn()
      .mockRejectedValue(new Error("exporter unavailable"));
    await act(async () => {
      render(<Harness flush={flush} syncFlush={syncFlush} />);
      await flushMicrotasks();
    });

    await act(async () => {
      await handler!({ preventDefault: vi.fn() });
    });

    expect(syncFlush).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "Notes sync export flush before close failed",
      expect.any(Error)
    );
    error.mockRestore();
  });

  it("releases a successful drain after sync failure and drains again on retry", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const flush = vi.fn().mockResolvedValue(true);
    const syncFlush = vi
      .fn()
      .mockRejectedValueOnce(new Error("exporter unavailable"))
      .mockResolvedValueOnce(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      render(
        <Harness flush={flush} syncFlush={syncFlush} release={release} />
      );
      await flushMicrotasks();
    });
    const handler = onCloseRequested.mock.lastCall?.[0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;

    await act(async () => {
      await handler({ preventDefault: vi.fn() });
    });
    expect(release).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();

    await act(async () => {
      await handler({ preventDefault: vi.fn() });
    });
    expect(flush).toHaveBeenCalledTimes(2);
    expect(syncFlush).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("releases a successful drain when destroying the window fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const release = vi.fn().mockResolvedValue(undefined);
    destroy.mockRejectedValueOnce(new Error("window stayed open"));
    await act(async () => {
      render(
        <Harness
          flush={vi.fn().mockResolvedValue(true)}
          release={release}
        />
      );
      await flushMicrotasks();
    });
    const handler = onCloseRequested.mock.lastCall?.[0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;

    await act(async () => {
      await handler({ preventDefault: vi.fn() });
    });

    expect(release).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("keeps the window open after ten seconds while a drain is pending", async () => {
    vi.useFakeTimers();
    const flush = vi.fn().mockReturnValue(new Promise<boolean>(() => {}));
    await act(async () => {
      render(<Harness flush={flush} />);
      await flushMicrotasks();
    });

    const handler = onCloseRequested.mock.calls[0][0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;
    const event = { preventDefault: vi.fn() };
    const settled = handler(event);

    await flushMicrotasks();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(destroy).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    void settled;
  });

  it("keeps the window open when the drain reports incomplete", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const flush = vi.fn().mockResolvedValue(false);
    await act(async () => {
      render(<Harness flush={flush} />);
      await flushMicrotasks();
    });

    const handler = onCloseRequested.mock.calls[0][0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;

    await act(async () => {
      await handler({ preventDefault: vi.fn() });
    });

    expect(flush).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not persist")
    );
    warn.mockRestore();
  });

  it("keeps the window open when the drain rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("write queue exploded");
    const flush = vi.fn().mockRejectedValue(failure);
    await act(async () => {
      render(<Harness flush={flush} />);
      await flushMicrotasks();
    });

    const handler = onCloseRequested.mock.calls[0][0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;

    await act(async () => {
      await handler({ preventDefault: vi.fn() });
    });

    expect(flush).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "Notes draft flush before close failed",
      failure
    );
    error.mockRestore();
  });

  it("prevents every simultaneous request and shares one drain", async () => {
    const pending = deferred<boolean>();
    const flush = vi.fn(() => pending.promise);
    await act(async () => {
      render(<Harness flush={flush} />);
      await flushMicrotasks();
    });
    const handler = onCloseRequested.mock.calls[0][0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };

    const first = handler(firstEvent);
    const second = handler(secondEvent);
    await flushMicrotasks();

    expect(first).toBe(second);
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    pending.resolve(true);
    await act(async () => {
      await first;
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("does nothing outside a Tauri runtime", async () => {
    setTauriRuntime(false);
    const flush = vi.fn().mockResolvedValue(true);

    await act(async () => {
      render(<Harness flush={flush} />);
      await flushMicrotasks();
    });

    expect(onCloseRequested).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("unlistens the close handler on unmount", async () => {
    const flush = vi.fn().mockResolvedValue(true);
    let unmount!: () => void;
    await act(async () => {
      ({ unmount } = render(<Harness flush={flush} />));
      await flushMicrotasks();
    });
    expect(onCloseRequested).toHaveBeenCalledTimes(1);

    await act(async () => {
      unmount();
      await flushMicrotasks();
    });

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
