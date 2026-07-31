import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { MonacoOutlineSession } from "./session";

export interface MonacoOutlineProbeResult {
  readonly samples: readonly number[];
  readonly p50: number;
  readonly p95: number;
  readonly longTasks: number;
  readonly lineCount: number;
  readonly modelSetValueCount: number;
}

export interface MonacoOutlineRuntimeProbe {
  snapshot(): MonacoOutlineProbeResult;
}

declare global {
  interface Window {
    __YONALIST_MONACO_PROBE__?: MonacoOutlineRuntimeProbe;
  }
}

const MAX_SAMPLES = 500;

export function attachRuntimeProbe(
  editor: monaco.editor.IStandaloneCodeEditor,
  session: MonacoOutlineSession
): monaco.IDisposable {
  const samples: number[] = [];
  let longTasks = 0;
  let disposed = false;
  const host = editor.getDomNode();
  const snapshot = (): MonacoOutlineProbeResult => {
    const sorted = [...samples].sort((left, right) => left - right);
    return Object.freeze({
      samples: Object.freeze([...samples]),
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      longTasks,
      lineCount: session.model.getLineCount(),
      modelSetValueCount: session.metrics.fullModelReplacementCount
    });
  };
  const publish = () => {
    host?.setAttribute(
      "data-monaco-outline-probe",
      JSON.stringify(snapshot())
    );
  };
  const onKeyDown = () => {
    const started = performance.now();
    requestAnimationFrame(() => {
      if (disposed) return;
      samples.push(performance.now() - started);
      if (samples.length > MAX_SAMPLES) samples.shift();
      publish();
    });
  };
  const keyDownSubscription = editor.onKeyDown(onKeyDown);
  const observer = typeof PerformanceObserver === "undefined"
    ? null
    : new PerformanceObserver((entries) => {
        longTasks += entries.getEntries().filter(
          (entry) => entry.duration >= 50
        ).length;
      });
  try {
    observer?.observe({ entryTypes: ["longtask"] });
  } catch {
    observer?.disconnect();
  }
  const probe: MonacoOutlineRuntimeProbe = Object.freeze({
    snapshot
  });
  window.__YONALIST_MONACO_PROBE__ = probe;
  publish();
  return {
    dispose: () => {
      disposed = true;
      keyDownSubscription.dispose();
      observer?.disconnect();
      host?.removeAttribute("data-monaco-outline-probe");
      if (window.__YONALIST_MONACO_PROBE__ === probe) {
        delete window.__YONALIST_MONACO_PROBE__;
      }
    }
  };
}

function percentile(
  sorted: readonly number[],
  quantile: number
): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  );
  return sorted[index] ?? 0;
}
