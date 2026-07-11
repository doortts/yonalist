import {
  forwardRef,
  type ChangeEvent,
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
import type { LocalDate, NoteDateMatch } from "./noteDates";
import type { NoteTagToken } from "./noteTokens";
import { NoteTokenText } from "./NoteTokenText";

export interface NoteTextFieldProps
  extends Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "children" | "value" | "onDateClick"
  > {
  value: string;
  onTagClick: (token: NoteTagToken) => void;
  today?: LocalDate;
  onDateClick?: (token: NoteDateMatch, anchor: HTMLButtonElement) => void;
  onDateTrigger?: (
    range: { readonly startUtf16: number; readonly endUtf16: number },
    anchor: HTMLTextAreaElement
  ) => void;
  isTagActive?: (token: NoteTagToken) => boolean;
  containerClassName?: string;
  presentationAriaLabel?: string;
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
    today,
    onDateClick,
    onDateTrigger,
    isTagActive,
    containerClassName,
    presentationAriaLabel,
    className,
    style,
    disabled,
    readOnly,
    onFocus,
    onBlur,
    onChange,
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
  const nonEditable = Boolean(disabled || readOnly);
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
    if (nonEditable) {
      focusAfterRevealRef.current = false;
      if (editing) {
        setEditing(false);
      }
      return;
    }
    if (!editing || !focusAfterRevealRef.current) {
      return;
    }
    focusAfterRevealRef.current = false;
    textareaRef.current?.focus();
  }, [editing, nonEditable]);

  const handleFocus = (event: FocusEvent<HTMLTextAreaElement>) => {
    if (nonEditable) {
      return;
    }
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

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange?.(event);
    const inputEvent = event.nativeEvent as InputEvent;
    const caret = event.currentTarget.selectionStart;
    if (
      composingRef.current ||
      disabled ||
      readOnly ||
      inputEvent.isComposing ||
      inputEvent.inputType !== "insertText" ||
      inputEvent.data !== "!" ||
      caret !== event.currentTarget.selectionEnd ||
      event.currentTarget.value.slice(caret - 2, caret) !== "!!"
    ) {
      return;
    }
    onDateTrigger?.(
      { startUtf16: caret - 2, endUtf16: caret },
      event.currentTarget
    );
  };

  const revealAndFocusTextarea = () => {
    if (nonEditable) {
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
        today={today}
        onDateClick={disabled || readOnly ? undefined : onDateClick}
        isTagActive={isTagActive}
        role="group"
        aria-label={presentationAriaLabel ?? ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-disabled={disabled || undefined}
        aria-readonly={readOnly || undefined}
        aria-hidden={editing ? "true" : undefined}
        tabIndex={editing || nonEditable ? -1 : 0}
        style={presentationLayout}
        onPointerDown={nonEditable ? undefined : handlePresentationPointerDown}
        onKeyDown={nonEditable ? undefined : handlePresentationKeyDown}
      />
      <textarea
        {...textareaProps}
        ref={assignTextareaRef}
        className={className}
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-hidden={editing ? ariaHidden : true}
        tabIndex={editing ? tabIndex : -1}
        style={textareaLayout}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onChange={handleChange}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
      />
    </span>
  );
});
