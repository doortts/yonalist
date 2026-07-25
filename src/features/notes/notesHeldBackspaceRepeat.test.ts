import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNotesHeldBackspaceRepeatController,
  previousGraphemeBoundary,
} from "./notesHeldBackspaceRepeat";

describe("notesHeldBackspaceRepeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back after the initial delay and repeats recursively", () => {
    vi.useFakeTimers();
    const repeat = vi.fn(() => true);
    const controller = createNotesHeldBackspaceRepeatController({
      repeat,
      initialDelayMs: 400,
      repeatIntervalMs: 50,
    });

    expect(controller.handleKeyDown(1, false)).toBe("native");
    vi.advanceTimersByTime(399);
    expect(repeat).not.toHaveBeenCalled();
    vi.advanceTimersByTime(101);

    expect(repeat).toHaveBeenCalledTimes(3);
    expect(controller.handleKeyDown(1, true)).toBe("consume");
  });

  it("lets timely native repeats run and rearms the fallback", () => {
    vi.useFakeTimers();
    const repeat = vi.fn(() => true);
    const controller = createNotesHeldBackspaceRepeatController({
      repeat,
      initialDelayMs: 400,
      repeatIntervalMs: 50,
    });

    controller.handleKeyDown(2, false);
    vi.advanceTimersByTime(350);
    expect(controller.handleKeyDown(2, true)).toBe("native");
    vi.advanceTimersByTime(399);
    expect(repeat).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(repeat).toHaveBeenCalledOnce();
  });

  it("invalidates pending and recursive work when stopped or disposed", () => {
    vi.useFakeTimers();
    const repeat = vi.fn(() => true);
    const controller = createNotesHeldBackspaceRepeatController({
      repeat,
      initialDelayMs: 400,
      repeatIntervalMs: 50,
    });

    controller.handleKeyDown(3, false);
    controller.stop();
    vi.advanceTimersByTime(1_000);
    expect(repeat).not.toHaveBeenCalled();

    controller.handleKeyDown(4, false);
    vi.advanceTimersByTime(400);
    expect(repeat).toHaveBeenCalledOnce();
    controller.dispose();
    vi.advanceTimersByTime(1_000);
    expect(repeat).toHaveBeenCalledOnce();
    expect(controller.handleKeyDown(4, true)).toBe("native");
  });

  it("finds the previous extended grapheme boundary", () => {
    const value = `A${"👨‍👩‍👧‍👦"}e\u0301`;

    expect(previousGraphemeBoundary(value, value.length)).toBe(
      value.length - 2,
    );
    expect(previousGraphemeBoundary(value, value.length - 2)).toBe(1);
    expect(previousGraphemeBoundary(value, 1)).toBe(0);
  });
});
