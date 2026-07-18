import DOMPurify from "dompurify";
import {
  MAX_NOTE_ATTACHMENT_BATCH_BYTES,
  MAX_NOTE_ATTACHMENT_BATCH_METADATA_BYTES,
  MAX_NOTE_ATTACHMENT_BYTES,
  MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS,
  type NoteAttachment
} from "../../domain/notes";
import type { NotesClipboardEvent, NotesClipboardGlobals } from "./notesClipboard";
import {
  canonicalClipboardImageExtension,
  extractClipboardImages,
  isSupportedClipboardImageMime,
  type ClipboardImageDescriptor
} from "./notesClipboardImages";

const maxHtmlImageBytes = 32 * 1024 * 1024;
const htmlMarkerAttribute = "data-yonalist-image-atom-v1";
const maxEncodedMarkerBytes = 3 * MAX_NOTE_ATTACHMENT_BATCH_METADATA_BYTES;

/** The private, byte-free flavor carried alongside the interoperable formats. */
export const NOTES_IMAGE_ATOM_CLIPBOARD_MIME =
  "application/x-yonalist-notes-image-atom-v1";

export interface NotesImageAtomPasteCandidate {
  readonly custom: string | null;
  readonly html: string;
  readonly images: readonly ClipboardImageDescriptor[];
  readonly claimed: boolean;
}

function clipboardTypesInclude(
  types: DataTransfer["types"] | undefined,
  value: string
): boolean {
  if (!types) return false;
  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === value) return true;
  }
  return false;
}

/**
 * Reads only the small, synchronous paste carriers needed to decide ownership.
 * A marked flavor or HTML image remains editor-owned if native item access
 * fails, so it cannot fall through to the pane's generic image importer.
 */
export function readNotesImageAtomPasteCandidate(
  clipboardData: DataTransfer
): NotesImageAtomPasteCandidate {
  let customFlavorPresent = false;
  try {
    customFlavorPresent = clipboardTypesInclude(
      clipboardData.types,
      NOTES_IMAGE_ATOM_CLIPBOARD_MIME
    );
  } catch {
    // An unreadable type list is not itself evidence of an internal marker.
  }
  let rawCustom = "";
  let html = "";
  try {
    rawCustom = clipboardData.getData(NOTES_IMAGE_ATOM_CLIPBOARD_MIME);
  } catch {
    // Preserve an advertised private flavor as an invalid empty payload so the
    // parser rejects it rather than allowing a generic import fallback.
  }
  try {
    html = clipboardData.getData("text/html");
  } catch {
    // Native image carriers can still be safely handled without HTML text.
  }
  const custom = customFlavorPresent || rawCustom.length > 0 ? rawCustom : null;
  const markedOrHtml = custom !== null || /<img\b/i.test(html);
  try {
    const items = clipboardData.items;
    let hasImageCarrier = false;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        hasImageCarrier = true;
        break;
      }
    }
    const extraction = extractClipboardImages(items);
    const images = extraction.kind === "images" ? extraction.items : [];
    return {
      custom,
      html,
      images,
      claimed: markedOrHtml || hasImageCarrier
    };
  } catch {
    return { custom, html, images: [], claimed: markedOrHtml };
  }
}

export interface NotesImageAtomClipboardV1 {
  readonly version: 1;
  readonly kind: "notes-image-atom";
  readonly beforeText: string;
  readonly afterText: string;
  readonly image: {
    readonly originalName: string;
    readonly mimeType: NoteAttachment["mimeType"];
    readonly byteSize: number;
    readonly contentHash: string;
  };
}

export interface ParsedImageAtomPaste {
  readonly version: 1;
  readonly fragment: readonly (
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "image"; readonly source: ClipboardImageDescriptor }
  )[];
}

type ParsedFragmentItem =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly source: ClipboardImageDescriptor };

export interface NotesImageAtomCopyInput {
  readonly beforeText: string;
  readonly afterText: string;
  readonly image: {
    readonly originalName: string;
    readonly mimeType: NoteAttachment["mimeType"];
    readonly bytes: Uint8Array;
    /** Authority comes from the persisted attachment, not a copy-time digest. */
    readonly byteSize: number;
    readonly contentHash: string;
  };
}

