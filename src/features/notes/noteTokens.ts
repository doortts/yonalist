import { normalizeNoteTagIdentity } from "./noteTagIdentity";
import {
  isUnicodeLetterOrNumber,
  isUnicodeMark
} from "./noteUnicodeCategories";

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

export type NoteFormatKind = "strong" | "em" | "strike" | "code";

/**
 * A Workflowy-style inline formatting span stored as PLAIN TEXT. The marker
 * characters (`**`, `*`, `~~`, `` ` ``) remain part of {@link raw} so the
 * rendered overlay reproduces the source character-for-character (the caret /
 * selection mapping in NoteTextField/NoteTokenText depends on identical
 * length); `innerStartUtf16`/`innerEndUtf16` bound only the styled content
 * between the markers.
 */
export interface NoteFormatToken extends NoteTokenBase {
  kind: NoteFormatKind;
  innerStartUtf16: number;
  innerEndUtf16: number;
}

/**
 * An auto-linked `http`/`https` URL stored as PLAIN TEXT. Like a tag, the full
 * source slice is preserved in {@link raw} so the rendered overlay reproduces
 * the source character-for-character (caret / selection mapping depends on
 * identical length). Only `http://` and `https://` are recognized — never
 * `javascript:`, `mailto:`, other schemes, or a bare `www.` host — so the
 * value in {@link raw} is always safe to hand to `openExternal`.
 */
export interface NoteUrlToken extends NoteTokenBase {
  kind: "url";
}

export type NoteTextToken =
  | NotePlainTextToken
  | NoteTagToken
  | NoteFormatToken
  | NoteUrlToken;

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
  return character === "_" || character === "-" || isUnicodeLetterOrNumber(character);
}

