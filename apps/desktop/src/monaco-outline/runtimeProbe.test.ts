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
    const {
      cursorListeners,
      editor,
      host,
      keyDownListeners,
      modelListeners,
      session
    } = fixture();
    const attachment = attachBenchmarkRun(editor, session);
    const readyAt = host.getAttribute("data-monaco-outline-ready");
    expect(readyAt).not.toBeNull();
    expect(Number(readyAt)).toBeGreaterThanOrEqual(0);

    for (let index = 0; index < 33; index += 1) {
      keyDownListeners.forEach((listener) => listener());
      await vi.advanceTimersByTimeAsync(20);
    }

    expect(window.__YONALIST_MONACO_BENCHMARK__?.result()).toBeNull();
    expect(keyDownListeners.size).toBe(1);
    expect(host).not.toHaveAttribute("data-monaco-outline-benchmark");

    keyDownListeners.forEach((listener) => listener());
    await vi.advanceTimersByTimeAsync(20);

    const result = window.__YONALIST_MONACO_BENCHMARK__?.result();
    expect(result).toEqual(expect.objectContaining({
      lineCount: 42,
      modelSetValueCount: 0,
      longTasks: 0,
      sourceCounts: { keydown: 31, model: 0, cursor: 0 }
    }));
    expect(result?.samples).toHaveLength(31);
    expect(result?.median).toBe(20);
    expect(result?.p95).toBe(20);
    expect(Object.isFrozen(result)).toBe(true);
    expect(keyDownListeners.size).toBe(0);
    expect(modelListeners.size).toBe(0);
    expect(cursorListeners.size).toBe(0);
    expect(JSON.parse(
      host.getAttribute("data-monaco-outline-benchmark") ?? "null"
    )).toEqual(result);

    attachment.dispose();
    expect(window.__YONALIST_MONACO_BENCHMARK__).toBeUndefined();
    expect(host).not.toHaveAttribute("data-monaco-outline-benchmark");
    expect(host).not.toHaveAttribute("data-monaco-outline-ready");
  });

  it("labels EditContext model events when automation bypasses keydown", async () => {
    const {
      cursorListeners,
      editor,
      keyDownListeners,
      modelListeners,
      session
    } = fixture();
    attachBenchmarkRun(editor, session);

    cursorListeners.forEach((listener) => listener({ source: "mouse" }));
    await vi.advanceTimersByTimeAsync(20);
    for (let index = 0; index < 33; index += 1) {
      modelListeners.forEach((listener) => listener());
      cursorListeners.forEach((listener) => listener({ source: "keyboard" }));
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(window.__YONALIST_MONACO_BENCHMARK__?.result()).toBeNull();
    modelListeners.forEach((listener) => listener());
    await vi.advanceTimersByTimeAsync(20);

    expect(window.__YONALIST_MONACO_BENCHMARK__?.result())
      .toEqual(expect.objectContaining({
        sourceCounts: { keydown: 0, model: 31, cursor: 0 }
      }));
    expect(keyDownListeners.size).toBe(0);
    expect(modelListeners.size).toBe(0);
    expect(cursorListeners.size).toBe(0);
  });

  it("disposes an unfinished run without publishing partial results", async () => {
    const { editor, host, keyDownListeners, session } = fixture();
    const attachment = attachBenchmarkRun(editor, session);

    keyDownListeners.forEach((listener) => listener());
    await vi.advanceTimersByTimeAsync(20);
    attachment.dispose();

    expect(keyDownListeners.size).toBe(0);
    expect(window.__YONALIST_MONACO_BENCHMARK__).toBeUndefined();
    expect(host).not.toHaveAttribute("data-monaco-outline-benchmark");
  });
});

function fixture(): {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  readonly host: HTMLDivElement;
  readonly keyDownListeners: Set<() => void>;
  readonly modelListeners: Set<() => void>;
  readonly cursorListeners: Set<(event: { source: string }) => void>;
  readonly session: MonacoOutlineSession;
} {
  const host = document.createElement("div");
  const keyDownListeners = new Set<() => void>();
  const modelListeners = new Set<() => void>();
  const cursorListeners = new Set<(event: { source: string }) => void>();
  const editor = {
    getDomNode: () => host,
    onKeyDown: (listener: () => void) => {
      keyDownListeners.add(listener);
      return {
        dispose: () => keyDownListeners.delete(listener)
      };
    },
    onDidChangeCursorPosition: (
      listener: (event: { source: string }) => void
    ) => {
      cursorListeners.add(listener);
      return {
        dispose: () => cursorListeners.delete(listener)
      };
    }
  } as unknown as monaco.editor.IStandaloneCodeEditor;
  const session = {
    model: {
      getLineCount: () => 42,
      onDidChangeContent: (listener: () => void) => {
        modelListeners.add(listener);
        return {
          dispose: () => modelListeners.delete(listener)
        };
      }
    },
    metrics: { fullModelReplacementCount: 0 }
  } as unknown as MonacoOutlineSession;
  return {
    editor,
    host,
    keyDownListeners,
    modelListeners,
    cursorListeners,
    session
  };
}
