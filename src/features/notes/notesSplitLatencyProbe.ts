/**
 * Dev-only instrumentation for the Enter->caret split latency chain (plan Phase
 * L0). Each split records `performance.now()` at a handful of phases keyed by
 * the client-generated new node id; when the caret finally lands it logs one
 * console summary line with the per-phase spans and the end-to-end total. This
 * is how we confirm which span dominates (the plan expects the split IPC round
 * trip) before committing to the optimistic path in Phase L1.
 *
 * Disabled unless the build is DEV or `localStorage["notes:splitLatency"]` is
 * "1", so it is a genuine no-op in production and in ordinary test runs. Tests
 * force it on/off through {@link setNotesSplitLatencyProbeEnabled}.
 */

export type SplitLatencyPhase =
  | "keydown"
  | "barrier"
  | "provisional-caret"
  | "ipc-done"
  | "settled"
  | "rollback"
  | "recovered"
  | "caret";

const PHASE_ORDER: readonly SplitLatencyPhase[] = [
  "keydown",
  "barrier",
  "provisional-caret",
  "ipc-done",
  "settled",
  "rollback",
  "recovered",
  "caret"
];

function readDevFlag(): boolean {
  const meta = import.meta as unknown as { env?: { DEV?: boolean } };
  if (meta.env?.DEV === true) {
    return true;
  }
  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("notes:splitLatency") === "1"
    );
  } catch {
    return false;
  }
}

let enabled = readDevFlag();

export function setNotesSplitLatencyProbeEnabled(value: boolean): void {
  enabled = value;
  marks.clear();
}

// Records survive only from a split's keydown to its caret; a split that never
// reaches the caret (failure/rollback) leaves one small stale map. Dev-only, so
// no eviction policy — a session's abandoned splits are negligible.
// ponytail: unbounded map, add an LRU cap only if a dev session ever leaks.
const marks = new Map<string, Map<SplitLatencyPhase, number>>();

const SPLIT_INPUT_BENCHMARK_PORT = "1438";
const SPLIT_INPUT_BACKSPACE_FIXTURE_ID =
  "10000000-0000-4000-8000-00000000002d";

export type SplitInputBenchmarkOperation = "arrow" | "enter" | "backspace";
export type SplitInputBenchmarkPhase =
  | "visible"
  | "pane-commit"
  | "authoritative-settled"
  | "keyup-stop"
  | "undo-restored"
  | "backlog-checked";

type SplitInputBenchmarkRecord = {
  id: string;
  operation: SplitInputBenchmarkOperation;
  paneId: "primary" | "secondary";
  startedAt: number;
  phases: { phase: SplitInputBenchmarkPhase; at: number }[];
  lateWorkAfterTwoSeconds: number;
};

export type SplitInputBenchmarkSample = {
  operation: SplitInputBenchmarkOperation;
  paneId: "primary" | "secondary";
  phases: readonly SplitInputBenchmarkPhase[];
  lateWorkAfterTwoSeconds: number;
};

export type NotesSplitInputBenchmarkCollector = {
  begin: (
    operation: SplitInputBenchmarkOperation,
    paneId: "primary" | "secondary"
  ) => string;
  mark: (id: string, phase: SplitInputBenchmarkPhase) => void;
  markLatest: (
    paneId: "primary" | "secondary",
    phase: SplitInputBenchmarkPhase
  ) => void;
  reset: () => void;
  snapshot: () => readonly SplitInputBenchmarkSample[];
  result: () => string;
};

/**
 * Records benchmark-only input timelines. It deliberately owns no product
 * behavior: callers add phase marks while this collector only retains them for
 * the isolated development app on port 1438.
 */
