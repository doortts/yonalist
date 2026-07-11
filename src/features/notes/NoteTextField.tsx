import {
  forwardRef,
  type CSSProperties,
  type FocusEvent,
  type ForwardedRef,
  type CompositionEvent,
  type TextareaHTMLAttributes,
  useCallback,
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
    ...textareaProps
  },
  forwardedRef
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
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

  const presentationLayout: CSSProperties = {
    ...style,
    position: "absolute",
    inset: 0,
    zIndex: 1,
    pointerEvents: "none",
    visibility: editing ? "hidden" : "visible"
  };
  const textareaLayout: CSSProperties = {
    ...style,
    opacity: editing ? style?.opacity ?? 1 : 0,
    caretColor: editing ? style?.caretColor : "transparent"
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
        style={presentationLayout}
      />
      <textarea
        {...textareaProps}
        ref={assignTextareaRef}
        className={className}
        value={value}
        style={textareaLayout}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
      />
    </span>
  );
});