export interface NotesImageAtomClipboardSerialization {
  readonly plainText: string;
  readonly html: string | null;
  readonly metadata: NotesImageAtomClipboardV1;
  readonly custom: string | null;
}

export interface NotesImageAtomClipboardDependencies {
  /** Paste-only SHA-256 injection for deterministic tests. */
  readonly digest?: (bytes: Uint8Array) => Promise<Uint8Array>;
  readonly Blob?: typeof Blob;
  readonly document?: Document;
}

export type NotesImageAtomClipboardWriteOutcome =
  | {
      readonly kind: "success";
      readonly method: "event" | "multiMime";
      readonly carriesImageBytes: boolean;
    }
  | {
      readonly kind: "failure";
      readonly message: string;
      readonly carriesImageBytes: false;
    };

export interface NotesImageAtomPasteInput {
  readonly custom?: string | null;
  readonly html?: string | null;
  readonly images?: readonly ClipboardImageDescriptor[];
}

export type NotesImageAtomPasteOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "imageAtom"; readonly value: ParsedImageAtomPaste }
  | { readonly kind: "external"; readonly value: ParsedImageAtomPaste }
  | { readonly kind: "error"; readonly message: string };

export type NotesImageAtomCutOutcome =
  | {
      readonly kind: "success";
      readonly method: "event" | "multiMime";
      readonly carriesImageBytes: true;
    }
  | {
      readonly kind: "failure";
      readonly message: string;
      readonly carriesImageBytes: boolean;
    }
  | { readonly kind: "stale"; readonly carriesImageBytes: true };

const clipboardFailureMessage = "The clipboard could not be written.";
const clipboardPasteFailureMessage = "The clipboard image data is invalid.";

function isSupportedMime(
  value: string
): value is NoteAttachment["mimeType"] {
  return isSupportedClipboardImageMime(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      case '"':
        return "&quot;";
      default:
        return character;
    }
  });
}

function base64FromBytes(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
    let binary = "";
    for (const byte of chunk) binary += String.fromCharCode(byte);
    chunks.push(binary);
  }
  return btoa(chunks.join(""));
}

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(
  bytes: Uint8Array,
  dependencies: NotesImageAtomClipboardDependencies
): Promise<Uint8Array> {
  if (dependencies.digest) return dependencies.digest(bytes);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 is unavailable.");
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return new Uint8Array(await subtle.digest("SHA-256", buffer));
}

