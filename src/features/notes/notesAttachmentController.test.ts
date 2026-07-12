import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSupportedImageFile,
  isSupportedImagePath,
  nativeNotesAttachmentUi
} from "./notesAttachmentController";

const open = vi.hoisted(() => vi.fn());
const scaleFactor = vi.hoisted(() => vi.fn());
const onScaleChanged = vi.hoisted(() => vi.fn());
const onDragDropEvent = vi.hoisted(() => vi.fn());
const useNotesWorkspace = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent })
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onScaleChanged, scaleFactor })
}));
vi.mock("./useNotesWorkspace", () => ({ useNotesWorkspace }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  onScaleChanged.mockResolvedValue(vi.fn());
});

afterEach(() => {
  open.mockReset();
  scaleFactor.mockReset();
  onScaleChanged.mockReset();
  onDragDropEvent.mockReset();
  useNotesWorkspace.mockReset();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("notes attachment UI boundary", () => {
  it("opens the native dialog for multiple image files", async () => {
    open.mockResolvedValue(["/incoming/one.png", "/incoming/two.webp"]);

    await expect(nativeNotesAttachmentUi.openImageFiles()).resolves.toEqual([
      "/incoming/one.png",
      "/incoming/two.webp"
    ]);
    expect(open).toHaveBeenCalledWith({
      directory: false,
      multiple: true,
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "webp", "gif"]
        }
      ]
    });
  });

  it("normalizes legacy picker results and keeps cancellation silent", async () => {
    open
      .mockResolvedValueOnce("/incoming/legacy.png")
      .mockResolvedValueOnce(null);

    await expect(nativeNotesAttachmentUi.openImageFiles()).resolves.toEqual([
      "/incoming/legacy.png"
    ]);
    await expect(nativeNotesAttachmentUi.openImageFiles()).resolves.toBeNull();
  });

  it("resolves the scale factor before registering the native listener", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    const unlisten = vi.fn();
    const listener = vi.fn();
    const pendingScaleFactor = deferred<number>();
    scaleFactor.mockReturnValue(pendingScaleFactor.promise);
    onDragDropEvent.mockResolvedValue(unlisten);

    const subscription = nativeNotesAttachmentUi.subscribeToImageDrop(listener);
    await vi.waitFor(() => expect(scaleFactor).toHaveBeenCalledOnce());

    expect(onDragDropEvent).not.toHaveBeenCalled();
    pendingScaleFactor.resolve(2);
    await expect(subscription).resolves.toEqual(expect.any(Function));
    expect(onScaleChanged).toHaveBeenCalledOnce();
    expect(onDragDropEvent).toHaveBeenCalledOnce();
  });

  it("forwards native events synchronously in source order after setup", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    const unlisten = vi.fn();
    const listener = vi.fn();
    let nativeDropHandler:
      | ((event: { payload: unknown }) => void | Promise<void>)
      | undefined;
    onDragDropEvent.mockImplementation(async (handler) => {
      nativeDropHandler = handler;
      return unlisten;
    });
    scaleFactor
      .mockResolvedValueOnce(2)
      .mockReturnValue(new Promise<number>(() => {}));
    const enterToLogical = vi.fn(() => ({ x: 120, y: 80 }));
    const overToLogical = vi.fn(() => ({ x: 180, y: 120 }));
    const dropToLogical = vi.fn(() => ({ x: 240, y: 160 }));

    await expect(
      nativeNotesAttachmentUi.subscribeToImageDrop(listener)
    ).resolves.toEqual(expect.any(Function));
    nativeDropHandler?.({
      payload: {
        type: "enter",
        paths: ["/incoming/one.png"],
        position: { toLogical: enterToLogical }
      }
    });
    nativeDropHandler?.({
      payload: {
        type: "over",
        position: { toLogical: overToLogical }
      }
    });
    nativeDropHandler?.({ payload: { type: "leave" } });
    nativeDropHandler?.({
      payload: {
        type: "drop",
        paths: ["/incoming/two.webp"],
        position: { toLogical: dropToLogical }
      }
    });

    expect(enterToLogical).toHaveBeenCalledWith(2);
    expect(overToLogical).toHaveBeenCalledWith(2);
    expect(dropToLogical).toHaveBeenCalledWith(2);
    expect(scaleFactor).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenNthCalledWith(1, {
      type: "enter",
      paths: ["/incoming/one.png"],
      position: { x: 120, y: 80 }
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      type: "over",
      position: { x: 180, y: 120 }
    });
    expect(listener).toHaveBeenNthCalledWith(3, { type: "leave" });
    expect(listener).toHaveBeenNthCalledWith(4, {
      type: "drop",
      paths: ["/incoming/two.webp"],
      position: { x: 240, y: 160 }
    });
  });

  it("uses scale-change events for later mixed-DPI coordinates", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    let nativeDropHandler:
      | ((event: { payload: unknown }) => void | Promise<void>)
      | undefined;
    let scaleChangedHandler:
      | ((event: { payload: { scaleFactor: number } }) => void)
      | undefined;
    onDragDropEvent.mockImplementation(async (handler) => {
      nativeDropHandler = handler;
      return vi.fn();
    });
    onScaleChanged.mockImplementation(async (handler) => {
      scaleChangedHandler = handler;
      return vi.fn();
    });
    scaleFactor.mockResolvedValue(2);
    const beforeMove = vi.fn(() => ({ x: 100, y: 80 }));
    const afterMove = vi.fn(() => ({ x: 200, y: 160 }));
    const listener = vi.fn();

    await nativeNotesAttachmentUi.subscribeToImageDrop(listener);
    nativeDropHandler?.({
      payload: {
        type: "enter",
        paths: ["/incoming/one.png"],
        position: { toLogical: beforeMove }
      }
    });
    scaleChangedHandler?.({ payload: { scaleFactor: 1.5 } });
    nativeDropHandler?.({
      payload: {
        type: "drop",
        paths: ["/incoming/two.webp"],
        position: { toLogical: afterMove }
      }
    });

    expect(beforeMove).toHaveBeenCalledWith(2);
    expect(afterMove).toHaveBeenCalledWith(1.5);
    expect(listener.mock.calls.map(([event]) => event.type)).toEqual([
      "enter",
      "drop"
    ]);
  });

  it("unlistens both native subscriptions", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    const unlistenScale = vi.fn();
    const unlistenDrag = vi.fn();
    scaleFactor.mockResolvedValue(2);
    onScaleChanged.mockResolvedValue(unlistenScale);
    onDragDropEvent.mockResolvedValue(unlistenDrag);

    const unlisten = await nativeNotesAttachmentUi.subscribeToImageDrop(vi.fn());
    await unlisten();

    expect(unlistenDrag).toHaveBeenCalledOnce();
    expect(unlistenScale).toHaveBeenCalledOnce();
  });

  it("cleans up a scale listener when drag setup fails", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    const unlistenScale = vi.fn();
    scaleFactor.mockResolvedValue(2);
    onScaleChanged.mockResolvedValue(unlistenScale);
    onDragDropEvent.mockRejectedValue(new Error("drag setup failed"));

    await expect(
      nativeNotesAttachmentUi.subscribeToImageDrop(vi.fn())
    ).rejects.toThrow("drag setup failed");
    expect(unlistenScale).toHaveBeenCalledOnce();
  });

  it("provides an async no-op unlisten in the browser fallback", async () => {
    const listener = vi.fn();

    const unlisten = await nativeNotesAttachmentUi.subscribeToImageDrop(listener);
    await expect(unlisten()).resolves.toBeUndefined();
    expect(onDragDropEvent).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("exposes the native boundary through the attachment UI context by default", async () => {
    const [{ renderHook }, { useNotesAttachmentUi }] = await Promise.all([
      import("@testing-library/react"),
      import("./NotesAttachmentUiContext")
    ]);

    expect(renderHook(() => useNotesAttachmentUi()).result.current).toBe(
      nativeNotesAttachmentUi
    );
  });

  it("provides the same attachment boundary to the workspace and descendant panes", async () => {
    const [React, { render }, { NotesFeatureProvider }, attachmentContext] =
      await Promise.all([
        import("react"),
        import("@testing-library/react"),
        import("./NotesFeature"),
        import("./NotesAttachmentUiContext")
      ]);
    const attachmentUi = {
      openImageFiles: vi.fn().mockResolvedValue(null),
      subscribeToImageDrop: vi.fn().mockResolvedValue(vi.fn())
    };
    let providedAttachmentUi: unknown;
    useNotesWorkspace.mockReturnValue({});

    function AttachmentUiProbe() {
      providedAttachmentUi = attachmentContext.useNotesAttachmentUi();
      return null;
    }

    render(
      React.createElement(
        NotesFeatureProvider,
        { attachmentUi },
        React.createElement(AttachmentUiProbe)
      )
    );

    expect(providedAttachmentUi).toBe(attachmentUi);
    expect(useNotesWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentUi })
    );
  });

  it("validates supported image paths and MIME types without reading File.path", () => {
    const image = new File(["x"], "photo.jpeg", { type: "image/jpeg" });
    const spoofed = new File(["x"], "photo.svg", { type: "image/png" });

    expect(isSupportedImagePath("/incoming/photo.WEBP")).toBe(true);
    expect(isSupportedImagePath("https://example.com/photo.png")).toBe(false);
    expect(isSupportedImageFile(image)).toBe(true);
    expect(isSupportedImageFile(spoofed)).toBe(false);
    expect("openImageFile" in nativeNotesAttachmentUi).toBe(false);
    expect("pathForDroppedFile" in nativeNotesAttachmentUi).toBe(false);
  });
});
