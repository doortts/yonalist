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
  type SyntheticEvent,
  type TextareaHTMLAttributes,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { LocalDate, NoteDateMatch } from "./noteDates";
import type { NoteMarkerKind } from "../../domain/notes";
import type { NoteTagToken } from "./noteTokens";
import {
  resolveInlineFormatShortcut,
  toggleInlineFormat
} from "./inlineFormat";
import { NoteTokenText } from "./NoteTokenText";
import { NotesSlashCommandMenu } from "./NotesSlashCommandMenu";
import {
  parseNoteMarkdown,
  sourceOffsetFromPresentation
} from "./noteMarkdown";
import {
  applyNotesSlashCommand,
  filterNotesSlashCommands,
  resolveNotesSlashCommandQuery,
  type NotesSlashCommandDefinition,
  type NotesSlashCommandId,
  type NotesSlashCommandQuery
} from "./notesSlashCommands";

export interface NoteTextFieldProps
  extends Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "children" | "value" | "onDateClick"
  > {
  value: string;
  stablePresentation?: boolean;
  onTagClick: (token: NoteTagToken) => void;
  today?: LocalDate;
  getToday?: () => LocalDate;
  onDateClick?: (token: NoteDateMatch, anchor: HTMLButtonElement) => void;
  onDateTrigger?: (
    range: { readonly startUtf16: number; readonly endUtf16: number },
    anchor: HTMLTextAreaElement
  ) => void;
  isTagActive?: (token: NoteTagToken) => boolean;
  containerClassName?: string;
  presentationAriaLabel?: string;
  placeCaretFromPointer?: boolean;
  markdown?: boolean;
  slashCommands?: boolean;
  onSlashMarkerCommand?: (
    markerKind: NoteMarkerKind,
    value: string,
    caretUtf16: number
  ) => void;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
}

interface SlashCommandMenuState {
  readonly query: NotesSlashCommandQuery;
  readonly commands: readonly NotesSlashCommandDefinition[];
  readonly activeIndex: number;
}

