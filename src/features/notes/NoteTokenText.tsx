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
  type NoteTagToken
} from "./noteTokens";
import {
  findNoteDateMatches,
  type LocalDate,
  type NoteDateMatch
} from "./noteDates";

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
  | { readonly kind: "format"; readonly token: NoteFormatToken };

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
    // Formatting spans are top-level and non-overlapping; the tokenizer already
    // suppresses tags inside them, so tag tokens never collide with a span.
    const formatTokens = parsed.filter(isFormatToken);
    const tokens: RenderToken[] = parsed
      .filter((token): token is NoteTagToken => token.kind === "tag")
      .map((token) => ({ kind: "tag", token }));
    for (const token of formatTokens) {
      tokens.push({ kind: "format", token });
    }
    if (today) {
      // Dates are matched independently of the tokenizer, so a date that falls
      // inside a formatting span must be dropped: the span renders
      // non-recursively (its inner content is plain styled text), matching the
      // tokenizer's own no-recursion rule for tags.
      const overlapsFormatSpan = (match: NoteDateMatch) =>
        formatTokens.some(
          (span) =>
            match.startUtf16 < span.endUtf16 &&
            match.endUtf16 > span.startUtf16
        );
      for (const token of findNoteDateMatches(text, { today })) {
        if (!overlapsFormatSpan(token)) {
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
