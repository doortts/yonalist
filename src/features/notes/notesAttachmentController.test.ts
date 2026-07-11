import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSupportedImageFile,
  isSupportedImagePath,
  nativeNotesAttachmentUi
} from "./notesAttachmentController";

const open = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));

afterEach(() => {
  open.mockReset();
});

describe("notes attachment UI boundary", () => {
  it("opens the native dialog with one image-only file filter", async () => {
    open.mockResolvedValue("/incoming/diagram.PNG");

    await expect(nativeNotesAttachmentUi.openImageFile()).resolves.toBe(
      "/incoming/diagram.PNG"
    );
    expect(open).toHaveBeenCalledWith({
      directory: false,
      multiple: false,
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "webp", "gif"]
        }
      ]
    });
  });

  it("keeps native cancellation silent and ignores non-string selections", async () => {
    open.mockResolvedValueOnce(null).mockResolvedValueOnce(["/one.png"]);

    await expect(nativeNotesAttachmentUi.openImageFile()).resolves.toBeNull();
    await expect(nativeNotesAttachmentUi.openImageFile()).resolves.toBeNull();
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