export function createNotesSplitInputBenchmarkCollector(options: {
  enabled: boolean;
  now?: () => number;
}): NotesSplitInputBenchmarkCollector {
  const now = options.now ?? (() => performance.now());
  const records = new Map<string, SplitInputBenchmarkRecord>();
  let sequence = 0;

  const snapshot = (): readonly SplitInputBenchmarkSample[] =>
    [...records.values()].map((record) => ({
      operation: record.operation,
      paneId: record.paneId,
      phases: record.phases.map(({ phase }) => phase),
      lateWorkAfterTwoSeconds: record.lateWorkAfterTwoSeconds
    }));
  const mark = (id: string, phase: SplitInputBenchmarkPhase): void => {
    if (!options.enabled) {
      return;
    }
    const record = records.get(id);
    if (!record) {
      return;
    }
    const at = now();
    record.phases.push({ phase, at });
    if (phase !== "backlog-checked" && at - record.startedAt > 2_000) {
      record.lateWorkAfterTwoSeconds += 1;
    }
  };

  return {
    begin(operation, paneId) {
      const id = `split-input-${sequence++}`;
      if (options.enabled) {
        records.set(id, {
          id,
          operation,
          paneId,
          startedAt: now(),
          phases: [],
          lateWorkAfterTwoSeconds: 0
        });
      }
      return id;
    },
    mark,
    reset() {
      records.clear();
      sequence = 0;
    },
    markLatest(paneId, phase) {
      const id = [...records.values()]
        .reverse()
        .find((record) => record.paneId === paneId)?.id;
      if (id) {
        mark(id, phase);
      }
    },
    snapshot,
    result() {
      const samples = snapshot();
      return JSON.stringify(
        [...records.values()].map((record, index) => ({
          ...samples[index],
          elapsedMs: record.phases.map(({ phase, at }) => ({
            phase,
            elapsedMs: at - record.startedAt
          }))
        })),
        null,
        2
      );
    }
  };
}

function isSplitInputBenchmarkOrigin(): boolean {
  const meta = import.meta as unknown as { env?: { DEV?: boolean } };
  return meta.env?.DEV === true && window.location.port === SPLIT_INPUT_BENCHMARK_PORT;
}

let installedSplitInputBenchmarkCollector: NotesSplitInputBenchmarkCollector | null =
  null;

/** No-op unless the dedicated development benchmark origin is active. */
export function markNotesSplitInputBenchmarkPhase(
  paneId: "primary" | "secondary",
  phase: SplitInputBenchmarkPhase
): void {
  if (!installedSplitInputBenchmarkCollector) {
    return;
  }
  installedSplitInputBenchmarkCollector.markLatest(paneId, phase);
}

export function installNotesSplitInputBenchmarkCollector(): void {
  if (!isSplitInputBenchmarkOrigin() || installedSplitInputBenchmarkCollector) {
    return;
  }
  const collector = createNotesSplitInputBenchmarkCollector({ enabled: true });
  installedSplitInputBenchmarkCollector = collector;
  const pendingByPane = new Map<"primary" | "secondary", string>();

  const fieldContext = (
    target: EventTarget | null
  ): { field: HTMLTextAreaElement; paneId: "primary" | "secondary" } | null => {
    const field = target instanceof Element
      ? target.closest<HTMLTextAreaElement>("textarea.notes-node-title")
      : null;
    const row = field?.closest<HTMLElement>("[data-outline-id]");
    const pane = field?.closest<HTMLElement>("[data-notes-pane-id]");
    const paneId = pane?.dataset.notesPaneId;
    return field && row && (paneId === "primary" || paneId === "secondary")
      ? { field, paneId }
      : null;
  };

  const focusPane = (paneId: "primary" | "secondary", fixture = false) => {
    const selector = fixture
      ? `[data-outline-id="${SPLIT_INPUT_BACKSPACE_FIXTURE_ID}"] textarea.notes-node-title`
      : `[data-notes-pane-id="${paneId}"] textarea.notes-node-title`;
    const field = document.querySelector<HTMLTextAreaElement>(selector);
    if (!field) {
      return;
    }
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  };

  const show = () => {
    const output = document.createElement("textarea");
    output.id = "split-input-benchmark-result";
    output.readOnly = true;
    output.setAttribute("aria-label", "Split input benchmark result");
    output.style.cssText = [
      "position:fixed",
      "inset:16px",
      "z-index:2147483647",
      "font:14px ui-monospace,monospace"
    ].join(";");
    output.value = collector.result();
    document.getElementById(output.id)?.remove();
    document.body.append(output);
    output.focus();
    output.select();
  };

  window.addEventListener("keydown", (event) => {
    if (event.metaKey && event.altKey && event.code === "Digit1") {
      event.preventDefault();
      focusPane("primary");
      return;
    }
    if (event.metaKey && event.altKey && event.code === "Digit2") {
      event.preventDefault();
      focusPane("secondary");
      return;
    }
    if (event.metaKey && event.altKey && event.code === "Digit3") {
      event.preventDefault();
      focusPane("primary", true);
      return;
    }
    if (event.metaKey && event.altKey && event.code === "KeyR") {
      event.preventDefault();
      collector.reset();
      document.getElementById("split-input-benchmark-result")?.remove();
      return;
    }
    if (event.metaKey && event.altKey && event.code === "KeyB") {
      event.preventDefault();
      show();
      return;
    }
    const context = fieldContext(event.target);
    if (!context) {
      return;
    }
    const operation = event.key === "Enter"
      ? "enter"
      : event.key === "Backspace"
        ? "backspace"
        : event.key === "ArrowUp" || event.key === "ArrowDown"
          ? "arrow"
          : null;
    if (!operation) {
      return;
    }
    pendingByPane.set(context.paneId, collector.begin(operation, context.paneId));
  }, true);

  window.addEventListener("focusin", (event) => {
    const context = fieldContext(event.target);
    if (!context) {
      return;
    }
    const id = pendingByPane.get(context.paneId);
    if (id) {
      collector.mark(id, "visible");
    }
  }, true);

  window.addEventListener("input", (event) => {
    const context = fieldContext(event.target);
    const id = context && pendingByPane.get(context.paneId);
    if (id) {
      collector.mark(id, "visible");
    }
  }, true);

  window.addEventListener("keyup", (event) => {
    if (event.key !== "Backspace") {
      return;
    }
    const context = fieldContext(event.target);
    const id = context && pendingByPane.get(context.paneId);
    if (id) {
      collector.mark(id, "keyup-stop");
      window.setTimeout(() => collector.mark(id, "backlog-checked"), 2_000);
    }
  }, true);
}

