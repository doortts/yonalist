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

function snapshot(
  lines: readonly OutlineLineMetadata[]
): OutlineMetadataSnapshot {
  return OutlineMetadataTimeline.hydrate(1, lines).current();
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
      new monaco.Range(1, 1, 2, 1)
    ]);
    expect(hiddenRangesForZoom(metadata, "a")).toEqual([
      new monaco.Range(3, 1, 3, 1)
    ]);
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
    const listeners = new Set<() => void>();
    const session = {
      metadata: { current: () => metadata },
      subscribeMetadata: (listener: () => void) => {
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
      [new monaco.Range(1, 1, 2, 1)],
      "yonalist-outline-secondary",
      true
    );
    leftAdapter.dispose();
    rightAdapter.dispose();
  });
});

function fakeEditor(viewState: unknown): {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  readonly restoreViewState: ReturnType<typeof vi.fn>;
  readonly setHiddenAreas: ReturnType<typeof vi.fn>;
} {
  const restoreViewState = vi.fn();
  const setHiddenAreas = vi.fn();
  return {
    editor: {
      saveViewState: vi.fn().mockReturnValue(viewState),
      restoreViewState,
      getSelection: vi.fn().mockReturnValue(null),
      setHiddenAreas
    } as unknown as monaco.editor.IStandaloneCodeEditor,
    restoreViewState,
    setHiddenAreas
  };
}
