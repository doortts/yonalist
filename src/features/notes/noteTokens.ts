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
  urlEvidenceEndUtf16: number | null;
}

function isAsciiLetter(codeUnit: number): boolean {
  return (
    (codeUnit >= 0x41 && codeUnit <= 0x5a) ||
    (codeUnit >= 0x61 && codeUnit <= 0x7a)
  );
}

function isAsciiDigit(codeUnit: number): boolean {
  return codeUnit >= 0x30 && codeUnit <= 0x39;
}

function isAsciiLetterOrDigit(codeUnit: number): boolean {
  return isAsciiLetter(codeUnit) || isAsciiDigit(codeUnit);
}

function isUrlLeadRunCharacter(codeUnit: number): boolean {
  return (
    isAsciiLetterOrDigit(codeUnit) ||
    codeUnit === 0x2b ||
    codeUnit === 0x2d ||
    codeUnit === 0x2e
  );
}

function isDomainLabel(
  source: string,
  startUtf16: number,
  endUtf16: number
): boolean {
  if (startUtf16 === endUtf16) {
    return false;
  }
  if (
    !isAsciiLetterOrDigit(source.charCodeAt(startUtf16)) ||
    !isAsciiLetterOrDigit(source.charCodeAt(endUtf16 - 1))
  ) {
    return false;
  }

  for (let offsetUtf16 = startUtf16; offsetUtf16 < endUtf16; offsetUtf16 += 1) {
    const codeUnit = source.charCodeAt(offsetUtf16);
    if (!isAsciiLetterOrDigit(codeUnit) && codeUnit !== 0x2d) {
      return false;
    }
  }

  return true;
}

function isDomainLikeHost(
  source: string,
  startUtf16: number,
  endUtf16: number
): boolean {
  let labelStartUtf16 = startUtf16;
  let topLevelStartUtf16 = -1;

  for (let offsetUtf16 = startUtf16; offsetUtf16 < endUtf16; offsetUtf16 += 1) {
    if (source.charCodeAt(offsetUtf16) !== 0x2e) {
      continue;
    }
    if (!isDomainLabel(source, labelStartUtf16, offsetUtf16)) {
      return false;
    }
    labelStartUtf16 = offsetUtf16 + 1;
    topLevelStartUtf16 = labelStartUtf16;
  }

  if (
    topLevelStartUtf16 < 0 ||
    !isDomainLabel(source, labelStartUtf16, endUtf16) ||
    endUtf16 - topLevelStartUtf16 < 2
  ) {
    return false;
  }

  for (
    let offsetUtf16 = topLevelStartUtf16;
    offsetUtf16 < endUtf16;
    offsetUtf16 += 1
  ) {
    if (!isAsciiLetter(source.charCodeAt(offsetUtf16))) {
      return false;
    }
  }

  return true;
}

function isOpeningUrlWrapper(character: string): boolean {
  return (
    character === "(" ||
    character === "[" ||
    character === "{" ||
    character === "<" ||
    character === '"' ||
    character === "'"
  );
}

function findUrlEvidenceEnd(
  source: string,
  startUtf16: number,
  endUtf16: number
): number | null {
  let relativeStartUtf16 = startUtf16;
  while (
    relativeStartUtf16 < endUtf16 &&
    isOpeningUrlWrapper(scalarAt(source, relativeStartUtf16))
  ) {
    relativeStartUtf16 += scalarAt(source, relativeStartUtf16).length;
  }

  if (
    source.startsWith("/", relativeStartUtf16) ||
    source.startsWith("./", relativeStartUtf16) ||
    source.startsWith("../", relativeStartUtf16)
  ) {
    return relativeStartUtf16;
  }

  let offsetUtf16 = startUtf16;
  while (offsetUtf16 < endUtf16) {
    const codeUnit = source.charCodeAt(offsetUtf16);
    if (!isAsciiLetterOrDigit(codeUnit)) {
      offsetUtf16 += scalarAt(source, offsetUtf16).length;
      continue;
    }

    const runStartUtf16 = offsetUtf16;
    offsetUtf16 += 1;
    while (
      offsetUtf16 < endUtf16 &&
      isUrlLeadRunCharacter(source.charCodeAt(offsetUtf16))
    ) {
      offsetUtf16 += 1;
    }
    const runEndUtf16 = offsetUtf16;

    if (
      isAsciiLetter(source.charCodeAt(runStartUtf16)) &&
      runEndUtf16 + 3 <= endUtf16 &&
      source.startsWith("://", runEndUtf16)
    ) {
      return runEndUtf16 + 3;
    }

    if (
      runEndUtf16 - runStartUtf16 > 4 &&
      source.slice(runStartUtf16, runStartUtf16 + 4).toLowerCase() === "www."
    ) {
      return runStartUtf16 + 4;
    }

    const nextCharacter = source[runEndUtf16];
    if (
      isDomainLikeHost(source, runStartUtf16, runEndUtf16) &&
      (nextCharacter === "/" ||
        nextCharacter === "?" ||
        nextCharacter === "#" ||
        nextCharacter === ":")
    ) {
      return runEndUtf16;
    }
  }

  return null;
}

function readSegmentContext(
  source: string,
  startUtf16: number
): SegmentContext {
  let endUtf16 = startUtf16;

  while (endUtf16 < source.length) {
    const character = scalarAt(source, endUtf16);
    if (unicodeWhitespace.test(character)) {
      break;
    }

    endUtf16 += character.length;
  }

  return {
    endUtf16,
    urlEvidenceEndUtf16: findUrlEvidenceEnd(source, startUtf16, endUtf16)
  };
}

export function tokenizeNoteText(source: string): readonly NoteTextToken[] {
  const tokens: NoteTextToken[] = [];
  let textStartUtf16 = 0;
  let offsetUtf16 = 0;
  let segmentEndUtf16 = 0;
  let segmentUrlEvidenceEndUtf16: number | null = null;

  while (offsetUtf16 < source.length) {
    const character = scalarAt(source, offsetUtf16);
    if (offsetUtf16 >= segmentEndUtf16) {
      if (unicodeWhitespace.test(character)) {
        segmentEndUtf16 = offsetUtf16 + character.length;
        segmentUrlEvidenceEndUtf16 = null;
      } else {
        const segment = readSegmentContext(source, offsetUtf16);
        segmentEndUtf16 = segment.endUtf16;
        segmentUrlEvidenceEndUtf16 = segment.urlEvidenceEndUtf16;
      }
    }

    const prefix =
      character === "#" || character === "@" ? character : null;

    if (
      prefix === null ||
      (segmentUrlEvidenceEndUtf16 !== null &&
        offsetUtf16 >= segmentUrlEvidenceEndUtf16) ||
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

    // Normalize the derived tag VALUE to NFC so decomposed (NFD) and composed
    // spellings of the same tag unify. macOS routinely emits NFD Hangul/accented
    // text via drag, paste, and some IMEs. The UTF-16 offsets and `raw` below still
    // index the ORIGINAL source, whose length may differ from the normalized value.
    const display = source.slice(bodyStartUtf16, bodyEndUtf16).normalize("NFC");
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
