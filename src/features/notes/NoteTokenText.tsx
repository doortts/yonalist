import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import {
  tokenizeNoteText,
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

type InteractiveToken =
  | { readonly kind: "tag"; readonly token: NoteTagToken }
  | { readonly kind: "date"; readonly token: NoteDateMatch };

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
  const interactiveTokens: InteractiveToken[] = tokenizeNoteText(text)
    .filter((token): token is NoteTagToken => token.kind === "tag")
    .map((token) => ({ kind: "tag", token }));
  if (today && onDateClick) {
    interactiveTokens.push(
      ...findNoteDateMatches(text, { today }).map((token) => ({
        kind: "date" as const,
        token
      }))
    );
  }
  interactiveTokens.sort(
    (left, right) => left.token.startUtf16 - right.token.startUtf16
  );

  const content: ReactNode[] = [];
  let textStartUtf16 = 0;
  for (const interactiveToken of interactiveTokens) {
    const { token } = interactiveToken;
    if (textStartUtf16 < token.startUtf16) {
      content.push(text.slice(textStartUtf16, token.startUtf16));
    }

    if (interactiveToken.kind === "date") {
      const dateToken = interactiveToken.token;
      content.push(
        <button
          className="notes-date-token"
          type="button"
          key={`date:${dateToken.startUtf16}:${dateToken.endUtf16}`}
          aria-label={`Edit date ${dateToken.raw}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => onDateClick?.(dateToken, event.currentTarget)}
        >
          {dateToken.raw}
        </button>
      );
    } else {
      const tagToken = interactiveToken.token;
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
