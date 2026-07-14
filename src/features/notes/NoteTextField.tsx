import {
  forwardRef,
  type ChangeEvent,
  type ClipboardEventHandler,
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
import {
  resolveInlineFormatShortcut,
  toggleInlineFormat
} from "./inlineFormat";
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
  placeCaretFromPointer?: boolean;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
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

interface CaretDocument {
  caretPositionFromPoint?: (
    x: number,
    y: number
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
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

function resolvePointerCaretOffset(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  fallback: number
): number {
  const documentWithCaret = root.ownerDocument as CaretDocument;
  const position = documentWithCaret.caretPositionFromPoint?.(
    clientX,
    clientY
  );
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
    placeCaretFromPointer,
    className,
    style,
    disabled,
    readOnly,
    onFocus,
    onBlur,
    onChange,
    onCompositionStart,
    onCompositionEnd,
    onKeyDown,
    onPaste,
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
  const selectionAfterRevealRef = useRef<number | null>(null);
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
      selectionAfterRevealRef.current = null;
      const textarea = textareaRef.current;
      if (textarea && document.activeElement === textarea) {
        textarea.blur();
      }
      if (editing) {
        setEditing(false);
      }
      return;
    }
    if (!editing || !focusAfterRevealRef.current) {
      return;
    }
    focusAfterRevealRef.current = false;
    const textarea = textareaRef.current;
    textarea?.focus();
    const selection = selectionAfterRevealRef.current;
    selectionAfterRevealRef.current = null;
    if (textarea && selection !== null) {
      textarea.setSelectionRange(selection, selection);
    }
  }, [editing, nonEditable]);

  const handleFocus = (event: FocusEvent<HTMLTextAreaElement>) => {
    if (nonEditable) {
      event.currentTarget.blur();
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

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const kind =
      composingRef.current ||
      disabled ||
      readOnly ||
      event.nativeEvent.isComposing
        ? null
        : resolveInlineFormatShortcut({
            key: event.key,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey
          });
    if (kind === null) {
      onKeyDown?.(event);
      return;
    }

    // Handle the wrap/unwrap as a normal text edit: mutate the native value
    // through the tracked setter and dispatch `input` so the controlled
    // onChange (draft-update path) fires, then restore the mapped selection.
    event.preventDefault();
    const textarea = event.currentTarget;
    const edit = toggleInlineFormat(
      textarea.value,
      textarea.selectionStart ?? textarea.value.length,
      textarea.selectionEnd ?? textarea.value.length,
      kind
    );
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    valueSetter?.call(textarea, edit.value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
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
    if (placeCaretFromPointer) {
      selectionAfterRevealRef.current = resolvePointerCaretOffset(
        event.currentTarget,
        event.clientX,
        event.clientY,
        value.length
      );
    }
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
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
      />
    </span>
  );
});