export function markSplitPhase(
  splitId: string,
  phase: SplitLatencyPhase
): void {
  if (!enabled) {
    return;
  }
  let byPhase = marks.get(splitId);
  if (!byPhase) {
    // Only a keydown opens a record: a settle/caret that arrives without one
    // (a non-optimistic or already-summarized split) is ignored, never faked.
    if (phase !== "keydown") {
      return;
    }
    byPhase = new Map();
    marks.set(splitId, byPhase);
  }
  byPhase.set(phase, performance.now());
  if (phase === "provisional-caret") {
    const start = byPhase.get("keydown");
    const end = byPhase.get("provisional-caret");
    if (start !== undefined && end !== undefined) {
      console.log(
        `notes split-latency ${splitId.slice(0, 8)} ui=${(end - start).toFixed(1)}ms`
      );
    }
    return;
  }
  if (
    phase === "settled" &&
    byPhase.has("provisional-caret")
  ) {
    const start = byPhase.get("keydown")!;
    const provisional = byPhase.get("provisional-caret")!;
    const end = byPhase.get("settled")!;
    console.log(
      `notes split-latency ${splitId.slice(0, 8)} persistence=${(end - provisional).toFixed(1)}ms total=${(end - start).toFixed(1)}ms`
    );
    marks.delete(splitId);
    return;
  }
  if (phase === "rollback" || phase === "recovered") {
    logSummary(splitId, byPhase, phase);
    marks.delete(splitId);
    return;
  }
  if (phase === "caret") {
    logSummary(splitId, byPhase);
    marks.delete(splitId);
  }
}

function logSummary(
  splitId: string,
  byPhase: Map<SplitLatencyPhase, number>,
  terminalPhase: SplitLatencyPhase = "caret"
): void {
  const start = byPhase.get("keydown");
  const end = byPhase.get(terminalPhase);
  if (start === undefined || end === undefined) {
    return;
  }
  const spans: string[] = [];
  let previousTime = start;
  let previousName: SplitLatencyPhase = "keydown";
  for (const phase of PHASE_ORDER.slice(1)) {
    const time = byPhase.get(phase);
    if (time === undefined) {
      continue;
    }
    spans.push(`${previousName}->${phase}=${(time - previousTime).toFixed(1)}ms`);
    previousTime = time;
    previousName = phase;
  }
  console.log(
    `notes split-latency ${splitId.slice(0, 8)} total=${(end - start).toFixed(1)}ms ${spans.join(" ")}`
  );
}
