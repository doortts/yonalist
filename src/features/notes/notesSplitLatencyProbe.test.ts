import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNotesSplitInputBenchmarkCollector,
  installNotesSplitInputBenchmarkCollector,
  markSplitPhase,
  setNotesSplitLatencyProbeEnabled
} from "./notesSplitLatencyProbe";

const PRIMARY_EMPTY_FIXTURE_ID = "10000000-0000-4000-8000-000000000031";

function press(target: EventTarget, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
}

function release(target: EventTarget, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, ...init }));
}

function benchmarkSamples(): unknown[] {
  press(window, { code: "KeyB", metaKey: true, altKey: true });
  return JSON.parse(
    document.querySelector<HTMLTextAreaElement>("#split-input-benchmark-result")!
      .value
  ) as unknown[];
}

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

  it("installs controls only at the exact benchmark origin and focuses the last empty fixture in either pane", () => {
    document.body.innerHTML = `
      <section data-notes-pane-id="primary">
        <div data-outline-id="primary"><textarea class="notes-node-title">Primary</textarea></div>
        <div data-outline-id="${PRIMARY_EMPTY_FIXTURE_ID}"><textarea class="notes-node-title"></textarea></div>
      </section>
      <section data-notes-pane-id="secondary">
        <div data-outline-id="secondary"><textarea class="notes-node-title">Secondary</textarea></div>
        <div data-outline-id="${PRIMARY_EMPTY_FIXTURE_ID}"><textarea class="notes-node-title"></textarea></div>
      </section>
    `;
    const noOp = installNotesSplitInputBenchmarkCollector({
      origin: "http://localhost:1438",
      now: () => 0,
      scheduleBacklogCheck: () => {}
    });
    press(window, { code: "KeyB", metaKey: true, altKey: true });
    expect(document.getElementById("split-input-benchmark-result")).toBeNull();
    noOp();

    const dispose = installNotesSplitInputBenchmarkCollector({
      origin: "http://127.0.0.1:1438",
      now: () => 0,
      scheduleBacklogCheck: () => {}
    });
    press(window, { code: "Digit3", metaKey: true, altKey: true });
    expect(document.activeElement).toBe(
      document.querySelector('[data-notes-pane-id="primary"] [data-outline-id="10000000-0000-4000-8000-000000000031"] textarea')
    );
    press(window, { code: "Digit3", metaKey: true, altKey: true, shiftKey: true });
    expect(document.activeElement).toBe(
      document.querySelector('[data-notes-pane-id="secondary"] [data-outline-id="10000000-0000-4000-8000-000000000031"] textarea')
    );
    dispose();
  });

  it("binds physical Enter visibility, pane commit, and settlement to its split after a later operation starts", async () => {
    let clock = 0;
    document.body.innerHTML = `
      <section data-notes-pane-id="primary">
        <div data-outline-id="primary"><textarea class="notes-node-title">Primary</textarea></div>
      </section>
      <section data-notes-pane-id="secondary">
        <div data-outline-id="secondary"><textarea class="notes-node-title">Secondary</textarea></div>
      </section>
    `;
    setNotesSplitLatencyProbeEnabled(true);
    const dispose = installNotesSplitInputBenchmarkCollector({
      origin: "http://127.0.0.1:1438",
      now: () => (clock += 10),
      scheduleBacklogCheck: () => {}
    });
    const primary = document.querySelector<HTMLTextAreaElement>(
      '[data-notes-pane-id="primary"] textarea'
    )!;
    const secondary = document.querySelector<HTMLTextAreaElement>(
      '[data-notes-pane-id="secondary"] textarea'
    )!;

    press(primary, { key: "Enter" });
    markSplitPhase("enter-split", "keydown");
    markSplitPhase("enter-split", "provisional-caret");
    press(secondary, { key: "ArrowDown" });
    markSplitPhase("enter-split", "settled");
    const row = document.createElement("div");
    row.dataset.outlineId = "enter-split";
    document.querySelector('[data-notes-pane-id="primary"]')!.append(row);
    await new Promise((resolve) => window.setTimeout(resolve));

    expect(benchmarkSamples()).toEqual([
      expect.objectContaining({
        operation: "enter",
        paneId: "primary",
        phases: expect.arrayContaining([
          "visible",
          "pane-commit",
          "authoritative-settled"
        ])
      }),
      expect.objectContaining({ operation: "arrow", paneId: "secondary" })
    ]);
    dispose();
  });

  it("keeps one physical held-Backspace record through repeats, keyup, Undo, and the two-second backlog check", async () => {
    let clock = 0;
    let runBacklogCheck: (() => void) | undefined;
    document.body.innerHTML = `
      <section data-notes-pane-id="primary">
        <div data-outline-id="${PRIMARY_EMPTY_FIXTURE_ID}"><textarea class="notes-node-title"></textarea></div>
      </section>
    `;
    const dispose = installNotesSplitInputBenchmarkCollector({
      origin: "http://127.0.0.1:1438",
      now: () => clock,
      scheduleBacklogCheck: (callback) => {
        runBacklogCheck = callback;
      }
    });
    const field = document.querySelector<HTMLTextAreaElement>("textarea")!;

    press(field, { key: "Backspace" });
    press(field, { key: "Backspace", repeat: true });
    release(field, { key: "Backspace" });
    clock = 2_010;
    runBacklogCheck!();
    press(field, { key: "z", code: "KeyZ", metaKey: true });
    document.querySelector('[data-notes-pane-id="primary"]')!.append(document.createElement("div"));
    await new Promise((resolve) => window.setTimeout(resolve));

    expect(benchmarkSamples()).toEqual([
      expect.objectContaining({
        operation: "backspace",
        phases: expect.arrayContaining(["keyup-stop", "undo-restored", "backlog-checked"]),
        lateWorkAfterTwoSeconds: 2
      })
    ]);
    dispose();
  });
});
