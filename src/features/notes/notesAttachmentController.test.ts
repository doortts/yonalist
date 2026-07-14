import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TauriEvent } from "@tauri-apps/api/event";
import {
  isSupportedImageFile,
  isSupportedImagePath,
  nativeNotesAttachmentUi
} from "./notesAttachmentController";

const open = vi.hoisted(() => vi.fn());
const scaleFactor = vi.hoisted(() => vi.fn());
const onScaleChanged = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
const useNotesWorkspace = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ listen })
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onScaleChanged, scaleFactor })
}));
vi.mock("./useNotesWorkspace", () => ({ useNotesWorkspace }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

type NativeEventHandler<T = unknown> = (event: { payload: T }) => void;

const dragEventNames = [
  TauriEvent.DRAG_ENTER,
  TauriEvent.DRAG_OVER,
  TauriEvent.DRAG_DROP,
  TauriEvent.DRAG_LEAVE
] as const;

function enableTauri() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {}
  });
}

function captureDragHandlers(
  unlisteners: readonly (() => void | Promise<void>)[] = dragEventNames.map(() =>
    vi.fn()
  )
) {
  const handlers = new Map<string, NativeEventHandler>();
  let registrationIndex = 0;
  listen.mockImplementation(async (eventName, handler) => {
    handlers.set(eventName, handler);
    const unlisten = unlisteners[registrationIndex];
    registrationIndex += 1;
    if (!unlisten) throw new Error(`Missing unlisten for ${eventName}`);
    return unlisten;
  });
  return handlers;
}

beforeEach(() => {
  onScaleChanged.mockResolvedValue(vi.fn());
});

