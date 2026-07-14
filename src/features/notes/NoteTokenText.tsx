import {
  useMemo,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode
} from "react";
import {
  tokenizeNoteText,
  type NoteFormatKind,
  type NoteFormatToken,
  type NoteTagToken,
  type NoteUrlToken
} from "./noteTokens";
import {
  findNoteDateMatches,
  type LocalDate,
  type NoteDateMatch
} from "./noteDates";
import { openExternal } from "../../services/browser";

export interface NoteTokenTextProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children" | "onDateClick"> {
  text: string;
  onTagClick: (token: NoteTagToken) => void;
  today?: LocalDate;
  onDateClick?: (token: NoteDateMatch, anchor: HTMLButtonElement) => void;
  isTagActive?: (token: NoteTagToken) => boolean;
}

const presentationStyle: CSSProperties = {
  font: "inherit",
  letterSpacing: "inherit",
  lineHeight: "inherit",
  overflowWrap: "anywhere",
  whiteSpace: "pre-wrap"
};

const tagStyle: CSSProperties = {
  appearance: "none",
  margin: 0,
  padding: 0,
  border: 0,
  background: "none",
  color: "inherit",
  cursor: "pointer",
  font: "inherit",
  letterSpacing: "inherit",
  lineHeight: "inherit",
  pointerEvents: "auto",
  textDecoration: "underline",
  whiteSpace: "inherit"
};

// A URL keeps the flow's wrapping semantics (long links break like the source
// text) while presenting as an inline link; notes.css owns the accent color.
const urlStyle: CSSProperties = {
  appearance: "none",
  margin: 0,
  padding: 0,
  border: 0,
  background: "none",
  cursor: "pointer",
  font: "inherit",
  letterSpacing: "inherit",
  lineHeight: "inherit",
  overflowWrap: "anywhere",
  pointerEvents: "auto",
  textDecoration: "underline",
  whiteSpace: "inherit"
};

// Defense in depth: the tokenizer only emits http/https URL tokens, but re-check
// the scheme before handing the value to the external opener so a future change
// upstream can never route another scheme through here.
function openUrlTokenExternally(url: string): void {
  if (/^https?:\/\//i.test(url)) {
    void openExternal(url);
  }
}

// Each formatting kind maps to a stable class pair so notes.css owns the visual
// treatment. The markers keep flowing through the DOM (dimmed, not removed) so
// the overlay's text content stays character-for-character identical to source.
const FORMAT_TOKEN_CLASS: Record<NoteFormatKind, string> = {
  strong: "notes-format-token notes-format-strong",
  em: "notes-format-token notes-format-em",
  strike: "notes-format-token notes-format-strike",
  code: "notes-format-token notes-format-code"
};

type RenderToken =
  | { readonly kind: "tag"; readonly token: NoteTagToken }
  | { readonly kind: "date"; readonly token: NoteDateMatch }
  | { readonly kind: "format"; readonly token: NoteFormatToken }
  | { readonly kind: "url"; readonly token: NoteUrlToken };

function isFormatToken(
  token: { kind: string }
): token is NoteFormatToken {
  return (
    token.kind === "strong" ||
    token.kind === "em" ||
    token.kind === "strike" ||
    token.kind === "code"
  );
}

