import { describe, expect, it, vi } from "vitest";
import { extractClipboardImages } from "./notesClipboardImages";

function clipboardItem(
  kind: DataTransferItem["kind"],
  type: string,
  file: File | null
): DataTransferItem {
  return Object.freeze({
    kind,
    type,
    getAsFile: vi.fn(() => file),
    getAsString: vi.fn(),
    webkitGetAsEntry: vi.fn()
  }) as unknown as DataTransferItem;
}

function clipboardItems(
  entries: readonly DataTransferItem[]
): DataTransferItemList {
  const items = Object.assign([...entries], {
    add: vi.fn(),
    clear: vi.fn(),
    remove: vi.fn()
  });
  return Object.freeze(items) as unknown as DataTransferItemList;
}

describe("extractClipboardImages", () => {
  it("returns none for text and non-image file items without mutating the input", () => {
    const text = clipboardItem("string", "text/plain", null);
    const pdf = clipboardItem(
      "file",
      "application/pdf",
      new File(["pdf"], "document.pdf", { type: "application/pdf" })
    );
    const items = clipboardItems([text, pdf]);

    expect(extractClipboardImages(items)).toEqual({ kind: "none" });
    expect(text.getAsFile).not.toHaveBeenCalled();
    expect(pdf.getAsFile).not.toHaveBeenCalled();
    expect(items.clear).not.toHaveBeenCalled();
    expect(items.remove).not.toHaveBeenCalled();
  });

  it("returns every image descriptor in source order and ignores other flavors", () => {
    const first = new File(["first"], "first.png", { type: "image/png" });
    const second = new File(["second"], "second.jpg", {
      type: "image/jpeg"
    });
    const items = clipboardItems([
      clipboardItem("string", "text/plain", null),
      clipboardItem("file", "image/png", first),
      clipboardItem(
        "file",
        "application/pdf",
        new File(["pdf"], "document.pdf", { type: "application/pdf" })
      ),
      clipboardItem("file", "image/jpeg", second)
    ]);

    expect(extractClipboardImages(items)).toEqual({
      kind: "images",
      items: [
        { blob: first, originalName: "first.png", mimeType: "image/png" },
        { blob: second, originalName: "second.jpg", mimeType: "image/jpeg" }
      ]
    });
  });

  it("returns one error and no partial descriptors when an image has no file", () => {
    const readable = new File(["first"], "first.png", {
      type: "image/png"
    });
    const items = clipboardItems([
      clipboardItem("file", "image/png", readable),
      clipboardItem("file", "image/jpeg", null)
    ]);

    const result = extractClipboardImages(items);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message.trim()).not.toBe("");
    }
    expect(result).not.toHaveProperty("items");
  });

  it("generates canonical names for unnamed supported image MIME types", () => {
    const files = [
      new File(["png"], "", { type: "image/png" }),
      new File(["jpeg"], "", { type: "image/jpeg" }),
      new File(["webp"], "", { type: "image/webp" }),
      new File(["gif"], "", { type: "image/gif" })
    ];
    const items = clipboardItems([
      clipboardItem("file", "image/png", files[0]),
      clipboardItem("string", "text/html", null),
      clipboardItem("file", "image/jpeg", files[1]),
      clipboardItem("file", "image/webp", files[2]),
      clipboardItem("file", "image/gif", files[3])
    ]);

    const result = extractClipboardImages(items);

    expect(result.kind).toBe("images");
    if (result.kind === "images") {
      expect(result.items.map(({ originalName }) => originalName)).toEqual([
        "clipboard-image-1.png",
        "clipboard-image-2.jpg",
        "clipboard-image-3.webp",
        "clipboard-image-4.gif"
      ]);
    }
  });

  it("passes unsupported image MIME types through with an extensionless fallback name", () => {
    const unsupported = new File(["heic"], "", { type: "image/heic" });
    const items = clipboardItems([
      clipboardItem("file", "image/heic", unsupported)
    ]);

    expect(extractClipboardImages(items)).toEqual({
      kind: "images",
      items: [
        {
          blob: unsupported,
          originalName: "clipboard-image-1",
          mimeType: "image/heic"
        }
      ]
    });
  });
});
