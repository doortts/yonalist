import { createElement, Profiler, type ReactNode } from "react";

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
  | "authoritative-settled"
  | "keyup-stop"
  | "undo-restored";

type SplitInputBenchmarkRecord = {
  id: string;
  operation: SplitInputBenchmarkOperation;
  paneId: "primary" | "secondary";
  startedAt: number;
  phases: { phase: SplitInputBenchmarkPhase; at: number }[];
  lateWorkAfterTwoSeconds: number;
  activePaneCommits: number;
  inactivePaneCommits: number;
  backlogWindowComplete: boolean;
  backlogAtTwoSeconds: boolean | null;
  invalidOverlap: boolean;
};

export type SplitInputBenchmarkSample = {
  operation: SplitInputBenchmarkOperation;
  paneId: "primary" | "secondary";
  phases: readonly SplitInputBenchmarkPhase[];
  lateWorkAfterTwoSeconds: number;
  activePaneCommits: number;
  inactivePaneCommits: number;
  backlogWindowComplete: boolean;
  backlogAtTwoSeconds: boolean | null;
  invalidOverlap: boolean;
};

export type NotesSplitInputBenchmarkCollector = {
  begin: (
    operation: SplitInputBenchmarkOperation,
    paneId: "primary" | "secondary"
  ) => string;
  mark: (id: string, phase: SplitInputBenchmarkPhase) => void;
  recordPaneCommit: (id: string, paneId: "primary" | "secondary") => void;
  recordLateWork: (id: string) => void;
  completeBacklogWindow: (id: string, backlogAtTwoSeconds: boolean) => void;
  invalidateOverlap: (id: string) => void;
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
      lateWorkAfterTwoSeconds: record.lateWorkAfterTwoSeconds,
      activePaneCommits: record.activePaneCommits,
      inactivePaneCommits: record.inactivePaneCommits,
      backlogWindowComplete: record.backlogWindowComplete,
      backlogAtTwoSeconds: record.backlogAtTwoSeconds,
      invalidOverlap: record.invalidOverlap
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
          lateWorkAfterTwoSeconds: 0,
          activePaneCommits: 0,
          inactivePaneCommits: 0,
          backlogWindowComplete: false,
          backlogAtTwoSeconds: null,
          invalidOverlap: false
        });
      }
      return id;
    },
    mark,
    recordPaneCommit(id, paneId) {
      const record = records.get(id);
      if (!record) return;
      if (record.paneId === paneId) record.activePaneCommits += 1;
      else record.inactivePaneCommits += 1;
    },
    recordLateWork(id) {
      const record = records.get(id);
      if (record) record.lateWorkAfterTwoSeconds += 1;
    },
    completeBacklogWindow(id, backlogAtTwoSeconds) {
      const record = records.get(id);
      if (record) {
        record.backlogWindowComplete = true;
        record.backlogAtTwoSeconds = backlogAtTwoSeconds;
      }
    },
    invalidateOverlap(id) {
      const record = records.get(id);
      if (record) record.invalidOverlap = true;
    },
    reset() {
      records.clear();
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
  scheduleEnterCancellation?: (callback: () => void) => void;
  scheduleOperationClose?: (callback: () => void) => void;
};

type BenchmarkPaneId = "primary" | "secondary";

type InstalledSplitInputBenchmarkCollector = {
  collector: NotesSplitInputBenchmarkCollector;
  enterOperationIds: string[];
  splitOperationIds: Map<string, string>;
  operationPanes: Map<string, BenchmarkPaneId>;
  operationKinds: Map<string, SplitInputBenchmarkOperation>;
  activeBackspaceByPane: Map<BenchmarkPaneId, string>;
  lastBackspaceByPane: Map<BenchmarkPaneId, string>;
  backspaceSnapshotsByPane: Map<BenchmarkPaneId, string>;
  undoSnapshotsByPane: Map<BenchmarkPaneId, { id: string; snapshot: string }>;
  backspaceObservationByPane: Map<BenchmarkPaneId, string>;
  backspacePendingCounts: Map<string, number>;
  backspaceCommittedCounts: Map<string, number>;
  keyupBackspaceOperationIds: Set<string>;
  terminalBackspaceOperationIds: Set<string>;
  overdueBackspaceOperationIds: Set<string>;
  activeOperationId: string | null;
  visibleOperationIds: Set<string>;
  generation: number;
  scheduleClose: (id: string) => void;
  finishBackspaceOperation: (id: string) => void;
};