export function restoreTextareaPrimarySelection(
  textarea: HTMLTextAreaElement,
  selection: { readonly anchorUtf16: number; readonly focusUtf16: number }
): boolean {
  if (!textarea.isConnected) return false;
  const start = Math.min(selection.anchorUtf16, selection.focusUtf16);
  const end = Math.max(selection.anchorUtf16, selection.focusUtf16);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
  try {
    textarea.setSelectionRange(
      Math.max(0, Math.min(textarea.value.length, start)),
      Math.max(0, Math.min(textarea.value.length, end)),
      selection.anchorUtf16 > selection.focusUtf16 ? "backward" : "forward"
    );
    return true;
  } catch {
    return false;
  }
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
    stablePresentation = false,
    onTagClick,
    today,
    getToday,
    onDateClick,
    onDateTrigger,
    isTagActive,
    containerClassName,
    presentationAriaLabel,
    placeCaretFromPointer,
    markdown = false,
    slashCommands = false,
    onSlashMarkerCommand,
    className,
    style,
    placeholder,
    disabled,
    readOnly,
    onFocus,
    onBlur,
    onChange,
    onCompositionStart,
    onCompositionEnd,
    onKeyDown,
    onSelect,
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
  const [slashMenu, setSlashMenu] = useState<SlashCommandMenuState | null>(
    null
  );
  const slashMenuId = `notes-slash-${useId().replaceAll(":", "")}`;
  const nonEditable = Boolean(disabled || readOnly);
  const markdownBlock = useMemo(
    () => (markdown ? parseNoteMarkdown(value) : null),
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

  useLayoutEffect(() => {
    if (nonEditable) {
      setSlashMenu(null);
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

  useLayoutEffect(() => {
    setSlashMenu((current) => {
      if (!current) return null;
      const textarea = textareaRef.current;
      const query = textarea
        ? resolveNotesSlashCommandQuery(
            value,
            textarea.selectionStart,
            textarea.selectionEnd
          )
        : null;
      return query &&
        query.endUtf16 === current.query.endUtf16 &&
        query.query === current.query.query
        ? current
        : null;
    });
  }, [value]);

  const handleFocus = (event: FocusEvent<HTMLTextAreaElement>) => {
    if (nonEditable) {
      event.currentTarget.blur();
      return;
    }
    setEditing(true);
    onFocus?.(event);
  };

  const handleBlur = (event: FocusEvent<HTMLTextAreaElement>) => {
    setSlashMenu(null);
    if (!composingRef.current) {
      setEditing(false);
    }
    onBlur?.(event);
  };

  const handleCompositionStart = (
    event: CompositionEvent<HTMLTextAreaElement>
  ) => {
    composingRef.current = true;
    setSlashMenu(null);
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
      slashCommands &&
      today &&
      !composingRef.current &&
      !disabled &&
      !readOnly &&
      !inputEvent.isComposing
    ) {
      const query = resolveNotesSlashCommandQuery(
        event.currentTarget.value,
        caret,
        event.currentTarget.selectionEnd
      );
      const commands = query ? filterNotesSlashCommands(query.query) : [];
      setSlashMenu(
        query && commands.length > 0
          ? { query, commands, activeIndex: 0 }
          : null
      );
    } else {
      setSlashMenu(null);
    }
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

  const applySlashCommand = (commandId: NotesSlashCommandId) => {
    const textarea = textareaRef.current;
    if (!textarea || !slashMenu || !today || composingRef.current) return;
    const currentQuery = resolveNotesSlashCommandQuery(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd
    );
    if (
      !currentQuery ||
      currentQuery.endUtf16 !== slashMenu.query.endUtf16 ||
      currentQuery.query !== slashMenu.query.query
    ) {
      setSlashMenu(null);
      return;
    }
    const edit = applyNotesSlashCommand(
      textarea.value,
      currentQuery,
      commandId,
      getToday?.() ?? today
    );
    setSlashMenu(null);
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    valueSetter?.call(textarea, edit.value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    if (edit.kind === "marker") {
      onSlashMarkerCommand?.(
        edit.markerKind,
        edit.value,
        edit.caretUtf16
      );
    }
    queueMicrotask(() => {
      textarea.focus();
      textarea.setSelectionRange(edit.caretUtf16, edit.caretUtf16);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      slashMenu &&
      !composingRef.current &&
      !event.nativeEvent.isComposing &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setSlashMenu((current) =>
          current
            ? {
                ...current,
                activeIndex:
                  (current.activeIndex + direction + current.commands.length) %
                  current.commands.length
              }
            : null
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        applySlashCommand(slashMenu.commands[slashMenu.activeIndex]!.id);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashMenu(null);
        return;
      }
    }
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

  const handleSelect = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    onSelect?.(event);
    if (!slashMenu) return;
    const textarea = event.currentTarget;
    const query = resolveNotesSlashCommandQuery(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd
    );
    if (
      !query ||
      query.endUtf16 !== slashMenu.query.endUtf16 ||
      query.query !== slashMenu.query.query
    ) {
      setSlashMenu(null);
    }
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
      const textarea = textareaRef.current;
      const previousVisibility = textarea?.style.visibility ?? "";
      if (textarea) {
        textarea.style.visibility = "hidden";
      }
      try {
        const presentationOffset = resolvePointerCaretOffset(
          event.currentTarget,
          event.clientX,
          event.clientY,
          value.length
        );
        selectionAfterRevealRef.current = markdownBlock
          ? sourceOffsetFromPresentation(markdownBlock, presentationOffset)
          : presentationOffset;
      } finally {
        if (textarea) {
          textarea.style.visibility = previousVisibility;
        }
      }
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

  const stableEditing = stablePresentation && editing;
  const presentationText =
    stablePresentation && value.length === 0 && placeholder
      ? placeholder
      : value;
  const showingPlaceholder = presentationText !== value;
  const presentationLayout: CSSProperties = {
    ...style,
    position: "absolute",
    inset: 0,
    zIndex: 1,
    pointerEvents: editing ? "none" : "auto",
    visibility: editing && !stablePresentation ? "hidden" : "visible"
  };
  const textareaLayout: CSSProperties = {
    ...style,
    opacity: editing ? style?.opacity ?? 1 : 0,
    visibility: style?.visibility ?? "visible",
    caretColor: editing
      ? stablePresentation
        ? "var(--notes-stable-caret-color)"
        : style?.caretColor
      : "transparent",
    pointerEvents: editing ? style?.pointerEvents : "none",
    ...(stableEditing
      ? {
          color: "transparent",
          WebkitTextFillColor: "transparent"
        }
      : {})
  };

  return (
    <span
      className={fieldClassName}
      data-editing={editing ? "true" : "false"}
      data-stable-presentation={stablePresentation ? "true" : undefined}
      data-markdown-block={markdownBlock?.kind}
      data-markdown-level={
        markdownBlock?.kind === "heading"
          ? markdownBlock.level
          : undefined
      }
      style={{ display: "block", minWidth: 0, position: "relative" }}
    >
      <NoteTokenText
        className={className}
        text={presentationText}
        markdownMode={
          markdown ? (editing ? "source" : "rendered") : undefined
        }
        data-placeholder={showingPlaceholder ? "true" : undefined}
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
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className={className}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-hidden={editing ? ariaHidden : true}
        aria-controls={slashMenu ? slashMenuId : textareaProps["aria-controls"]}
        aria-expanded={slashMenu ? true : undefined}
        aria-haspopup={slashMenu ? "listbox" : undefined}
        aria-activedescendant={
          slashMenu
            ? `${slashMenuId}-${slashMenu.commands[slashMenu.activeIndex]!.id}`
            : undefined
        }
        tabIndex={editing ? tabIndex : -1}
        style={textareaLayout}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onChange={handleChange}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onKeyDown={handleKeyDown}
        onSelect={handleSelect}
        onPaste={onPaste}
      />
      {slashMenu && textareaRef.current ? (
        <NotesSlashCommandMenu
          anchor={textareaRef.current}
          commands={slashMenu.commands}
          activeIndex={slashMenu.activeIndex}
          menuId={slashMenuId}
          onSelect={applySlashCommand}
        />
      ) : null}
    </span>
  );
});
