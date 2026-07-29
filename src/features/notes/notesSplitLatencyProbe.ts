import { createElement, Profiler, type ReactNode } from "react";
import {
  readPlainText,
  readPlainTextSelection,
} from "./plainTextContenteditable";
import { NOTES_SPLIT_LAYOUT_STORAGE_KEY } from "./notesSplitLayoutStore";

/**
 * Dev-only instrumentation for split, caret, and row-render latency. Records
 * are allocated only while the development probe is enabled.
 *
 * Disabled unless a development build has
 * `localStorage["notes:splitLatency"] === "1"`, so it is a genuine no-op in
 * production and in ordinary test runs. Tests force it on/off through
 * {@link setNotesSplitLatencyProbeEnabled}.
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
  "caret",
];

export type CaretLatencyPhase = "keydown" | "dom-focus" | "sync" | "paint";

const CARET_PHASE_ORDER: readonly CaretLatencyPhase[] = [
  "keydown",
  "dom-focus",
  "sync",
  "paint",
];

function readDevFlag(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("notes:splitLatency") === "1"
    );
  } catch {
    return false;
  }
}

type CaretRecord = {
  times: Map<CaretLatencyPhase, number>;
  visibleRows?: number;
};

let enabled = readDevFlag();
let marks: Map<string, Map<SplitLatencyPhase, number>> | null = enabled
  ? new Map()
  : null;
let caretMarks: Map<string, CaretRecord> | null = enabled ? new Map() : null;
let rowRenderCounts: Map<string, number> | null = enabled ? new Map() : null;
let rowRenderFlush: ReturnType<typeof setTimeout> | null = null;

export function isNotesSplitLatencyProbeEnabled(): boolean {
  return import.meta.env.DEV && enabled;
}

export function hasNotesSplitLatencyProbeStores(): boolean {
  return marks !== null || caretMarks !== null || rowRenderCounts !== null;
}

export function setNotesSplitLatencyProbeEnabled(value: boolean): void {
  if (rowRenderFlush !== null) {
    clearTimeout(rowRenderFlush);
    rowRenderFlush = null;
  }
  marks = null;
  caretMarks = null;
  rowRenderCounts = null;
  enabled = import.meta.env.DEV && value;
  if (enabled) {
    marks = new Map();
    caretMarks = new Map();
    rowRenderCounts = new Map();
  }
}

// Records survive only from a split's keydown to its caret; a split that never
// reaches the caret (failure/rollback) leaves one small stale map. Dev-only, so
// no eviction policy — a session's abandoned splits are negligible.
// ponytail: unbounded map, add an LRU cap only if a dev session ever leaks.
const SPLIT_INPUT_BENCHMARK_PORT = "1438";
const SPLIT_INPUT_BACKSPACE_FIXTURE_ID = "10000031-0000-4000-8000-000000000031";
const SPLIT_INPUT_BENCHMARK_ORIGIN = `http://127.0.0.1:${SPLIT_INPUT_BENCHMARK_PORT}`;

export type SplitInputBenchmarkOperation = "arrow" | "enter" | "backspace";
export type SplitInputBenchmarkPhase =
  "visible" | "authoritative-settled" | "keyup-stop" | "undo-restored";

export interface HeldKeyFrameSummary {
  readonly deliveredKeydowns: number;
  readonly frameDurationsMs: readonly number[];
  readonly frameP95Ms: number;
  readonly framesOver34Ms: number;
}

export function summarizeHeldKeyFrames(
  deliveredKeydowns: number,
  frameDurationsMs: readonly number[],
): HeldKeyFrameSummary {
  const sorted = [...frameDurationsMs].sort((left, right) => left - right);
  return {
    deliveredKeydowns,
    frameDurationsMs: [...frameDurationsMs],
    frameP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0,
    framesOver34Ms: frameDurationsMs.filter((duration) => duration > 34).length,
  };
}

type HeldKeyGestureResult = HeldKeyFrameSummary & {
  finalFocusNodeId: string | null;
  mountedOrdinaryRows: number;
};

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
  heldGesture?: HeldKeyGestureResult;
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
    paneId: "primary" | "secondary",
  ) => string;
  mark: (id: string, phase: SplitInputBenchmarkPhase) => void;
  recordPaneCommit: (id: string, paneId: "primary" | "secondary") => void;
  recordLateWork: (id: string) => void;
  completeBacklogWindow: (id: string, backlogAtTwoSeconds: boolean) => void;
  invalidateOverlap: (id: string) => void;
  completeHeldGesture: (id: string, result: HeldKeyGestureResult) => void;
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
      invalidOverlap: record.invalidOverlap,
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
          invalidOverlap: false,
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
    completeHeldGesture(id, result) {
      const record = records.get(id);
      if (record) record.heldGesture = result;
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
          ...record.heldGesture,
          elapsedMs: record.phases.map(({ phase, at }) => ({
            phase,
            elapsedMs: at - record.startedAt,
          })),
        })),
        null,
        2,
      );
    },
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

const TITLE_EDITOR_SELECTOR = "[data-notes-bullet-title]";
export const NOTES_REROUTED_HELD_ENTER_EVENT = "__yonalistReroutedHeldEnter";

function benchmarkEditorFocusSnapshot(paneId: BenchmarkPaneId): {
  readonly id: string | undefined;
  readonly selectionStart: number;
  readonly selectionEnd: number;
} | null {
  const active = document.activeElement;
  if (
    !(active instanceof HTMLElement) ||
    !active.matches(TITLE_EDITOR_SELECTOR) ||
    active.closest<HTMLElement>("[data-notes-pane-id]")?.dataset.notesPaneId !==
      paneId
  ) {
    return null;
  }
  const selection = readPlainTextSelection(active);
  if (!selection) return null;
  return {
    id: active.closest<HTMLElement>("[data-outline-id]")?.dataset.outlineId,
    selectionStart: Math.min(selection.anchorUtf16, selection.focusUtf16),
    selectionEnd: Math.max(selection.anchorUtf16, selection.focusUtf16),
  };
}

function benchmarkPaneSnapshot(paneId: BenchmarkPaneId): string {
  return JSON.stringify({
    rows: [
      ...document.querySelectorAll<HTMLElement>(
        `[data-notes-pane-id="${paneId}"] [data-outline-id]`,
      ),
    ].map((row) => ({
      id: row.dataset.outlineId,
      title: (() => {
        const title = row.querySelector<HTMLElement>(TITLE_EDITOR_SELECTOR);
        return title instanceof HTMLTextAreaElement
          ? title.value
          : title
            ? readPlainText(title)
            : "";
      })(),
      note:
        row.querySelector<HTMLTextAreaElement>("textarea.notes-node-note")
          ?.value ?? "",
    })),
    focus: benchmarkEditorFocusSnapshot(paneId),
  });
}

type HeldKeyGesture = {
  operationId: string;
  paneId: BenchmarkPaneId;
  key: string;
  deliveredKeydowns: number;
  frameDurationsMs: number[];
  priorFrameAt: number;
  frameRequestId: number | null;
};

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
  heldGesture: HeldKeyGesture | null;
  generation: number;
  scheduleClose: (id: string) => void;
  finishBackspaceOperation: (id: string) => void;
};

function isSplitInputBenchmarkOrigin(origin = window.location.origin): boolean {
  return import.meta.env.DEV && origin === SPLIT_INPUT_BENCHMARK_ORIGIN;
}

export function configureNotesSplitInputBenchmarkVault(
  storage: Pick<Storage, "getItem" | "setItem">,
  origin = window.location.origin,
  search = window.location.search,
  configuredVault?: string,
): boolean {
  if (!isSplitInputBenchmarkOrigin(origin)) return false;
  const vaultFolder =
    new URLSearchParams(search).get("splitInputBenchmarkVault") ??
    configuredVault;
  if (
    !vaultFolder ||
    !/^\/tmp\/yonalist-split-input-bench\.[A-Za-z0-9]+\/vault$/.test(
      vaultFolder,
    )
  ) {
    return false;
  }
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(
      storage.getItem("yonalist.settings.v1") ?? "{}",
    ) as Record<string, unknown>;
  } catch {
    current = {};
  }
  storage.setItem(
    "yonalist.settings.v1",
    JSON.stringify({
      ...current,
      vaultFolder,
      githubNotificationsPluginEnabled: false,
    }),
  );
  storage.setItem(
    NOTES_SPLIT_LAYOUT_STORAGE_KEY,
    JSON.stringify({ version: 1, vaults: {} }),
  );
  return true;
}

let installedSplitInputBenchmarkCollector: InstalledSplitInputBenchmarkCollector | null =
  null;

function markInstalledSplitPhase(
  splitId: string,
  phase: SplitLatencyPhase,
): void {
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
  options: NotesSplitInputBenchmarkInstallOptions = {},
): () => void {
  if (
    !isSplitInputBenchmarkOrigin(options.origin) ||
    installedSplitInputBenchmarkCollector
  ) {
    return () => {};
  }
  const collector = createNotesSplitInputBenchmarkCollector({
    enabled: true,
    now: options.now,
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
    heldGesture: null,
    generation: 0,
    scheduleClose: () => {},
    finishBackspaceOperation: () => {},
  };
  installedSplitInputBenchmarkCollector = installed;
  const focusOperationIdsByPane = new Map<BenchmarkPaneId, string>();
  const now = options.now ?? (() => performance.now());
  const scheduleBacklogCheck =
    options.scheduleBacklogCheck ??
    ((callback: () => void) => window.setTimeout(callback, 2_000));
  const scheduleEnterCancellation =
    options.scheduleEnterCancellation ??
    ((callback: () => void) => window.setTimeout(callback, 0));
  const scheduleOperationClose =
    options.scheduleOperationClose ??
    ((callback: () => void) =>
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(callback),
      ));
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

  const finishHeldGesture = () => {
    const gesture = installed.heldGesture;
    if (!gesture) return;
    if (gesture.frameRequestId !== null) {
      window.cancelAnimationFrame(gesture.frameRequestId);
      gesture.frameDurationsMs.push(now() - gesture.priorFrameAt);
    }
    const active = document.activeElement;
    collector.completeHeldGesture(gesture.operationId, {
      ...summarizeHeldKeyFrames(
        gesture.deliveredKeydowns,
        gesture.frameDurationsMs,
      ),
      finalFocusNodeId:
        active instanceof Element
          ? (active.closest<HTMLElement>("[data-outline-id]")?.dataset
              .outlineId ?? null)
          : null,
      mountedOrdinaryRows: document.querySelectorAll(
        `[data-notes-pane-id="${gesture.paneId}"] [data-outline-id]`,
      ).length,
    });
    installed.heldGesture = null;
  };

  const startHeldGesture = (
    operationId: string,
    paneId: BenchmarkPaneId,
    key: string,
  ) => {
    const gesture: HeldKeyGesture = {
      operationId,
      paneId,
      key,
      deliveredKeydowns: 1,
      frameDurationsMs: [],
      priorFrameAt: now(),
      frameRequestId: null,
    };
    const sampleFrame = () => {
      if (installed.heldGesture !== gesture) return;
      const frameAt = now();
      gesture.frameDurationsMs.push(frameAt - gesture.priorFrameAt);
      gesture.priorFrameAt = frameAt;
      gesture.frameRequestId = window.requestAnimationFrame(sampleFrame);
    };
    installed.heldGesture = gesture;
    gesture.frameRequestId = window.requestAnimationFrame(sampleFrame);
  };

  const fieldContext = (
    target: EventTarget | null,
  ): { field: Element; paneId: BenchmarkPaneId } | null => {
    const field =
      target instanceof Element
        ? target.closest<HTMLElement>(TITLE_EDITOR_SELECTOR)
        : null;
    const row = field?.closest<HTMLElement>("[data-outline-id]");
    const pane = field?.closest<HTMLElement>("[data-notes-pane-id]");
    const paneId = pane?.dataset.notesPaneId;
    return field && row && (paneId === "primary" || paneId === "secondary")
      ? { field, paneId }
      : null;
  };

  const reset = () => {
    installed.generation += 1;
    finishHeldGesture();
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
    document.getElementById("root")?.removeAttribute("aria-hidden");
  };
  const activateOperation = (
    operationId: string,
    paneId: BenchmarkPaneId,
    operation: SplitInputBenchmarkOperation,
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
      ? `[data-notes-pane-id="${paneId}"] [data-outline-id="${SPLIT_INPUT_BACKSPACE_FIXTURE_ID}"] ${TITLE_EDITOR_SELECTOR}`
      : `[data-notes-pane-id="${paneId}"] ${TITLE_EDITOR_SELECTOR}`;
    const field = document.querySelector<HTMLElement>(selector);
    if (!field) {
      return;
    }
    field.focus();
    if (field instanceof HTMLTextAreaElement) {
      field.setSelectionRange(field.value.length, field.value.length);
    }
  };

  const showValue = (value: string) => {
    const output = document.createElement("textarea");
    output.id = "split-input-benchmark-result";
    output.readOnly = true;
    output.setAttribute("aria-label", "Split input benchmark result");
    output.style.cssText = [
      "position:fixed",
      "inset:16px",
      "z-index:2147483647",
      "font:14px ui-monospace,monospace",
    ].join(";");
    output.value = value;
    document.getElementById(output.id)?.remove();
    document.getElementById("root")?.setAttribute("aria-hidden", "true");
    document.body.append(output);
    output.focus();
    output.select();
  };
  const show = () => showValue(collector.result());

  const keydown = (event: KeyboardEvent) => {
    if (Reflect.get(event, NOTES_REROUTED_HELD_ENTER_EVENT) === true) {
      return;
    }
    if (event.metaKey && event.altKey && event.code === "KeyS") {
      event.preventDefault();
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Open split view"]',
        )
        ?.click();
      return;
    }
    if (event.metaKey && event.altKey && event.code === "Digit1") {
      event.preventDefault();
      focusPane("primary");
      return;
    }
    if (event.metaKey && event.altKey && event.code === "KeyP") {
      event.preventDefault();
      focusPane("primary");
      return;
    }
    if (event.metaKey && event.altKey && event.code === "Digit2") {
      event.preventDefault();
      focusPane("secondary");
      return;
    }
    if (event.metaKey && event.altKey && event.code === "KeyO") {
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
      if (event.shiftKey) {
        showValue(
          JSON.stringify({
            panes: document.querySelectorAll("[data-notes-pane-id]").length,
            titleFields: document.querySelectorAll(TITLE_EDITOR_SELECTOR)
              .length,
            openSplitButtons: document.querySelectorAll(
              'button[aria-label="Open split view"]',
            ).length,
            activeClass:
              document.activeElement instanceof HTMLElement
                ? document.activeElement.className
                : null,
            activePane:
              document.activeElement instanceof Element
                ? (document.activeElement.closest<HTMLElement>(
                    "[data-notes-pane-id]",
                  )?.dataset.notesPaneId ?? null)
                : null,
          }),
        );
      } else {
        show();
      }
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
          snapshot:
            installed.backspaceSnapshotsByPane.get(context.paneId) ?? "",
        });
        if (installed.activeOperationId === operationId) {
          installed.activeOperationId = null;
        }
      }
      return;
    }
    if (
      event.key !== "Enter" &&
      event.key !== "Backspace" &&
      event.key !== "ArrowUp" &&
      event.key !== "ArrowDown"
    ) {
      finishHeldGesture();
      return;
    }
    const priorGesture = installed.heldGesture;
    if (
      priorGesture &&
      event.repeat &&
      priorGesture.paneId === context.paneId &&
      priorGesture.key === event.key
    ) {
      priorGesture.deliveredKeydowns += 1;
      return;
    }
    finishHeldGesture();
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
      startHeldGesture(operationId, context.paneId, event.key);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const operationId = collector.begin("arrow", context.paneId);
      activateOperation(operationId, context.paneId, "arrow");
      focusOperationIdsByPane.set(context.paneId, operationId);
      startHeldGesture(operationId, context.paneId, event.key);
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
      installed.backspaceSnapshotsByPane.set(
        context.paneId,
        benchmarkPaneSnapshot(context.paneId),
      );
    }
    focusOperationIdsByPane.set(context.paneId, operationId);
    startHeldGesture(operationId, context.paneId, event.key);
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
    const context = fieldContext(event.target);
    const gesture = installed.heldGesture;
    const paneId =
      context?.paneId ?? (gesture?.key === event.key ? gesture.paneId : null);
    if (paneId && gesture?.paneId === paneId && gesture.key === event.key) {
      finishHeldGesture();
    }
    if (event.key !== "Backspace") return;
    const id = paneId && installed.activeBackspaceByPane.get(paneId);
    if (id && paneId) {
      collector.mark(id, "keyup-stop");
      installed.activeBackspaceByPane.delete(paneId);
      installed.lastBackspaceByPane.set(paneId, id);
      installed.backspaceObservationByPane.set(paneId, id);
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
          installed.backspaceObservationByPane.delete(paneId);
        } else {
          installed.overdueBackspaceOperationIds.add(id);
        }
      });
    }
  };

  const blur = (event: FocusEvent) => {
    if (event.target === event.currentTarget) finishHeldGesture();
  };
  const visibilitychange = () => {
    if (document.visibilityState !== "visible") finishHeldGesture();
  };

  window.addEventListener("keydown", keydown, true);
  window.addEventListener("focusin", focusin, true);
  window.addEventListener("input", input, true);
  window.addEventListener("keyup", keyup, true);
  window.addEventListener("blur", blur, true);
  document.addEventListener("visibilitychange", visibilitychange);
  return () => {
    window.removeEventListener("keydown", keydown, true);
    window.removeEventListener("focusin", focusin, true);
    window.removeEventListener("input", input, true);
    window.removeEventListener("keyup", keyup, true);
    window.removeEventListener("blur", blur, true);
    document.removeEventListener("visibilitychange", visibilitychange);
    finishHeldGesture();
    if (installedSplitInputBenchmarkCollector === installed) {
      installedSplitInputBenchmarkCollector = null;
    }
  };
}

/** Called from the dev-only React Profiler boundary around each real pane. */
export function markNotesSplitInputBenchmarkPaneCommit(
  paneId: BenchmarkPaneId,
): void {
  const installed = installedSplitInputBenchmarkCollector;
  if (!installed) return;
  const operationId = installed.activeOperationId;
  if (operationId) {
    installed.collector.recordPaneCommit(operationId, paneId);
  }
  const undo = installed.undoSnapshotsByPane.get(paneId);
  if (!undo) return;
  const snapshot = benchmarkPaneSnapshot(paneId);
  if (snapshot === undo.snapshot) {
    installed.collector.mark(undo.id, "undo-restored");
    installed.undoSnapshotsByPane.delete(paneId);
  }
}

