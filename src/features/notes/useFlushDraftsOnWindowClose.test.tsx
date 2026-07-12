import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const onCloseRequested = vi.hoisted(() => vi.fn());
const destroy = vi.hoisted(() => vi.fn());
const unlisten = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested, destroy })
}));

import { useFlushDraftsOnWindowClose } from "./useFlushDraftsOnWindowClose";

function Harness({ flush }: { flush: () => Promise<boolean> }) {
  useFlushDraftsOnWindowClose(flush);
  return null;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
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
    const handler = onCloseRequested.mock.calls[0][0] as (event: {
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

  it("destroys the window and logs even when the flush never resolves", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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

    await vi.advanceTimersByTimeAsync(3000);
    await settled;

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("timed out")
    );
    warn.mockRestore();
  });

  it("logs and still destroys when the flush reports an incomplete drain", async () => {
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
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not persist")
    );
    warn.mockRestore();
  });

  it("logs and still destroys when the flush rejects", async () => {
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
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "Notes draft flush before close failed",
      failure
    );
    error.mockRestore();
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