afterEach(() => {
  open.mockReset();
  scaleFactor.mockReset();
  onScaleChanged.mockReset();
  listen.mockReset();
  useNotesWorkspace.mockReset();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  Reflect.deleteProperty(window.navigator, "platform");
  Reflect.deleteProperty(window.navigator, "userAgent");
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

  it("keeps a scale change that arrives while the baseline query is pending", async () => {
    enableTauri();
    const handlers = captureDragHandlers();
    const listener = vi.fn();
    const pendingScaleFactor = deferred<number>();
    let scaleChangedHandler: NativeEventHandler<{ scaleFactor: number }> | undefined;
    onScaleChanged.mockImplementation(async (handler) => {
      scaleChangedHandler = handler;
      return vi.fn();
    });
    scaleFactor.mockReturnValue(pendingScaleFactor.promise);

    const subscription = nativeNotesAttachmentUi.subscribeToImageDrop(listener);
    await vi.waitFor(() => expect(onScaleChanged).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(scaleFactor).toHaveBeenCalledOnce());

    expect(onScaleChanged.mock.invocationCallOrder[0]).toBeLessThan(
      scaleFactor.mock.invocationCallOrder[0]
    );
    expect(listen).not.toHaveBeenCalled();
    scaleChangedHandler?.({ payload: { scaleFactor: 1.5 } });
    pendingScaleFactor.resolve(2);
    await expect(subscription).resolves.toEqual(expect.any(Function));
    expect(new Set(listen.mock.calls.map(([eventName]) => eventName))).toEqual(
      new Set(dragEventNames)
    );

    handlers.get(TauriEvent.DRAG_ENTER)?.({
      payload: {
        paths: ["/incoming/one.png"],
        position: { x: 150, y: 90 }
      }
    });
    expect(listener).toHaveBeenCalledWith({
      type: "enter",
      paths: ["/incoming/one.png"],
      position: { x: 100, y: 60 }
    });
  });

  it("keeps macOS native drag coordinates in CSS point space on Retina displays", async () => {
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel"
    });
    enableTauri();
    const handlers = captureDragHandlers();
    const listener = vi.fn();
    scaleFactor.mockResolvedValue(2);

    await nativeNotesAttachmentUi.subscribeToImageDrop(listener);
    handlers.get(TauriEvent.DRAG_DROP)?.({
      payload: {
        paths: ["/incoming/retina.png"],
        position: { x: 690, y: 111 }
      }
    });

    expect(listener).toHaveBeenCalledWith({
      type: "drop",
      paths: ["/incoming/retina.png"],
      position: { x: 690, y: 111 }
    });
  });

  it("recognizes macOS drag coordinates from the WKWebView user agent fallback", async () => {
    Object.defineProperties(window.navigator, {
      platform: { configurable: true, value: "" },
      userAgent: {
        configurable: true,
        value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
      }
    });
    enableTauri();
    const handlers = captureDragHandlers();
    const listener = vi.fn();
    scaleFactor.mockResolvedValue(2);

    await nativeNotesAttachmentUi.subscribeToImageDrop(listener);
    handlers.get(TauriEvent.DRAG_OVER)?.({
      payload: { position: { x: 640, y: 360 } }
    });

    expect(listener).toHaveBeenCalledWith({
      type: "over",
      position: { x: 640, y: 360 }
    });
  });

  it("converts Windows native physical drag coordinates to CSS pixels", async () => {
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "Win32"
    });
    enableTauri();
    const handlers = captureDragHandlers();
    const listener = vi.fn();
    scaleFactor.mockResolvedValue(2);

    await nativeNotesAttachmentUi.subscribeToImageDrop(listener);
    handlers.get(TauriEvent.DRAG_DROP)?.({
      payload: {
        paths: ["C:\\incoming\\retina.png"],
        position: { x: 690, y: 110 }
      }
    });

    expect(listener).toHaveBeenCalledWith({
      type: "drop",
      paths: ["C:\\incoming\\retina.png"],
      position: { x: 345, y: 55 }
    });
  });

  it("discards pre-ready callbacks and forwards only fresh events after ready", async () => {
    enableTauri();
    const handlers = new Map<string, NativeEventHandler>();
    const registrationOrder = [
      TauriEvent.DRAG_LEAVE,
      TauriEvent.DRAG_DROP,
      TauriEvent.DRAG_OVER,
      TauriEvent.DRAG_ENTER
    ] as const;
    const registrations = new Map(
      registrationOrder.map(
        (eventName) => [eventName, deferred<() => void>()] as const
      )
    );
    const dragUnlisteners = new Map(
      registrationOrder.map((eventName) => [eventName, vi.fn()] as const)
    );
    listen.mockImplementation((eventName, handler) => {
      handlers.set(eventName, handler);
      return registrations.get(eventName)!.promise;
    });
    scaleFactor.mockResolvedValue(2);
    const listener = vi.fn();

    const subscription = nativeNotesAttachmentUi.subscribeToImageDrop(listener);
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    expect(listen).toHaveBeenNthCalledWith(
      1,
      TauriEvent.DRAG_LEAVE,
      expect.any(Function)
    );
    handlers.get(TauriEvent.DRAG_LEAVE)?.({ payload: undefined });
    expect(listener).not.toHaveBeenCalled();
    registrations
      .get(TauriEvent.DRAG_LEAVE)!
      .resolve(dragUnlisteners.get(TauriEvent.DRAG_LEAVE)!);

    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(2));
    expect(listen).toHaveBeenNthCalledWith(
      2,
      TauriEvent.DRAG_DROP,
      expect.any(Function)
    );
    handlers.get(TauriEvent.DRAG_DROP)?.({
      payload: {
        paths: ["/incoming/pre-ready.webp"],
        position: { x: 180, y: 80 }
      }
    });
    expect(listener).not.toHaveBeenCalled();
    registrations
      .get(TauriEvent.DRAG_DROP)!
      .resolve(dragUnlisteners.get(TauriEvent.DRAG_DROP)!);

    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(3));
    expect(listen).toHaveBeenNthCalledWith(
      3,
      TauriEvent.DRAG_OVER,
      expect.any(Function)
    );
    handlers.get(TauriEvent.DRAG_OVER)?.({
      payload: { position: { x: 190, y: 90 } }
    });
    expect(listener).not.toHaveBeenCalled();
    registrations
      .get(TauriEvent.DRAG_OVER)!
      .resolve(dragUnlisteners.get(TauriEvent.DRAG_OVER)!);

    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(4));
    expect(listen).toHaveBeenNthCalledWith(
      4,
      TauriEvent.DRAG_ENTER,
      expect.any(Function)
    );
    handlers.get(TauriEvent.DRAG_ENTER)?.({
      payload: {
        paths: ["/incoming/pre-ready.png"],
        position: { x: 200, y: 100 }
      }
    });
    expect(listener).not.toHaveBeenCalled();
    registrations
      .get(TauriEvent.DRAG_ENTER)!
      .resolve(dragUnlisteners.get(TauriEvent.DRAG_ENTER)!);
    const cleanup = await subscription;

    expect(listener).not.toHaveBeenCalled();
    handlers.get(TauriEvent.DRAG_ENTER)?.({
      payload: {
        paths: ["/incoming/one.png"],
        position: { x: 200, y: 100 }
      }
    });
    handlers.get(TauriEvent.DRAG_OVER)?.({
      payload: { position: { x: 220, y: 120 } }
    });
    handlers.get(TauriEvent.DRAG_DROP)?.({
      payload: {
        paths: ["/incoming/two.webp"],
        position: { x: 240, y: 140 }
      }
    });
    handlers.get(TauriEvent.DRAG_LEAVE)?.({ payload: undefined });

    expect(listener).toHaveBeenNthCalledWith(1, {
      type: "enter",
      paths: ["/incoming/one.png"],
      position: { x: 100, y: 50 }
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      type: "over",
      position: { x: 110, y: 60 }
    });
    expect(listener).toHaveBeenNthCalledWith(3, {
      type: "drop",
      paths: ["/incoming/two.webp"],
      position: { x: 120, y: 70 }
    });
    expect(listener).toHaveBeenNthCalledWith(4, { type: "leave" });
    expect(listener).toHaveBeenCalledTimes(4);
    await cleanup();
  });

  it("discards pre-ready callbacks when enter registration fails", async () => {
    enableTauri();
    const handlers = new Map<string, NativeEventHandler>();
    const setupFailure = new Error("enter registration failed");
    const unlistenScale = vi.fn();
    const registrationOrder = [
      TauriEvent.DRAG_LEAVE,
      TauriEvent.DRAG_DROP,
      TauriEvent.DRAG_OVER,
      TauriEvent.DRAG_ENTER
    ] as const;
    const registrations = new Map(
      registrationOrder.map(
        (eventName) => [eventName, deferred<() => void>()] as const
      )
    );
    const dragUnlisteners = new Map(
      registrationOrder.slice(0, 3).map((eventName) => [eventName, vi.fn()] as const)
    );
    listen.mockImplementation((eventName, handler) => {
      handlers.set(eventName, handler);
      return registrations.get(eventName)!.promise;
    });
    scaleFactor.mockResolvedValue(2);
    onScaleChanged.mockResolvedValue(unlistenScale);
    const listener = vi.fn();

    const subscription = nativeNotesAttachmentUi.subscribeToImageDrop(listener);
    for (let index = 0; index < 3; index += 1) {
      const eventName = registrationOrder[index];
      await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(index + 1));
      handlers.get(eventName)?.({
        payload:
          eventName === TauriEvent.DRAG_LEAVE
            ? undefined
            : eventName === TauriEvent.DRAG_DROP
              ? {
                  paths: ["/incoming/pre-ready.webp"],
                  position: { x: 180, y: 80 }
                }
              : { position: { x: 190, y: 90 } }
      });
      expect(listener).not.toHaveBeenCalled();
      registrations.get(eventName)!.resolve(dragUnlisteners.get(eventName)!);
    }

    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(4));
    handlers.get(TauriEvent.DRAG_ENTER)?.({
      payload: {
        paths: ["/incoming/stale.png"],
        position: { x: 200, y: 100 }
      }
    });
    expect(listener).not.toHaveBeenCalled();

    const rejectedSetup = expect(subscription).rejects.toBe(setupFailure);
    registrations.get(TauriEvent.DRAG_ENTER)!.reject(setupFailure);
    await rejectedSetup;

    handlers.get(TauriEvent.DRAG_ENTER)?.({
      payload: {
        paths: ["/incoming/still-stale.png"],
        position: { x: 220, y: 120 }
      }
    });
    expect(listener).not.toHaveBeenCalled();
    expect(listen).toHaveBeenCalledTimes(4);
    for (const unlisten of dragUnlisteners.values()) {
      expect(unlisten).toHaveBeenCalledOnce();
    }
    expect(unlistenScale).toHaveBeenCalledOnce();
  });

  it("forwards native events synchronously in source order after setup", async () => {
    enableTauri();
    const handlers = captureDragHandlers();
    const listener = vi.fn();
    scaleFactor
      .mockResolvedValueOnce(2)
      .mockReturnValue(new Promise<number>(() => {}));

    await expect(
      nativeNotesAttachmentUi.subscribeToImageDrop(listener)
    ).resolves.toEqual(expect.any(Function));
    handlers.get(TauriEvent.DRAG_ENTER)?.({
      payload: {
        paths: ["/incoming/one.png"],
        position: { x: 240, y: 160 }
      }
    });
    handlers.get(TauriEvent.DRAG_OVER)?.({
      payload: {
        position: { x: 360, y: 240 }
      }
    });
    handlers.get(TauriEvent.DRAG_LEAVE)?.({ payload: undefined });
    handlers.get(TauriEvent.DRAG_DROP)?.({
      payload: {
        paths: ["/incoming/two.webp"],
        position: { x: 480, y: 320 }
      }
    });

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
    enableTauri();
    const handlers = captureDragHandlers();
    let scaleChangedHandler: NativeEventHandler<{ scaleFactor: number }> | undefined;
    onScaleChanged.mockImplementation(async (handler) => {
      scaleChangedHandler = handler;
      return vi.fn();
    });
    scaleFactor.mockResolvedValue(2);
    const listener = vi.fn();

    await nativeNotesAttachmentUi.subscribeToImageDrop(listener);
    handlers.get(TauriEvent.DRAG_ENTER)?.({
      payload: {
        paths: ["/incoming/one.png"],
        position: { x: 200, y: 160 }
      }
    });
    scaleChangedHandler?.({ payload: { scaleFactor: 1.5 } });
    handlers.get(TauriEvent.DRAG_DROP)?.({
      payload: {
        paths: ["/incoming/two.webp"],
        position: { x: 300, y: 240 }
      }
    });

    expect(listener).toHaveBeenNthCalledWith(1, {
      type: "enter",
      paths: ["/incoming/one.png"],
      position: { x: 100, y: 80 }
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      type: "drop",
      paths: ["/incoming/two.webp"],
      position: { x: 200, y: 160 }
    });
  });

  it("rolls back the scale listener when the baseline query fails", async () => {
    enableTauri();
    const queryFailure = new Error("scale query failed");
    const unlistenScale = vi.fn();
    onScaleChanged.mockResolvedValue(unlistenScale);
    scaleFactor.mockRejectedValue(queryFailure);

    await expect(
      nativeNotesAttachmentUi.subscribeToImageDrop(vi.fn())
    ).rejects.toBe(queryFailure);

    expect(listen).not.toHaveBeenCalled();
    expect(unlistenScale).toHaveBeenCalledOnce();
  });

  it.each([1, 2, 3])(
    "rolls back all listeners after %i successful drag registrations",
    async (successfulRegistrations) => {
      enableTauri();
      const setupFailure = new Error(
        `drag registration ${successfulRegistrations + 1} failed`
      );
      const unlistenScale = vi
        .fn()
        .mockRejectedValue(new Error("scale cleanup failed"));
      const dragUnlisteners = Array.from(
        { length: successfulRegistrations },
        (_, index) =>
          index === 0
            ? vi.fn().mockRejectedValue(new Error("drag cleanup failed"))
            : vi.fn()
      );
      let registrationIndex = 0;
      listen.mockImplementation(async () => {
        if (registrationIndex === successfulRegistrations) throw setupFailure;
        const unlisten = dragUnlisteners[registrationIndex];
        registrationIndex += 1;
        return unlisten;
      });
      scaleFactor.mockResolvedValue(2);
      onScaleChanged.mockResolvedValue(unlistenScale);

      await expect(
        nativeNotesAttachmentUi.subscribeToImageDrop(vi.fn())
      ).rejects.toBe(setupFailure);

      expect(listen).toHaveBeenCalledTimes(successfulRegistrations + 1);
      for (const unlisten of dragUnlisteners) {
        expect(unlisten).toHaveBeenCalledOnce();
      }
      expect(unlistenScale).toHaveBeenCalledOnce();
    }
  );

  it("absorbs teardown failures while attempting every cleanup", async () => {
    enableTauri();
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const unlistenScale = vi
      .fn()
      .mockRejectedValue(new Error("scale cleanup failed"));
    const dragUnlisteners = [
      vi.fn(() => {
        throw new Error("enter cleanup failed");
      }),
      vi.fn().mockRejectedValue(new Error("over cleanup failed")),
      vi.fn(),
      vi.fn().mockResolvedValue(undefined)
    ];
    captureDragHandlers(dragUnlisteners);
    scaleFactor.mockResolvedValue(2);
    onScaleChanged.mockResolvedValue(unlistenScale);

    try {
      const cleanup = await nativeNotesAttachmentUi.subscribeToImageDrop(vi.fn());
      await expect(cleanup()).resolves.toBeUndefined();
      await Promise.resolve();

      for (const unlisten of dragUnlisteners) {
        expect(unlisten).toHaveBeenCalledOnce();
      }
      expect(unlistenScale).toHaveBeenCalledOnce();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });

  it("runs successful cleanup only once", async () => {
    enableTauri();
    const unlistenScale = vi.fn();
    const dragUnlisteners = dragEventNames.map(() => vi.fn());
    captureDragHandlers(dragUnlisteners);
    scaleFactor.mockResolvedValue(2);
    onScaleChanged.mockResolvedValue(unlistenScale);

    const cleanup = await nativeNotesAttachmentUi.subscribeToImageDrop(vi.fn());
    await Promise.all([cleanup(), cleanup()]);
    await cleanup();

    for (const unlisten of dragUnlisteners) {
      expect(unlisten).toHaveBeenCalledOnce();
    }
    expect(unlistenScale).toHaveBeenCalledOnce();
  });

  it("provides an async no-op unlisten in the browser fallback", async () => {
    const listener = vi.fn();

    const unlisten = await nativeNotesAttachmentUi.subscribeToImageDrop(listener);
    await expect(unlisten()).resolves.toBeUndefined();
    expect(listen).not.toHaveBeenCalled();
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
    useNotesWorkspace.mockReturnValue({
      actions: { flushAllDrafts: vi.fn().mockResolvedValue(true) }
    });

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

  // Paths are prefixed with a separator where needed so the absolute-path gate
  // passes and the assertion exercises extension parsing rather than the gate.
  it.each([
    ["/tmp/png", false], // directory named "png" — no file extension
    ["C:\\gif", false], // windows directory named "gif" — no file extension
    ["/a/b.png", true],
    ["/photo.JPG", true], // uppercase extensions are accepted
    ["/archive.png.txt", false], // only the final extension segment counts
    ["photo.JPG", false] // relative paths are rejected by the absolute-path gate
  ] as const)("isSupportedImagePath(%j) === %s", (path, expected) => {
    expect(isSupportedImagePath(path)).toBe(expected);
  });
});
