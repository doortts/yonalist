import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNotesSplitInputBenchmarkCollector,
  installNotesSplitInputBenchmarkCollector,
  markSplitPhase,
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

  it("records provisional caret latency before settlement latency", () => {
    const lines = captureConsole();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 4));
    setNotesSplitLatencyProbeEnabled(true);

    markSplitPhase("optimistic", "keydown");
    markSplitPhase("optimistic", "provisional-caret");
    markSplitPhase("optimistic", "ipc-done");
    markSplitPhase("optimistic", "settled");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("ui=4.0ms");
    expect(lines[1]).toContain("persistence=8.0ms");
  });

  it("collects the queued-input benchmark timeline only at its isolated development origin", () => {
    let clock = 0;
    const collector = createNotesSplitInputBenchmarkCollector({
      enabled: true,
      now: () => (clock += 10)
    });

    const arrow = collector.begin("arrow", "primary");
    collector.mark(arrow, "visible");
    collector.mark(arrow, "pane-commit");
    collector.mark(arrow, "authoritative-settled");

    const enter = collector.begin("enter", "secondary");
    collector.mark(enter, "visible");
    collector.mark(enter, "pane-commit");
    collector.mark(enter, "authoritative-settled");

    const backspace = collector.begin("backspace", "primary");
    collector.mark(backspace, "visible");
    collector.mark(backspace, "visible");
    collector.mark(backspace, "keyup-stop");
    collector.mark(backspace, "pane-commit");
    collector.mark(backspace, "authoritative-settled");
    clock += 2_010;
    collector.mark(backspace, "undo-restored");
    collector.mark(backspace, "backlog-checked");

    expect(collector.snapshot()).toEqual([
      {
        operation: "arrow",
        paneId: "primary",
        phases: ["visible", "pane-commit", "authoritative-settled"],
        lateWorkAfterTwoSeconds: 0
      },
      {
        operation: "enter",
        paneId: "secondary",
        phases: ["visible", "pane-commit", "authoritative-settled"],
        lateWorkAfterTwoSeconds: 0
      },
      {
        operation: "backspace",
        paneId: "primary",
        phases: [
          "visible",
          "visible",
          "keyup-stop",
          "pane-commit",
          "authoritative-settled",
          "undo-restored",
          "backlog-checked"
        ],
        lateWorkAfterTwoSeconds: 1
      }
    ]);
  });

  it("does not retain benchmark samples when disabled", () => {
    const collector = createNotesSplitInputBenchmarkCollector({
      enabled: false,
      now: () => 0
    });

    const arrow = collector.begin("arrow", "primary");
    collector.mark(arrow, "visible");

    expect(collector.snapshot()).toEqual([]);
  });

  it("does not install controls outside the isolated benchmark port", () => {
    document.body.innerHTML = `
      <section data-notes-pane-id="primary">
        <div data-outline-id="fixture">
          <textarea class="notes-node-title"></textarea>
        </div>
      </section>
    `;
    const field = document.querySelector<HTMLTextAreaElement>(
      "textarea.notes-node-title"
    )!;

    installNotesSplitInputBenchmarkCollector();
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "b",
        code: "KeyB",
        metaKey: true,
        altKey: true,
        bubbles: true
      })
    );

    expect(document.getElementById("split-input-benchmark-result")).toBeNull();
  });
});
