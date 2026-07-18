import { describe, expect, it, vi } from "vitest";
import {
  NOTES_IMAGE_ATOM_CLIPBOARD_MIME,
  isNotesImageAtomHtmlWithinLimit,
  parseNotesImageAtomPaste,
  readNotesImageAtomPasteCandidate,
  settleNotesImageAtomCut,
  serializeNotesImageAtomClipboard,
  writeNotesImageAtomClipboard,
  type NotesImageAtomClipboardV1
} from "./notesImageAtomClipboard";
import type { NotesClipboardItemConstructor } from "./notesClipboard";
import type { ClipboardImageDescriptor } from "./notesClipboardImages";

const pngBytes = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0
]);

function copyInput(overrides: Partial<{
  beforeText: string;
  afterText: string;
  image: Partial<{
    originalName: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    bytes: Uint8Array;
    byteSize: number;
    contentHash: string;
  }>;
}> = {}) {
  return {
    image: {
      originalName: "diagram & plan.png",
      mimeType: "image/png" as const,
      bytes: pngBytes,
      byteSize: pngBytes.byteLength,
      contentHash: "0".repeat(64),
      ...overrides.image
    },
    beforeText: overrides.beforeText ?? "before <tag>",
    afterText: overrides.afterText ?? "after & tail"
  };
}

function metadata(overrides: Partial<NotesImageAtomClipboardV1> = {}) {
  return {
    version: 1 as const,
    kind: "notes-image-atom" as const,
    beforeText: "before",
    afterText: "after",
    image: {
      originalName: "diagram.png",
      mimeType: "image/png" as const,
      byteSize: pngBytes.byteLength,
      contentHash:
        "0000000000000000000000000000000000000000000000000000000000000000"
    },
    ...overrides
  };
}

function imageDescriptor(
  bytes = pngBytes,
  originalName = "external.png"
) {
  return {
    blob: new Blob([bytes.slice().buffer], { type: "image/png" }),
    originalName,
    mimeType: "image/png" as const
  };
}

