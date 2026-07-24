import { afterEach, describe, expect, it, vi } from "vitest";

import {
  markCaretPhase,
  markRowRender,
  markSplitPhase,
  resetRowRenderCounts,
  setNotesSplitLatencyProbeEnabled
} from "./notesSplitLatencyProbe";

function captureConsole(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return lines;
}

describe("notesSplitLatencyProbe", () => {
  afterEach(() => {
    setNotesSplitLatencyProbeEnabled(false);
    vi.restoreAllMocks();
  });

  it("emits one summary line spanning keydown to caret when enabled", () => {
    const lines = captureConsole();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 4));
    setNotesSplitLatencyProbeEnabled(true);

    markSplitPhase("node-1234abcd", "keydown"); // 4
    markSplitPhase("node-1234abcd", "barrier"); // 8
    markSplitPhase("node-1234abcd", "ipc-done"); // 12
    markSplitPhase("node-1234abcd", "settled"); // 16
    markSplitPhase("node-1234abcd", "caret"); // 20

    expect(lines).toHaveLength(1);
    const [summary] = lines;
    expect(summary).toContain("node-123");
    expect(summary).toContain("total=16.0ms");
    expect(summary).toContain("ipc-done=");
  });

  it("stays silent when disabled", () => {
    const lines = captureConsole();
    setNotesSplitLatencyProbeEnabled(false);

    markSplitPhase("node-5678", "keydown");
    markSplitPhase("node-5678", "caret");

    expect(lines).toHaveLength(0);
  });

  it("ignores phases for a split whose keydown was never marked", () => {
    const lines = captureConsole();
    setNotesSplitLatencyProbeEnabled(true);

    // A settle that arrives without a keydown (e.g. a non-optimistic split)
    // must not fabricate a partial record or crash.
    markSplitPhase("orphan", "ipc-done");
    markSplitPhase("orphan", "caret");

    expect(lines).toHaveLength(0);
  });

  it("keeps concurrent splits independent by id", () => {
    const lines = captureConsole();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 1));
    setNotesSplitLatencyProbeEnabled(true);

    markSplitPhase("a", "keydown"); // 1
    markSplitPhase("b", "keydown"); // 2
    markSplitPhase("a", "caret"); // 3 -> total 2
    markSplitPhase("b", "caret"); // 4 -> total 2

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("total=2.0ms");
    expect(lines[1]).toContain("total=2.0ms");
  });
});

describe("notesSplitLatencyProbe caret chain", () => {
  afterEach(() => {
    setNotesSplitLatencyProbeEnabled(false);
    vi.restoreAllMocks();
  });

  it("emits one summary line with rows spanning keydown to paint", () => {
    const lines = captureConsole();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 4));
    setNotesSplitLatencyProbeEnabled(true);

    markCaretPhase("node-1234abcd", "keydown", { visibleRows: 42 }); // 4
    markCaretPhase("node-1234abcd", "dom-focus"); // 8
    markCaretPhase("node-1234abcd", "sync"); // 12
    markCaretPhase("node-1234abcd", "paint"); // 16

    expect(lines).toHaveLength(1);
    const [summary] = lines;
    expect(summary).toContain("caret-latency node-123");
    expect(summary).toContain("rows=42");
    expect(summary).toContain("total=12.0ms");
    expect(summary).toContain("keydown->dom-focus=");
    expect(summary).toContain("sync->paint=");
  });

  it("ignores caret phases whose keydown was never marked", () => {
    const lines = captureConsole();
    setNotesSplitLatencyProbeEnabled(true);

    markCaretPhase("orphan", "dom-focus");
    markCaretPhase("orphan", "sync");
    markCaretPhase("orphan", "paint");

    expect(lines).toHaveLength(0);
  });

  it("restarts the record when the same node keydowns again", () => {
    const lines = captureConsole();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 1));
    setNotesSplitLatencyProbeEnabled(true);

    markCaretPhase("node-repeat", "keydown", { visibleRows: 1 }); // 1 (discarded)
    markCaretPhase("node-repeat", "dom-focus"); // 2 (discarded)
    markCaretPhase("node-repeat", "keydown", { visibleRows: 9 }); // 3 (fresh)
    markCaretPhase("node-repeat", "dom-focus"); // 4
    markCaretPhase("node-repeat", "sync"); // 5
    markCaretPhase("node-repeat", "paint"); // 6

    expect(lines).toHaveLength(1);
    const [summary] = lines;
    // total spans the second keydown (3) to paint (6), not the first (1).
    expect(summary).toContain("total=3.0ms");
    expect(summary).toContain("rows=9");
  });

  it("stays silent when disabled", () => {
    const lines = captureConsole();
    setNotesSplitLatencyProbeEnabled(false);

    markCaretPhase("node-off", "keydown", { visibleRows: 3 });
    markCaretPhase("node-off", "dom-focus");
    markCaretPhase("node-off", "sync");
    markCaretPhase("node-off", "paint");

    expect(lines).toHaveLength(0);
  });

  it("clears caret records when re-enabled", () => {
    const lines = captureConsole();
    setNotesSplitLatencyProbeEnabled(true);

    // Open a record, then a disable->enable cycle must drop it so the trailing
    // phases find nothing to close.
    markCaretPhase("node-clear", "keydown", { visibleRows: 5 });
    markCaretPhase("node-clear", "dom-focus");
    setNotesSplitLatencyProbeEnabled(false);
    setNotesSplitLatencyProbeEnabled(true);
    markCaretPhase("node-clear", "sync");
    markCaretPhase("node-clear", "paint");

    expect(lines).toHaveLength(0);
  });
});

describe("notesSplitLatencyProbe row-render counter", () => {
  afterEach(() => {
    setNotesSplitLatencyProbeEnabled(false);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("logs the accumulated per-pane count once the window closes", () => {
    vi.useFakeTimers();
    const lines = captureConsole();
    setNotesSplitLatencyProbeEnabled(true);

    markRowRender("pane-a");
    markRowRender("pane-a");
    markRowRender("pane-b");
    expect(lines).toHaveLength(0); // nothing until the 100ms window closes

    vi.advanceTimersByTime(100);

    expect(lines).toEqual([
      "notes row-renders pane=pane-a count=2",
      "notes row-renders pane=pane-b count=1"
    ]);

    // The window resets after flushing, so the next batch counts from zero.
    markRowRender("pane-a");
    vi.advanceTimersByTime(100);
    expect(lines.at(-1)).toBe("notes row-renders pane=pane-a count=1");
  });

  it("drains counts synchronously and cancels the pending flush", () => {
    vi.useFakeTimers();
    const lines = captureConsole();
    setNotesSplitLatencyProbeEnabled(true);

    markRowRender("pane-x");
    markRowRender("pane-x");

    expect(resetRowRenderCounts()).toEqual(new Map([["pane-x", 2]]));
    // The pending flush was cancelled, so no summary line ever lands.
    vi.advanceTimersByTime(100);
    expect(lines).toHaveLength(0);
  });

  it("stays silent when disabled", () => {
    vi.useFakeTimers();
    const lines = captureConsole();
    setNotesSplitLatencyProbeEnabled(false);

    markRowRender("pane-off");
    vi.advanceTimersByTime(100);

    expect(lines).toHaveLength(0);
    expect(resetRowRenderCounts().size).toBe(0);
  });
});
