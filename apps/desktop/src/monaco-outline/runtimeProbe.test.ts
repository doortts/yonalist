import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import { attachBenchmarkRun } from "./runtimeProbe";
import type { MonacoOutlineSession } from "./session";

describe("Monaco outline runtime benchmark", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback) => setTimeout(
        () => callback(performance.now()),
        20
      ) as unknown as number
    );
  });

  afterEach(() => {
    delete window.__YONALIST_MONACO_BENCHMARK__;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("publishes 31 samples once and releases its key listener", async () => {
    const { editor, host, keyDownListeners, session } = fixture();
    const attachment = attachBenchmarkRun(editor, session);

    for (let index = 0; index < 33; index += 1) {
      keyDownListeners.forEach((listener) => listener());
      await vi.advanceTimersByTimeAsync(20);
    }

    expect(window.__YONALIST_MONACO_BENCHMARK__?.result()).toBeNull();
    expect(keyDownListeners.size).toBe(1);

    keyDownListeners.forEach((listener) => listener());
    await vi.advanceTimersByTimeAsync(20);

    const result = window.__YONALIST_MONACO_BENCHMARK__?.result();
    expect(result).toEqual(expect.objectContaining({
      lineCount: 42,
      modelSetValueCount: 0,
      longTasks: 0
    }));
    expect(result?.samples).toHaveLength(31);
    expect(result?.median).toBe(20);
    expect(result?.p95).toBe(20);
    expect(Object.isFrozen(result)).toBe(true);
    expect(keyDownListeners.size).toBe(0);
    expect(host.hasAttribute("data-monaco-outline-probe")).toBe(false);

    attachment.dispose();
    expect(window.__YONALIST_MONACO_BENCHMARK__).toBeUndefined();
  });

  it("disposes an unfinished run without publishing partial results", async () => {
    const { editor, keyDownListeners, session } = fixture();
    const attachment = attachBenchmarkRun(editor, session);

    keyDownListeners.forEach((listener) => listener());
    await vi.advanceTimersByTimeAsync(20);
    attachment.dispose();

    expect(keyDownListeners.size).toBe(0);
    expect(window.__YONALIST_MONACO_BENCHMARK__).toBeUndefined();
  });
});

function fixture(): {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  readonly host: HTMLDivElement;
  readonly keyDownListeners: Set<() => void>;
  readonly session: MonacoOutlineSession;
} {
  const host = document.createElement("div");
  const keyDownListeners = new Set<() => void>();
  const editor = {
    getDomNode: () => host,
    onKeyDown: (listener: () => void) => {
      keyDownListeners.add(listener);
      return {
        dispose: () => keyDownListeners.delete(listener)
      };
    }
  } as unknown as monaco.editor.IStandaloneCodeEditor;
  const session = {
    model: { getLineCount: () => 42 },
    metrics: { fullModelReplacementCount: 0 }
  } as unknown as MonacoOutlineSession;
  return { editor, host, keyDownListeners, session };
}
