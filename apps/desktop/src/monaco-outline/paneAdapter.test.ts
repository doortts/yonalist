import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import {
  OutlineMetadataTimeline,
  type OutlineLineMetadata,
  type OutlineMetadataSnapshot
} from "./metadata";
import {
  hiddenRangesForZoom,
  MonacoOutlinePaneAdapter,
  routeBulletClick,
  visibleRangesForZoom,
  type OutlinePaneNavigation
} from "./paneAdapter";

function line(
  nodeId: string,
  parentId: string,
  depth: number
): OutlineLineMetadata {
  return {
    nodeId,
    parentId,
    depth,
    kind: "text",
    collapsed: false,
    completed: false
  };
}

function noteLine(
  title: OutlineLineMetadata
): OutlineLineMetadata {
  return { ...title, kind: "note" };
}

function snapshot(
  lines: readonly OutlineLineMetadata[]
): OutlineMetadataSnapshot {
  return OutlineMetadataTimeline.hydrate(1, lines).current();
}

function stubSession(
  metadata: OutlineMetadataSnapshot
): ConstructorParameters<typeof MonacoOutlinePaneAdapter>[0]["session"] {
  return {
    metadata: { current: () => metadata },
    subscribeMetadata: () => () => undefined
  } as unknown as ConstructorParameters<
    typeof MonacoOutlinePaneAdapter
  >[0]["session"];
}

function navigation(): OutlinePaneNavigation {
  return {
    zoomSamePane: vi.fn(),
    openSecondary: vi.fn()
  };
}

