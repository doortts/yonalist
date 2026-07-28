import {
  forwardRef,
  type CSSProperties,
  type FocusEvent,
  type ForwardedRef,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type TextareaHTMLAttributes,
  useCallback,
  useMemo,
  useRef,
  useState
} from "react";
import {
  parseOutlinePresentation,
  sourceOffsetFromOutlinePresentation,
  type OutlinePresentation,
  type OutlinePresentationToken
} from "./outlinePresentation";
import { openExternalUrl } from "./openExternal";

export interface OutlineTagToken {
  readonly prefix: "#" | "@";
  readonly normalized: string;
  readonly raw: string;
}

export interface OutlineTextFieldProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "children"> {
  readonly value: string;
  readonly markdown?: boolean;
  readonly containerClassName?: string;
  readonly onTagClick?: (token: OutlineTagToken) => void;
  readonly onOpenExternal?: (url: string) => void;
}

const urlStyle: CSSProperties = {
  appearance: "none",
  margin: 0,
  padding: 0,
  border: 0,
  background: "none",
  color: "inherit",
  cursor: "pointer",
  font: "inherit",
  letterSpacing: "inherit",
  textDecoration: "underline",
  whiteSpace: "inherit"
};

interface CaretDocument {
  caretPositionFromPoint?: (
    x: number,
    y: number
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

function setForwardedRef<T>(ref: ForwardedRef<T>, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

function textOffsetWithin(
  root: HTMLElement,
  node: Node,
  nodeOffset: number
): number | null {
  if (node !== root && !root.contains(node)) return null;
  try {
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, nodeOffset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function pointerTextOffset(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  fallback: number
): number {
  const documentWithCaret = root.ownerDocument as CaretDocument;
  const position = documentWithCaret.caretPositionFromPoint?.(clientX, clientY);
  const range = position
    ? null
    : documentWithCaret.caretRangeFromPoint?.(clientX, clientY);
  const offset = position
    ? textOffsetWithin(root, position.offsetNode, position.offset)
    : range
      ? textOffsetWithin(root, range.startContainer, range.startOffset)
      : null;
  return Math.max(0, Math.min(fallback, offset ?? fallback));
}

function renderToken(
  token: OutlinePresentationToken,
  onTagClick: OutlineTextFieldProps["onTagClick"],
  onOpenExternal: NonNullable<OutlineTextFieldProps["onOpenExternal"]>
) {
  switch (token.kind) {
    case "strong":
      return (
        <strong className="notes-markdown-strong" key={token.start}>
          {token.display}
        </strong>
      );
    case "strike":
      return (
        <span className="notes-markdown-strike" key={token.start}>
          {token.display}
        </span>
      );
    case "link":
      return (
        <button
          className="notes-url-token"
          type="button"
          aria-label={`Open link ${token.display}`}
          key={token.start}
          style={urlStyle}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onOpenExternal(token.href)}
        >
          {token.display}
        </button>
      );
    case "tag":
      return (
        <button
          className="notes-tag-token"
          type="button"
          aria-label={`${token.raw} tag filter is inactive`}
          aria-pressed="false"
          key={token.start}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() =>
            onTagClick?.({
              prefix: token.prefix,
              normalized: token.normalized,
              raw: token.raw
            })
          }
        >
          {token.display}
        </button>
      );
    case "date":
      return (
        <span className="notes-date-token" key={token.start}>
          {token.display}
        </span>
      );
    case "text":
      return token.display;
  }
}

function renderPresentation(
  parsed: OutlinePresentation,
  onTagClick: OutlineTextFieldProps["onTagClick"],
  onOpenExternal: NonNullable<OutlineTextFieldProps["onOpenExternal"]>
) {
  if (parsed.kind === "divider") {
    return <span className="notes-markdown-divider" role="separator" />;
  }
  return parsed.tokens.map((token) =>
    renderToken(token, onTagClick, onOpenExternal)
  );
}

export const OutlineTextField = forwardRef<
  HTMLTextAreaElement,
  OutlineTextFieldProps
>(function OutlineTextField(
  {
    value,
    markdown = false,
    containerClassName,
    onTagClick,
    onOpenExternal = (url) => void openExternalUrl(url),
    className,
    style,
    placeholder,
    disabled,
    readOnly,
    onFocus,
    onBlur,
    onCompositionStart,
    onCompositionEnd,
    "aria-label": ariaLabel,
    ...textareaProps
  },
  forwardedRef
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const parsed = useMemo(
    () => parseOutlinePresentation(value, { markdown }),
    [markdown, value]
  );
  const fieldClassName = ["notes-text-field", containerClassName]
    .filter(Boolean)
    .join(" ");

  const assignTextareaRef = useCallback(
    (textarea: HTMLTextAreaElement | null) => {
      textareaRef.current = textarea;
      setForwardedRef(forwardedRef, textarea);
    },
    [forwardedRef]
  );

  const handleFocus = (event: FocusEvent<HTMLTextAreaElement>) => {
    setEditing(true);
    onFocus?.(event);
  };

  const handleBlur = (event: FocusEvent<HTMLTextAreaElement>) => {
    if (!composingRef.current) setEditing(false);
    onBlur?.(event);
  };

  const handlePresentationPointerDown = (
    event: ReactPointerEvent<HTMLSpanElement>
  ) => {
    if (disabled || readOnly) return;
    const presentationOffset = pointerTextOffset(
      event.currentTarget,
      event.clientX,
      event.clientY,
      markdown
        ? parsed.tokens.reduce((length, token) => length + token.display.length, 0)
        : value.length
    );
    const sourceOffset = markdown
      ? sourceOffsetFromOutlinePresentation(parsed, presentationOffset)
      : presentationOffset;
    event.preventDefault();
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(sourceOffset, sourceOffset);
  };

  const revealEditor = () => {
    if (disabled || readOnly) return;
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(value.length, value.length);
  };

  const handlePresentationKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (
      event.target !== event.currentTarget ||
      (event.key !== "Enter" && event.key !== " ")
    ) {
      return;
    }
    event.preventDefault();
    revealEditor();
  };

  const presentationStyle: CSSProperties = {
    ...style,
    position: "absolute",
    inset: 0,
    zIndex: 1,
    pointerEvents: editing ? "none" : "auto",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere"
  };
  const textareaStyle: CSSProperties = {
    ...style,
    opacity: editing ? (style?.opacity ?? 1) : 0,
    pointerEvents: editing ? style?.pointerEvents : "none",
    caretColor: editing
      ? "var(--notes-stable-caret-color)"
      : "transparent",
    ...(editing
      ? {
          color: "transparent",
          WebkitTextFillColor: "transparent"
        }
      : {})
  };
  const presentationValue =
    value.length === 0 && placeholder ? placeholder : value;

  return (
    <span
      className={fieldClassName}
      data-editing={editing ? "true" : "false"}
      data-stable-presentation="true"
      data-markdown-block={markdown ? parsed.kind : undefined}
      data-markdown-level={
        markdown && parsed.kind === "heading" ? parsed.level : undefined
      }
      style={{ display: "block", minWidth: 0, position: "relative" }}
    >
      <span
        className={className}
        role="group"
        aria-label={ariaLabel}
        aria-hidden={editing ? "true" : undefined}
        aria-disabled={disabled || undefined}
        aria-readonly={readOnly || undefined}
        tabIndex={editing || disabled ? -1 : 0}
        data-placeholder={
          value.length === 0 && placeholder ? "true" : undefined
        }
        style={presentationStyle}
        onPointerDown={handlePresentationPointerDown}
        onKeyDown={handlePresentationKeyDown}
      >
        {editing
          ? presentationValue
          : renderPresentation(parsed, onTagClick, onOpenExternal)}
      </span>
      <textarea
        {...textareaProps}
        ref={assignTextareaRef}
        className={className}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        aria-label={ariaLabel}
        aria-hidden={editing ? undefined : true}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        tabIndex={editing ? textareaProps.tabIndex : -1}
        style={textareaStyle}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onCompositionStart={(event) => {
          composingRef.current = true;
          setEditing(true);
          onCompositionStart?.(event);
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          if (document.activeElement !== event.currentTarget) {
            setEditing(false);
          }
          onCompositionEnd?.(event);
        }}
      />
    </span>
  );
});
