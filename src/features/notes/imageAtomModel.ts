export interface LogicalSelection {
  readonly anchorUtf16: number;
  readonly focusUtf16: number;
}

export interface ImagePrimaryValue {
  readonly title: string;
  readonly imageOffsetUtf16: number;
}

export interface ImagePrimarySegments {
  readonly beforeText: string;
  readonly afterText: string;
}

type AtomAffinity = "before" | "after";

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer.`);
  }
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function assertUtf16Boundary(title: string, offset: number, name: string): void {
  assertSafeInteger(offset, name);
  if (offset < 0 || offset > title.length) {
    throw new RangeError(`${name} must be within the title.`);
  }
  if (
    offset > 0 &&
    offset < title.length &&
    isHighSurrogate(title.charCodeAt(offset - 1)) &&
    isLowSurrogate(title.charCodeAt(offset))
  ) {
    throw new RangeError(`${name} must not split a surrogate pair.`);
  }
}

function clampLogicalOffset(offset: number, length: number, name: string): number {
  assertSafeInteger(offset, name);
  return Math.min(Math.max(offset, 0), length);
}

function assertLogicalOffset(
  value: ImagePrimaryValue,
  logicalOffset: number,
  affinity: AtomAffinity
): number {
  assertSafeInteger(logicalOffset, "Logical offset");
  if (logicalOffset < 0 || logicalOffset > imageLogicalLength(value)) {
    throw new RangeError("Logical offset must be within the image primary value.");
  }
  if (affinity !== "before" && affinity !== "after") {
    throw new RangeError("Image atom affinity is invalid.");
  }

  // The before and after edges of the omitted atom have the same raw title
  // boundary. Affinity records which logical edge the caller mapped.
  const rawOffset =
    logicalOffset <= value.imageOffsetUtf16
      ? logicalOffset
      : logicalOffset - 1;
  assertUtf16Boundary(value.title, rawOffset, "Logical offset");
  return rawOffset;
}

export function validateImagePrimary(value: ImagePrimaryValue): ImagePrimarySegments {
  assertUtf16Boundary(value.title, value.imageOffsetUtf16, "Image offset");
  return {
    beforeText: value.title.slice(0, value.imageOffsetUtf16),
    afterText: value.title.slice(value.imageOffsetUtf16)
  };
}

export function joinImagePrimary(segments: ImagePrimarySegments): ImagePrimaryValue {
  const value = {
    title: segments.beforeText + segments.afterText,
    imageOffsetUtf16: segments.beforeText.length
  };
  validateImagePrimary(value);
  return value;
}

export function imageLogicalLength(value: ImagePrimaryValue): number {
  validateImagePrimary(value);
  return value.title.length + 1;
}

export function normalizeLogicalSelection(
  value: ImagePrimaryValue,
  selection: LogicalSelection
): LogicalSelection {
  const length = imageLogicalLength(value);
  const normalized = {
    anchorUtf16: clampLogicalOffset(selection.anchorUtf16, length, "Selection anchor"),
    focusUtf16: clampLogicalOffset(selection.focusUtf16, length, "Selection focus")
  };
  logicalToRawOffset(value, normalized.anchorUtf16, "before");
  logicalToRawOffset(value, normalized.focusUtf16, "after");
  return normalized;
}

export function logicalToRawOffset(
  value: ImagePrimaryValue,
  logicalOffset: number,
  affinity: AtomAffinity
): number {
  validateImagePrimary(value);
  return assertLogicalOffset(value, logicalOffset, affinity);
}

export function applyImageLogicalTextEdit(
  value: ImagePrimaryValue,
  selection: LogicalSelection,
  replacement: string
): {
  value: ImagePrimaryValue;
  selection: LogicalSelection;
  removesAtom: boolean;
} {
  const normalized = normalizeLogicalSelection(value, selection);
  const start = Math.min(normalized.anchorUtf16, normalized.focusUtf16);
  const end = Math.max(normalized.anchorUtf16, normalized.focusUtf16);
  const startRaw = logicalToRawOffset(value, start, "before");
  const endRaw = logicalToRawOffset(value, end, "after");
  const removesAtom = start <= value.imageOffsetUtf16 && end > value.imageOffsetUtf16;
  const title = value.title.slice(0, startRaw) + replacement + value.title.slice(endRaw);
  const caretUtf16 = start + replacement.length;

  if (removesAtom) {
    return {
      value: { title, imageOffsetUtf16: 0 },
      selection: { anchorUtf16: caretUtf16, focusUtf16: caretUtf16 },
      removesAtom: true
    };
  }

  const imageOffsetUtf16 =
    end <= value.imageOffsetUtf16
      ? value.imageOffsetUtf16 + replacement.length - (endRaw - startRaw)
      : value.imageOffsetUtf16;
  const nextValue = { title, imageOffsetUtf16 };
  validateImagePrimary(nextValue);
  return {
    value: nextValue,
    selection: { anchorUtf16: caretUtf16, focusUtf16: caretUtf16 },
    removesAtom: false
  };
}