function isSplitInputBenchmarkOrigin(origin = window.location.origin): boolean {
  const meta = import.meta as unknown as { env?: { DEV?: boolean } };
  return meta.env?.DEV === true && origin === SPLIT_INPUT_BENCHMARK_ORIGIN;
}

export function configureNotesSplitInputBenchmarkVault(
  storage: Pick<Storage, "getItem" | "setItem">,
  origin = window.location.origin,
  search = window.location.search
): boolean {
  if (!isSplitInputBenchmarkOrigin(origin)) return false;
  const vaultFolder = new URLSearchParams(search).get(
    "splitInputBenchmarkVault"
  );
  if (!vaultFolder?.startsWith("/tmp/")) return false;
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(storage.getItem("yonalist.settings.v1") ?? "{}") as Record<
      string,
      unknown
    >;
  } catch {
    current = {};
  }
  storage.setItem(
    "yonalist.settings.v1",
    JSON.stringify({ ...current, vaultFolder })
  );
  return true;
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
    if (!installed.visibleOperationIds.has(operationId)) {
      installed.visibleOperationIds.add(operationId);
      installed.collector.mark(operationId, "visible");
    }
  } else if (phase === "settled") {
    installed.collector.mark(operationId, "authoritative-settled");
    installed.scheduleClose(operationId);
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
    operationPanes: new Map(),
    operationKinds: new Map(),
    activeBackspaceByPane: new Map(),
    lastBackspaceByPane: new Map(),
    backspaceSnapshotsByPane: new Map(),
    undoSnapshotsByPane: new Map(),
    backspaceObservationByPane: new Map(),
    backspacePendingCounts: new Map(),
    backspaceCommittedCounts: new Map(),
    keyupBackspaceOperationIds: new Set(),
    terminalBackspaceOperationIds: new Set(),
    overdueBackspaceOperationIds: new Set(),
    activeOperationId: null,
    visibleOperationIds: new Set(),
    generation: 0,
    scheduleClose: () => {},
    finishBackspaceOperation: () => {}
  };
  installedSplitInputBenchmarkCollector = installed;
  const focusOperationIdsByPane = new Map<BenchmarkPaneId, string>();
  const scheduleBacklogCheck =
    options.scheduleBacklogCheck ??
    ((callback: () => void) => window.setTimeout(callback, 2_000));
  const scheduleEnterCancellation =
    options.scheduleEnterCancellation ??
    ((callback: () => void) => window.setTimeout(callback, 0));
  const scheduleOperationClose =
    options.scheduleOperationClose ??
    ((callback: () => void) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(callback)));
  installed.scheduleClose = (operationId) => {
    const generation = installed.generation;
    scheduleOperationClose(() => {
      if (
        installed.generation === generation &&
        installed.activeOperationId === operationId
      ) {
        installed.activeOperationId = null;
      }
    });
  };
  installed.finishBackspaceOperation = (operationId) => {
    if (installed.terminalBackspaceOperationIds.has(operationId)) return;
    installed.terminalBackspaceOperationIds.add(operationId);
    if ((installed.backspaceCommittedCounts.get(operationId) ?? 0) > 0) {
      collector.mark(operationId, "authoritative-settled");
    }
    if (installed.overdueBackspaceOperationIds.delete(operationId)) {
      collector.recordLateWork(operationId);
    }
    installed.scheduleClose(operationId);
  };

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

  const paneSnapshot = (paneId: BenchmarkPaneId) =>
    JSON.stringify({
      rows: [...document.querySelectorAll<HTMLElement>(
        `[data-notes-pane-id="${paneId}"] [data-outline-id]`
      )].map((row) => ({
        id: row.dataset.outlineId,
        title: row.querySelector<HTMLTextAreaElement>("textarea.notes-node-title")?.value ?? "",
        note: row.querySelector<HTMLTextAreaElement>("textarea.notes-node-note")?.value ?? ""
      })),
      focus: document.activeElement instanceof HTMLTextAreaElement
        ? {
            id: document.activeElement.closest<HTMLElement>("[data-outline-id]")?.dataset.outlineId,
            selectionStart: document.activeElement.selectionStart,
            selectionEnd: document.activeElement.selectionEnd
          }
        : null
    });

  const reset = () => {
    installed.generation += 1;
    collector.reset();
    installed.enterOperationIds.length = 0;
    installed.splitOperationIds.clear();
    installed.operationPanes.clear();
    installed.operationKinds.clear();
    installed.activeBackspaceByPane.clear();
    installed.lastBackspaceByPane.clear();
    installed.backspaceSnapshotsByPane.clear();
    installed.undoSnapshotsByPane.clear();
    installed.backspaceObservationByPane.clear();
    installed.backspacePendingCounts.clear();
    installed.backspaceCommittedCounts.clear();
    installed.keyupBackspaceOperationIds.clear();
    installed.terminalBackspaceOperationIds.clear();
    installed.overdueBackspaceOperationIds.clear();
    installed.visibleOperationIds.clear();
    installed.activeOperationId = null;
    focusOperationIdsByPane.clear();
  };
  const activateOperation = (
    operationId: string,
    paneId: BenchmarkPaneId,
    operation: SplitInputBenchmarkOperation
  ) => {
    const previousOperationId = installed.activeOperationId;
    if (previousOperationId && previousOperationId !== operationId) {
      collector.invalidateOverlap(previousOperationId);
      collector.invalidateOverlap(operationId);
    }
    installed.operationPanes.set(operationId, paneId);
    installed.operationKinds.set(operationId, operation);
    installed.activeOperationId = operationId;
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
      reset();
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
        installed.undoSnapshotsByPane.set(context.paneId, {
          id: operationId,
          snapshot: installed.backspaceSnapshotsByPane.get(context.paneId) ?? ""
        });
        if (installed.activeOperationId === operationId) {
          installed.activeOperationId = null;
        }
      }
      return;
    }
    if (event.key === "Enter") {
      const operationId = collector.begin("enter", context.paneId);
      activateOperation(operationId, context.paneId, "enter");
      installed.enterOperationIds.push(operationId);
      const generation = installed.generation;
      scheduleEnterCancellation(() => {
        if (installed.generation !== generation) return;
        const index = installed.enterOperationIds.indexOf(operationId);
        if (index >= 0) {
          installed.enterOperationIds.splice(index, 1);
          if (installed.activeOperationId === operationId) {
            installed.activeOperationId = null;
          }
          focusOperationIdsByPane.clear();
        }
      });
      focusOperationIdsByPane.set(context.paneId, operationId);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const operationId = collector.begin("arrow", context.paneId);
      activateOperation(operationId, context.paneId, "arrow");
      focusOperationIdsByPane.set(context.paneId, operationId);
      return;
    }
    if (event.key !== "Backspace") {
      return;
    }
    let operationId = installed.activeBackspaceByPane.get(context.paneId);
    if (!operationId || !event.repeat) {
      operationId = collector.begin("backspace", context.paneId);
      activateOperation(operationId, context.paneId, "backspace");
      installed.activeBackspaceByPane.set(context.paneId, operationId);
      installed.backspaceSnapshotsByPane.set(context.paneId, paneSnapshot(context.paneId));
    }
    focusOperationIdsByPane.set(context.paneId, operationId);
  };

  const focusin = (event: FocusEvent) => {
    const context = fieldContext(event.target);
    if (!context) {
      return;
    }
    const id = focusOperationIdsByPane.get(context.paneId);
    if (id && !installed.visibleOperationIds.has(id)) {
      installed.visibleOperationIds.add(id);
      collector.mark(id, "visible");
      if (installed.operationKinds.get(id) === "arrow") {
        installed.scheduleClose(id);
      }
    }
    focusOperationIdsByPane.delete(context.paneId);
  };

  const input = (event: Event) => {
    const context = fieldContext(event.target);
    const id = context && installed.activeBackspaceByPane.get(context.paneId);
    if (id && !installed.visibleOperationIds.has(id)) {
      installed.visibleOperationIds.add(id);
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
      installed.backspaceObservationByPane.set(context!.paneId, id);
      installed.keyupBackspaceOperationIds.add(id);
      if ((installed.backspacePendingCounts.get(id) ?? 0) === 0) {
        installed.finishBackspaceOperation(id);
      }
      const generation = installed.generation;
      scheduleBacklogCheck(() => {
        if (installed.generation !== generation) return;
        const terminal = installed.terminalBackspaceOperationIds.has(id);
        collector.completeBacklogWindow(id, !terminal);
        if (terminal) {
          installed.backspaceObservationByPane.delete(context!.paneId);
        } else {
          installed.overdueBackspaceOperationIds.add(id);
        }
      });
    }
  };

  window.addEventListener("keydown", keydown, true);
  window.addEventListener("focusin", focusin, true);
  window.addEventListener("input", input, true);
  window.addEventListener("keyup", keyup, true);
  return () => {
    window.removeEventListener("keydown", keydown, true);
    window.removeEventListener("focusin", focusin, true);
    window.removeEventListener("input", input, true);
    window.removeEventListener("keyup", keyup, true);
    if (installedSplitInputBenchmarkCollector === installed) {
      installedSplitInputBenchmarkCollector = null;
    }
  };
}