function isTagBodyContinuationCharacter(character: string): boolean {
  return isTagBodyStartCharacter(character) || isUnicodeMark(character);
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

function isAsciiUppercase(codeUnit: number): boolean {
  return codeUnit >= 0x41 && codeUnit <= 0x5a;
}

function isAsciiDigit(codeUnit: number): boolean {
  return codeUnit >= 0x30 && codeUnit <= 0x39;
}

function isAsciiLetterOrDigit(codeUnit: number): boolean {
  return isAsciiLetter(codeUnit) || isAsciiDigit(codeUnit);
}

function isAsciiScalar(character: string): boolean {
  return character.length === 1 && character.charCodeAt(0) <= 0x7f;
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

// ---------------------------------------------------------------------------
// URL auto-links (http/https only)
//
// A URL token is emitted for a literal `http://` or `https://` run. The scheme
// is matched case-insensitively; every other scheme (including `javascript:`,
// `mailto:`, and a bare `www.` host) is left as ordinary text, so a URL token's
// `raw` is always an http/https URL that is safe to open externally.
//
// Boundary rule (kept deliberately conservative so prose is not over-linked):
//   * The scheme must sit at a word boundary — offset 0, or preceded by a
//     scalar that is NOT an ASCII letter or digit — so `http` embedded inside a
//     larger token (e.g. `xhttp://…`) is not linkified.
//   * The body runs from the scheme to the first RFC "delimiter"/whitespace
//     character (space, control, `<` `>` `"` `` ` `` `{` `}` `|` `\` `^`), which
//     never appears unescaped in a URL.
//   * Trailing sentence punctuation (`. , ; : ! ? '`) is dropped, as is a
//     trailing `)`/`]` that is unbalanced within the URL (so `(http://x)` links
//     `http://x` while `http://x/a(b)` keeps its balanced parens).
//   * At least one authority character must remain after `://`; a bare scheme
//     is not a link.
// ---------------------------------------------------------------------------

function matchesLowercaseAscii(
  source: string,
  offsetUtf16: number,
  lowercaseTarget: string
): boolean {
  if (offsetUtf16 + lowercaseTarget.length > source.length) {
    return false;
  }
  for (let index = 0; index < lowercaseTarget.length; index += 1) {
    let codeUnit = source.charCodeAt(offsetUtf16 + index);
    if (codeUnit >= 0x41 && codeUnit <= 0x5a) {
      codeUnit += 0x20;
    }
    if (codeUnit !== lowercaseTarget.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function urlSchemeLength(source: string, offsetUtf16: number): number {
  const firstCodeUnit = source.charCodeAt(offsetUtf16);
  // Fast reject: every accepted scheme starts with `h`/`H`.
  if (!isHttpUrlSchemeLead(firstCodeUnit)) {
    return 0;
  }
  if (matchesLowercaseAscii(source, offsetUtf16, "https://")) {
    return 8;
  }
  if (matchesLowercaseAscii(source, offsetUtf16, "http://")) {
    return 7;
  }
  return 0;
}

function isHttpUrlSchemeLead(codeUnit: number): boolean {
  return codeUnit === 0x68 || codeUnit === 0x48;
}

function isUrlBodyStopCodeUnit(codeUnit: number): boolean {
  if (codeUnit <= 0x20) {
    // C0 controls and the space character.
    return true;
  }
  if (codeUnit < 0x80) {
    return (
      codeUnit === 0x22 || // "
      codeUnit === 0x3c || // <
      codeUnit === 0x3e || // >
      codeUnit === 0x5c || // \
      codeUnit === 0x5e || // ^
      codeUnit === 0x60 || // `
      codeUnit === 0x7b || // {
      codeUnit === 0x7c || // |
      codeUnit === 0x7d || // }
      codeUnit === 0x7f // DEL
    );
  }
  // Non-ASCII: stop on Unicode whitespace only. A lone surrogate is never
  // whitespace, so an astral scalar stays inside the URL and its pair is never
  // split (both halves are non-stop, so the boundary lands after the pair).
  return unicodeWhitespace.test(String.fromCharCode(codeUnit));
}

function countCodeUnit(
  source: string,
  startUtf16: number,
  endUtf16: number,
  codeUnit: number
): number {
  let total = 0;
  for (let offsetUtf16 = startUtf16; offsetUtf16 < endUtf16; offsetUtf16 += 1) {
    if (source.charCodeAt(offsetUtf16) === codeUnit) {
      total += 1;
    }
  }
  return total;
}

function trimTrailingUrlPunctuation(
  source: string,
  startUtf16: number,
  endUtf16: number
): number {
  // Opener counts are fixed (openers are never trailing punctuation, so they
  // are never trimmed); only closer counts fall as brackets are stripped, so
  // this stays linear in the URL length.
  const openParenCount = countCodeUnit(source, startUtf16, endUtf16, 0x28);
  let closeParenCount = countCodeUnit(source, startUtf16, endUtf16, 0x29);
  const openBracketCount = countCodeUnit(source, startUtf16, endUtf16, 0x5b);
  let closeBracketCount = countCodeUnit(source, startUtf16, endUtf16, 0x5d);

  let trimmedEndUtf16 = endUtf16;
  while (trimmedEndUtf16 > startUtf16) {
    const codeUnit = source.charCodeAt(trimmedEndUtf16 - 1);
    if (
      codeUnit === 0x2e || // .
      codeUnit === 0x2c || // ,
      codeUnit === 0x3b || // ;
      codeUnit === 0x3a || // :
      codeUnit === 0x21 || // !
      codeUnit === 0x3f || // ?
      codeUnit === 0x27 // '
    ) {
      trimmedEndUtf16 -= 1;
      continue;
    }
    if (codeUnit === 0x29) {
      if (closeParenCount > openParenCount) {
        trimmedEndUtf16 -= 1;
        closeParenCount -= 1;
        continue;
      }
      break;
    }
    if (codeUnit === 0x5d) {
      if (closeBracketCount > openBracketCount) {
        trimmedEndUtf16 -= 1;
        closeBracketCount -= 1;
        continue;
      }
      break;
    }
    break;
  }
  return trimmedEndUtf16;
}

// Returns the exclusive end offset of an http/https URL starting at
// `offsetUtf16`, or null if no URL begins there.
function matchUrlAt(source: string, offsetUtf16: number): number | null {
  if (offsetUtf16 > 0) {
    const previousCodeUnit = source.charCodeAt(offsetUtf16 - 1);
    if (isAsciiLetterOrDigit(previousCodeUnit)) {
      return null;
    }
  }

  const schemeLength = urlSchemeLength(source, offsetUtf16);
  if (schemeLength === 0) {
    return null;
  }

  const schemeEndUtf16 = offsetUtf16 + schemeLength;
  let bodyEndUtf16 = schemeEndUtf16;
  while (
    bodyEndUtf16 < source.length &&
    !isUrlBodyStopCodeUnit(source.charCodeAt(bodyEndUtf16))
  ) {
    bodyEndUtf16 += 1;
  }

  const endUtf16 = trimTrailingUrlPunctuation(
    source,
    schemeEndUtf16,
    bodyEndUtf16
  );
  // A bare scheme with no authority is not a link.
  if (endUtf16 <= schemeEndUtf16) {
    return null;
  }
  return endUtf16;
}

interface FormatMarker {
  readonly text: string;
  readonly kind: NoteFormatKind;
}

// Two-character markers precede their one-character prefixes so `**` wins over
// `*` when both could open at the same offset.
const FORMAT_MARKERS: readonly FormatMarker[] = [
  { text: "**", kind: "strong" },
  { text: "~~", kind: "strike" },
  { text: "*", kind: "em" },
  { text: "`", kind: "code" }
];

function matchFormatOpen(
  source: string,
  offsetUtf16: number
): FormatMarker | null {
  for (const marker of FORMAT_MARKERS) {
    if (source.startsWith(marker.text, offsetUtf16)) {
      return marker;
    }
  }
  return null;
}

function hasPossibleFormatMarker(source: string): boolean {
  return (
    source.includes("*") ||
    source.includes("`") ||
    source.includes("~~")
  );
}

interface FormatSpan {
  readonly kind: NoteFormatKind;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly innerStartUtf16: number;
  readonly innerEndUtf16: number;
}

// Find the closing marker for an opener. The content must be non-empty and the
// closer must be right-flanking (preceded by a non-whitespace scalar), mirroring
// the left-flanking opener rule so prose like "a * b *" never turns into
// emphasis. Whitespace-preceded candidates are skipped, not treated as failures.
function findFormatClose(
  source: string,
  markerText: string,
  innerStartUtf16: number
): number | null {
  let searchFromUtf16 = innerStartUtf16;
  while (searchFromUtf16 < source.length) {
    const closeUtf16 = source.indexOf(markerText, searchFromUtf16);
    if (closeUtf16 === -1) {
      return null;
    }
    if (
      closeUtf16 > innerStartUtf16 &&
      !unicodeWhitespace.test(scalarBefore(source, closeUtf16))
    ) {
      return closeUtf16;
    }
    searchFromUtf16 = closeUtf16 + 1;
  }
  return null;
}

// Formatting is tokenized at the TOP LEVEL and never recurses: a span's inner
// content is treated as plain styled text, so tags and dates inside a span are
// NOT separately recognized (they render as ordinary formatted characters).
// Spans are returned sorted by start and are guaranteed non-overlapping.
function findFormatSpans(source: string): readonly FormatSpan[] {
  const spans: FormatSpan[] = [];
  let offsetUtf16 = 0;

  while (offsetUtf16 < source.length) {
    const marker = matchFormatOpen(source, offsetUtf16);
    if (marker === null) {
      offsetUtf16 += 1;
      continue;
    }

    const innerStartUtf16 = offsetUtf16 + marker.text.length;
    // Left-flanking opener: the first content scalar must be non-whitespace.
    if (
      innerStartUtf16 >= source.length ||
      unicodeWhitespace.test(scalarAt(source, innerStartUtf16))
    ) {
      offsetUtf16 += 1;
      continue;
    }

    const closeUtf16 = findFormatClose(source, marker.text, innerStartUtf16);
    if (closeUtf16 === null) {
      offsetUtf16 += 1;
      continue;
    }

    spans.push({
      kind: marker.kind,
      startUtf16: offsetUtf16,
      endUtf16: closeUtf16 + marker.text.length,
      innerStartUtf16,
      innerEndUtf16: closeUtf16
    });
    offsetUtf16 = closeUtf16 + marker.text.length;
  }

  return spans;
}

export function tokenizeNoteText(source: string): readonly NoteTextToken[] {
  const tokens: NoteTextToken[] = [];
  const formatSpans: readonly FormatSpan[] = hasPossibleFormatMarker(source)
    ? findFormatSpans(source)
    : [];
  let nextSpanIndex = 0;
  let textStartUtf16 = 0;
  let offsetUtf16 = 0;
  let segmentEndUtf16 = 0;
  let segmentUrlEvidenceEndUtf16: number | null = null;

  while (offsetUtf16 < source.length) {
    // A formatting span consumes its whole range (markers + inner content) as a
    // single non-recursive token; tag scanning resumes only after it.
    const span =
      nextSpanIndex < formatSpans.length &&
      formatSpans[nextSpanIndex].startUtf16 === offsetUtf16
        ? formatSpans[nextSpanIndex]
        : null;
    if (span) {
      if (textStartUtf16 < offsetUtf16) {
        tokens.push({
          kind: "text",
          raw: source.slice(textStartUtf16, offsetUtf16),
          startUtf16: textStartUtf16,
          endUtf16: offsetUtf16
        });
      }
      tokens.push({
        kind: span.kind,
        raw: source.slice(span.startUtf16, span.endUtf16),
        startUtf16: span.startUtf16,
        endUtf16: span.endUtf16,
        innerStartUtf16: span.innerStartUtf16,
        innerEndUtf16: span.innerEndUtf16
      });
      nextSpanIndex += 1;
      textStartUtf16 = span.endUtf16;
      offsetUtf16 = span.endUtf16;
      continue;
    }

    // A URL literal (http/https only) is an atomic top-level token, like a tag:
    // its whole extent — including any `#`/`@` that would otherwise open a tag —
    // is consumed here, so the enclosed text is never re-scanned. Formatting
    // wins when it starts first (the loop reaches the span's opener before the
    // URL and jumps past it); conversely a formatting span that starts INSIDE a
    // URL is discarded (nextSpanIndex advances past it) and its markers render
    // as plain URL characters — mirroring the tokenizer's non-recursion rule.
    const urlEndUtf16 = isHttpUrlSchemeLead(source.charCodeAt(offsetUtf16))
      ? matchUrlAt(source, offsetUtf16)
      : null;
    if (urlEndUtf16 !== null) {
      if (textStartUtf16 < offsetUtf16) {
        tokens.push({
          kind: "text",
          raw: source.slice(textStartUtf16, offsetUtf16),
          startUtf16: textStartUtf16,
          endUtf16: offsetUtf16
        });
      }
      tokens.push({
        kind: "url",
        raw: source.slice(offsetUtf16, urlEndUtf16),
        startUtf16: offsetUtf16,
        endUtf16: urlEndUtf16
      });
      while (
        nextSpanIndex < formatSpans.length &&
        formatSpans[nextSpanIndex].startUtf16 < urlEndUtf16
      ) {
        nextSpanIndex += 1;
      }
      textStartUtf16 = urlEndUtf16;
      offsetUtf16 = urlEndUtf16;
      continue;
    }

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

    let tagBodyIsAscii = isAsciiScalar(firstBodyCharacter);
    let tagBodyHasAsciiUppercase =
      tagBodyIsAscii && isAsciiUppercase(firstBodyCharacter.charCodeAt(0));
    let bodyEndUtf16 = bodyStartUtf16 + firstBodyCharacter.length;

    while (bodyEndUtf16 < source.length) {
      const bodyCharacter = scalarAt(source, bodyEndUtf16);
      if (!isTagBodyContinuationCharacter(bodyCharacter)) {
        break;
      }
      if (isAsciiScalar(bodyCharacter)) {
        tagBodyHasAsciiUppercase ||= isAsciiUppercase(
          bodyCharacter.charCodeAt(0)
        );
      } else {
        tagBodyIsAscii = false;
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

    // Keep an NFC display value, while deriving semantic identity through the
    // shared NFC -> full Unicode fold -> NFC pipeline. macOS routinely emits NFD
    // Hangul/accented text via drag, paste, and some IMEs. The UTF-16 offsets and
    // `raw` below still index the ORIGINAL source, whose length may differ from
    // either derived value.
    const display = source.slice(bodyStartUtf16, bodyEndUtf16).normalize("NFC");
    tokens.push({
      kind: "tag",
      prefix,
      display,
      normalized: normalizeNoteTagIdentity(display),
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