export function NotesSplitInputBenchmarkProfiler({
  paneId,
  children,
}: {
  readonly paneId: BenchmarkPaneId;
  readonly children?: ReactNode;
}) {
  return createElement(
    Profiler,
    {
      id: `notes-benchmark-${paneId}`,
      onRender: () => markNotesSplitInputBenchmarkPaneCommit(paneId),
    },
    children,
  );
}

/** Captures the physical gesture identity before a real remove command starts. */
export function captureNotesSplitInputBenchmarkBackspaceOperation(
  paneId: BenchmarkPaneId,
): string | null {
  const installed = installedSplitInputBenchmarkCollector;
  const operationId = installed?.activeBackspaceByPane.get(paneId);
  if (!installed || !operationId) return null;
  installed.backspacePendingCounts.set(
    operationId,
    (installed.backspacePendingCounts.get(operationId) ?? 0) + 1,
  );
  return operationId;
}

/** Called after the captured empty-row remove command reaches a terminal outcome. */
export function markNotesSplitInputBenchmarkBackspaceSettled(
  operationId: string | null,
  outcome: "committed" | "skipped" | "failed",
): void {
  const installed = installedSplitInputBenchmarkCollector;
  if (!installed || !operationId) return;
  const pending = installed.backspacePendingCounts.get(operationId) ?? 0;
  if (pending === 0) return;
  installed.backspacePendingCounts.set(operationId, pending - 1);
  if (outcome === "committed") {
    installed.backspaceCommittedCounts.set(
      operationId,
      (installed.backspaceCommittedCounts.get(operationId) ?? 0) + 1,
    );
  }
  if (pending === 1 && installed.keyupBackspaceOperationIds.has(operationId)) {
    installed.finishBackspaceOperation(operationId);
  }
}