/** Called from the dev-only React Profiler boundary around each real pane. */
export function markNotesSplitInputBenchmarkPaneCommit(
  paneId: BenchmarkPaneId
): void {
  const installed = installedSplitInputBenchmarkCollector;
  if (!installed) return;
  const operationId = installed.activeOperationId;
  if (operationId) {
    installed.collector.recordPaneCommit(operationId, paneId);
  }
  const undo = installed.undoSnapshotsByPane.get(paneId);
  if (!undo) return;
  const snapshot = JSON.stringify({
    rows: [...document.querySelectorAll<HTMLElement>(
      `[data-notes-pane-id="${paneId}"] [data-outline-id]`
    )].map((row) => ({
      id: row.dataset.outlineId,
      title: row.querySelector<HTMLTextAreaElement>("textarea.notes-node-title")?.value ?? "",
      note: row.querySelector<HTMLTextAreaElement>("textarea.notes-node-note")?.value ?? ""
    })),
    focus: document.activeElement instanceof HTMLTextAreaElement
      ? {
          id: document.activeElement.closest<HTMLElement>("[data-outline-id]")?.dataset.outlineId,
          selectionStart: document.activeElement.selectionStart,
          selectionEnd: document.activeElement.selectionEnd
        }
      : null
  });
  if (snapshot === undo.snapshot) {
    installed.collector.mark(undo.id, "undo-restored");
    installed.undoSnapshotsByPane.delete(paneId);
  }
}

