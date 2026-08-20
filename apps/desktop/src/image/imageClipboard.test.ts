import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clipboardImageCandidates,
  writeImageClipboard
} from "./imageClipboard";

/** jsdom has no ClipboardItem, so the write contract is read off this one. */
class FakeClipboardItem {
  constructor(readonly data: Record<string, Promise<Blob>>) {}
}

function stubClipboard(write = vi.fn().mockResolvedValue(undefined)) {
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  Object.defineProperty(navigator, "clipboard", {
    value: { write },
    configurable: true
  });
  return write;
}

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

describe("image clipboard writing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("carries png bytes beside a pasteable filename line", async () => {
    const write = stubClipboard();

    await writeImageClipboard(
      Uint8Array.from([1, 2, 3]),
      "image/png",
      "cat.png"
    );

    const item = write.mock.calls[0]![0]![0] as FakeClipboardItem;
    expect(Object.keys(item.data)).toEqual(["image/png", "text/plain"]);
    const png = await item.data["image/png"]!;
    expect(png.type).toBe("image/png");
    expect(png.size).toBe(3);
    expect(await (await item.data["text/plain"]!).text()).toBe("- cat.png");
  });

  // An in-app paste has to bring the row back by hash, not import the bytes
  // again, so the rich payload rides beside the picture.
  it("carries a rich payload beside the bytes when one is given", async () => {
    const write = stubClipboard();

    await writeImageClipboard(
      Uint8Array.from([1, 2, 3]),
      "image/png",
      "cat.png",
      '<div data-yonalist-outline-clipboard="eyJ9"><ul><li>cat.png</li></ul></div>'
    );

    const item = write.mock.calls[0]![0]![0] as FakeClipboardItem;
    expect(Object.keys(item.data))
      .toEqual(["image/png", "text/plain", "text/html"]);
    expect(await (await item.data["text/html"]!).text())
      .toContain("yonalist-outline-clipboard");
  });

  // WebKit rejects a clipboard write that lands after the gesture that asked
  // for it, so the bytes ride in as a promise and the write goes out first.
  it("writes before the bytes arrive, still inside the gesture", () => {
    const write = stubClipboard();
    let deliver = (_bytes: Uint8Array) => undefined as void;
    const pending = new Promise<Uint8Array>((resolve) => {
      deliver = resolve;
    });

    void writeImageClipboard(pending, "image/png", "cat.png");

    expect(write).toHaveBeenCalledOnce();
    deliver(Uint8Array.from([1]));
  });

  // WebKit's ClipboardItem takes image/png alone, so anything else has to be
  // redrawn first -- and jsdom has no decoder to redraw it with. The refusal
  // now rides the item's own promise, which is what a real write rejects on.
  it("refuses a format it cannot redraw as png", async () => {
    const write = stubClipboard();

    await writeImageClipboard(Uint8Array.from([1]), "image/webp", "dog.webp");

    const item = write.mock.calls[0]![0]![0] as FakeClipboardItem;
    await expect(item.data["image/png"]).rejects.toThrow(/copied/);
  });

  it("refuses when the clipboard takes no items at all", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true
    });

    await expect(writeImageClipboard(
      Uint8Array.from([1]),
      "image/png",
      "cat.png"
    )).rejects.toThrow(/unavailable/);
  });
});