describe("Monaco outline pane adapter", () => {
  it("computes hidden ranges for a zoomed subtree", () => {
    const metadata = snapshot([
      line("a", "page", 0),
      line("a-child", "a", 1),
      line("b", "page", 0)
    ]);

    expect(visibleRangesForZoom(metadata, "a")).toEqual([
      new monaco.Range(2, 1, 2, 1)
    ]);
    expect(hiddenRangesForZoom(metadata, "a")).toEqual([
      new monaco.Range(1, 1, 1, 1),
      new monaco.Range(3, 1, 3, 1)
    ]);
  });

  it("keeps a zoom root's note run inside the zoomed range", () => {
    const root = line("a", "page", 0);
    const withChild = snapshot([
      root,
      noteLine(root),
      line("a-child", "a", 1),
      line("b", "page", 0)
    ]);

    expect(visibleRangesForZoom(withChild, "a")).toEqual([
      new monaco.Range(2, 1, 3, 1)
    ]);

    // A note is content of its own, so zooming a noted leaf is not empty.
    const notedLeaf = snapshot([root, noteLine(root), line("b", "page", 0)]);
    expect(visibleRangesForZoom(notedLeaf, "a")).toEqual([
      new monaco.Range(2, 1, 2, 1)
    ]);
  });

  it("hides the note run of every line a collapsed parent hides", () => {
    const parent = { ...line("parent", "page", 0), collapsed: true };
    const child = line("child", "parent", 1);
    const metadata = snapshot([
      parent,
      noteLine(parent),
      child,
      noteLine(child),
      line("tail", "page", 0)
    ]);
    const fake = fakeEditor({});
    const adapter = new MonacoOutlinePaneAdapter({
      paneId: "primary",
      editor: fake.editor,
      session: stubSession(metadata),
      zoomRootId: null,
      showCompleted: true,
      navigation: navigation()
    });

    expect(fake.setHiddenAreas).toHaveBeenCalledWith(
      [new monaco.Range(3, 1, 4, 1)],
      "yonalist-outline-primary",
      true
    );
    adapter.dispose();
  });

  it("realigns the caret when the caret sits on a note line", () => {
    const title = line("a", "page", 0);
    const metadata = snapshot([title, noteLine(title)]);
    const setCursorStates = vi.fn();
    const fake = fakeEditor({});
    const editor = fake.editor as unknown as Record<string, unknown>;
    editor.getSelection = () => new monaco.Selection(2, 1, 2, 1);
    editor._getViewModel = () => ({
      coordinatesConverter: {
        convertModelPositionToViewPosition: (
          _position: monaco.Position,
          affinity?: number
        ) => affinity === 1
          ? new monaco.Position(2, 7)
          : new monaco.Position(2, 1)
      },
      setCursorStates
    });
    const adapter = new MonacoOutlinePaneAdapter({
      paneId: "primary",
      editor: fake.editor,
      session: stubSession(metadata),
      zoomRootId: null,
      showCompleted: true,
      navigation: navigation()
    });

    adapter.setZoomRoot("a");
    expect(setCursorStates).toHaveBeenCalled();
    adapter.dispose();
  });

  it("realigns the caret when structural metadata changes the prefix", () => {
    const metadata = snapshot([line("a", "page", 0)]);
    const listeners = new Set<(structural: boolean) => void>();
    const session = {
      metadata: { current: () => metadata },
      subscribeMetadata: (listener: (structural: boolean) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    } as unknown as ConstructorParameters<
      typeof MonacoOutlinePaneAdapter
    >[0]["session"];
    const setCursorStates = vi.fn();
    const fake = fakeEditor({});
    const editor = fake.editor as unknown as Record<string, unknown>;
    editor.getSelection = () => new monaco.Selection(1, 1, 1, 1);
    editor._getViewModel = () => ({
      coordinatesConverter: {
        convertModelPositionToViewPosition: (
          _position: monaco.Position,
          affinity?: number
        ) =>
          affinity === 1
            ? new monaco.Position(1, 8)
            : new monaco.Position(1, 1)
      },
      setCursorStates
    });
    const adapter = new MonacoOutlinePaneAdapter({
      paneId: "primary",
      editor: fake.editor,
      session,
      zoomRootId: null,
      showCompleted: true,
      navigation: navigation()
    });
    setCursorStates.mockClear();

    listeners.forEach((listener) => listener(false));
    expect(setCursorStates).not.toHaveBeenCalled();

    listeners.forEach((listener) => listener(true));
    expect(setCursorStates).toHaveBeenCalledOnce();
    adapter.dispose();
  });

  it("routes a normal click locally and Shift click to the secondary pane", () => {
    const target = navigation();

    routeBulletClick({ nodeId: "a", shiftKey: false }, target);
    routeBulletClick({ nodeId: "a", shiftKey: true }, target);

    expect(target.zoomSamePane).toHaveBeenCalledWith("a");
    expect(target.openSecondary).toHaveBeenCalledWith("a");
  });

  it("keeps zoom and view state local to each editor over one session", () => {
    const metadata = snapshot([
      line("a", "page", 0),
      line("a-child", "a", 1),
      line("b", "page", 0)
    ]);
    const listeners = new Set<(structural: boolean) => void>();
    const session = {
      metadata: { current: () => metadata },
      subscribeMetadata: (listener: (structural: boolean) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    } as unknown as ConstructorParameters<
      typeof MonacoOutlinePaneAdapter
    >[0]["session"];
    const leftState = { cursorState: [], viewState: {} };
    const left = fakeEditor(leftState);
    const right = fakeEditor({ cursorState: [], viewState: {} });
    const leftAdapter = new MonacoOutlinePaneAdapter({
      paneId: "primary",
      editor: left.editor,
      session,
      zoomRootId: null,
      showCompleted: true,
      navigation: navigation()
    });
    const rightAdapter = new MonacoOutlinePaneAdapter({
      paneId: "secondary",
      editor: right.editor,
      session,
      zoomRootId: "b",
      showCompleted: true,
      navigation: navigation()
    });

    leftAdapter.setZoomRoot("a");
    leftAdapter.setZoomRoot(null);

    expect(left.restoreViewState).toHaveBeenCalledWith(leftState);
    expect(right.restoreViewState).not.toHaveBeenCalled();
    expect(right.setHiddenAreas).toHaveBeenCalledWith(
      [new monaco.Range(1, 1, 3, 1)],
      "yonalist-outline-secondary",
      true
    );
    expect(right.host).toHaveAttribute("data-empty-zoom", "true");
    expect(left.collectionSet).toHaveBeenCalledOnce();
    expect(right.collectionSet).toHaveBeenCalledOnce();
    const leftHiddenUpdates = left.setHiddenAreas.mock.calls.length;
    const rightHiddenUpdates = right.setHiddenAreas.mock.calls.length;
    listeners.forEach((listener) => listener(false));
    expect(left.setHiddenAreas).toHaveBeenCalledTimes(leftHiddenUpdates);
    expect(right.setHiddenAreas).toHaveBeenCalledTimes(rightHiddenUpdates);
    expect(left.collectionSet).toHaveBeenCalledOnce();
    expect(right.collectionSet).toHaveBeenCalledOnce();

    listeners.forEach((listener) => listener(true));
    expect(left.collectionSet).toHaveBeenCalledTimes(2);
    expect(right.collectionSet).toHaveBeenCalledTimes(2);
    expect(leftAdapter.diagnostics()).toEqual({
      disposed: false,
      savedViewStates: 2,
      viewDecorations: 3,
      liveSubscriptions: 3
    });
    leftAdapter.dispose();
    leftAdapter.dispose();
    rightAdapter.dispose();
    expect(leftAdapter.diagnostics()).toEqual({
      disposed: true,
      savedViewStates: 0,
      viewDecorations: 0,
      liveSubscriptions: 0
    });
    expect(listeners.size).toBe(0);
  });
});

function fakeEditor(viewState: unknown): {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  readonly host: HTMLDivElement;
  readonly restoreViewState: ReturnType<typeof vi.fn>;
  readonly setHiddenAreas: ReturnType<typeof vi.fn>;
  readonly collectionSet: ReturnType<typeof vi.fn>;
} {
  const host = document.createElement("div");
  const restoreViewState = vi.fn();
  const setHiddenAreas = vi.fn();
  const collectionSet = vi.fn();
  return {
    editor: {
      saveViewState: vi.fn().mockReturnValue(viewState),
      restoreViewState,
      getSelection: vi.fn().mockReturnValue(null),
      getDomNode: vi.fn().mockReturnValue(host),
      setHiddenAreas,
      getVisibleRanges: vi.fn().mockReturnValue([new monaco.Range(1, 1, 3, 1)]),
      getPosition: vi.fn().mockReturnValue({ lineNumber: 1, column: 1 }),
      getLayoutInfo: vi.fn().mockReturnValue({ height: 75 }),
      createDecorationsCollection: vi.fn().mockReturnValue({
        set: collectionSet,
        clear: vi.fn()
      }),
      onDidScrollChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      onDidLayoutChange: vi.fn().mockReturnValue({ dispose: vi.fn() })
    } as unknown as monaco.editor.IStandaloneCodeEditor,
    host,
    restoreViewState,
    setHiddenAreas,
    collectionSet
  };
}
