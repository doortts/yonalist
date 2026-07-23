import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutlineIdleBaselineScheduler } from "./outlineIdleBaseline";

interface IdleHarness {
  readonly requestIdle: (
    callback: IdleRequestCallback,
    timeoutMs: number
  ) => unknown;
  readonly cancelIdle: (handle: unknown) => void;
  readonly pendingIdleCount: () => number;
  readonly runIdle: () => void;
}

function createIdleHarness(): IdleHarness {
  let nextHandle = 1;
  const callbacks = new Map<number, IdleRequestCallback>();
  const requestIdle = vi.fn(
    (callback: IdleRequestCallback, _timeoutMs: number): number => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    }
  );
  const cancelIdle = vi.fn((handle: unknown) => {
    callbacks.delete(handle as number);
  });
  return {
    requestIdle,
    cancelIdle,
    pendingIdleCount: () => callbacks.size,
    runIdle: () => {
      const entry = callbacks.entries().next().value as
        | [number, IdleRequestCallback]
        | undefined;
      if (!entry) return;
      callbacks.delete(entry[0]);
      entry[1]({
        didTimeout: false,
        timeRemaining: () => 8
      });
    }
  };
}

function createScheduler(options: {
  readonly idle?: IdleHarness;
  readonly capture?: (generation: number) => void;
  readonly requestIdle?: (
    callback: IdleRequestCallback,
    timeoutMs: number
  ) => unknown;
}) {
  const idle = options.idle ?? createIdleHarness();
  const capture = options.capture ?? vi.fn();
  return {
    capture,
    idle,
    scheduler: createOutlineIdleBaselineScheduler({
      quietMs: 150,
      idleTimeoutMs: 500,
      requestIdle: options.requestIdle ?? idle.requestIdle,
      cancelIdle: idle.cancelIdle,
      captureLatest: capture
    })
  };
}

describe("createOutlineIdleBaselineScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not queue or capture before a settled first paint", () => {
    vi.useFakeTimers();
    const { capture, idle, scheduler } = createScheduler({});

    scheduler.noteActivity(3);
    vi.advanceTimersByTime(650);

    expect(scheduler.pendingCount()).toBe(0);
    expect(idle.requestIdle).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("keeps one logical task through quiet time and one idle callback", () => {
    vi.useFakeTimers();
    const { capture, idle, scheduler } = createScheduler({});

    scheduler.afterSettledFirstPaint(4);
    expect(scheduler.pendingCount()).toBe(1);
    expect(idle.requestIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(149);
    expect(idle.requestIdle).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(scheduler.pendingCount()).toBe(1);
    expect(idle.requestIdle).toHaveBeenCalledOnce();
    expect(idle.requestIdle).toHaveBeenCalledWith(expect.any(Function), 500);
    expect(idle.pendingIdleCount()).toBe(1);

    idle.runIdle();
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(4);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("captures once at quiet expiry when the idle adapter runs synchronously", () => {
    vi.useFakeTimers();
    const capture = vi.fn();
    const requestIdle = vi.fn(
      (callback: IdleRequestCallback, _timeoutMs: number) => {
        callback({
          didTimeout: false,
          timeRemaining: () => 0
        });
        return null;
      }
    );
    const { scheduler } = createScheduler({ capture, requestIdle });

    scheduler.afterSettledFirstPaint(5);
    vi.advanceTimersByTime(150);
    vi.advanceTimersByTime(1_000);

    expect(requestIdle).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(5);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("cancels quiet and idle work and rearms only the latest generation", () => {
    vi.useFakeTimers();
    const { capture, idle, scheduler } = createScheduler({});

    scheduler.afterSettledFirstPaint(6);
    vi.advanceTimersByTime(100);
    scheduler.noteActivity(7);
    expect(scheduler.pendingCount()).toBe(1);

    vi.advanceTimersByTime(100);
    expect(idle.requestIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(idle.requestIdle).toHaveBeenCalledOnce();

    scheduler.noteActivity(8);
    expect(idle.cancelIdle).toHaveBeenCalledOnce();
    expect(idle.pendingIdleCount()).toBe(0);
    expect(scheduler.pendingCount()).toBe(1);

    vi.advanceTimersByTime(150);
    idle.runIdle();
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(8);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("stays within the 650ms quiet plus idle deadline after the latest rearm", () => {
    vi.useFakeTimers();
    const capture = vi.fn();
    let idleTimeout: ReturnType<typeof setTimeout> | null = null;
    const requestIdle = vi.fn(
      (callback: IdleRequestCallback, timeoutMs: number) => {
        idleTimeout = setTimeout(
          () =>
            callback({
              didTimeout: true,
              timeRemaining: () => 0
            }),
          timeoutMs
        );
        return idleTimeout;
      }
    );
    const cancelIdle = vi.fn((handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
    const scheduler = createOutlineIdleBaselineScheduler({
      quietMs: 150,
      idleTimeoutMs: 500,
      requestIdle,
      cancelIdle,
      captureLatest: capture
    });

    scheduler.afterSettledFirstPaint(8);
    vi.advanceTimersByTime(149);
    scheduler.noteActivity(9);
    vi.advanceTimersByTime(649);
    expect(capture).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(9);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("rearms one bounded task after same-generation activity follows an idle capture", () => {
    vi.useFakeTimers();
    const capture = vi.fn();
    const requestIdle = vi.fn(
      (callback: IdleRequestCallback, timeoutMs: number) =>
        setTimeout(
          () =>
            callback({
              didTimeout: true,
              timeRemaining: () => 0
            }),
          timeoutMs
        )
    );
    const scheduler = createOutlineIdleBaselineScheduler({
      quietMs: 150,
      idleTimeoutMs: 500,
      requestIdle,
      cancelIdle: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
      captureLatest: capture
    });

    scheduler.afterSettledFirstPaint(10);
    vi.advanceTimersByTime(650);
    expect(capture).toHaveBeenCalledOnce();

    scheduler.noteActivity(10);
    expect(scheduler.pendingCount()).toBe(1);
    vi.advanceTimersByTime(649);
    expect(capture).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);

    expect(requestIdle).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenLastCalledWith(10);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("rearms one bounded task after same-generation activity follows a synchronous capture", () => {
    vi.useFakeTimers();
    const capture = vi.fn();
    const requestIdle = vi.fn(
      (callback: IdleRequestCallback, timeoutMs: number) =>
        setTimeout(
          () =>
            callback({
              didTimeout: true,
              timeRemaining: () => 0
            }),
          timeoutMs
        )
    );
    const scheduler = createOutlineIdleBaselineScheduler({
      quietMs: 150,
      idleTimeoutMs: 500,
      requestIdle,
      cancelIdle: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
      captureLatest: capture
    });

    scheduler.completeFromSynchronousCapture(11);
    scheduler.noteActivity(11);
    expect(scheduler.pendingCount()).toBe(1);
    vi.advanceTimersByTime(649);
    expect(capture).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(requestIdle).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(11);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("suspends cancel-only during a pending insertion until its settled paint", () => {
    vi.useFakeTimers();
    const { capture, idle, scheduler } = createScheduler({});

    scheduler.afterSettledFirstPaint(10);
    vi.advanceTimersByTime(150);
    expect(idle.pendingIdleCount()).toBe(1);

    scheduler.suspendForPendingInsertion(11);
    scheduler.noteActivity(12);
    vi.advanceTimersByTime(2_000);

    expect(idle.cancelIdle).toHaveBeenCalledOnce();
    expect(idle.pendingIdleCount()).toBe(0);
    expect(scheduler.pendingCount()).toBe(0);
    expect(capture).not.toHaveBeenCalled();

    scheduler.afterSettledFirstPaint(10);
    expect(scheduler.pendingCount()).toBe(0);
    scheduler.afterSettledFirstPaint(12);
    expect(scheduler.pendingCount()).toBe(1);

    vi.advanceTimersByTime(150);
    idle.runIdle();
    expect(capture).toHaveBeenCalledWith(12);
  });

  it("synchronous capture cancels same-generation queued work and stale callbacks", () => {
    vi.useFakeTimers();
    const { capture, idle, scheduler } = createScheduler({});

    scheduler.afterSettledFirstPaint(13);
    vi.advanceTimersByTime(150);
    expect(idle.pendingIdleCount()).toBe(1);
    scheduler.completeFromSynchronousCapture(13);
    idle.runIdle();
    vi.advanceTimersByTime(1_000);

    expect(idle.cancelIdle).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("does not let an older synchronous capture cancel newer queued work", () => {
    vi.useFakeTimers();
    const { capture, idle, scheduler } = createScheduler({});

    scheduler.afterSettledFirstPaint(15);
    scheduler.completeFromSynchronousCapture(14);
    vi.advanceTimersByTime(150);
    idle.runIdle();

    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(15);
  });

  it("dispose cancels the one pending task and rejects every stale callback", () => {
    vi.useFakeTimers();
    const { capture, idle, scheduler } = createScheduler({});

    scheduler.afterSettledFirstPaint(16);
    vi.advanceTimersByTime(150);
    scheduler.dispose();
    idle.runIdle();
    vi.advanceTimersByTime(1_000);
    scheduler.afterSettledFirstPaint(17);
    scheduler.noteActivity(17);

    expect(idle.cancelIdle).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(scheduler.pendingCount()).toBe(0);
  });
});