function sniffImageMime(bytes: Uint8Array): NoteAttachment["mimeType"] | null {
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function metadataJson(metadata: NotesImageAtomClipboardV1): string {
  return JSON.stringify(metadata);
}

function metadataMarker(serializedMetadata: string): string {
  return encodeURIComponent(serializedMetadata);
}

export function isNotesImageAtomHtmlWithinLimit(
  structuralHtml: string,
  imageByteLength: number
): boolean {
  return (
    Number.isSafeInteger(imageByteLength) &&
    imageByteLength >= 0 &&
    new TextEncoder().encode(structuralHtml).byteLength +
      4 * Math.ceil(imageByteLength / 3) <=
      maxHtmlImageBytes
  );
}

function plainText(input: NotesImageAtomCopyInput): string {
  return `${input.beforeText}[Image: ${input.image.originalName}]${input.afterText}`;
}

export function serializeNotesImageAtomClipboard(
  input: NotesImageAtomCopyInput,
  _dependencies: NotesImageAtomClipboardDependencies = {}
): NotesImageAtomClipboardSerialization {
  if (
    !isSupportedMime(input.image.mimeType) ||
    input.image.byteSize !== input.image.bytes.byteLength ||
    !/^[0-9a-f]{64}$/u.test(input.image.contentHash)
  ) {
    throw new Error("Image clipboard authority is invalid.");
  }
  const metadata: NotesImageAtomClipboardV1 = {
    version: 1,
    kind: "notes-image-atom",
    beforeText: input.beforeText,
    afterText: input.afterText,
    image: {
      originalName: input.image.originalName,
      mimeType: input.image.mimeType,
      byteSize: input.image.byteSize,
      contentHash: input.image.contentHash
    }
  };
  const serializedMetadata = metadataJson(metadata);
  const hasValidAttachmentAuthority =
    input.image.byteSize > 0 &&
    input.image.byteSize <= MAX_NOTE_ATTACHMENT_BYTES;
  const custom =
    hasValidAttachmentAuthority &&
    new TextEncoder().encode(serializedMetadata).byteLength <=
      MAX_NOTE_ATTACHMENT_BATCH_METADATA_BYTES
      ? serializedMetadata
      : null;
  let html: string | null = null;
  if (custom !== null) {
    const prefix = `${escapeHtml(
      input.beforeText
    )}<img ${htmlMarkerAttribute}="${escapeHtml(
      metadataMarker(custom)
    )}" alt="${escapeHtml(input.image.originalName)}" src="data:${
      input.image.mimeType
    };base64,`;
    const suffix = `">${escapeHtml(input.afterText)}`;
    if (
      isNotesImageAtomHtmlWithinLimit(
        prefix + suffix,
        input.image.bytes.byteLength
      )
    ) {
      html = `${prefix}${base64FromBytes(input.image.bytes)}${suffix}`;
    }
  }

  return { plainText: plainText(input), html, metadata, custom };
}

function supportsFlavor(
  ClipboardItem: NotesClipboardGlobals["ClipboardItem"],
  type: string
): boolean {
  try {
    return ClipboardItem?.supports?.(type) === true;
  } catch {
    return false;
  }
}

function eventWrite(
  event: NotesClipboardEvent,
  serialized: NotesImageAtomClipboardSerialization,
  defaultPrevented = false
): NotesImageAtomClipboardWriteOutcome {
  if (!event.clipboardData) {
    return {
      kind: "failure",
      message: clipboardFailureMessage,
      carriesImageBytes: false
    };
  }
  try {
    event.clipboardData.setData("text/plain", serialized.plainText);
    if (serialized.html !== null) {
      event.clipboardData.setData("text/html", serialized.html);
    }
    if (serialized.custom !== null) {
      event.clipboardData.setData(
        NOTES_IMAGE_ATOM_CLIPBOARD_MIME,
        serialized.custom
      );
    }
    if (!defaultPrevented) event.preventDefault();
    return {
      kind: "success",
      method: "event",
      carriesImageBytes: serialized.html !== null
    };
  } catch {
    return {
      kind: "failure",
      message: clipboardFailureMessage,
      carriesImageBytes: false
    };
  }
}

export function writeNotesImageAtomClipboard(
  input: NotesImageAtomCopyInput,
  globals: NotesClipboardGlobals,
  dependencies: NotesImageAtomClipboardDependencies = {},
  event?: NotesClipboardEvent
): Promise<NotesImageAtomClipboardWriteOutcome> {
  let serialized: NotesImageAtomClipboardSerialization;
  try {
    serialized = serializeNotesImageAtomClipboard(input, dependencies);
  } catch {
    return Promise.resolve({
      kind: "failure",
      message: clipboardFailureMessage,
      carriesImageBytes: false
    });
  }
  const { clipboard, ClipboardItem, Blob } = globals;
  if (clipboard?.write && ClipboardItem && Blob) {
    let defaultPrevented = false;
    try {
      const data: Record<string, Blob> = {
        "text/plain": new Blob([serialized.plainText], { type: "text/plain" })
      };
      if (serialized.html !== null) {
        data["text/html"] = new Blob([serialized.html], { type: "text/html" });
      }
      if (supportsFlavor(ClipboardItem, input.image.mimeType)) {
        const bytes = input.image.bytes.buffer.slice(
          input.image.bytes.byteOffset,
          input.image.bytes.byteOffset + input.image.bytes.byteLength
        ) as ArrayBuffer;
        data[input.image.mimeType] = new Blob([bytes], {
          type: input.image.mimeType
        });
      }
      if (
        serialized.custom !== null &&
        supportsFlavor(ClipboardItem, NOTES_IMAGE_ATOM_CLIPBOARD_MIME)
      ) {
        data[NOTES_IMAGE_ATOM_CLIPBOARD_MIME] = new Blob(
          [serialized.custom],
          { type: NOTES_IMAGE_ATOM_CLIPBOARD_MIME }
        );
      }
      const item = new ClipboardItem(data);
      event?.preventDefault();
      defaultPrevented = event !== undefined;
      const write = clipboard.write([item]);
      return write.then(
        () => ({
          kind: "success" as const,
          method: "multiMime" as const,
          carriesImageBytes:
            serialized.html !== null ||
            (input.image.mimeType in data &&
              NOTES_IMAGE_ATOM_CLIPBOARD_MIME in data)
        }),
        () => ({
          kind: "failure" as const,
          message: clipboardFailureMessage,
          carriesImageBytes: false as const
        })
      );
    } catch {
      if (event) {
        return Promise.resolve(eventWrite(event, serialized, defaultPrevented));
      }
      return Promise.resolve({
        kind: "failure",
        message: clipboardFailureMessage,
        carriesImageBytes: false
      });
    }
  }
  if (event) return Promise.resolve(eventWrite(event, serialized));
  return Promise.resolve({
    kind: "failure",
    message: clipboardFailureMessage,
    carriesImageBytes: false
  });
}

function parseMetadata(value: string): NotesImageAtomClipboardV1 | null {
  if (
    new TextEncoder().encode(value).byteLength >
    MAX_NOTE_ATTACHMENT_BATCH_METADATA_BYTES
  ) {
    return null;
  }
  try {
    const candidate: unknown = JSON.parse(value);
    if (!candidate || typeof candidate !== "object") return null;
    const payload = candidate as Record<string, unknown>;
    const image = payload.image;
    if (!image || typeof image !== "object") return null;
    const descriptor = image as Record<string, unknown>;
    if (
      payload.version !== 1 ||
      payload.kind !== "notes-image-atom" ||
      typeof payload.beforeText !== "string" ||
      typeof payload.afterText !== "string" ||
      typeof descriptor.originalName !== "string" ||
      typeof descriptor.mimeType !== "string" ||
      !isSupportedMime(descriptor.mimeType) ||
      typeof descriptor.byteSize !== "number" ||
      !Number.isSafeInteger(descriptor.byteSize) ||
      descriptor.byteSize <= 0 ||
      descriptor.byteSize > MAX_NOTE_ATTACHMENT_BYTES ||
      typeof descriptor.contentHash !== "string" ||
      !/^[0-9a-f]{64}$/u.test(descriptor.contentHash)
    ) {
      return null;
    }
    return {
      version: 1,
      kind: "notes-image-atom",
      beforeText: payload.beforeText,
      afterText: payload.afterText,
      image: {
        originalName: descriptor.originalName,
        mimeType: descriptor.mimeType,
        byteSize: descriptor.byteSize,
        contentHash: descriptor.contentHash
      }
    };
  } catch {
    return null;
  }
}

function decodeMarker(value: string | null): NotesImageAtomClipboardV1 | null {
  if (value === null) return null;
  try {
    if (
      new TextEncoder().encode(value).byteLength >
      maxEncodedMarkerBytes
    ) {
      return null;
    }
    const decoded = decodeURIComponent(value);
    return parseMetadata(decoded);
  } catch {
    return null;
  }
}

function decodeBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) {
    return null;
  }
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function dataImageDescriptor(
  value: string,
  ordinal: number,
  BlobConstructor: typeof Blob
): ClipboardImageDescriptor | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/iu.exec(value);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  if (!isSupportedMime(mimeType)) return null;
  const maxEncoded = 4 * Math.ceil(MAX_NOTE_ATTACHMENT_BYTES / 3) + 4;
  if (match[2].length > maxEncoded) return null;
  const bytes = decodeBase64(match[2]);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_NOTE_ATTACHMENT_BYTES) {
    return null;
  }
  const extension = canonicalClipboardImageExtension(mimeType);
  return {
    blob: new BlobConstructor([bytes.slice().buffer], { type: mimeType }),
    originalName: `clipboard-image-${ordinal}.${extension}`,
    mimeType
  };
}