export function NoteTokenText({
  text,
  onTagClick,
  today,
  onDateClick,
  isTagActive,
  className,
  style,
  ...props
}: NoteTokenTextProps) {
  const rootClassName = ["notes-token-text", className]
    .filter(Boolean)
    .join(" ");
  // tokenizeNoteText / findNoteDateMatches re-scan the whole string; memoize so
  // an unrelated re-render (or a keystroke in another row) does not re-parse.
  const renderTokens = useMemo<RenderToken[]>(() => {
    const parsed = tokenizeNoteText(text);
    // Formatting spans and URLs are top-level and non-overlapping; the tokenizer
    // already suppresses tags inside them, so tag tokens never collide with a
    // span or URL.
    const formatTokens = parsed.filter(isFormatToken);
    const urlTokens = parsed.filter(
      (token): token is NoteUrlToken => token.kind === "url"
    );
    const tokens: RenderToken[] = parsed
      .filter((token): token is NoteTagToken => token.kind === "tag")
      .map((token) => ({ kind: "tag", token }));
    for (const token of formatTokens) {
      tokens.push({ kind: "format", token });
    }
    for (const token of urlTokens) {
      tokens.push({ kind: "url", token });
    }
    if (today) {
      // Dates are matched independently of the tokenizer, so a date that falls
      // inside a formatting span or a URL must be dropped: those render
      // non-recursively (their inner content is plain text), matching the
      // tokenizer's own no-recursion rule for tags.
      const atomicRanges = [...formatTokens, ...urlTokens];
      const overlapsAtomicRange = (match: NoteDateMatch) =>
        atomicRanges.some(
          (range) =>
            match.startUtf16 < range.endUtf16 &&
            match.endUtf16 > range.startUtf16
        );
      for (const token of findNoteDateMatches(text, { today })) {
        if (!overlapsAtomicRange(token)) {
          tokens.push({ kind: "date", token });
        }
      }
    }
    tokens.sort(
      (left, right) => left.token.startUtf16 - right.token.startUtf16
    );
    return tokens;
  }, [text, today]);

  const content: ReactNode[] = [];
  let textStartUtf16 = 0;
  for (const renderToken of renderTokens) {
    const { token } = renderToken;
    if (textStartUtf16 < token.startUtf16) {
      content.push(text.slice(textStartUtf16, token.startUtf16));
    }

    if (renderToken.kind === "date") {
      const dateToken = renderToken.token;
      if (onDateClick) {
        content.push(
          <button
            className="notes-date-token"
            type="button"
            key={`date:${dateToken.startUtf16}:${dateToken.endUtf16}`}
            aria-label={`Edit date ${dateToken.raw}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => onDateClick(dateToken, event.currentTarget)}
          >
            {dateToken.raw}
          </button>
        );
      } else {
        content.push(
          <span
            className="notes-date-token"
            key={`date:${dateToken.startUtf16}:${dateToken.endUtf16}`}
          >
            {dateToken.raw}
          </span>
        );
      }
    } else if (renderToken.kind === "format") {
      const formatToken = renderToken.token;
      // Split the raw slice into dimmed markers + styled content. All three
      // slices concatenate back to the exact source substring, so the overlay
      // never gains or loses a character (caret/pointer mapping depends on it).
      content.push(
        <span
          className={FORMAT_TOKEN_CLASS[formatToken.kind]}
          key={`format:${formatToken.startUtf16}:${formatToken.endUtf16}`}
        >
          <span className="notes-format-marker">
            {text.slice(formatToken.startUtf16, formatToken.innerStartUtf16)}
          </span>
          <span className="notes-format-content">
            {text.slice(formatToken.innerStartUtf16, formatToken.innerEndUtf16)}
          </span>
          <span className="notes-format-marker">
            {text.slice(formatToken.innerEndUtf16, formatToken.endUtf16)}
          </span>
        </span>
      );
    } else if (renderToken.kind === "url") {
      const urlToken = renderToken.token;
      // Render the raw URL text verbatim (no character added or removed) so the
      // overlay stays aligned with the source. Interactivity is gated by the
      // parent field: while editing, the overlay has pointer-events: none, so
      // this only receives clicks in the resting state — exactly like tags.
      content.push(
        <button
          className="notes-url-token"
          type="button"
          key={`url:${urlToken.startUtf16}:${urlToken.endUtf16}`}
          aria-label={`Open link ${urlToken.raw}`}
          style={urlStyle}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => openUrlTokenExternally(urlToken.raw)}
        >
          {urlToken.raw}
        </button>
      );
    } else {
      const tagToken = renderToken.token;
      const active = isTagActive?.(tagToken) ?? false;
      content.push(
        <button
          className="notes-tag-token"
          type="button"
          key={`tag:${tagToken.startUtf16}:${tagToken.endUtf16}`}
          aria-label={`${tagToken.raw} tag filter is ${active ? "active" : "inactive"}`}
          aria-pressed={active}
          data-prefix={tagToken.prefix}
          data-normalized-tag={tagToken.normalized}
          style={tagStyle}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onTagClick(tagToken)}
        >
          {tagToken.raw}
        </button>
      );
    }
    textStartUtf16 = token.endUtf16;
  }
  if (textStartUtf16 < text.length) {
    content.push(text.slice(textStartUtf16));
  }

  return (
    <span
      {...props}
      className={rootClassName}
      style={{ ...presentationStyle, ...style }}
    >
      {content}
    </span>
  );
}
