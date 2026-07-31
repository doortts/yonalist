import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import { attachRuntimeProbe } from "./runtimeProbe";
import type { MonacoOutlineSession } from "./session";

describe("Monaco outline runtime probe", () => {
  it("samples keydown-to-frame without changing the model", async () => {
    vi.useFakeTimers();
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
    const probe = attachRuntimeProbe(editor, session);
    expect(host.getAttribute("data-monaco-outline-probe")).not.toBeNull();

    keyDownListeners.forEach((listener) => listener());
    await vi.advanceTimersByTimeAsync(20);

    expect(window.__YONALIST_MONACO_PROBE__?.snapshot()).toEqual(
      expect.objectContaining({
        lineCount: 42,
        modelSetValueCount: 0,
        longTasks: 0
      })
    );
    expect(window.__YONALIST_MONACO_PROBE__?.snapshot().samples)
      .toHaveLength(1);

    probe.dispose();
    expect(host.getAttribute("data-monaco-outline-probe")).toBeNull();
    expect(window.__YONALIST_MONACO_PROBE__).toBeUndefined();
    vi.useRealTimers();
  });
});
