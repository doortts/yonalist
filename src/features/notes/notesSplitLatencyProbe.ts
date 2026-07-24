/**
 * Dev-only instrumentation for two notes latency chains (plan Phase L0). Each
 * records `performance.now()` at a handful of phases keyed by a node id; when
 * the chain's terminal phase lands it logs one console summary line with the
 * per-phase spans and the end-to-end total, then drops the record.
 *
 * - Split chain (Enter->caret), keyed by the client-generated new node id via
 *   {@link markSplitPhase}: confirms which span dominates (the plan expects the
 *   split IPC round trip) before committing to the optimistic path in Phase L1.
 * - Caret chain (arrow-key cursor move), keyed by the target node id via
 *   {@link markCaretPhase}: keydown -> DOM focus -> focus ack sync -> paint,
 *   so we can see whether cursor moves stall in the sync or the paint.
 *
 * Disabled unless the build is DEV or `localStorage["notes:splitLatency"]` is
 * "1", so it is a genuine no-op in production and in ordinary test runs. Tests
 * force it on/off through {@link setNotesSplitLatencyProbeEnabled}.
 */

export type SplitLatencyPhase =
  | "keydown"
  | "barrier"
  | "ipc-done"
  | "settled"
  | "caret";

const PHASE_ORDER: readonly SplitLatencyPhase[] = [
  "keydown",
  "barrier",
  "ipc-done",
  "settled",
  "caret"
];

export type CaretLatencyPhase = "keydown" | "dom-focus" | "sync" | "paint";

const CARET_PHASE_ORDER: readonly CaretLatencyPhase[] = [
  "keydown",
  "dom-focus",
  "sync",
  "paint"
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
  caretMarks.clear();
}

// Records survive only from a split's keydown to its caret; a split that never
// reaches the caret (failure/rollback) leaves one small stale map. Dev-only, so
// no eviction policy — a session's abandoned splits are negligible.
// ponytail: unbounded map, add an LRU cap only if a dev session ever leaks.
const marks = new Map<string, Map<SplitLatencyPhase, number>>();

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
  if (phase === "caret") {
    logSummary(splitId, byPhase);
    marks.delete(splitId);
  }
}

// Joins the consecutive per-phase spans in order, skipping any phase the record
// never saw. Shared by both chains since the span math is identical.
function formatSpans<P extends string>(
  order: readonly P[],
  byPhase: Map<P, number>,
  start: number
): string {
  const spans: string[] = [];
  let previousTime = start;
  let previousName = order[0];
  for (const phase of order.slice(1)) {
    const time = byPhase.get(phase);
    if (time === undefined) {
      continue;
    }
    spans.push(`${previousName}->${phase}=${(time - previousTime).toFixed(1)}ms`);
    previousTime = time;
    previousName = phase;
  }
  return spans.join(" ");
}

function logSummary(
  splitId: string,
  byPhase: Map<SplitLatencyPhase, number>
): void {
  const start = byPhase.get("keydown");
  const end = byPhase.get("caret");
  if (start === undefined || end === undefined) {
    return;
  }
  console.log(
    `notes split-latency ${splitId.slice(0, 8)} total=${(end - start).toFixed(1)}ms ${formatSpans(PHASE_ORDER, byPhase, start)}`
  );
}

// Records survive only from a caret move's keydown to its paint; the same
// dev-only, no-eviction reasoning as `marks` above applies.
// ponytail: unbounded map, add an LRU cap only if a dev session ever leaks.
type CaretRecord = {
  times: Map<CaretLatencyPhase, number>;
  visibleRows?: number;
};

const caretMarks = new Map<string, CaretRecord>();

export function markCaretPhase(
  nodeId: string,
  phase: CaretLatencyPhase,
  info?: { visibleRows?: number }
): void {
  if (!enabled) {
    return;
  }
  if (phase === "keydown") {
    // Only a keydown opens a record, and a fresh one always: a repeat keydown
    // (key held) discards the in-flight record so the summary measures the
    // latest press, never a stale half-finished one.
    caretMarks.set(nodeId, {
      times: new Map([["keydown", performance.now()]]),
      visibleRows: info?.visibleRows
    });
    return;
  }
  const record = caretMarks.get(nodeId);
  if (!record) {
    // A dom-focus/sync/paint without a keydown (an ordinary focus move) is
    // ignored, never faked — same contract as markSplitPhase.
    return;
  }
  record.times.set(phase, performance.now());
  if (phase === "paint") {
    logCaretSummary(nodeId, record);
    caretMarks.delete(nodeId);
  }
}

function logCaretSummary(nodeId: string, record: CaretRecord): void {
  const start = record.times.get("keydown");
  const end = record.times.get("paint");
  if (start === undefined || end === undefined) {
    return;
  }
  const rows = record.visibleRows ?? "?";
  console.log(
    `notes caret-latency ${nodeId.slice(0, 8)} rows=${rows} total=${(end - start).toFixed(1)}ms ${formatSpans(CARET_PHASE_ORDER, record.times, start)}`
  );
}
