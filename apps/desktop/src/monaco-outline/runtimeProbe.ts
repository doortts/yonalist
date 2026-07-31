import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { MonacoOutlineSession } from "./session";

export interface MonacoOutlineBenchmarkResult {
  readonly samples: readonly number[];
  readonly median: number;
  readonly p95: number;
  readonly longTasks: number | null;
  readonly lineCount: number;
  readonly modelSetValueCount: number;
}

export interface MonacoOutlineBenchmarkController {
  result(): MonacoOutlineBenchmarkResult | null;
}

export interface MonacoOutlineBenchmarkOptions {
  readonly warmupSamples: number;
  readonly recordedSamples: number;
}

declare global {
  interface Window {
    __YONALIST_MONACO_BENCHMARK__?: MonacoOutlineBenchmarkController;
  }
}

const DEFAULT_OPTIONS: MonacoOutlineBenchmarkOptions = Object.freeze({
  warmupSamples: 3,
  recordedSamples: 31
});

export function attachBenchmarkRun(
  editor: monaco.editor.IStandaloneCodeEditor,
  session: MonacoOutlineSession,
  options: MonacoOutlineBenchmarkOptions = DEFAULT_OPTIONS
): monaco.IDisposable {
  const samples: number[] = [];
  let completedSamples = 0;
  let finalResult: MonacoOutlineBenchmarkResult | null = null;
  let active = true;
  let longTasks: number | null =
    typeof PerformanceObserver === "undefined" ? null : 0;
  let keyDownSubscription: monaco.IDisposable | null = null;
  let observer: PerformanceObserver | null = null;

  const controller: MonacoOutlineBenchmarkController = Object.freeze({
    result: () => finalResult
  });
  window.__YONALIST_MONACO_BENCHMARK__ = controller;

  const stopListening = () => {
    if (!active) return;
    active = false;
    keyDownSubscription?.dispose();
    keyDownSubscription = null;
    observer?.disconnect();
    observer = null;
  };
  const finish = () => {
    const sorted = [...samples].sort((left, right) => left - right);
    finalResult = Object.freeze({
      samples: Object.freeze([...samples]),
      median: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      longTasks,
      lineCount: session.model.getLineCount(),
      modelSetValueCount: session.metrics.fullModelReplacementCount
    });
    stopListening();
  };
  const onKeyDown = () => {
    if (!active) return;
    const startedAt = performance.now();
    requestAnimationFrame(() => {
      if (!active) return;
      completedSamples += 1;
      if (completedSamples <= options.warmupSamples) return;
      samples.push(performance.now() - startedAt);
      if (samples.length === options.recordedSamples) finish();
    });
  };

  keyDownSubscription = editor.onKeyDown(onKeyDown);
  if (longTasks !== null) {
    observer = new PerformanceObserver((entries) => {
      longTasks! += entries.getEntries().filter(
        (entry) => entry.duration >= 50
      ).length;
    });
    try {
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      observer.disconnect();
      observer = null;
      longTasks = null;
    }
  }

  return {
    dispose: () => {
      stopListening();
      if (window.__YONALIST_MONACO_BENCHMARK__ === controller) {
        delete window.__YONALIST_MONACO_BENCHMARK__;
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