export function markSplitPhase(
  splitId: string,
  phase: SplitLatencyPhase,
): void {
  markInstalledSplitPhase(splitId, phase);
  const splitMarks = marks;
  if (!isNotesSplitLatencyProbeEnabled() || splitMarks === null) {
    return;
  }
  let byPhase = splitMarks.get(splitId);
  if (!byPhase) {
    // Only a keydown opens a record: a settle/caret that arrives without one
    // (a non-optimistic or already-summarized split) is ignored, never faked.
    if (phase !== "keydown") {
      return;
    }
    byPhase = new Map();
    splitMarks.set(splitId, byPhase);
  }
  byPhase.set(phase, performance.now());
  if (phase === "provisional-caret") {
    const start = byPhase.get("keydown");
    const end = byPhase.get("provisional-caret");
    if (start !== undefined && end !== undefined) {
      console.log(
        `notes split-latency ${splitId.slice(0, 8)} ui=${(end - start).toFixed(1)}ms`,
      );
    }
    return;
  }
  if (phase === "settled" && byPhase.has("provisional-caret")) {
    const start = byPhase.get("keydown")!;
    const provisional = byPhase.get("provisional-caret")!;
    const end = byPhase.get("settled")!;
    console.log(
      `notes split-latency ${splitId.slice(0, 8)} persistence=${(end - provisional).toFixed(1)}ms total=${(end - start).toFixed(1)}ms`,
    );
    splitMarks.delete(splitId);
    return;
  }
  if (phase === "rollback" || phase === "recovered") {
    logSummary(splitId, byPhase, phase);
    splitMarks.delete(splitId);
    return;
  }
  if (phase === "caret") {
    logSummary(splitId, byPhase);
    splitMarks.delete(splitId);
  }
}

