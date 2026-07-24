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
  "10000000-0000-4000-8000-000000000031";
const SPLIT_INPUT_BENCHMARK_ORIGIN = `http://127.0.0.1:${SPLIT_INPUT_BENCHMARK_PORT}`;

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

export type NotesSplitInputBenchmarkInstallOptions = {
  origin?: string;
  now?: () => number;
  scheduleBacklogCheck?: (callback: () => void) => void;
};

type BenchmarkPaneId = "primary" | "secondary";

type InstalledSplitInputBenchmarkCollector = {
  collector: NotesSplitInputBenchmarkCollector;
  enterOperationIds: string[];
  splitOperationIds: Map<string, string>;
  activeBackspaceByPane: Map<BenchmarkPaneId, string>;
  lastBackspaceByPane: Map<BenchmarkPaneId, string>;
  undoOperationIdsByPane: Map<BenchmarkPaneId, string>;
  paneCommitOperationIds: Set<string>;
};

function isSplitInputBenchmarkOrigin(origin = window.location.origin): boolean {
  const meta = import.meta as unknown as { env?: { DEV?: boolean } };
  return meta.env?.DEV === true && origin === SPLIT_INPUT_BENCHMARK_ORIGIN;
}

let installedSplitInputBenchmarkCollector: InstalledSplitInputBenchmarkCollector | null =
  null;

function markInstalledSplitPhase(splitId: string, phase: SplitLatencyPhase): void {
  const installed = installedSplitInputBenchmarkCollector;
  if (!installed) {
    return;
  }
  if (phase === "keydown") {
    const operationId = installed.enterOperationIds.shift();
    if (operationId) {
      installed.splitOperationIds.set(splitId, operationId);
    }
    return;
  }
  const operationId = installed.splitOperationIds.get(splitId);
  if (!operationId) {
    return;
  }
  if (phase === "provisional-caret") {
    installed.collector.mark(operationId, "visible");
  } else if (phase === "settled") {
    installed.collector.mark(operationId, "authoritative-settled");
  }
}

