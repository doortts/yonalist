import type { CSSProperties, HTMLAttributes } from "react";
import {
  tokenizeNoteText,
  type NoteTagToken
} from "./noteTokens";

export interface NoteTokenTextProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  text: string;
  onTagClick: (token: NoteTagToken) => void;
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

export function NoteTokenText({
  text,
  onTagClick,
  isTagActive,
  className,
  style,
  ...props
}: NoteTokenTextProps) {
  const rootClassName = ["notes-token-text", className]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      {...props}
      className={rootClassName}
      style={{ ...presentationStyle, ...style }}
    >
      {tokenizeNoteText(text).map((token) => {
        if (token.kind === "text") {
          return token.raw;
        }

        const active = isTagActive?.(token) ?? false;
        return (
          <button
            className="notes-tag-token"
            type="button"
            key={`${token.startUtf16}:${token.endUtf16}`}
            aria-label={`${token.raw} tag filter is ${active ? "active" : "inactive"}`}
            aria-pressed={active}
            data-prefix={token.prefix}
            data-normalized-tag={token.normalized}
            style={tagStyle}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onTagClick(token)}
          >
            {token.raw}
          </button>
        );
      })}
    </span>
  );
}
