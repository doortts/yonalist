import { Blob as NodeBlob } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_NOTE_ATTACHMENT_BATCH_BYTES,
  MAX_NOTE_ATTACHMENT_BATCH_METADATA_BYTES,
  MAX_NOTE_ATTACHMENT_BYTES,
  MAX_NOTE_ATTACHMENTS_PER_NODE
} from "../domain/notes";
import type {
  ImportNoteAttachmentBytesBatchInput,
  NotesHistoryContext
} from "../domain/notes";
import { encodeNotesAttachmentRawEnvelope } from "./notesAttachmentRawIpc";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const FIRST_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_ID = "33333333-3333-4333-8333-333333333333";
const HISTORY_CONTEXT: NotesHistoryContext = {
  sessionId: "44444444-4444-4444-8444-444444444444",
  entryId: "55555555-5555-4555-8555-555555555555",
  commandKind: "importAttachmentBytes"
};
const HEADER_BYTES = 9;

interface FixtureMetadata {
  vaultPath: string;
  nodeId: string;
  attachments: Array<{
    id: string;
    ordinal: number;
    originalName: string;
    mimeType: string;
    byteLength: number;
  }>;
  initialMaxDisplayWidth: number;
  historyContext: NotesHistoryContext | null;
}

function fixtureBytes(): Uint8Array {
  const hex = readFileSync(
    resolve(process.cwd(), "src/test-fixtures/notes-attachment-batch-v1.hex"),
    "utf8"
  ).trim();
  if (!/^(?:[0-9a-f]{2})+$/u.test(hex)) {
    throw new Error("Attachment batch fixture must contain lowercase hexadecimal bytes.");
  }
  return Uint8Array.from(hex.match(/.{2}/gu) ?? [], (byte) =>
    Number.parseInt(byte, 16)
  );
}

