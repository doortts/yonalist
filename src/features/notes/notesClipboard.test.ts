import { describe, expect, it, vi } from "vitest";
import {
  writeNotesClipboardEvent,
  writeNotesClipboardText,
  type NotesClipboardGlobals
} from "./notesClipboard";

class FakeBlob {
  readonly parts: readonly BlobPart[];
  readonly type: string;

  constructor(parts: readonly BlobPart[] = [], options?: BlobPropertyBag) {
    this.parts = parts;
    this.type = options?.type ?? "";
  }
}

class FakeClipboardItem {
  readonly data: Readonly<Record<string, FakeBlob>>;

  constructor(data: Readonly<Record<string, FakeBlob>>) {
    this.data = data;
  }
}

function globalsWith(
  clipboard: NotesClipboardGlobals["clipboard"]
): NotesClipboardGlobals {
  return {
    clipboard,
    Blob: FakeBlob as unknown as NotesClipboardGlobals["Blob"],
    ClipboardItem:
      FakeClipboardItem as unknown as NotesClipboardGlobals["ClipboardItem"]
  };
}

describe("writeNotesClipboardEvent", () => {
  it("synchronously writes identical plain and Markdown data before preventing the native event", () => {
    const calls: string[] = [];
    const setData = vi.fn((type: string, value: string) => {
      calls.push(`set:${type}:${value}`);
    });
    const preventDefault = vi.fn(() => {
      calls.push("preventDefault");
    });

    const outcome = writeNotesClipboardEvent(
      { clipboardData: { setData }, preventDefault },
      "- Parent\n  - Child"
    );

    expect(outcome).toEqual({ kind: "success", method: "event" });
    expect(calls).toEqual([
      "set:text/plain:- Parent\n  - Child",
      "set:text/markdown:- Parent\n  - Child",
      "preventDefault"
    ]);
  });

  it("fails without preventing the event when synchronous clipboard data is unavailable", () => {
    const preventDefault = vi.fn();

    expect(
      writeNotesClipboardEvent(
        { clipboardData: null, preventDefault },
        "- Parent"
      )
    ).toEqual({
      kind: "failure",
      message: "The clipboard could not be written."
    });
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe("writeNotesClipboardText", () => {
  it("prefers a ClipboardItem write with identical text/plain and text/markdown blobs", async () => {
    const writtenItems: ClipboardItem[][] = [];
    const write = vi.fn(async (items: ClipboardItem[]) => {
      writtenItems.push(items);
    });
    const writeText = vi.fn(async () => {});

    const outcome = await writeNotesClipboardText("- Parent", globalsWith({
      write,
      writeText
    }));

    expect(outcome).toEqual({ kind: "success", method: "multiMime" });
    expect(write).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    expect(writtenItems).toHaveLength(1);
    const item = writtenItems[0][0] as unknown as FakeClipboardItem;
    expect(Object.keys(item.data)).toEqual(["text/plain", "text/markdown"]);
    expect(item.data["text/plain"]).toMatchObject({
      parts: ["- Parent"],
      type: "text/plain"
    });
    expect(item.data["text/markdown"]).toMatchObject({
      parts: ["- Parent"],
      type: "text/markdown"
    });
  });

  it("uses writeText when the multi-MIME path is unsupported", async () => {
    const writeText = vi.fn(async () => {});

    await expect(
      writeNotesClipboardText("- Parent", { clipboard: { writeText } })
    ).resolves.toEqual({ kind: "success", method: "plainText" });
    expect(writeText).toHaveBeenCalledWith("- Parent");
  });

  it("falls back to writeText when the preferred write rejects", async () => {
    const calls: string[] = [];
    const write = vi.fn(async () => {
      calls.push("write");
      throw new Error("multi-MIME denied");
    });
    const writeText = vi.fn(async () => {
      calls.push("writeText");
    });

    await expect(
      writeNotesClipboardText(
        "- Parent",
        globalsWith({ write, writeText })
      )
    ).resolves.toEqual({ kind: "success", method: "plainText" });
    expect(calls).toEqual(["write", "writeText"]);
  });

  it("returns failure only after both supported paths reject", async () => {
    const calls: string[] = [];
    const write = vi.fn(async () => {
      calls.push("write");
      throw new Error("multi-MIME denied");
    });
    const writeText = vi.fn(async () => {
      calls.push("writeText");
      throw new Error("plain text denied");
    });

    await expect(
      writeNotesClipboardText(
        "- Parent",
        globalsWith({ write, writeText })
      )
    ).resolves.toEqual({
      kind: "failure",
      message: "The clipboard could not be written."
    });
    expect(calls).toEqual(["write", "writeText"]);
  });

  it("returns a typed failure when no clipboard write capability exists", async () => {
    await expect(writeNotesClipboardText("- Parent", {})).resolves.toEqual({
      kind: "failure",
      message: "The clipboard could not be written."
    });
  });
});
