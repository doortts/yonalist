export type OutlinePresentationKind =
  | "text"
  | "heading"
  | "quote"
  | "divider";

export type OutlinePresentationToken =
  | {
      readonly kind: "text";
      readonly raw: string;
      readonly display: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "strong" | "strike";
      readonly raw: string;
      readonly display: string;
      readonly start: number;
      readonly end: number;
      readonly contentStart: number;
      readonly contentEnd: number;
    }
  | {
      readonly kind: "link";
      readonly raw: string;
      readonly display: string;
      readonly href: string;
      readonly start: number;
      readonly end: number;
      readonly contentStart: number;
      readonly contentEnd: number;
    }
  | {
      readonly kind: "tag";
      readonly raw: string;
      readonly display: string;
      readonly prefix: "#" | "@";
      readonly normalized: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "date";
      readonly raw: string;
      readonly display: string;
      readonly start: number;
      readonly end: number;
    };

export interface OutlinePresentation {
  readonly kind: OutlinePresentationKind;
  readonly level?: 1 | 2 | 3;
  readonly markerEnd: number;
  readonly tokens: readonly OutlinePresentationToken[];
}

const MAX_PRESENTATION_LENGTH = 20_000;
const tagStartCharacter = /[\p{L}\p{N}_]/u;
const tagCharacter = /[\p{L}\p{M}\p{N}_-]/u;
const tagBoundaryCharacter = /[\p{L}\p{M}\p{N}_#@-]/u;

function isSafeWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function pushTextToken(
  tokens: OutlinePresentationToken[],
  source: string,
  start: number,
  end: number
): void {
  if (end <= start) return;
  const raw = source.slice(start, end);
  const previous = tokens.at(-1);
  if (previous?.kind === "text" && previous.end === start) {
    tokens[tokens.length - 1] = {
      kind: "text",
      raw: previous.raw + raw,
      display: previous.display + raw,
      start: previous.start,
      end
    };
    return;
  }
  tokens.push({ kind: "text", raw, display: raw, start, end });
}

function matchInlineMarkdown(
  source: string,
  start: number
): OutlinePresentationToken | null {
  const marker = source.slice(start, start + 2);
  if (marker === "**" || marker === "~~") {
    const endMarker = source.indexOf(marker, start + 2);
    if (endMarker < start + 3) return null;
    const display = source.slice(start + 2, endMarker);
    if (/^\s|\s$/u.test(display)) return null;
    const end = endMarker + 2;
    return {
      kind: marker === "**" ? "strong" : "strike",
      raw: source.slice(start, end),
      display,
      start,
      end,
      contentStart: start + 2,
      contentEnd: endMarker
    };
  }

  if (source[start] !== "[") return null;
  const match = /^\[([^\]\r\n]+)\]\(([^)\s]+)\)/u.exec(source.slice(start));
  if (!match || !isSafeWebUrl(match[2])) return null;
  const end = start + match[0].length;
  return {
    kind: "link",
    raw: match[0],
    display: match[1],
    href: match[2],
    start,
    end,
    contentStart: start + 1,
    contentEnd: start + 1 + match[1].length
  };
}

function matchRawUrl(
  source: string,
  start: number
): OutlinePresentationToken | null {
  if (!source.startsWith("http://", start) && !source.startsWith("https://", start)) {
    return null;
  }
  const match = /^https?:\/\/[^\s<>()\[\]{}]+/iu.exec(source.slice(start));
  if (!match) return null;
  const raw = match[0].replace(/[.,!?;:]+$/u, "");
  if (!raw || !isSafeWebUrl(raw)) return null;
  const end = start + raw.length;
  return {
    kind: "link",
    raw,
    display: raw,
    href: raw,
    start,
    end,
    contentStart: start,
    contentEnd: end
  };
}

