import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSupportedImageFile,
  isSupportedImagePath,
  nativeNotesAttachmentUi
} from "./notesAttachmentController";

const open = vi.hoisted(() => vi.fn());
const scaleFactor = vi.hoisted(() => vi.fn());
const onDragDropEvent = vi.hoisted(() => vi.fn());
const useNotesWorkspace = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent })
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ scaleFactor })
}));
vi.mock("./useNotesWorkspace", () => ({ useNotesWorkspace }));

afterEach(() => {
  open.mockReset();
  scaleFactor.mockReset();
  onDragDropEvent.mockReset();
  useNotesWorkspace.mockReset();
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

  it("keeps the single-file picker as a first-result delegate", async () => {
    open.mockResolvedValueOnce(["/incoming/one.png", "/incoming/two.webp"]);

    await expect(nativeNotesAttachmentUi.openImageFile()).resolves.toBe(
      "/incoming/one.png"
    );
  });

  it("normalizes native drop positions with the current scale factor", async () => {
    const unlisten = vi.fn();
    const listener = vi.fn();
    let nativeDropHandler:
      | ((event: { payload: unknown }) => void | Promise<void>)
      | undefined;
    onDragDropEvent.mockImplementation(async (handler) => {
      nativeDropHandler = handler;
      return unlisten;
    });
    scaleFactor.mockResolvedValueOnce(2).mockResolvedValueOnce(1.5);
    const enterToLogical = vi.fn(() => ({ x: 120, y: 80 }));
    const dropToLogical = vi.fn(() => ({ x: 240, y: 160 }));

    await expect(
      nativeNotesAttachmentUi.subscribeToImageDrop?.(listener)
    ).resolves.toBe(unlisten);
    await nativeDropHandler?.({
      payload: {
        type: "enter",
        paths: ["/incoming/one.png"],
        position: { toLogical: enterToLogical }
      }
    });
    await nativeDropHandler?.({
      payload: {
        type: "drop",
        paths: ["/incoming/two.webp"],
        position: { toLogical: dropToLogical }
      }
    });

    expect(enterToLogical).toHaveBeenCalledWith(2);
    expect(dropToLogical).toHaveBeenCalledWith(1.5);
    expect(scaleFactor).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, {
      type: "enter",
      paths: ["/incoming/one.png"],
      position: { x: 120, y: 80 }
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      type: "drop",
      paths: ["/incoming/two.webp"],
      position: { x: 240, y: 160 }
    });
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
      openImageFile: vi.fn().mockResolvedValue(null),
      openImageFiles: vi.fn().mockResolvedValue(null),
      pathForDroppedFile: vi.fn().mockReturnValue(null)
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

  it("validates supported image paths, MIME types, and local dropped paths", () => {
    const image = new File(["x"], "photo.jpeg", { type: "image/jpeg" });
    Object.defineProperty(image, "path", { value: "/incoming/photo.jpeg" });
    const spoofed = new File(["x"], "photo.svg", { type: "image/png" });

    expect(isSupportedImagePath("/incoming/photo.WEBP")).toBe(true);
    expect(isSupportedImagePath("https://example.com/photo.png")).toBe(false);
    expect(isSupportedImageFile(image)).toBe(true);
    expect(isSupportedImageFile(spoofed)).toBe(false);
    expect(nativeNotesAttachmentUi.pathForDroppedFile(image)).toBe(
      "/incoming/photo.jpeg"
    );
    expect(
      nativeNotesAttachmentUi.pathForDroppedFile(
        new File(["x"], "photo.png", { type: "image/png" })
      )
    ).toBeNull();
  });
});