describe("image atom clipboard serialization", () => {
  it("keeps an unmarked native image external when clipboard text flavors are empty", async () => {
    const file = new File([pngBytes], "external.png", { type: "image/png" });
    const candidate = readNotesImageAtomPasteCandidate({
      types: ["Files"],
      items: {
        0: {
          kind: "file",
          type: "image/png",
          getAsFile: () => file
        },
        length: 1
      },
      getData: () => ""
    } as unknown as DataTransfer);

    expect(candidate.custom).toBeNull();
    expect(candidate.claimed).toBe(true);
    await expect(parseNotesImageAtomPaste(candidate)).resolves.toMatchObject({
      kind: "external"
    });
  });

  it("never lets throwing clipboard text reads escape or unclaim an image carrier", async () => {
    const file = new File([pngBytes], "external.png", { type: "image/png" });
    const candidate = readNotesImageAtomPasteCandidate({
      types: ["Files"],
      items: {
        0: {
          kind: "file",
          type: "image/png",
          getAsFile: () => file
        },
        length: 1
      },
      getData: () => {
        throw new Error("clipboard text unavailable");
      }
    } as unknown as DataTransfer);

    expect(candidate).toMatchObject({ custom: null, html: "", claimed: true });
    await expect(parseNotesImageAtomPaste(candidate)).resolves.toMatchObject({
      kind: "external"
    });
  });

  it("fails closed when a declared private clipboard flavor cannot be read", async () => {
    const candidate = readNotesImageAtomPasteCandidate({
      types: [NOTES_IMAGE_ATOM_CLIPBOARD_MIME],
      items: { length: 0 },
      getData: () => {
        throw new Error("clipboard text unavailable");
      }
    } as unknown as DataTransfer);

    expect(candidate).toMatchObject({ custom: "", html: "", claimed: true });
    await expect(parseNotesImageAtomPaste(candidate)).resolves.toMatchObject({
      kind: "error"
    });
  });

  it("serializes mixed content with escaped HTML, a data URL, and a byte-free internal payload", async () => {
    const serialized = await serializeNotesImageAtomClipboard(copyInput(), {
      digest: async () => new Uint8Array(32)
    });

    expect(serialized.plainText).toBe(
      "before <tag>[Image: diagram & plan.png]after & tail"
    );
    expect(serialized.html).toContain("before &lt;tag&gt;");
    expect(serialized.html).toContain("after &amp; tail");
    expect(serialized.html).toContain("src=\"data:image/png;base64,");
    expect(serialized.html).toContain("data-yonalist-image-atom-v1=");
    expect(serialized.metadata).toEqual(
      expect.objectContaining({
        version: 1,
        kind: "notes-image-atom",
        beforeText: "before <tag>",
        afterText: "after & tail",
        image: expect.objectContaining({
          originalName: "diagram & plan.png",
          byteSize: pngBytes.byteLength,
          contentHash: "0".repeat(64)
        })
      })
    );
    expect(JSON.stringify(serialized.metadata)).not.toMatch(
      /relativePath|attachmentId|vault/i
    );
  });

  it("omits only the HTML image carrier when its encoded representation exceeds 32 MiB", async () => {
    const tooLarge = new Uint8Array(24 * 1024 * 1024);
    tooLarge.set(pngBytes);
    const serialized = await serializeNotesImageAtomClipboard(
      copyInput({
        image: { bytes: tooLarge, byteSize: tooLarge.byteLength }
      }),
      { digest: async () => new Uint8Array(32) }
    );

    expect(serialized.html).toBeNull();
    expect(serialized.plainText).toContain("[Image: diagram & plan.png]");
    expect(serialized.metadata.image.byteSize).toBe(tooLarge.byteLength);
  });

  it("bounds the complete escaped HTML representation, not only its data URL", () => {
    const escapedHtmlWithoutData = `${"&amp;".repeat(2 * 1024 * 1024)}<img src="data:image/png;base64,">`;

    expect(
      isNotesImageAtomHtmlWithinLimit(
        escapedHtmlWithoutData,
        20 * 1024 * 1024
      )
    ).toBe(false);
  });

  it("serializes an image-only selection without inventing surrounding text", async () => {
    const serialized = serializeNotesImageAtomClipboard(
      copyInput({ beforeText: "", afterText: "" })
    );
    expect(serialized.plainText).toBe("[Image: diagram & plan.png]");
    expect(serialized.html).toMatch(/^<img /u);
  });

  it("writes exactly one ClipboardItem and independently omits unsupported custom and native flavors", async () => {
    const items: Record<string, Blob>[] = [];
    class Item {
      static supports = vi.fn((type: string) => type === "image/png");
      constructor(data: Record<string, Blob>) {
        items.push(data);
      }
    }
    const outcome = await writeNotesImageAtomClipboard(
      copyInput(),
      {
        clipboard: { write: vi.fn(async () => undefined) },
        ClipboardItem: Item as unknown as NotesClipboardItemConstructor,
        Blob
      },
      { digest: async () => new Uint8Array(32) }
    );

    expect(outcome).toEqual({
      kind: "success",
      method: "multiMime",
      carriesImageBytes: true
    });
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0])).toEqual([
      "text/plain",
      "text/html",
      "image/png"
    ]);
    expect(Item.supports).toHaveBeenCalledWith(NOTES_IMAGE_ATOM_CLIPBOARD_MIME);
    expect(Item.supports).toHaveBeenCalledWith("image/png");
  });

  it("includes the custom flavor when that flavor alone is supported", async () => {
    const items: Record<string, Blob>[] = [];
    class Item {
      static supports = vi.fn(
        (type: string) => type === NOTES_IMAGE_ATOM_CLIPBOARD_MIME
      );
      constructor(data: Record<string, Blob>) {
        items.push(data);
      }
    }
    await expect(
      writeNotesImageAtomClipboard(copyInput(), {
        clipboard: { write: vi.fn(async () => undefined) },
        ClipboardItem: Item as unknown as NotesClipboardItemConstructor,
        Blob
      })
    ).resolves.toMatchObject({ kind: "success", carriesImageBytes: true });

    expect(Object.keys(items[0])).toEqual([
      "text/plain",
      "text/html",
      NOTES_IMAGE_ATOM_CLIPBOARD_MIME
    ]);
  });

  it.each([
    ["before text", { beforeText: "x".repeat(256 * 1024) }],
    ["after text", { afterText: "x".repeat(256 * 1024) }],
    [
      "original name",
      { image: { originalName: `${"x".repeat(256 * 1024)}.png` } }
    ]
  ])("omits oversized internal metadata derived from %s", async (_label, overrides) => {
    const items: Record<string, Blob>[] = [];
    class Item {
      static supports = vi.fn(() => true);
      constructor(data: Record<string, Blob>) {
        items.push(data);
      }
    }

    await expect(
      writeNotesImageAtomClipboard(
        copyInput(overrides),
        {
          clipboard: { write: vi.fn(async () => undefined) },
          ClipboardItem: Item as unknown as NotesClipboardItemConstructor,
          Blob
        }
      )
    ).resolves.toMatchObject({ kind: "success", carriesImageBytes: false });
    expect(Object.keys(items[0])).toEqual(["text/plain", "image/png"]);
  });

  it("treats an oversized native image as copy-only when the custom flavor is unavailable", async () => {
    const bytes = new Uint8Array(24 * 1024 * 1024);
    bytes.set(pngBytes);
    const input = copyInput({
      image: { bytes, byteSize: bytes.byteLength }
    });
    const write = vi.fn(async () => undefined);
    class NativeOnlyItem {
      static supports = vi.fn((type: string) => type === "image/png");
      constructor(_data: Record<string, Blob>) {}
    }
    const nativeSettlement = writeNotesImageAtomClipboard(input, {
        clipboard: { write },
        ClipboardItem:
          NativeOnlyItem as unknown as NotesClipboardItemConstructor,
        Blob
      });
    await expect(nativeSettlement).resolves.toMatchObject({
      kind: "success",
      carriesImageBytes: false
    });
    const remove = vi.fn();
    await expect(
      settleNotesImageAtomCut(nativeSettlement, () => true, remove)
    ).resolves.toMatchObject({ kind: "failure" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not authorize Cut from native plus custom flavors for an oversized attachment", async () => {
    const bytes = new Uint8Array(20 * 1024 * 1024 + 1);
    bytes.set(pngBytes);
    const items: Record<string, Blob>[] = [];
    class InternalItem {
      static supports = vi.fn(
        (type: string) =>
          type === "image/png" || type === NOTES_IMAGE_ATOM_CLIPBOARD_MIME
      );
      constructor(data: Record<string, Blob>) {
        items.push(data);
      }
    }
    const settlement = writeNotesImageAtomClipboard(
      copyInput({ image: { bytes, byteSize: bytes.byteLength } }),
      {
        clipboard: { write: vi.fn(async () => undefined) },
        ClipboardItem: InternalItem as unknown as NotesClipboardItemConstructor,
        Blob
      }
    );

    await expect(
      settlement
    ).resolves.toMatchObject({ kind: "success", carriesImageBytes: false });
    expect(Object.keys(items[0])).toEqual(["text/plain", "image/png"]);
    const remove = vi.fn();
    await expect(
      settleNotesImageAtomCut(settlement, () => true, remove)
    ).resolves.toMatchObject({ kind: "failure", carriesImageBytes: false });
    expect(remove).not.toHaveBeenCalled();
  });

  it("falls back synchronously with bytes only when bounded HTML is available", async () => {
    const values = new Map<string, string>();
    const event = {
      clipboardData: { setData: vi.fn((type: string, value: string) => values.set(type, value)) },
      preventDefault: vi.fn()
    };

    const outcome = await writeNotesImageAtomClipboard(
      copyInput(),
      {},
      { digest: async () => new Uint8Array(32) },
      event
    );

    expect(outcome).toEqual({
      kind: "success",
      method: "event",
      carriesImageBytes: true
    });
    expect(values.get("text/plain")).toContain("[Image: diagram & plan.png]");
    expect(values.get("text/html")).toContain("data:image/png;base64,");
    expect(values.get(NOTES_IMAGE_ATOM_CLIPBOARD_MIME)).toContain(
      "notes-image-atom"
    );
  });

  it("starts the rich write before returning from the copy event", async () => {
    const write = vi.fn(() => Promise.resolve());
    const preventDefault = vi.fn();
    class Item {
      static supports = vi.fn(() => true);
      constructor(_data: Record<string, Blob>) {}
    }

    const settlement = writeNotesImageAtomClipboard(
      copyInput(),
      {
        clipboard: { write },
        ClipboardItem: Item as unknown as NotesClipboardItemConstructor,
        Blob
      },
      {},
      { clipboardData: { setData: vi.fn() }, preventDefault }
    );

    expect(write).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    await expect(settlement).resolves.toMatchObject({ kind: "success" });
  });

  it("sets synchronous fallback data before returning when rich clipboard writing is unavailable", async () => {
    const setData = vi.fn();
    const preventDefault = vi.fn();
    const settlement = writeNotesImageAtomClipboard(
      copyInput(),
      {},
      {},
      { clipboardData: { setData }, preventDefault }
    );

    expect(setData).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledOnce();
    await expect(settlement).resolves.toMatchObject({
      kind: "success",
      carriesImageBytes: true
    });
  });

  it("uses the synchronous event fallback when ClipboardItem construction throws", async () => {
    const setData = vi.fn();
    const preventDefault = vi.fn();
    class ThrowingItem {
      static supports = vi.fn(() => true);
      constructor(_data: Record<string, Blob>) {
        throw new Error("unsupported");
      }
    }
    const settlement = writeNotesImageAtomClipboard(
      copyInput(),
      {
        clipboard: { write: vi.fn() },
        ClipboardItem: ThrowingItem as unknown as NotesClipboardItemConstructor,
        Blob
      },
      {},
      { clipboardData: { setData }, preventDefault }
    );

    expect(setData).toHaveBeenCalledWith("text/plain", expect.any(String));
    expect(preventDefault).toHaveBeenCalledOnce();
    await expect(settlement).resolves.toMatchObject({
      kind: "success",
      method: "event",
      carriesImageBytes: true
    });
  });

  it("does not fall back after an async write rejection or authorize Cut", async () => {
    const setData = vi.fn();
    const preventDefault = vi.fn();
    const remove = vi.fn();
    class Item {
      static supports = vi.fn(() => true);
      constructor(_data: Record<string, Blob>) {}
    }
    const settlement = writeNotesImageAtomClipboard(
      copyInput(),
      {
        clipboard: { write: vi.fn(async () => Promise.reject(new Error("denied"))) },
        ClipboardItem: Item as unknown as NotesClipboardItemConstructor,
        Blob
      },
      {},
      { clipboardData: { setData }, preventDefault }
    );

    await expect(settleNotesImageAtomCut(settlement, () => true, remove)).resolves
      .toMatchObject({ kind: "failure", carriesImageBytes: false });
    expect(setData).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not authorize Cut when frozen authority has changed after a byte-carrying write", async () => {
    const remove = vi.fn();
    await expect(
      settleNotesImageAtomCut(
        Promise.resolve({
          kind: "success",
          method: "event",
          carriesImageBytes: true
        }),
        () => false,
        remove
      )
    ).resolves.toEqual({ kind: "stale", carriesImageBytes: true });
    expect(remove).not.toHaveBeenCalled();
  });

  it("reports Cut success only after a current byte-carrying settlement removes the source", async () => {
    const remove = vi.fn();
    await expect(
      settleNotesImageAtomCut(
        Promise.resolve({
          kind: "success",
          method: "multiMime",
          carriesImageBytes: true
        }),
        () => true,
        remove
      )
    ).resolves.toEqual({
      kind: "success",
      method: "multiMime",
      carriesImageBytes: true
    });
    expect(remove).toHaveBeenCalledOnce();
  });

  it("reports a non-success Cut settlement when source removal rejects", async () => {
    await expect(
      settleNotesImageAtomCut(
        Promise.resolve({
          kind: "success",
          method: "event",
          carriesImageBytes: true
        }),
        () => true,
        () => Promise.reject(new Error("stale authority"))
      )
    ).resolves.toMatchObject({ kind: "failure", carriesImageBytes: true });
  });

  it("keeps metadata-only synchronous fallback copy-only", async () => {
    const tooLarge = new Uint8Array(24 * 1024 * 1024);
    tooLarge.set(pngBytes);
    const setData = vi.fn();
    const settlement = writeNotesImageAtomClipboard(
        copyInput({ image: { bytes: tooLarge, byteSize: tooLarge.byteLength } }),
        {},
        {},
        { clipboardData: { setData }, preventDefault: vi.fn() }
      );
    await expect(settlement).resolves.toMatchObject({
      kind: "success",
      carriesImageBytes: false
    });
    expect(setData).toHaveBeenCalledWith("text/plain", expect.any(String));
    expect(setData).not.toHaveBeenCalledWith("text/html", expect.any(String));
    await expect(
      settleNotesImageAtomCut(settlement, () => true, vi.fn())
    ).resolves.toMatchObject({ kind: "failure", carriesImageBytes: false });
  });
});