function matchTag(
  source: string,
  start: number
): OutlinePresentationToken | null {
  const prefix = source[start];
  if (prefix !== "#" && prefix !== "@") return null;
  const previous = start > 0 ? source[start - 1] : "";
  if (previous && tagBoundaryCharacter.test(previous)) return null;

  const first = source[start + 1];
  if (!first || !tagStartCharacter.test(first)) return null;
  let end = start + 2;
  while (end < source.length) {
    const point = source.codePointAt(end);
    if (point === undefined) break;
    const character = String.fromCodePoint(point);
    if (!tagCharacter.test(character)) break;
    end += character.length;
  }
  const raw = source.slice(start, end);
  const body = raw.slice(1);
  return {
    kind: "tag",
    raw,
    display: raw,
    prefix,
    normalized: body.normalize("NFC").toLocaleLowerCase("und"),
    start,
    end
  };
}

function matchDate(
  source: string,
  start: number
): OutlinePresentationToken | null {
  const raw = source.slice(start, start + 10);
  if (
    !isValidIsoDate(raw) ||
    (start > 0 && /\d/u.test(source[start - 1])) ||
    (start + 10 < source.length && /\d/u.test(source[start + 10]))
  ) {
    return null;
  }
  return {
    kind: "date",
    raw,
    display: raw,
    start,
    end: start + 10
  };
}

function resolveBlock(source: string, markdown: boolean): {
  readonly kind: OutlinePresentationKind;
  readonly level?: 1 | 2 | 3;
  readonly markerEnd: number;
} {
  if (markdown && source === "--") {
    return { kind: "divider", markerEnd: source.length };
  }
  const heading = markdown ? /^(#{1,3}) (.+)$/u.exec(source) : null;
  if (heading) {
    return {
      kind: "heading",
      level: heading[1].length as 1 | 2 | 3,
      markerEnd: heading[1].length + 1
    };
  }
  if (markdown && source.startsWith("> ") && source.length > 2) {
    return { kind: "quote", markerEnd: 2 };
  }
  return { kind: "text", markerEnd: 0 };
}

export function parseOutlinePresentation(
  source: string,
  options: { readonly markdown?: boolean } = {}
): OutlinePresentation {
  const markdown = options.markdown ?? true;
  const block = resolveBlock(source, markdown);
  if (source.length > MAX_PRESENTATION_LENGTH) {
    return {
      ...block,
      tokens:
        source.length > block.markerEnd
          ? [{
              kind: "text",
              raw: source.slice(block.markerEnd),
              display: source.slice(block.markerEnd),
              start: block.markerEnd,
              end: source.length
            }]
          : []
    };
  }

  const tokens: OutlinePresentationToken[] = [];
  let textStart = block.markerEnd;
  let index = block.markerEnd;
  while (index < source.length) {
    const token =
      (markdown ? matchInlineMarkdown(source, index) : null) ??
      matchRawUrl(source, index) ??
      matchTag(source, index) ??
      matchDate(source, index);
    if (!token) {
      index += 1;
      continue;
    }
    pushTextToken(tokens, source, textStart, index);
    tokens.push(token);
    index = token.end;
    textStart = index;
  }
  pushTextToken(tokens, source, textStart, source.length);
  return { ...block, tokens };
}

export function sourceOffsetFromOutlinePresentation(
  presentation: OutlinePresentation,
  presentationOffset: number
): number {
  if (presentation.kind === "divider") return presentation.markerEnd;
  let renderedStart = 0;
  for (const token of presentation.tokens) {
    const renderedEnd = renderedStart + token.display.length;
    if (presentationOffset < renderedEnd) {
      const relative = Math.max(
        0,
        Math.min(token.display.length, presentationOffset - renderedStart)
      );
      if (
        token.kind === "strong" ||
        token.kind === "strike" ||
        token.kind === "link"
      ) {
        return token.contentStart + relative;
      }
      return token.start + relative;
    }
    renderedStart = renderedEnd;
  }
  return presentation.tokens.at(-1)?.end ?? presentation.markerEnd;
}
