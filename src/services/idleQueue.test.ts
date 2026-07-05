import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleIdleTask } from "./idleQueue";

describe("scheduleIdleTask", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses requestIdleCallback when available", () => {
    const cancelIdleCallback = vi.fn();
    const requestIdleCallback = vi.fn(() => 42);
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
    const task = vi.fn();

    const cancel = scheduleIdleTask(task, 1500);

    expect(requestIdleCallback).toHaveBeenCalledWith(task, { timeout: 1500 });
    cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(42);
  });

  it("falls back to a delayed timer so work does not run immediately", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("cancelIdleCallback", undefined);
    const task = vi.fn();

    scheduleIdleTask(task, 1500);

    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1499);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
