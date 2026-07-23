export type NoteMarkdownInlineKind =
  | "text"
  | "strong"
  | "strike"
  | "link";

export interface NoteMarkdownInline {
  readonly kind: NoteMarkdownInlineKind;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly contentStartUtf16: number;
  readonly contentEndUtf16: number;
  readonly href?: string;
}

export type NoteMarkdownBlock =
  | {
      readonly kind: "text";
      readonly inline: readonly NoteMarkdownInline[];
    }
  | {
      readonly kind: "heading";
      readonly level: 1 | 2 | 3;
      readonly markerEndUtf16: number;
      readonly inline: readonly NoteMarkdownInline[];
    }
  | {
      readonly kind: "quote";
      readonly markerEndUtf16: number;
      readonly inline: readonly NoteMarkdownInline[];
    }
  | { readonly kind: "divider" }
  | {
      readonly kind: "remoteImage";
      readonly alt: string;
      readonly url: string;
    };

interface InlineMatch {
  readonly kind: Exclude<NoteMarkdownInlineKind, "text">;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly contentStartUtf16: number;
  readonly contentEndUtf16: number;
  readonly href?: string;
}

function isAllowedLinkUrl(value: string): boolean {
  if (value.length === 0 || /\s/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isAllowedImageUrl(value: string): boolean {
  if (value.length === 0 || /\s/u.test(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function matchLinkAt(source: string, startUtf16: number): InlineMatch | null {
  if (source[startUtf16] !== "[" || source[startUtf16 - 1] === "!") {
    return null;
  }
  const labelEndUtf16 = source.indexOf("](", startUtf16 + 1);
  if (labelEndUtf16 <= startUtf16 + 1) return null;
  const urlStartUtf16 = labelEndUtf16 + 2;
  const urlEndUtf16 = source.indexOf(")", urlStartUtf16);
  if (urlEndUtf16 === -1) return null;
  const href = source.slice(urlStartUtf16, urlEndUtf16);
  if (!isAllowedLinkUrl(href)) return null;
  return {
    kind: "link",
    startUtf16,
    endUtf16: urlEndUtf16 + 1,
    contentStartUtf16: startUtf16 + 1,
    contentEndUtf16: labelEndUtf16,
    href
  };
}

function matchFormatAt(
  source: string,
  startUtf16: number,
  marker: "**" | "~~",
  kind: "strong" | "strike"
): InlineMatch | null {
  if (!source.startsWith(marker, startUtf16)) return null;
  const contentStartUtf16 = startUtf16 + marker.length;
  if (
    contentStartUtf16 >= source.length ||
    /\s/u.test(source[contentStartUtf16]!)
  ) {
    return null;
  }
  let closeUtf16 = source.indexOf(marker, contentStartUtf16);
  while (closeUtf16 !== -1) {
    if (
      closeUtf16 > contentStartUtf16 &&
      !/\s/u.test(source[closeUtf16 - 1]!)
    ) {
      return {
        kind,
        startUtf16,
        endUtf16: closeUtf16 + marker.length,
        contentStartUtf16,
        contentEndUtf16: closeUtf16
      };
    }
    closeUtf16 = source.indexOf(marker, closeUtf16 + 1);
  }
  return null;
}

function matchInlineAt(
  source: string,
  startUtf16: number
): InlineMatch | null {
  return (
    matchLinkAt(source, startUtf16) ??
    matchFormatAt(source, startUtf16, "**", "strong") ??
    matchFormatAt(source, startUtf16, "~~", "strike")
  );
}

function parseInline(
  source: string,
  contentStartUtf16: number
): readonly NoteMarkdownInline[] {
  const tokens: NoteMarkdownInline[] = [];
  let plainStartUtf16 = contentStartUtf16;
  let offsetUtf16 = contentStartUtf16;

  while (offsetUtf16 < source.length) {
    const match = matchInlineAt(source, offsetUtf16);
    if (!match) {
      offsetUtf16 += 1;
      continue;
    }
    if (plainStartUtf16 < offsetUtf16) {
      tokens.push({
        kind: "text",
        startUtf16: plainStartUtf16,
        endUtf16: offsetUtf16,
        contentStartUtf16: plainStartUtf16,
        contentEndUtf16: offsetUtf16
      });
    }
    tokens.push(match);
    offsetUtf16 = match.endUtf16;
    plainStartUtf16 = offsetUtf16;
  }

  if (plainStartUtf16 < source.length) {
    tokens.push({
      kind: "text",
      startUtf16: plainStartUtf16,
      endUtf16: source.length,
      contentStartUtf16: plainStartUtf16,
      contentEndUtf16: source.length
    });
  }
  return tokens;
}

function parseRemoteImage(source: string): NoteMarkdownBlock | null {
  const match = /^!\[([^\]]*)\]\(([^)\s]+)\)$/u.exec(source);
  if (!match || !isAllowedImageUrl(match[2]!)) return null;
  return {
    kind: "remoteImage",
    alt: match[1]!,
    url: match[2]!
  };
}

export function parseNoteMarkdown(source: string): NoteMarkdownBlock {
  const remoteImage = parseRemoteImage(source);
  if (remoteImage) return remoteImage;
  if (source === "--") return { kind: "divider" };

  const heading = /^(#{1,3}) (.+)$/u.exec(source);
  if (heading) {
    const level = heading[1]!.length as 1 | 2 | 3;
    const markerEndUtf16 = level + 1;
    return {
      kind: "heading",
      level,
      markerEndUtf16,
      inline: parseInline(source, markerEndUtf16)
    };
  }

  if (source.startsWith("> ") && source.length > 2) {
    return {
      kind: "quote",
      markerEndUtf16: 2,
      inline: parseInline(source, 2)
    };
  }

  return { kind: "text", inline: parseInline(source, 0) };
}

export function isStandaloneRemoteMarkdownImage(source: string): boolean {
  return parseNoteMarkdown(source).kind === "remoteImage";
}

function sourceLength(block: NoteMarkdownBlock): number {
  if (block.kind === "divider") return 2;
  if (block.kind === "remoteImage") {
    return `![${block.alt}](${block.url})`.length;
  }
  return block.inline.at(-1)?.endUtf16 ?? 0;
}

export function sourceOffsetFromPresentation(
  block: NoteMarkdownBlock,
  presentationOffsetUtf16: number
): number {
  const clampedPresentationOffset = Math.max(0, presentationOffsetUtf16);
  if (block.kind === "divider") {
    return Math.min(2, clampedPresentationOffset);
  }
  if (block.kind === "remoteImage") {
    return clampedPresentationOffset === 0 ? 0 : sourceLength(block);
  }

  let remaining = clampedPresentationOffset;
  for (let index = 0; index < block.inline.length; index += 1) {
    const token = block.inline[index]!;
    const displayLength =
      token.contentEndUtf16 - token.contentStartUtf16;
    if (remaining < displayLength) {
      return token.contentStartUtf16 + remaining;
    }
    if (remaining === displayLength) {
      const next = block.inline[index + 1];
      return next ? next.contentStartUtf16 : token.endUtf16;
    }
    remaining -= displayLength;
  }
  return sourceLength(block);
}
