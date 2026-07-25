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
    const release = vi.fn();
    const firstTarget = document.createElement("textarea");
    const secondTarget = document.createElement("textarea");
    const controller = createNotesHeldBackspaceRepeatController({
      repeat,
      release,
      initialDelayMs: 400,
      repeatIntervalMs: 50,
    });

    controller.handleKeyDown(3, false, firstTarget);
    controller.stop();
    firstTarget.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Backspace" }),
    );
    vi.advanceTimersByTime(1_000);
    expect(repeat).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    controller.handleKeyDown(4, false, secondTarget);
    vi.advanceTimersByTime(400);
    expect(repeat).toHaveBeenCalledOnce();
    controller.dispose();
    secondTarget.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Backspace" }),
    );
    vi.advanceTimersByTime(1_000);
    expect(repeat).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(controller.handleKeyDown(4, true)).toBe("native");
  });

  it("stops and releases once when the detached original target receives keyup", () => {
    vi.useFakeTimers();
    const repeat = vi.fn(() => true);
    const release = vi.fn();
    const target = document.createElement("textarea");
    document.body.append(target);
    const controller = createNotesHeldBackspaceRepeatController({
      repeat,
      release,
      initialDelayMs: 400,
      repeatIntervalMs: 50,
    });

    controller.handleKeyDown(5, false, target);
    vi.advanceTimersByTime(400);
    expect(repeat).toHaveBeenCalledOnce();
    target.remove();

    target.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Backspace", bubbles: true }),
    );
    vi.advanceTimersByTime(500);
    target.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Backspace", bubbles: true }),
    );

    expect(release).toHaveBeenCalledOnce();
    expect(repeat).toHaveBeenCalledOnce();
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