function appendText(
  fragment: ParsedFragmentItem[],
  text: string
) {
  if (!text) return;
  const previous = fragment[fragment.length - 1];
  if (previous?.kind === "text") {
    fragment[fragment.length - 1] = { kind: "text", text: previous.text + text };
  } else {
    fragment.push({ kind: "text", text });
  }
}

interface HtmlParseResult {
  readonly markerPresent: boolean;
  readonly marker: NotesImageAtomClipboardV1 | null;
  readonly external: ParsedImageAtomPaste | null;
  readonly invalid: boolean;
}

function parseHtml(
  html: string,
  dependencies: NotesImageAtomClipboardDependencies
): HtmlParseResult | null {
  const document = dependencies.document ?? globalThis.document;
  const BlobConstructor = dependencies.Blob ?? globalThis.Blob;
  if (!document || !BlobConstructor) return null;
  if (new TextEncoder().encode(html).byteLength > maxHtmlImageBytes) return null;
  let sanitized: string;
  try {
    sanitized = DOMPurify.sanitize(html, {
      ADD_ATTR: [htmlMarkerAttribute],
      FORBID_TAGS: ["style", "script"]
    });
  } catch {
    return null;
  }
  const root = document.createElement("div");
  root.innerHTML = sanitized;
  let marker: NotesImageAtomClipboardV1 | null = null;
  let markerPresent = false;
  let invalidMarker = false;
  let invalidImage = false;
  let imageOrdinal = 0;
  let imageCount = 0;
  let imageBytes = 0;
  const fragment: ParsedFragmentItem[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      appendText(fragment, node.textContent ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const markerValue = element.getAttribute(htmlMarkerAttribute);
    if (markerValue !== null) {
      if (markerPresent) invalidMarker = true;
      markerPresent = true;
      if (element.tagName !== "IMG") {
        invalidMarker = true;
      } else {
        const decoded = decodeMarker(markerValue);
        if (!decoded) invalidMarker = true;
        else marker = decoded;
      }
    }
    if (element.tagName === "BR") {
      appendText(fragment, "\n");
      return;
    }
    if (element.tagName === "IMG") {
      const src = element.getAttribute("src") ?? "";
      if (src.toLowerCase().startsWith("data:")) {
        imageOrdinal += 1;
        const descriptor = dataImageDescriptor(src, imageOrdinal, BlobConstructor);
        if (!descriptor) {
          invalidImage = true;
          return;
        }
        imageCount += 1;
        imageBytes += descriptor.blob.size;
        if (
          imageCount > MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS ||
          imageBytes > MAX_NOTE_ATTACHMENT_BATCH_BYTES
        ) {
          invalidImage = true;
          return;
        }
        fragment.push({ kind: "image", source: descriptor });
      }
      return;
    }
    for (const child of Array.from(element.childNodes)) visit(child);
  };
  for (const child of Array.from(root.childNodes)) visit(child);
  if (invalidMarker || (markerPresent && marker === null)) {
    return { markerPresent, marker: null, external: null, invalid: true };
  }
  if (invalidImage) {
    return { markerPresent, marker, external: null, invalid: true };
  }
  const hasImage = fragment.some((item) => item.kind === "image");
  return {
    markerPresent,
    marker,
    external: hasImage ? { version: 1, fragment } : null,
    invalid: false
  };
}

async function blobBytes(blob: Blob): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

async function exactCarrier(
  metadata: NotesImageAtomClipboardV1,
  carriers: readonly ClipboardImageDescriptor[],
  dependencies: NotesImageAtomClipboardDependencies
): Promise<ClipboardImageDescriptor | null> {
  for (const carrier of carriers) {
    if (carrier.mimeType !== metadata.image.mimeType) continue;
    if (carrier.blob.size !== metadata.image.byteSize) continue;
    const bytes = await blobBytes(carrier.blob);
    if (!bytes || sniffImageMime(bytes) !== metadata.image.mimeType) continue;
    const hash = hexFromBytes(await sha256(bytes, dependencies));
    if (hash === metadata.image.contentHash) return carrier;
  }
  return null;
}

function validateExternalImages(
  items: readonly ClipboardImageDescriptor[]
): string | null {
  if (items.length > MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS) {
    return clipboardPasteFailureMessage;
  }
  let totalBytes = 0;
  for (const item of items) {
    if (
      !isSupportedMime(item.mimeType) ||
      item.blob.size <= 0 ||
      item.blob.size > MAX_NOTE_ATTACHMENT_BYTES
    ) {
      return clipboardPasteFailureMessage;
    }
    totalBytes += item.blob.size;
    if (totalBytes > MAX_NOTE_ATTACHMENT_BATCH_BYTES) {
      return clipboardPasteFailureMessage;
    }
  }
  return null;
}

function imageSources(
  fragment: ParsedImageAtomPaste["fragment"]
): ClipboardImageDescriptor[] {
  return fragment.flatMap((item) => (item.kind === "image" ? [item.source] : []));
}

export async function parseNotesImageAtomPaste(
  input: NotesImageAtomPasteInput,
  dependencies: NotesImageAtomClipboardDependencies = {}
): Promise<NotesImageAtomPasteOutcome> {
  const customMarkerPresent = input.custom !== undefined && input.custom !== null;
  const custom = customMarkerPresent ? parseMetadata(input.custom ?? "") : null;
  const htmlResult = input.html ? parseHtml(input.html, dependencies) : null;
  const htmlMarkerPresent = htmlResult?.markerPresent === true;
  if ((customMarkerPresent && !custom) || (htmlMarkerPresent && !htmlResult?.marker)) {
    return { kind: "error", message: clipboardPasteFailureMessage };
  }
  const marker = custom ?? htmlResult?.marker;
  if (marker) {
    if (custom && htmlResult?.marker && metadataJson(custom) !== metadataJson(htmlResult.marker)) {
      return { kind: "error", message: clipboardPasteFailureMessage };
    }
    if (htmlResult?.invalid && htmlResult.markerPresent) {
      return { kind: "error", message: clipboardPasteFailureMessage };
    }
    const carriers = [
      ...(input.images ?? []).filter(
        (item) => item.mimeType === marker.image.mimeType
      ),
      ...(htmlResult && !htmlResult.invalid && htmlResult.external
        ? imageSources(htmlResult.external.fragment)
        : [])
    ];
    if (validateExternalImages(carriers)) {
      return { kind: "error", message: clipboardPasteFailureMessage };
    }
    const matched = await exactCarrier(marker, carriers, dependencies).catch(
      () => null
    );
    if (!matched) return { kind: "error", message: clipboardPasteFailureMessage };
    const source: ClipboardImageDescriptor = {
      blob: matched.blob,
      originalName: marker.image.originalName,
      mimeType: marker.image.mimeType
    };
    return {
      kind: "imageAtom",
      value: {
        version: 1,
        fragment: [
          { kind: "text", text: marker.beforeText },
          { kind: "image", source },
          { kind: "text", text: marker.afterText }
        ]
      }
    };
  }
  if (input.images && input.images.length > 0) {
    if (validateExternalImages(input.images)) {
      return { kind: "error", message: clipboardPasteFailureMessage };
    }
    return {
      kind: "external",
      value: {
        version: 1,
        fragment: input.images.map((source) => ({ kind: "image", source }))
      }
    };
  }
  if (input.html && (!htmlResult || htmlResult.invalid)) {
    return { kind: "error", message: clipboardPasteFailureMessage };
  }
  if (htmlResult?.external) {
    const invalid = validateExternalImages(imageSources(htmlResult.external.fragment));
    return invalid
      ? { kind: "error", message: invalid }
      : { kind: "external", value: htmlResult.external };
  }
  return { kind: "none" };
}

export async function settleNotesImageAtomCut(
  settlement: Promise<NotesImageAtomClipboardWriteOutcome>,
  isCurrent: () => boolean,
  remove: () => void | Promise<void>
): Promise<NotesImageAtomCutOutcome> {
  const outcome = await settlement;
  if (outcome.kind === "failure") return outcome;
  if (!outcome.carriesImageBytes) {
    return {
      kind: "failure",
      message: "The clipboard did not carry image bytes.",
      carriesImageBytes: false
    };
  }
  if (!isCurrent()) return { kind: "stale", carriesImageBytes: true };
  try {
    await remove();
    return { ...outcome, carriesImageBytes: true };
  } catch {
    return {
      kind: "failure",
      message: "The image could not be removed after copying.",
      carriesImageBytes: true
    };
  }
}
