import {
  forwardRef,
  type CSSProperties,
  type FocusEvent,
  type ForwardedRef,
  type KeyboardEvent,
  type CompositionEvent,
  type PointerEvent as ReactPointerEvent,
  type TextareaHTMLAttributes,
  useCallback,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import type { NoteTagToken } from "./noteTokens";
import { NoteTokenText } from "./NoteTokenText";

export interface NoteTextFieldProps
  extends Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "children" | "value"
  > {
  value: string;
  onTagClick: (token: NoteTagToken) => void;
  isTagActive?: (token: NoteTagToken) => boolean;
  containerClassName?: string;
}

function setForwardedRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) {
    ref.current = value;
  }
}

export const NoteTextField = forwardRef<
  HTMLTextAreaElement,
  NoteTextFieldProps
>(function NoteTextField(
  {
    value,
    onTagClick,
    isTagActive,
    containerClassName,
    className,
    style,
    onFocus,
    onBlur,
    onCompositionStart,
    onCompositionEnd,
    tabIndex,
    "aria-hidden": ariaHidden,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    ...textareaProps
  },
  forwardedRef
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const focusAfterRevealRef = useRef(false);
  const [editing, setEditing] = useState(false);
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

  useLayoutEffect(() => {
    if (!editing || !focusAfterRevealRef.current) {
      return;
    }
    focusAfterRevealRef.current = false;
    textareaRef.current?.focus();
  }, [editing]);

  const handleFocus = (event: FocusEvent<HTMLTextAreaElement>) => {
    setEditing(true);
    onFocus?.(event);
  };

  const handleBlur = (event: FocusEvent<HTMLTextAreaElement>) => {
    if (!composingRef.current) {
      setEditing(false);
    }
    onBlur?.(event);
  };

  const handleCompositionStart = (
    event: CompositionEvent<HTMLTextAreaElement>
  ) => {
    composingRef.current = true;
    setEditing(true);
    onCompositionStart?.(event);
  };

  const handleCompositionEnd = (
    event: CompositionEvent<HTMLTextAreaElement>
  ) => {
    composingRef.current = false;
    if (document.activeElement !== event.currentTarget) {
      setEditing(false);
    }
    onCompositionEnd?.(event);
  };

  const revealAndFocusTextarea = () => {
    if (textareaRef.current?.disabled) {
      return;
    }
    focusAfterRevealRef.current = true;
    setEditing(true);
  };

  const handlePresentationPointerDown = (
    event: ReactPointerEvent<HTMLSpanElement>
  ) => {
    event.preventDefault();
    revealAndFocusTextarea();
  };

  const handlePresentationKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (
      event.target !== event.currentTarget ||
      (event.key !== "Enter" && event.key !== " ")
    ) {
      return;
    }
    event.preventDefault();
    revealAndFocusTextarea();
  };

  const presentationLayout: CSSProperties = {
    ...style,
    position: "absolute",
    inset: 0,
    zIndex: 1,
    pointerEvents: editing ? "none" : "auto",
    visibility: editing ? "hidden" : "visible"
  };
  const textareaLayout: CSSProperties = {
    ...style,
    opacity: editing ? style?.opacity ?? 1 : 0,
    caretColor: editing ? style?.caretColor : "transparent",
    pointerEvents: editing ? style?.pointerEvents : "none"
  };

  return (
    <span
      className={fieldClassName}
      data-editing={editing ? "true" : "false"}
      style={{ display: "block", minWidth: 0, position: "relative" }}
    >
      <NoteTokenText
        className={className}
        text={value}
        onTagClick={onTagClick}
        isTagActive={isTagActive}
        role="group"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-hidden={editing ? "true" : undefined}
        tabIndex={editing ? -1 : 0}
        style={presentationLayout}
        onPointerDown={handlePresentationPointerDown}
        onKeyDown={handlePresentationKeyDown}
      />
      <textarea
        {...textareaProps}
        ref={assignTextareaRef}
        className={className}
        value={value}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-hidden={editing ? ariaHidden : true}
        tabIndex={editing ? tabIndex : -1}
        style={textareaLayout}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
      />
    </span>
  );
});
