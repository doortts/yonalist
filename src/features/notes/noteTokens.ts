export type NoteTagPrefix = "#" | "@";

interface NoteTokenBase {
  raw: string;
  startUtf16: number;
  endUtf16: number;
}

export interface NotePlainTextToken extends NoteTokenBase {
  kind: "text";
}

export interface NoteTagToken extends NoteTokenBase {
  kind: "tag";
  prefix: NoteTagPrefix;
  display: string;
  normalized: string;
}

export type NoteTextToken = NotePlainTextToken | NoteTagToken;

const unicodeLetterOrNumber = /^[\p{L}\p{N}]$/u;
const unicodeMark = /^\p{M}$/u;
const unicodeWhitespace = /^\s$/u;

function scalarAt(source: string, offsetUtf16: number): string {
  return String.fromCodePoint(source.codePointAt(offsetUtf16)!);
}

function scalarBefore(source: string, offsetUtf16: number): string {
  let startUtf16 = offsetUtf16 - 1;
  const trailingCodeUnit = source.charCodeAt(startUtf16);

  if (
    trailingCodeUnit >= 0xdc00 &&
    trailingCodeUnit <= 0xdfff &&
    startUtf16 > 0
  ) {
    const leadingCodeUnit = source.charCodeAt(startUtf16 - 1);
    if (leadingCodeUnit >= 0xd800 && leadingCodeUnit <= 0xdbff) {
      startUtf16 -= 1;
    }
  }

  return source.slice(startUtf16, offsetUtf16);
}

function isTagBodyStartCharacter(character: string): boolean {
  return (
    character === "_" ||
    character === "-" ||
    unicodeLetterOrNumber.test(character)
  );
}

function isTagBodyContinuationCharacter(character: string): boolean {
  return isTagBodyStartCharacter(character) || unicodeMark.test(character);
}

function hasTagBoundary(source: string, markerOffsetUtf16: number): boolean {
  if (markerOffsetUtf16 === 0) {
    return true;
  }

  const previousCharacter = scalarBefore(source, markerOffsetUtf16);
  return (
    !isTagBodyContinuationCharacter(previousCharacter) &&
    previousCharacter !== "/" &&
    previousCharacter !== "#" &&
    previousCharacter !== "@"
  );
}

interface SegmentContext {
  endUtf16: number;
  isUrlLike: boolean;
}

function readSegmentContext(
  source: string,
  startUtf16: number
): SegmentContext {
  let endUtf16 = startUtf16;
  let hasSlash = false;
  let hasQuestionMark = false;
  let hasEquals = false;

  while (endUtf16 < source.length) {
    const character = scalarAt(source, endUtf16);
    if (unicodeWhitespace.test(character)) {
      break;
    }

    hasSlash ||= character === "/";
    hasQuestionMark ||= character === "?";
    hasEquals ||= character === "=";
    endUtf16 += character.length;
  }

  return {
    endUtf16,
    isUrlLike: hasSlash || (hasQuestionMark && hasEquals)
  };
}

export function tokenizeNoteText(source: string): readonly NoteTextToken[] {
  const tokens: NoteTextToken[] = [];
  let textStartUtf16 = 0;
  let offsetUtf16 = 0;
  let segmentEndUtf16 = 0;
  let segmentIsUrlLike = false;

  while (offsetUtf16 < source.length) {
    const character = scalarAt(source, offsetUtf16);
    if (offsetUtf16 >= segmentEndUtf16) {
      if (unicodeWhitespace.test(character)) {
        segmentEndUtf16 = offsetUtf16 + character.length;
        segmentIsUrlLike = false;
      } else {
        const segment = readSegmentContext(source, offsetUtf16);
        segmentEndUtf16 = segment.endUtf16;
        segmentIsUrlLike = segment.isUrlLike;
      }
    }

    const prefix =
      character === "#" || character === "@" ? character : null;

    if (
      prefix === null ||
      segmentIsUrlLike ||
      !hasTagBoundary(source, offsetUtf16)
    ) {
      offsetUtf16 += character.length;
      continue;
    }

    const bodyStartUtf16 = offsetUtf16 + prefix.length;
    if (bodyStartUtf16 >= source.length) {
      offsetUtf16 += prefix.length;
      continue;
    }

    const firstBodyCharacter = scalarAt(source, bodyStartUtf16);
    if (!isTagBodyStartCharacter(firstBodyCharacter)) {
      offsetUtf16 += prefix.length;
      continue;
    }

    let bodyEndUtf16 = bodyStartUtf16 + firstBodyCharacter.length;

    while (bodyEndUtf16 < source.length) {
      const bodyCharacter = scalarAt(source, bodyEndUtf16);
      if (!isTagBodyContinuationCharacter(bodyCharacter)) {
        break;
      }
      bodyEndUtf16 += bodyCharacter.length;
    }

    if (textStartUtf16 < offsetUtf16) {
      tokens.push({
        kind: "text",
        raw: source.slice(textStartUtf16, offsetUtf16),
        startUtf16: textStartUtf16,
        endUtf16: offsetUtf16
      });
    }

    const display = source.slice(bodyStartUtf16, bodyEndUtf16);
    tokens.push({
      kind: "tag",
      prefix,
      display,
      normalized: display.toLowerCase(),
      raw: source.slice(offsetUtf16, bodyEndUtf16),
      startUtf16: offsetUtf16,
      endUtf16: bodyEndUtf16
    });

    textStartUtf16 = bodyEndUtf16;
    offsetUtf16 = bodyEndUtf16;
  }

  if (textStartUtf16 < source.length) {
    tokens.push({
      kind: "text",
      raw: source.slice(textStartUtf16),
      startUtf16: textStartUtf16,
      endUtf16: source.length
    });
  }

  return tokens;
}