export function NotesSplitInputBenchmarkProfiler({
  paneId,
  children
}: {
  readonly paneId: BenchmarkPaneId;
  readonly children?: ReactNode;
}) {
  return createElement(
    Profiler,
    {
      id: `notes-benchmark-${paneId}`,
      onRender: () => markNotesSplitInputBenchmarkPaneCommit(paneId)
    },
    children
  );
}

/** Captures the physical gesture identity before a real remove command starts. */
export function captureNotesSplitInputBenchmarkBackspaceOperation(
  paneId: BenchmarkPaneId
): string | null {
  const installed = installedSplitInputBenchmarkCollector;
  const operationId = installed?.activeBackspaceByPane.get(paneId);
  if (!installed || !operationId) return null;
  installed.backspacePendingCounts.set(
    operationId,
    (installed.backspacePendingCounts.get(operationId) ?? 0) + 1
  );
  return operationId;
}

/** Called after the captured empty-row remove command reaches a terminal outcome. */
export function markNotesSplitInputBenchmarkBackspaceSettled(
  operationId: string | null,
  outcome: "committed" | "skipped" | "failed"
): void {
  const installed = installedSplitInputBenchmarkCollector;
  if (!installed || !operationId) return;
  const pending = installed.backspacePendingCounts.get(operationId) ?? 0;
  if (pending === 0) return;
  installed.backspacePendingCounts.set(operationId, pending - 1);
  if (outcome === "committed") {
    installed.backspaceCommittedCounts.set(
      operationId,
      (installed.backspaceCommittedCounts.get(operationId) ?? 0) + 1
    );
  }
  if (
    pending === 1 &&
    installed.keyupBackspaceOperationIds.has(operationId)
  ) {
    installed.finishBackspaceOperation(operationId);
  }
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