describe("image atom clipboard parsing", () => {
  it("round-trips serialized HTML-only metadata with escaped multilingual text", async () => {
    const serialized = serializeNotesImageAtomClipboard(
      copyInput({ beforeText: "é".repeat(80_000) })
    );
    if (serialized.html === null) throw new Error("Expected bounded HTML.");

    await expect(
      parseNotesImageAtomPaste(
        { html: serialized.html },
        { digest: async () => new Uint8Array(32) }
      )
    ).resolves.toMatchObject({ kind: "imageAtom" });
  });

  it("accepts a marked HTML data carrier only when its exact hash, size, MIME, and magic match", async () => {
    const base64 = btoa(String.fromCharCode(...pngBytes));
    const marker = encodeURIComponent(JSON.stringify(metadata()));
    const result = await parseNotesImageAtomPaste({
      html: `<img data-yonalist-image-atom-v1="${marker}" src="data:image/png;base64,${base64}">`
    }, {
      digest: async () => new Uint8Array(32)
    });

    expect(result).toEqual({
      kind: "imageAtom",
      value: {
        version: 1,
        fragment: [
          { kind: "text", text: "before" },
          expect.objectContaining({ kind: "image", source: expect.any(Object) }),
          { kind: "text", text: "after" }
        ]
      }
    });
  });

  it("accepts a valid custom flavor paired with a native image carrier", async () => {
    await expect(
      parseNotesImageAtomPaste(
        {
          custom: JSON.stringify(metadata()),
          images: [imageDescriptor()]
        },
        { digest: async () => new Uint8Array(32) }
      )
    ).resolves.toMatchObject({ kind: "imageAtom" });
  });

  it("prefers a matching marked HTML carrier when an OS native flavor was transcoded", async () => {
    const base64 = btoa(String.fromCharCode(...pngBytes));
    const marker = encodeURIComponent(JSON.stringify(metadata()));
    const transcoded = imageDescriptor(
      new Uint8Array([0xff, 0xd8, 0xff]),
      "transcoded.png"
    );
    const result = await parseNotesImageAtomPaste(
      {
        images: [transcoded],
        html: `<img data-yonalist-image-atom-v1="${marker}" src="data:image/png;base64,${base64}">`
      },
      { digest: async () => new Uint8Array(32) }
    );

    expect(result).toMatchObject({
      kind: "imageAtom",
      value: {
        fragment: [
          expect.anything(),
          { kind: "image", source: { originalName: "diagram.png" } },
          expect.anything()
        ]
      }
    });
  });

  it("rejects a marked mismatch atomically instead of treating its carrier as external", async () => {
    const marker = encodeURIComponent(
      JSON.stringify(metadata({ image: { ...metadata().image, byteSize: 99 } }))
    );
    const result = await parseNotesImageAtomPaste({
      html: `<p>external</p><img data-yonalist-image-atom-v1="${marker}" src="data:image/png;base64,iVBORw0KGgo=">`
    }, {
      digest: async () => new Uint8Array(32)
    });

    expect(result).toEqual({ kind: "error", message: expect.any(String) });
  });

  it.each([
    ["hash", metadata({ image: { ...metadata().image, contentHash: "1".repeat(64) } }), pngBytes],
    ["MIME", metadata({ image: { ...metadata().image, mimeType: "image/jpeg" } }), pngBytes],
    ["magic", metadata(), new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])]
  ])("rejects an internal carrier with mismatched %s", async (_kind, payload, bytes) => {
    await expect(
      parseNotesImageAtomPaste(
        { custom: JSON.stringify(payload), images: [imageDescriptor(bytes)] },
        { digest: async () => new Uint8Array(32) }
      )
    ).resolves.toMatchObject({ kind: "error" });
  });

  it("sanitizes external mixed HTML in source order and never accepts remote images", async () => {
    const result = await parseNotesImageAtomPaste({
      html: '<p>before<script>throw new Error()</script><img src="https://example.invalid/x.png" onerror="alert(1)"><img src="data:image/png;base64,iVBORw0KGgo="><style>p{display:none}</style>after</p>'
    });

    expect(result).toEqual({
      kind: "external",
      value: {
        version: 1,
        fragment: [
          { kind: "text", text: "before" },
          expect.objectContaining({ kind: "image", source: expect.any(Object) }),
          { kind: "text", text: "after" }
        ]
      }
    });
  });

  it("uses external native File or Blob images before unmarked HTML", async () => {
    const native = imageDescriptor();
    const result = await parseNotesImageAtomPaste({
      images: [native],
      html: '<img src="data:image/png;base64,iVBORw0KGgo=">'
    });

    expect(result).toEqual({
      kind: "external",
      value: { version: 1, fragment: [{ kind: "image", source: native }] }
    });
  });

  it("keeps a valid native image when an unmarked lower-priority HTML alternate is unsupported", async () => {
    const native = imageDescriptor();
    await expect(
      parseNotesImageAtomPaste({
        images: [native],
        html: '<img src="data:image/heic;base64,AA==">'
      })
    ).resolves.toEqual({
      kind: "external",
      value: { version: 1, fragment: [{ kind: "image", source: native }] }
    });
  });

  it("ignores an unrelated native alternate when marked HTML supplies the exact internal bytes", async () => {
    const base64 = btoa(String.fromCharCode(...pngBytes));
    const marker = encodeURIComponent(JSON.stringify(metadata()));
    const unsupportedNative = {
      blob: new Blob([new Uint8Array([1])], { type: "image/heic" }),
      originalName: "transcoded.heic",
      mimeType: "image/heic"
    };
    await expect(
      parseNotesImageAtomPaste(
        {
          images: [unsupportedNative as unknown as ClipboardImageDescriptor],
          html: `<img data-yonalist-image-atom-v1="${marker}" src="data:image/png;base64,${base64}">`
        },
        { digest: async () => new Uint8Array(32) }
      )
    ).resolves.toMatchObject({ kind: "imageAtom" });
  });

  it("preserves external HTML text and multiple embedded images in source order", async () => {
    const result = await parseNotesImageAtomPaste({
      html: 'one<img src="data:image/png;base64,iVBORw0KGgo=">two<img src="data:image/png;base64,iVBORw0KGgo=">three'
    });
    expect(result).toMatchObject({
      kind: "external",
      value: {
        fragment: [
          { kind: "text", text: "one" },
          { kind: "image", source: { originalName: "clipboard-image-1.png" } },
          { kind: "text", text: "two" },
          { kind: "image", source: { originalName: "clipboard-image-2.png" } },
          { kind: "text", text: "three" }
        ]
      }
    });
  });

  it("rejects unsupported data MIME, an oversized metadata flavor, and an over-count HTML batch", async () => {
    await expect(
      parseNotesImageAtomPaste({
        html: '<img src="data:image/heic;base64,AA==">'
      })
    ).resolves.toMatchObject({ kind: "error" });
    await expect(
      parseNotesImageAtomPaste({ custom: "x".repeat(256 * 1024) })
    ).resolves.toMatchObject({ kind: "error" });
    await expect(
      parseNotesImageAtomPaste({
        html: Array.from(
          { length: 129 },
          () => '<img src="data:image/png;base64,iVBORw0KGgo=">'
        ).join("")
      })
    ).resolves.toMatchObject({ kind: "error" });
  });

  it("rejects native external images that exceed the item or aggregate byte bounds", async () => {
    const descriptorWithSize = (size: number) => ({
      blob: { size } as Blob,
      originalName: "large.png",
      mimeType: "image/png" as const
    });
    await expect(
      parseNotesImageAtomPaste({
        images: [descriptorWithSize(20 * 1024 * 1024 + 1)]
      })
    ).resolves.toMatchObject({ kind: "error" });
    await expect(
      parseNotesImageAtomPaste({
        images: Array.from({ length: 4 }, () =>
          descriptorWithSize(20 * 1024 * 1024)
        )
      })
    ).resolves.toMatchObject({ kind: "error" });
  });

  it("does not mistake plain text containing the marker attribute name for an internal payload", async () => {
    await expect(
      parseNotesImageAtomPaste({
        html: '<p>data-yonalist-image-atom-v1 is documentation</p><img src="data:image/png;base64,iVBORw0KGgo=">'
      })
    ).resolves.toMatchObject({ kind: "external" });
  });

  it("atomically rejects a marker placed on a non-image element", async () => {
    const marker = encodeURIComponent(JSON.stringify(metadata()));
    await expect(
      parseNotesImageAtomPaste({
        html: `<span data-yonalist-image-atom-v1="${marker}">before</span><img src="data:image/png;base64,iVBORw0KGgo=">`
      })
    ).resolves.toMatchObject({ kind: "error" });
  });
});
