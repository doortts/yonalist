import { describe, expect, it, vi } from "vitest";
import { clipboardImageCandidates } from "./imageClipboard";

function item(
  kind: string,
  type: string,
  file: File | null
): DataTransferItem {
  return {
    kind,
    type,
    getAsFile: vi.fn(() => file)
  } as unknown as DataTransferItem;
}

describe("image clipboard routing", () => {
  it("keeps supported file order and ignores HTML remote-image text", () => {
    const cat = new File([Uint8Array.from([1])], "cat.png", {
      type: "image/png"
    });
    const dog = new File([Uint8Array.from([2])], "dog.webp", {
      type: "image/webp"
    });
    const html = item("string", "text/html", null);

    const candidates = clipboardImageCandidates({
      items: [
        html,
        item("file", "image/png", cat),
        item("file", "image/svg+xml", new File(["<svg/>"], "bad.svg")),
        item("file", "image/webp", dog)
      ] as unknown as DataTransferItemList
    });

    expect(candidates.map((candidate) => candidate.originalName)).toEqual([
      "cat.png",
      "dog.webp"
    ]);
    expect(candidates.map((candidate) => candidate.blob)).toEqual([cat, dog]);
    expect(html.getAsFile).not.toHaveBeenCalled();
  });

  it("returns an empty batch for text-only clipboard data", () => {
    expect(clipboardImageCandidates({
      items: [
        item("string", "text/plain", null),
        item("string", "text/html", null)
      ] as unknown as DataTransferItemList
    })).toEqual([]);
  });
});
