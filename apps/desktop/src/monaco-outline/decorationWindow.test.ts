import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import {
  decorationWindowFor,
  PaneDecorationWindow
} from "./decorationWindow";
import {
  OutlineMetadataTimeline,
  type OutlineLineMetadata
} from "./metadata";

afterEach(() => vi.unstubAllGlobals());

describe("Monaco pane decoration window", () => {
  it("adds one visible-height overscan above and below", () => {
    expect(decorationWindowFor(101, 140, 5_000))
      .toEqual([61, 180]);

    expect(decorationWindowFor(1, 40, 50))
      .toEqual([1, 50]);
  });

  it("decorates synchronously and coalesces rapid scroll updates", () => {
    const metadata = OutlineMetadataTimeline.hydrate(
      1,
      Array.from({ length: 5_000 }, (_, index) => line(index + 1))
    );
    const fixture = editorFixture(101, 140);
    const scheduler = frameScheduler();
    scheduler.install();
    const window = new PaneDecorationWindow({
      editor: fixture.editor,
      metadata: () => metadata.current()
    });

    expect(fixture.collectionSet).toHaveBeenCalledOnce();
    expect(fixture.collectionSet.mock.calls[0]?.[0]).toHaveLength(120);
    expect(window.size).toBe(120);

    fixture.setVisibleRange(201, 240);
    fixture.emitScroll();
    fixture.emitScroll();
    fixture.emitLayout();
    expect(scheduler.pending()).toBe(1);
    expect(fixture.collectionSet).toHaveBeenCalledOnce();

    scheduler.flush();
    expect(fixture.collectionSet).toHaveBeenCalledTimes(2);
    expect(fixture.collectionSet.mock.calls[1]?.[0]).toHaveLength(120);
    expect(window.size).toBe(120);
    window.dispose();
    expect(fixture.collectionClear).toHaveBeenCalledOnce();
    expect(window.size).toBe(0);
  });

  it("ignores text metadata and follows the viewport after structural edits", () => {
    const metadata = OutlineMetadataTimeline.hydrate(
      1,
      Array.from({ length: 500 }, (_, index) => line(index + 1))
    );
    const fixture = editorFixture(101, 140);
    const scheduler = frameScheduler();
    scheduler.install();
    const window = new PaneDecorationWindow({
      editor: fixture.editor,
      metadata: () => metadata.current()
    });

    window.invalidate(false);
    expect(fixture.collectionSet).toHaveBeenCalledOnce();

    window.invalidate(true);
    expect(fixture.collectionSet).toHaveBeenCalledTimes(2);

    fixture.setVisibleRange(401, 440);
    expect(scheduler.pending()).toBe(1);
    scheduler.flush();
    expect(fixture.collectionSet).toHaveBeenCalledTimes(3);
    expect(fixture.collectionSet.mock.calls[2]?.[0]).toHaveLength(120);
    window.dispose();
  });
});

function line(lineNumber: number): OutlineLineMetadata {
  return {
    nodeId: `node-${lineNumber}`,
    parentId: "page",
    depth: 0,
    kind: "text",
    collapsed: false,
    completed: false
  };
}

function editorFixture(start: number, end: number): {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  readonly collectionSet: ReturnType<typeof vi.fn>;
  readonly collectionClear: ReturnType<typeof vi.fn>;
  setVisibleRange(nextStart: number, nextEnd: number): void;
  emitScroll(): void;
  emitLayout(): void;
} {
  let visibleStart = start;
  let visibleEnd = end;
  const scrollListeners = new Set<() => void>();
  const layoutListeners = new Set<() => void>();
  const collectionSet = vi.fn();
  const collectionClear = vi.fn();
  const editor = {
    getVisibleRanges: () => [new monaco.Range(
      visibleStart,
      1,
      visibleEnd,
      1
    )],
    getPosition: () => ({ lineNumber: visibleStart, column: 1 }),
    getLayoutInfo: () => ({ height: (visibleEnd - visibleStart + 1) * 25 }),
    createDecorationsCollection: () => ({
      set: collectionSet,
      clear: collectionClear
    }),
    onDidScrollChange: (listener: () => void) => {
      scrollListeners.add(listener);
      return { dispose: () => scrollListeners.delete(listener) };
    },
    onDidLayoutChange: (listener: () => void) => {
      layoutListeners.add(listener);
      return { dispose: () => layoutListeners.delete(listener) };
    }
  } as unknown as monaco.editor.IStandaloneCodeEditor;
  return {
    editor,
    collectionSet,
    collectionClear,
    setVisibleRange: (nextStart, nextEnd) => {
      visibleStart = nextStart;
      visibleEnd = nextEnd;
    },
    emitScroll: () => scrollListeners.forEach((listener) => listener()),
    emitLayout: () => layoutListeners.forEach((listener) => listener())
  };
}

function frameScheduler(): {
  install(): void;
  pending(): number;
  flush(): void;
} {
  let callback: (() => void) | null = null;
  return {
    install: () => {
      vi.stubGlobal("requestAnimationFrame", (next: () => void) => {
        callback = next;
        return 1;
      });
    },
    pending: () => callback === null ? 0 : 1,
    flush: () => {
      const next = callback;
      callback = null;
      next?.();
    }
  };
}
