import { render, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  createEditor: vi.fn(),
  paneInputs: [] as unknown[],
  paneZoom: vi.fn(),
  paneCompleted: vi.fn(),
  paneDispose: vi.fn(),
  bind: vi.fn(),
  assertCapabilities: vi.fn()
}));

vi.mock("monaco-editor/esm/vs/editor/editor.api", () => ({
  editor: {
    create: mocks.createEditor
  }
}));

vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: class EditorWorker {}
}));

vi.mock("./monaco-outline/internalAdapter", () => ({
  assertMonacoInternalCapabilities: mocks.assertCapabilities
}));

vi.mock("./monaco-outline/paneAdapter", () => ({
  MonacoOutlinePaneAdapter: class {
    constructor(input: unknown) {
      mocks.paneInputs.push(input);
    }

    setZoomRoot(value: string | null) {
      mocks.paneZoom(value);
    }

    setShowCompleted(value: boolean) {
      mocks.paneCompleted(value);
    }

    dispose() {
      mocks.paneDispose();
    }
  }
}));

vi.mock("./monaco-outline/plugin", () => ({
  bindYonalistOutlineEditor: mocks.bind
}));

import type { MonacoSessionRegistry } from "./monaco-outline/sessionRegistry";
import MonacoOutlineSurface from "./MonacoOutlineSurface";

describe("MonacoOutlineSurface", () => {
  beforeEach(() => {
    mocks.createEditor.mockReset();
    mocks.paneInputs.length = 0;
    mocks.paneZoom.mockReset();
    mocks.paneCompleted.mockReset();
    mocks.paneDispose.mockReset();
    mocks.bind.mockReset();
    mocks.assertCapabilities.mockReset();
  });

  it("leases one page session and keeps zoom changes pane-local", async () => {
    const editor = {
      onDidBlurEditorText: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      dispose: vi.fn()
    };
    mocks.createEditor.mockReturnValue(editor);
    mocks.bind.mockReturnValue({ dispose: vi.fn() });
    const session = {
      model: { id: "shared-model" },
      ensureEditableLine: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      subscribePersistence: vi.fn().mockReturnValue(() => undefined),
      persistenceState: vi.fn().mockReturnValue({
        kind: "saved",
        pending: 0
      })
    };
    const release = vi.fn().mockResolvedValue(undefined);
    const registry = {
      acquire: vi.fn().mockResolvedValue({ session, release })
    } as unknown as MonacoSessionRegistry;
    const onZoom = vi.fn();
    const onSplit = vi.fn();
    const onUnsupported = vi.fn();
    const onSessionChange = vi.fn();
    const view = render(
      <MonacoOutlineSurface
        pageId="page"
        paneId="secondary"
        zoomRootId="child"
        showCompleted
        registry={registry}
        focusRequest={null}
        onSessionChange={onSessionChange}
        onZoomRootChange={onZoom}
        onOpenSplit={onSplit}
        onUnsupported={onUnsupported}
      />
    );

    await waitFor(() => expect(registry.acquire).toHaveBeenCalledWith("page"));
    await waitFor(() => expect(mocks.paneInputs).toHaveLength(1));
    expect(onSessionChange).toHaveBeenCalledWith(session);
    expect(mocks.paneInputs[0]).toEqual(expect.objectContaining({
      paneId: "secondary",
      zoomRootId: "child",
      session
    }));
    expect(mocks.createEditor).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        model: session.model,
        fontSize: 16,
        lineHeight: 25
      })
    );

    view.rerender(
      <MonacoOutlineSurface
        pageId="page"
        paneId="secondary"
        zoomRootId="next"
        showCompleted={false}
        registry={registry}
        focusRequest={null}
        onSessionChange={onSessionChange}
        onZoomRootChange={onZoom}
        onOpenSplit={onSplit}
        onUnsupported={onUnsupported}
      />
    );
    expect(mocks.paneZoom).toHaveBeenCalledWith("next");
    expect(mocks.paneCompleted).toHaveBeenCalledWith(false);

    view.unmount();
    expect(editor.dispose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(onSessionChange).toHaveBeenLastCalledWith(null);
  });
});