export function installNotesSplitInputBenchmarkCollector(
  options: NotesSplitInputBenchmarkInstallOptions = {}
): () => void {
  if (
    !isSplitInputBenchmarkOrigin(options.origin) ||
    installedSplitInputBenchmarkCollector
  ) {
    return () => {};
  }
  const collector = createNotesSplitInputBenchmarkCollector({
    enabled: true,
    now: options.now
  });
  const installed: InstalledSplitInputBenchmarkCollector = {
    collector,
    enterOperationIds: [],
    splitOperationIds: new Map(),
    activeBackspaceByPane: new Map(),
    lastBackspaceByPane: new Map(),
    undoOperationIdsByPane: new Map(),
    paneCommitOperationIds: new Set()
  };
  installedSplitInputBenchmarkCollector = installed;
  const focusOperationIdsByPane = new Map<BenchmarkPaneId, string>();
  const scheduleBacklogCheck =
    options.scheduleBacklogCheck ??
    ((callback: () => void) => window.setTimeout(callback, 2_000));

  const fieldContext = (
    target: EventTarget | null
  ): { field: HTMLTextAreaElement; paneId: BenchmarkPaneId } | null => {
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

  const focusPane = (paneId: BenchmarkPaneId, fixture = false) => {
    const selector = fixture
      ? `[data-notes-pane-id="${paneId}"] [data-outline-id="${SPLIT_INPUT_BACKSPACE_FIXTURE_ID}"] textarea.notes-node-title`
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

  const keydown = (event: KeyboardEvent) => {
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
      focusPane(event.shiftKey ? "secondary" : "primary", true);
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
    if (event.metaKey && event.key.toLowerCase() === "z") {
      const operationId = installed.lastBackspaceByPane.get(context.paneId);
      if (operationId) {
        installed.undoOperationIdsByPane.set(context.paneId, operationId);
      }
      return;
    }
    if (event.key === "Enter") {
      const operationId = collector.begin("enter", context.paneId);
      installed.enterOperationIds.push(operationId);
      focusOperationIdsByPane.set(context.paneId, operationId);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      focusOperationIdsByPane.set(
        context.paneId,
        collector.begin("arrow", context.paneId)
      );
      return;
    }
    if (event.key !== "Backspace") {
      return;
    }
    let operationId = installed.activeBackspaceByPane.get(context.paneId);
    if (!operationId || !event.repeat) {
      operationId = collector.begin("backspace", context.paneId);
      installed.activeBackspaceByPane.set(context.paneId, operationId);
    }
    focusOperationIdsByPane.set(context.paneId, operationId);
  };

  const focusin = (event: FocusEvent) => {
    const context = fieldContext(event.target);
    if (!context) {
      return;
    }
    const id = focusOperationIdsByPane.get(context.paneId);
    if (id) {
      collector.mark(id, "visible");
    }
  };

  const input = (event: Event) => {
    const context = fieldContext(event.target);
    const id = context && installed.activeBackspaceByPane.get(context.paneId);
    if (id) {
      collector.mark(id, "visible");
    }
  };

  const keyup = (event: KeyboardEvent) => {
    if (event.key !== "Backspace") {
      return;
    }
    const context = fieldContext(event.target);
    const id = context && installed.activeBackspaceByPane.get(context.paneId);
    if (id) {
      collector.mark(id, "keyup-stop");
      installed.activeBackspaceByPane.delete(context!.paneId);
      installed.lastBackspaceByPane.set(context!.paneId, id);
      scheduleBacklogCheck(() => collector.mark(id, "backlog-checked"));
    }
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const nodes = [...mutation.addedNodes, ...mutation.removedNodes, mutation.target];
      const element = nodes
        .map((node) =>
          node.nodeType === 1 ? (node as HTMLElement) : node.parentElement
        )
        .find((node): node is HTMLElement => node !== null);
      const pane = element?.closest<HTMLElement>("[data-notes-pane-id]") ??
        (mutation.target.nodeType === 1
          ? (mutation.target as HTMLElement).closest<HTMLElement>(
              "[data-notes-pane-id]"
            )
          : mutation.target.parentElement?.closest<HTMLElement>(
              "[data-notes-pane-id]"
            ));
      const paneId = pane?.dataset.notesPaneId;
      if (paneId !== "primary" && paneId !== "secondary") {
        continue;
      }
      const row = element?.closest<HTMLElement>("[data-outline-id]");
      const splitOperationId = row?.dataset.outlineId
        ? installed.splitOperationIds.get(row.dataset.outlineId)
        : undefined;
      const undoOperationId = installed.undoOperationIdsByPane.get(paneId);
      const operationId =
        splitOperationId ??
        undoOperationId ??
        installed.activeBackspaceByPane.get(paneId);
      if (!operationId) {
        continue;
      }
      if (!installed.paneCommitOperationIds.has(operationId)) {
        collector.mark(operationId, "pane-commit");
        installed.paneCommitOperationIds.add(operationId);
      }
      if (undoOperationId === operationId) {
        collector.mark(operationId, "undo-restored");
        installed.undoOperationIdsByPane.delete(paneId);
      }
    }
  });

  window.addEventListener("keydown", keydown, true);
  window.addEventListener("focusin", focusin, true);
  window.addEventListener("input", input, true);
  window.addEventListener("keyup", keyup, true);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return () => {
    window.removeEventListener("keydown", keydown, true);
    window.removeEventListener("focusin", focusin, true);
    window.removeEventListener("input", input, true);
    window.removeEventListener("keyup", keyup, true);
    observer.disconnect();
    if (installedSplitInputBenchmarkCollector === installed) {
      installedSplitInputBenchmarkCollector = null;
    }
  };
}

export function markSplitPhase(
  splitId: string,
  phase: SplitLatencyPhase
): void {
  markInstalledSplitPhase(splitId, phase);
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