function decodeMetadata(envelope: Uint8Array): FixtureMetadata {
  expect([...envelope.slice(0, 4)]).toEqual([89, 78, 65, 66]);
  expect(envelope[4]).toBe(1);
  const metadataLength = new DataView(
    envelope.buffer,
    envelope.byteOffset,
    envelope.byteLength
  ).getUint32(5, true);
  const metadata = JSON.parse(
    new TextDecoder().decode(
      envelope.slice(HEADER_BYTES, HEADER_BYTES + metadataLength)
    )
  ) as FixtureMetadata;
  metadata.attachments.forEach((attachment, index) => {
    if (attachment.ordinal !== index) {
      throw new Error("Attachment ordinals must be contiguous and match transport order.");
    }
  });
  return metadata;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sizedBlob(size: number, arrayBuffer = vi.fn()): Blob {
  return {
    size,
    type: "image/png",
    arrayBuffer
  } as unknown as Blob;
}

function bytesBlob(bytes: Uint8Array, type: string): Blob {
  return new NodeBlob([bytes], { type }) as Blob;
}

function input(
  attachments: ImportNoteAttachmentBytesBatchInput["attachments"],
  initialMaxDisplayWidth = 480
): ImportNoteAttachmentBytesBatchInput {
  return { nodeId: NODE_ID, attachments, initialMaxDisplayWidth };
}

function item(
  id: string,
  blob: Blob = bytesBlob(Uint8Array.of(1), "image/png"),
  originalName = "image.png"
) {
  return { id, originalName, mimeType: "image/png", blob };
}

function indexedId(index: number): string {
  return `22222222-2222-4222-8222-${index.toString(16).padStart(12, "0")}`;
}

describe("notes attachment raw IPC envelope", () => {
  it("matches the checked-in v1 fixture and preserves Unicode transport order", async () => {
    const envelope = await encodeNotesAttachmentRawEnvelope(
      "/vault",
      input([
        {
          id: FIRST_ID,
          originalName: "첫째.png",
          mimeType: "image/png",
          blob: bytesBlob(Uint8Array.of(1, 2), "image/png")
        },
        {
          id: SECOND_ID,
          originalName: "둘째.webp",
          mimeType: "image/webp",
          blob: bytesBlob(Uint8Array.of(3, 4, 5), "image/webp")
        }
      ]),
      HISTORY_CONTEXT
    );

    expect(hex(envelope)).toBe(hex(fixtureBytes()));
    expect([...envelope.slice(-5)]).toEqual([1, 2, 3, 4, 5]);
    expect(decodeMetadata(envelope)).toEqual({
      vaultPath: "/vault",
      nodeId: NODE_ID,
      attachments: [
        {
          id: FIRST_ID,
          ordinal: 0,
          originalName: "첫째.png",
          mimeType: "image/png",
          byteLength: 2
        },
        {
          id: SECOND_ID,
          ordinal: 1,
          originalName: "둘째.webp",
          mimeType: "image/webp",
          byteLength: 3
        }
      ],
      initialMaxDisplayWidth: 480,
      historyContext: HISTORY_CONTEXT
    });
  });

  it("rejects a decoded fixture whose ordinals do not match array order", () => {
    const envelope = fixtureBytes();
    const metadataLength = new DataView(envelope.buffer).getUint32(5, true);
    const metadata = JSON.parse(
      new TextDecoder().decode(
        envelope.slice(HEADER_BYTES, HEADER_BYTES + metadataLength)
      )
    ) as FixtureMetadata;
    metadata.attachments[1].ordinal = 2;
    const encoded = new TextEncoder().encode(JSON.stringify(metadata));
    const malformed = new Uint8Array(HEADER_BYTES + encoded.byteLength + 5);
    malformed.set(envelope.slice(0, 5));
    new DataView(malformed.buffer).setUint32(5, encoded.byteLength, true);
    malformed.set(encoded, HEADER_BYTES);
    malformed.set(envelope.slice(-5), HEADER_BYTES + encoded.byteLength);

    expect(() => decodeMetadata(malformed)).toThrow(/ordinals must be contiguous/);
  });

  it("rejects empty and oversized batches before reading any blob", async () => {
    await expect(
      encodeNotesAttachmentRawEnvelope("/vault", input([]), null)
    ).rejects.toThrow(/at least one attachment/i);

    const tooMany = Array.from(
      { length: MAX_NOTE_ATTACHMENTS_PER_NODE + 1 },
      (_, index) => item(indexedId(index))
    );
    await expect(
      encodeNotesAttachmentRawEnvelope("/vault", input(tooMany), null)
    ).rejects.toThrow(/at most 128 attachments/i);
  });

  it("rejects empty, individually oversized, and cumulatively oversized bytes", async () => {
    const emptyRead = vi.fn();
    await expect(
      encodeNotesAttachmentRawEnvelope(
        "/vault",
        input([item(FIRST_ID, sizedBlob(0, emptyRead))]),
        null
      )
    ).rejects.toThrow(/must not be empty/i);
    expect(emptyRead).not.toHaveBeenCalled();

    const oversizedRead = vi.fn();
    await expect(
      encodeNotesAttachmentRawEnvelope(
        "/vault",
        input([
          item(FIRST_ID, sizedBlob(MAX_NOTE_ATTACHMENT_BYTES + 1, oversizedRead))
        ]),
        null
      )
    ).rejects.toThrow(/20 MiB/i);
    expect(oversizedRead).not.toHaveBeenCalled();

    const aggregateItemBytes = MAX_NOTE_ATTACHMENT_BATCH_BYTES / 4 + 1;
    const aggregateReads = Array.from({ length: 4 }, () => vi.fn());
    await expect(
      encodeNotesAttachmentRawEnvelope(
        "/vault",
        input(
          aggregateReads.map((read, index) =>
            item(indexedId(index), sizedBlob(aggregateItemBytes, read))
          )
        ),
        null
      )
    ).rejects.toThrow(/64 MiB/i);
    aggregateReads.forEach((read) => expect(read).not.toHaveBeenCalled());
  });

  it("rejects metadata over 256 KiB before reading blobs", async () => {
    const read = vi.fn();
    await expect(
      encodeNotesAttachmentRawEnvelope(
        "/vault",
        input([
          item(
            FIRST_ID,
            sizedBlob(1, read),
            "x".repeat(MAX_NOTE_ATTACHMENT_BATCH_METADATA_BYTES)
          )
        ]),
        null
      )
    ).rejects.toThrow(/256 KiB/i);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects duplicate IDs, invalid IDs, and non-positive display widths", async () => {
    await expect(
      encodeNotesAttachmentRawEnvelope(
        "/vault",
        input([item(FIRST_ID), item(FIRST_ID)]),
        null
      )
    ).rejects.toThrow(/duplicate attachment ID/i);
    await expect(
      encodeNotesAttachmentRawEnvelope(
        "/vault",
        input([item("not-a-uuid")]),
        null
      )
    ).rejects.toThrow(/canonical UUID/i);
    await expect(
      encodeNotesAttachmentRawEnvelope(
        "/vault",
        input([item(FIRST_ID)], 0),
        null
      )
    ).rejects.toThrow(/display width must be positive/i);
  });

  it("rejects an invalid node ID before reading blobs", async () => {
    const read = vi.fn();

    await expect(
      encodeNotesAttachmentRawEnvelope(
        "/vault",
        {
          ...input([item(FIRST_ID, sizedBlob(1, read))]),
          nodeId: "11111111-1111-4111-8111-11111111111A"
        },
        null
      )
    ).rejects.toThrow(/node ID must be a canonical UUID v4/i);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["session ID", { ...HISTORY_CONTEXT, sessionId: "not-a-uuid" }],
    [
      "entry ID",
      { ...HISTORY_CONTEXT, entryId: "55555555-5555-1555-8555-555555555555" }
    ]
  ])("rejects an invalid history %s", async (_label, historyContext) => {
    await expect(
      encodeNotesAttachmentRawEnvelope(
        "/vault",
        input([item(FIRST_ID)]),
        historyContext
      )
    ).rejects.toThrow(/history .+ ID must be a canonical UUID v4/i);
  });

  it("trims history command kinds and rejects empty values", async () => {
    const envelope = await encodeNotesAttachmentRawEnvelope(
      "/vault",
      input([item(FIRST_ID)]),
      { ...HISTORY_CONTEXT, commandKind: "  importAttachmentBytes  " }
    );

    expect(decodeMetadata(envelope).historyContext).toEqual(HISTORY_CONTEXT);

    await expect(
      encodeNotesAttachmentRawEnvelope(
        "/vault",
        input([item(FIRST_ID)]),
        { ...HISTORY_CONTEXT, commandKind: " \t " }
      )
    ).rejects.toThrow(/command kind must contain 1 to 128 characters/i);
  });

  it.each([
    ["ASCII", "x".repeat(128)],
    ["multibyte", `${"한".repeat(42)}ab`]
  ])(
    "accepts a %s history command kind at 128 UTF-8 bytes",
    async (_label, commandKind) => {
      expect(new TextEncoder().encode(commandKind).byteLength).toBe(128);

      const envelope = await encodeNotesAttachmentRawEnvelope(
        "/vault",
        input([item(FIRST_ID)]),
        { ...HISTORY_CONTEXT, commandKind: ` ${commandKind} ` }
      );

      expect(decodeMetadata(envelope).historyContext?.commandKind).toBe(
        commandKind
      );
    }
  );

  it.each([
    ["ASCII", "x".repeat(129)],
    ["multibyte", "한".repeat(43)]
  ])(
    "rejects a %s history command kind at 129 UTF-8 bytes",
    async (_label, commandKind) => {
      expect(new TextEncoder().encode(commandKind).byteLength).toBe(129);

      await expect(
        encodeNotesAttachmentRawEnvelope(
          "/vault",
          input([item(FIRST_ID)]),
          { ...HISTORY_CONTEXT, commandKind: ` ${commandKind} ` }
        )
      ).rejects.toThrow(/command kind must contain 1 to 128 characters/i);
    }
  );

  it("rejects extra own keys on structurally typed history contexts", async () => {
    const historyContext: NotesHistoryContext & { extra: string } = {
      ...HISTORY_CONTEXT,
      extra: "must-not-cross-the-boundary"
    };

    await expect(
      encodeNotesAttachmentRawEnvelope(
        "/vault",
        input([item(FIRST_ID)]),
        historyContext
      )
    ).rejects.toThrow(/history context must contain exactly/i);
  });

  it("preflights every size and reads blob buffers sequentially", async () => {
    let activeReads = 0;
    const order: string[] = [];
    const trackedBlob = (label: string, byte: number): Blob =>
      sizedBlob(
        1,
        vi.fn(async () => {
          activeReads += 1;
          expect(activeReads).toBe(1);
          order.push(`${label}:start`);
          await Promise.resolve();
          order.push(`${label}:end`);
          activeReads -= 1;
          return Uint8Array.of(byte).buffer;
        })
      );

    const envelope = await encodeNotesAttachmentRawEnvelope(
      "/vault",
      input([
        item(FIRST_ID, trackedBlob("first", 7)),
        item(SECOND_ID, trackedBlob("second", 8))
      ]),
      undefined
    );

    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end"
    ]);
    expect([...envelope.slice(-2)]).toEqual([7, 8]);
    expect(decodeMetadata(envelope).historyContext).toBeNull();
  });
});
