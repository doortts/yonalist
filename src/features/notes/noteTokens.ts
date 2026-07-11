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

function isTagBodyCharacter(character: string): boolean {
  return (
    character === "_" ||
    character === "-" ||
    unicodeLetterOrNumber.test(character)
  );
}

function hasTagBoundary(source: string, markerOffsetUtf16: number): boolean {
  if (markerOffsetUtf16 === 0) {
    return true;
  }

  const previousCharacter = scalarBefore(source, markerOffsetUtf16);
  return (
    !isTagBodyCharacter(previousCharacter) &&
    previousCharacter !== "/" &&
    previousCharacter !== "#" &&
    previousCharacter !== "@"
  );
}

export function tokenizeNoteText(source: string): readonly NoteTextToken[] {
  const tokens: NoteTextToken[] = [];
  let textStartUtf16 = 0;
  let offsetUtf16 = 0;

  while (offsetUtf16 < source.length) {
    const character = scalarAt(source, offsetUtf16);
    const prefix =
      character === "#" || character === "@" ? character : null;

    if (prefix === null || !hasTagBoundary(source, offsetUtf16)) {
      offsetUtf16 += character.length;
      continue;
    }

    const bodyStartUtf16 = offsetUtf16 + prefix.length;
    let bodyEndUtf16 = bodyStartUtf16;

    while (bodyEndUtf16 < source.length) {
      const bodyCharacter = scalarAt(source, bodyEndUtf16);
      if (!isTagBodyCharacter(bodyCharacter)) {
        break;
      }
      bodyEndUtf16 += bodyCharacter.length;
    }

    if (bodyEndUtf16 === bodyStartUtf16) {
      offsetUtf16 += prefix.length;
      continue;
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