function logSummary(
  splitId: string,
  byPhase: Map<SplitLatencyPhase, number>,
  terminalPhase: SplitLatencyPhase = "caret",
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
    spans.push(
      `${previousName}->${phase}=${(time - previousTime).toFixed(1)}ms`,
    );
    previousTime = time;
    previousName = phase;
  }
  console.log(
    `notes split-latency ${splitId.slice(0, 8)} total=${(end - start).toFixed(1)}ms ${spans.join(" ")}`,
  );
}

export function markCaretPhase(
  nodeId: string,
  phase: CaretLatencyPhase,
  info?: { visibleRows?: number },
): boolean {
  const records = caretMarks;
  if (!isNotesSplitLatencyProbeEnabled() || records === null) {
    return false;
  }
  if (phase === "keydown") {
    records.set(nodeId, {
      times: new Map([["keydown", performance.now()]]),
      visibleRows: info?.visibleRows,
    });
    return true;
  }
  const record = records.get(nodeId);
  if (!record) {
    return false;
  }
  record.times.set(phase, performance.now());
  if (phase !== "paint") {
    return true;
  }
  const start = record.times.get("keydown");
  const end = record.times.get("paint");
  if (start !== undefined && end !== undefined) {
    const spans: string[] = [];
    let previousTime = start;
    let previousName: CaretLatencyPhase = "keydown";
    for (const currentPhase of CARET_PHASE_ORDER.slice(1)) {
      const time = record.times.get(currentPhase);
      if (time === undefined) continue;
      spans.push(
        `${previousName}->${currentPhase}=${(time - previousTime).toFixed(1)}ms`,
      );
      previousTime = time;
      previousName = currentPhase;
    }
    console.log(
      `notes caret-latency ${nodeId.slice(0, 8)} rows=${record.visibleRows ?? "?"} total=${(end - start).toFixed(1)}ms ${spans.join(" ")}`,
    );
  }
  records.delete(nodeId);
  return true;
}

export function markRowRender(paneId: string): void {
  const counts = rowRenderCounts;
  if (!isNotesSplitLatencyProbeEnabled() || counts === null) {
    return;
  }
  counts.set(paneId, (counts.get(paneId) ?? 0) + 1);
  if (rowRenderFlush === null) {
    rowRenderFlush = setTimeout(flushRowRenderCounts, 100);
  }
}

function flushRowRenderCounts(): void {
  rowRenderFlush = null;
  const counts = rowRenderCounts;
  if (counts === null) return;
  for (const [paneId, count] of counts) {
    console.log(`notes row-renders pane=${paneId} count=${count}`);
  }
  counts.clear();
}

export function resetRowRenderCounts(): ReadonlyMap<string, number> | null {
  const counts = rowRenderCounts;
  if (counts === null) return null;
  const snapshot = new Map(counts);
  counts.clear();
  if (rowRenderFlush !== null) {
    clearTimeout(rowRenderFlush);
    rowRenderFlush = null;
  }
  return snapshot;
}
