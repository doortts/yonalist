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
