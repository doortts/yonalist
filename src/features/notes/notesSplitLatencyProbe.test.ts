import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNotesSplitInputBenchmarkCollector,
  installNotesSplitInputBenchmarkCollector,
  markNotesSplitInputBenchmarkPaneCommit,
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
    collector.recordPaneCommit(arrow, "primary");
    collector.mark(arrow, "authoritative-settled");

    const enter = collector.begin("enter", "secondary");
    collector.mark(enter, "visible");
    collector.recordPaneCommit(enter, "secondary");
    collector.mark(enter, "authoritative-settled");

    const backspace = collector.begin("backspace", "primary");
    collector.mark(backspace, "visible");
    collector.mark(backspace, "visible");
    collector.mark(backspace, "keyup-stop");
    collector.recordPaneCommit(backspace, "primary");
    collector.mark(backspace, "authoritative-settled");
    clock += 2_010;
    collector.mark(backspace, "undo-restored");
    collector.completeBacklogWindow(backspace);
    collector.recordLateWork(backspace);

    expect(collector.snapshot()).toEqual([
      {
        operation: "arrow",
        paneId: "primary",
        phases: ["visible", "authoritative-settled"],
        lateWorkAfterTwoSeconds: 0,
        activePaneCommits: 1,
        inactivePaneCommits: 0,
        backlogWindowComplete: false
      },
      {
        operation: "enter",
        paneId: "secondary",
        phases: ["visible", "authoritative-settled"],
        lateWorkAfterTwoSeconds: 0,
        activePaneCommits: 1,
        inactivePaneCommits: 0,
        backlogWindowComplete: false
      },
      {
        operation: "backspace",
        paneId: "primary",
        phases: [
          "visible",
          "visible",
          "keyup-stop",
          "authoritative-settled",
          "undo-restored"
        ],
        lateWorkAfterTwoSeconds: 1,
        activePaneCommits: 1,
        inactivePaneCommits: 0,
        backlogWindowComplete: true
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
    secondary.focus();
    markSplitPhase("enter-split", "settled");
    markNotesSplitInputBenchmarkPaneCommit("primary");
    markNotesSplitInputBenchmarkPaneCommit("secondary");

    expect(benchmarkSamples()).toEqual([
      expect.objectContaining({
        operation: "enter",
        paneId: "primary",
        phases: expect.arrayContaining([
          "visible",
          "authoritative-settled"
        ]),
        activePaneCommits: 0,
        inactivePaneCommits: 0
      }),
      expect.objectContaining({ operation: "arrow", paneId: "secondary" })
    ]);
    dispose();
  });

  it("counts primary-origin commits separately in the active and inactive panes", () => {
    document.body.innerHTML = `
      <section data-notes-pane-id="primary"><div data-outline-id="primary"><textarea class="notes-node-title">Primary</textarea></div></section>
      <section data-notes-pane-id="secondary"><div data-outline-id="secondary"><textarea class="notes-node-title">Secondary</textarea></div></section>
    `;
    setNotesSplitLatencyProbeEnabled(true);
    const dispose = installNotesSplitInputBenchmarkCollector({
      origin: "http://127.0.0.1:1438",
      now: () => 0,
      scheduleBacklogCheck: () => {}
    });
    const primary = document.querySelector<HTMLTextAreaElement>('[data-notes-pane-id="primary"] textarea')!;
    press(primary, { key: "Enter" });
    markSplitPhase("split-both", "keydown");
    markNotesSplitInputBenchmarkPaneCommit("primary");
    markNotesSplitInputBenchmarkPaneCommit("secondary");

    expect(benchmarkSamples()).toEqual([
      expect.objectContaining({
        operation: "enter",
        paneId: "primary",
        activePaneCommits: 1,
        inactivePaneCommits: 1
      })
    ]);
    dispose();
  });

  it("expires a non-splitting Enter before the next split binds its own operation", () => {
    let expireFirstEnter: (() => void) | undefined;
    document.body.innerHTML = `<section data-notes-pane-id="primary"><div data-outline-id="primary"><textarea class="notes-node-title">Primary</textarea></div></section>`;
    setNotesSplitLatencyProbeEnabled(true);
    const dispose = installNotesSplitInputBenchmarkCollector({
      origin: "http://127.0.0.1:1438",
      now: () => 0,
      scheduleBacklogCheck: () => {},
      scheduleEnterCancellation: (callback) => {
        expireFirstEnter = callback;
      }
    });
    const field = document.querySelector<HTMLTextAreaElement>("textarea")!;
    press(field, { key: "Enter" });
    expireFirstEnter!();
    press(field, { key: "Enter" });
    markSplitPhase("second-split", "keydown");
    markNotesSplitInputBenchmarkPaneCommit("primary");

    const samples = benchmarkSamples() as { activePaneCommits: number }[];
    expect(samples.map((sample) => sample.activePaneCommits)).toEqual([0, 1]);
    dispose();
  });

  it("attributes Arrow and held Backspace commits in both panes to their origin operation", () => {
    document.body.innerHTML = `
      <section data-notes-pane-id="primary"><div data-outline-id="primary"><textarea class="notes-node-title">Primary</textarea></div></section>
      <section data-notes-pane-id="secondary"><div data-outline-id="secondary"><textarea class="notes-node-title">Secondary</textarea></div></section>
    `;
    const dispose = installNotesSplitInputBenchmarkCollector({
      origin: "http://127.0.0.1:1438",
      now: () => 0,
      scheduleBacklogCheck: () => {}
    });
    const primary = document.querySelector<HTMLTextAreaElement>('[data-notes-pane-id="primary"] textarea')!;
    press(primary, { key: "ArrowDown" });
    markNotesSplitInputBenchmarkPaneCommit("primary");
    markNotesSplitInputBenchmarkPaneCommit("secondary");
    press(primary, { key: "Backspace" });
    markNotesSplitInputBenchmarkPaneCommit("primary");
    markNotesSplitInputBenchmarkPaneCommit("secondary");

    expect(benchmarkSamples()).toEqual([
      expect.objectContaining({ operation: "arrow", activePaneCommits: 1, inactivePaneCommits: 1 }),
      expect.objectContaining({ operation: "backspace", activePaneCommits: 1, inactivePaneCommits: 1 })
    ]);
    dispose();
  });

  it("keeps one physical held-Backspace record through repeats, keyup, verified Undo, and real late work", () => {
    let clock = 0;
    let runBacklogCheck: (() => void) | undefined;
    document.body.innerHTML = `
      <section data-notes-pane-id="primary">
        <div data-outline-id="${PRIMARY_EMPTY_FIXTURE_ID}"><textarea class="notes-node-title"></textarea></div>
        <div data-outline-id="other"><textarea class="notes-node-title">Other</textarea></div>
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

    field.focus();
    press(field, { key: "Backspace" });
    press(field, { key: "Backspace", repeat: true });
    field.dispatchEvent(new Event("input", { bubbles: true }));
    release(field, { key: "Backspace" });
    clock = 2_010;
    runBacklogCheck!();
    const row = field.closest<HTMLElement>("[data-outline-id]")!;
    row.remove();
    const undoField = document.querySelector<HTMLTextAreaElement>('[data-outline-id="other"] textarea')!;
    press(undoField, { key: "z", code: "KeyZ", metaKey: true });
    undoField.value = "Changed";
    markNotesSplitInputBenchmarkPaneCommit("primary");
    const pane = document.querySelector('[data-notes-pane-id="primary"]')!;
    pane.insertBefore(row, pane.querySelector('[data-outline-id="other"]'));
    undoField.value = "Other";
    field.focus();
    markNotesSplitInputBenchmarkPaneCommit("primary");

    expect(benchmarkSamples()).toEqual([
      expect.objectContaining({
        operation: "backspace",
        phases: expect.arrayContaining(["keyup-stop", "undo-restored"]),
        lateWorkAfterTwoSeconds: 2,
        backlogWindowComplete: true
      })
    ]);
    dispose();
  });
});
