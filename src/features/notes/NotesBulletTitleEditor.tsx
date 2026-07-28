import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FocusEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode
} from "react";
import type { NoteId, NoteMarkerKind } from "../../domain/notes";
import type { LocalDate, NoteDateMatch } from "./noteDates";
import type { NoteTagToken } from "./noteTokens";
import type { NotesHistoryPrimarySelection } from "./notesHistory";
import {
  resolveInlineFormatShortcut,
  toggleInlineFormat
} from "./inlineFormat";
import {
  parseNoteMarkdown,
  sourceOffsetFromPresentation
} from "./noteMarkdown";
import { NoteTokenText } from "./NoteTokenText";
import { NotesSlashCommandMenu } from "./NotesSlashCommandMenu";
import {
  applyNotesSlashCommand,
  filterNotesSlashCommands,
  resolveNotesSlashCommandQuery,
  type NotesSlashCommandDefinition,
  type NotesSlashCommandId,
  type NotesSlashCommandQuery
} from "./notesSlashCommands";
import type {
  NotesEditorFlushAdapter,
  NotesEditorFlushResult
} from "./notesImageAtomEditorRegistry";
import {
  insertPlainTextAtSelection,
  readPlainText,
  readPlainTextSelection,
  replacePlainText,
  restorePlainTextSelection,
  type PlainTextSnapshot
} from "./plainTextContenteditable";

interface SlashCommandMenuState {
  readonly query: NotesSlashCommandQuery;
  readonly commands: readonly NotesSlashCommandDefinition[];
  readonly activeIndex: number;
}

export interface NotesBulletTitleEditorHandle {
  readonly element: HTMLDivElement | null;
  focus(selection?: NotesHistoryPrimarySelection): boolean;
  snapshot(): PlainTextSnapshot | null;
  replaceSource(
    source: string,
    selection?: NotesHistoryPrimarySelection
  ): boolean;
  flush(): Promise<NotesEditorFlushResult>;
}

export interface NotesBulletTitleEditorProps
  extends Omit<
    HTMLAttributes<HTMLDivElement>,
    | "children"
    | "contentEditable"
    | "onBlur"
    | "onCompositionEnd"
    | "onCompositionStart"
    | "onFocus"
    | "onInput"
    | "onKeyDown"
    | "onPaste"
  > {
  readonly nodeId: NoteId;
  readonly source: string;
  readonly onPublish: (source: string) => void;
  readonly registerFlushAdapter?: (
    adapter: NotesEditorFlushAdapter
  ) => () => void;
  readonly onEditorKeyDown?: (
    event: KeyboardEvent<HTMLDivElement>,
    snapshot: PlainTextSnapshot
  ) => void;
  readonly onFocus?: (event: FocusEvent<HTMLDivElement>) => void;
  readonly onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
  readonly onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly onTagClick: (token: NoteTagToken) => void;
  readonly today?: LocalDate;
  readonly getToday?: () => LocalDate;
  readonly onDateClick?: (
    token: NoteDateMatch,
    anchor: HTMLButtonElement
  ) => void;
  readonly onDateTrigger?: (
    range: { readonly startUtf16: number; readonly endUtf16: number },
    anchor: HTMLDivElement,
    source: string
  ) => void;
  readonly isTagActive?: (token: NoteTagToken) => boolean;
  readonly markdown?: boolean;
  readonly restingPresentation?: (requestEdit: () => void) => ReactNode;
  readonly slashCommands?: boolean;
  readonly onSlashMarkerCommand?: (
    markerKind: NoteMarkerKind,
    value: string,
    caretUtf16: number
  ) => void;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
}

interface CaretDocument {
  caretPositionFromPoint?: (
    x: number,
    y: number
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

function presentationOffsetFromPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  fallback: number
): number {
  const documentWithCaret = root.ownerDocument as CaretDocument;
  const position = documentWithCaret.caretPositionFromPoint?.(clientX, clientY);
  const fallbackRange = position
    ? null
    : documentWithCaret.caretRangeFromPoint?.(clientX, clientY);
  const node = position?.offsetNode ?? fallbackRange?.startContainer;
  const offset = position?.offset ?? fallbackRange?.startOffset;
  if (!node || offset === undefined || (node !== root && !root.contains(node))) {
    return fallback;
  }
  try {
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return fallback;
  }
}

function snapshotFromDom(root: HTMLDivElement): PlainTextSnapshot {
  const source = readPlainText(root);
  return {
    source,
    selection: readPlainTextSelection(root) ?? {
      anchorUtf16: source.length,
      focusUtf16: source.length
    }
  };
}

function isInteractiveRestingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("button, a, input, select, textarea") !== null
  );
}

function needsSynchronousPublish(
  event: KeyboardEvent<HTMLDivElement>,
  snapshot: PlainTextSnapshot
): boolean {
  if (event.key === "Enter" || event.key === "Tab") return true;
  const selection = snapshot.selection;
  const collapsed = selection.anchorUtf16 === selection.focusUtf16;
  if (event.key === "Backspace") {
    return collapsed && selection.focusUtf16 === 0;
  }
  const key = event.key.toLowerCase();
  if (
    ((event.metaKey || event.ctrlKey) && key === "z") ||
    (event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.altKey &&
      key === "y")
  ) {
    return true;
  }
  if (
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    (event.key === "ArrowUp" || event.key === "ArrowDown")
  ) {
    return true;
  }
  return (
    collapsed &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    ((event.key === "ArrowLeft" && selection.focusUtf16 === 0) ||
      (event.key === "ArrowRight" &&
        selection.focusUtf16 === snapshot.source.length))
  );
}

export const NotesBulletTitleEditor = forwardRef<
  NotesBulletTitleEditorHandle,
  NotesBulletTitleEditorProps
>(function NotesBulletTitleEditor(
  {
    nodeId,
    source,
    onPublish,
    registerFlushAdapter,
    onEditorKeyDown,
    onFocus,
    onBlur,
    onPaste,
    onTagClick,
    today,
    getToday,
    onDateClick,
    onDateTrigger,
    isTagActive,
    markdown = false,
    restingPresentation,
    slashCommands = false,
    onSlashMarkerCommand,
    readOnly = false,
    disabled = false,
    className,
    "aria-label": ariaLabel = "Edit node title",
    ...divProps
  },
  forwardedRef
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef(false);
  const composingRef = useRef(false);
  const unmountedRef = useRef(false);
  const dirtyRef = useRef(false);
  const publishTimerRef = useRef<number | null>(null);
  const pendingSelectionRef = useRef<NotesHistoryPrimarySelection | null>(null);
  const blurredDuringCompositionRef = useRef(false);
  const compositionWaitersRef = useRef<
    Array<(result: NotesEditorFlushResult) => void>
  >([]);
  const onPublishRef = useRef(onPublish);
  const onDateTriggerRef = useRef(onDateTrigger);
  const onSlashMarkerCommandRef = useRef(onSlashMarkerCommand);
  const [editing, setEditingState] = useState(false);
  const [publishedSource, setPublishedSource] = useState(source);
  const lastPublishedSourceRef = useRef(source);
  const lastSourcePropRef = useRef(source);
  const sourceChangedWhileEditingRef = useRef(false);
  const [slashMenu, setSlashMenu] = useState<SlashCommandMenuState | null>(
    null
  );
  const slashMenuId = `notes-slash-${useId().replaceAll(":", "")}`;
  const unavailable = readOnly || disabled;

  onPublishRef.current = onPublish;
  onDateTriggerRef.current = onDateTrigger;
  onSlashMarkerCommandRef.current = onSlashMarkerCommand;
  editingRef.current = editing;

  const setEditing = useCallback((next: boolean) => {
    editingRef.current = next;
    setEditingState(next);
  }, []);

  const clearPublishTimer = useCallback(() => {
    if (publishTimerRef.current !== null) {
      window.clearTimeout(publishTimerRef.current);
      publishTimerRef.current = null;
    }
  }, []);

  const currentSnapshot = useCallback((): PlainTextSnapshot | null => {
    const root = rootRef.current;
    if (!root?.isConnected) return null;
    if (editingRef.current) return snapshotFromDom(root);
    return {
      source: lastPublishedSourceRef.current,
      selection: {
        anchorUtf16: lastPublishedSourceRef.current.length,
        focusUtf16: lastPublishedSourceRef.current.length
      }
    };
  }, []);

  const publishNow = useCallback((): PlainTextSnapshot | null => {
    clearPublishTimer();
    if (composingRef.current || unmountedRef.current) return null;
    const snapshot = currentSnapshot();
    if (!snapshot) return null;
    dirtyRef.current = false;
    if (snapshot.source !== lastPublishedSourceRef.current) {
      lastPublishedSourceRef.current = snapshot.source;
      setPublishedSource(snapshot.source);
      onPublishRef.current(snapshot.source);
    }
    return snapshot;
  }, [clearPublishTimer, currentSnapshot]);

  const flush = useCallback(async (): Promise<NotesEditorFlushResult> => {
    if (unmountedRef.current) return "cancelled";
    if (composingRef.current) {
      return new Promise((resolve) => {
        compositionWaitersRef.current.push(resolve);
      });
    }
    publishNow();
    return "flushed";
  }, [publishNow]);

  const requestEdit = useCallback(
    (selection?: NotesHistoryPrimarySelection) => {
      if (unavailable) return;
      pendingSelectionRef.current = selection ?? {
        anchorUtf16: lastPublishedSourceRef.current.length,
        focusUtf16: lastPublishedSourceRef.current.length
      };
      setEditing(true);
    },
    [setEditing, unavailable]
  );

  useLayoutEffect(() => {
    if (!editing) return;
    const root = rootRef.current;
    if (!root || composingRef.current) return;
    const requested = pendingSelectionRef.current ?? {
      anchorUtf16: lastPublishedSourceRef.current.length,
      focusUtf16: lastPublishedSourceRef.current.length
    };
    pendingSelectionRef.current = null;
    replacePlainText(root, lastPublishedSourceRef.current, requested);
    root.focus();
    restorePlainTextSelection(root, requested);
  }, [editing]);

  useEffect(() => {
    const sourceChanged = source !== lastSourcePropRef.current;
    if (sourceChanged) {
      lastSourcePropRef.current = source;
    }
    if (editing) {
      if (sourceChanged) {
        sourceChangedWhileEditingRef.current = true;
        const root = rootRef.current;
        if (
          root &&
          !dirtyRef.current &&
          !composingRef.current &&
          source !== lastPublishedSourceRef.current
        ) {
          const selection = readPlainTextSelection(root) ?? {
            anchorUtf16: source.length,
            focusUtf16: source.length
          };
          lastPublishedSourceRef.current = source;
          setPublishedSource(source);
          replacePlainText(root, source, {
            anchorUtf16: Math.min(selection.anchorUtf16, source.length),
            focusUtf16: Math.min(selection.focusUtf16, source.length)
          });
          sourceChangedWhileEditingRef.current = false;
        }
      }
      return;
    }
    const shouldReconcile =
      sourceChanged || sourceChangedWhileEditingRef.current;
    sourceChangedWhileEditingRef.current = false;
    if (!shouldReconcile) return;
    if (source === lastPublishedSourceRef.current) return;
    lastPublishedSourceRef.current = source;
    setPublishedSource(source);
  }, [editing, source]);

  useEffect(() => {
    if (!registerFlushAdapter) return;
    return registerFlushAdapter({ nodeId, flush });
  }, [flush, nodeId, registerFlushAdapter]);

  useLayoutEffect(() => {
    unmountedRef.current = false;
    const waiters = compositionWaitersRef.current;
    return () => {
      clearPublishTimer();
      if (!composingRef.current && dirtyRef.current) {
        const snapshot = currentSnapshot();
        dirtyRef.current = false;
        if (
          snapshot &&
          snapshot.source !== lastPublishedSourceRef.current
        ) {
          lastPublishedSourceRef.current = snapshot.source;
          onPublishRef.current(snapshot.source);
        }
      }
      unmountedRef.current = true;
      for (const resolve of waiters.splice(0)) resolve("cancelled");
    };
  }, [clearPublishTimer, currentSnapshot]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      element: rootRef.current,
      focus(selection) {
        const root = rootRef.current;
        if (!root?.isConnected || unavailable) return false;
        if (editingRef.current) {
          root.focus();
          return (
            document.activeElement === root &&
            (!selection || restorePlainTextSelection(root, selection))
          );
        }
        requestEdit(selection);
        return true;
      },
      snapshot: currentSnapshot,
      replaceSource(nextSource, selection) {
        const root = rootRef.current;
        if (!root?.isConnected || composingRef.current) return false;
        clearPublishTimer();
        dirtyRef.current = false;
        lastPublishedSourceRef.current = nextSource;
        setPublishedSource(nextSource);
        if (!editingRef.current) return true;
        return replacePlainText(root, nextSource, selection);
      },
      flush
    }),
    [clearPublishTimer, currentSnapshot, flush, requestEdit, unavailable]
  );

  const refreshSlashMenu = (snapshot: PlainTextSnapshot) => {
    if (
      !slashCommands ||
      !today ||
      composingRef.current ||
      snapshot.selection.anchorUtf16 !== snapshot.selection.focusUtf16
    ) {
      setSlashMenu(null);
      return;
    }
    const query = resolveNotesSlashCommandQuery(
      snapshot.source,
      snapshot.selection.focusUtf16,
      snapshot.selection.focusUtf16
    );
    const commands = query ? filterNotesSlashCommands(query.query) : [];
    setSlashMenu(
      query && commands.length > 0
        ? { query, commands, activeIndex: 0 }
        : null
    );
  };

  const handleInput = (event: React.FormEvent<HTMLDivElement>) => {
    clearPublishTimer();
    dirtyRef.current = true;
    publishTimerRef.current = window.setTimeout(publishNow, 500);
    if (composingRef.current || (event.nativeEvent as InputEvent).isComposing) {
      return;
    }
    const inputEvent = event.nativeEvent as InputEvent;
    const needsSlashMenu = slashCommands && today !== undefined;
    const needsDateTrigger =
      onDateTriggerRef.current !== undefined &&
      inputEvent.inputType === "insertText" &&
      inputEvent.data === "!";
    if (!needsSlashMenu && !needsDateTrigger) return;
    const snapshot = snapshotFromDom(event.currentTarget);
    if (needsSlashMenu) refreshSlashMenu(snapshot);
    const caret = snapshot.selection.focusUtf16;
    if (
      needsDateTrigger &&
      !unavailable &&
      snapshot.selection.anchorUtf16 === caret &&
      snapshot.source.slice(caret - 2, caret) === "!!"
    ) {
      onDateTriggerRef.current?.(
        { startUtf16: caret - 2, endUtf16: caret },
        event.currentTarget,
        snapshot.source
      );
    }
  };

  const applySlashCommand = (commandId: NotesSlashCommandId) => {
    const root = rootRef.current;
    if (!root || !slashMenu || !today || composingRef.current) return;
    const snapshot = snapshotFromDom(root);
    const query = resolveNotesSlashCommandQuery(
      snapshot.source,
      snapshot.selection.focusUtf16,
      snapshot.selection.focusUtf16
    );
    if (
      !query ||
      query.endUtf16 !== slashMenu.query.endUtf16 ||
      query.query !== slashMenu.query.query
    ) {
      setSlashMenu(null);
      return;
    }
    const edit = applyNotesSlashCommand(
      snapshot.source,
      query,
      commandId,
      getToday?.() ?? today
    );
    replacePlainText(root, edit.value, {
      anchorUtf16: edit.caretUtf16,
      focusUtf16: edit.caretUtf16
    });
    dirtyRef.current = true;
    setSlashMenu(null);
    publishNow();
    if (edit.kind === "marker") {
      onSlashMarkerCommandRef.current?.(
        edit.markerKind,
        edit.value,
        edit.caretUtf16
      );
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (unavailable || composingRef.current || event.nativeEvent.isComposing) {
      return;
    }
    if (!editingRef.current) {
      if (
        (event.key === "ArrowDown" || event.key === "ArrowUp") &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        const snapshot = currentSnapshot();
        if (snapshot) onEditorKeyDown?.(event, snapshot);
        return;
      }
      if (
        (event.key === "Enter" || event.key === " ") &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        requestEdit();
      }
      return;
    }
    if (
      slashMenu &&
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
    const kind = resolveInlineFormatShortcut(event);
    if (kind) {
      const root = event.currentTarget;
      const snapshot = snapshotFromDom(root);
      const start = Math.min(
        snapshot.selection.anchorUtf16,
        snapshot.selection.focusUtf16
      );
      const end = Math.max(
        snapshot.selection.anchorUtf16,
        snapshot.selection.focusUtf16
      );
      const edit = toggleInlineFormat(snapshot.source, start, end, kind);
      event.preventDefault();
      replacePlainText(root, edit.value, {
        anchorUtf16: edit.selectionStart,
        focusUtf16: edit.selectionEnd
      });
      dirtyRef.current = true;
      publishNow();
      return;
    }
    let snapshot = snapshotFromDom(event.currentTarget);
    if (needsSynchronousPublish(event, snapshot)) {
      snapshot = publishNow() ?? snapshot;
    }
    onEditorKeyDown?.(event, snapshot);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (
      editingRef.current ||
      unavailable ||
      isInteractiveRestingTarget(event.target)
    ) {
      return;
    }
    const presentationOffset = presentationOffsetFromPoint(
      event.currentTarget,
      event.clientX,
      event.clientY,
      publishedSource.length
    );
    const offset = markdown
      ? sourceOffsetFromPresentation(
          parseNoteMarkdown(publishedSource),
          presentationOffset
        )
      : presentationOffset;
    event.preventDefault();
    requestEdit({ anchorUtf16: offset, focusUtf16: offset });
  };

  const rootClassName = ["notes-node-title", className]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <div
        {...divProps}
        ref={rootRef}
        className={rootClassName}
        data-notes-bullet-title
        data-editing={editing ? "true" : "false"}
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="false"
        aria-readonly={readOnly || undefined}
        aria-disabled={disabled || undefined}
        aria-controls={slashMenu ? slashMenuId : divProps["aria-controls"]}
        aria-expanded={slashMenu ? true : undefined}
        aria-haspopup={slashMenu ? "listbox" : undefined}
        aria-activedescendant={
          slashMenu
            ? `${slashMenuId}-${slashMenu.commands[slashMenu.activeIndex]!.id}`
            : undefined
        }
        contentEditable={editing && !unavailable ? "plaintext-only" : false}
        tabIndex={unavailable ? -1 : 0}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        suppressContentEditableWarning
        onPointerDown={handlePointerDown}
        onFocus={(event) => {
          onFocus?.(event);
        }}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ) {
            return;
          }
          const wasEditing = editingRef.current;
          setSlashMenu(null);
          if (composingRef.current) {
            blurredDuringCompositionRef.current = true;
            void flush();
          } else {
            publishNow();
            if (wasEditing) {
              event.currentTarget.replaceChildren();
              setEditing(false);
            }
          }
          if (wasEditing) onBlur?.(event);
        }}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          clearPublishTimer();
          composingRef.current = true;
          blurredDuringCompositionRef.current = false;
          setSlashMenu(null);
        }}
        onCompositionEnd={() => {
          if (!composingRef.current) return;
          composingRef.current = false;
          publishNow();
          for (const resolve of compositionWaitersRef.current.splice(0)) {
            resolve("deferred");
          }
          if (blurredDuringCompositionRef.current) {
            blurredDuringCompositionRef.current = false;
            rootRef.current?.replaceChildren();
            setEditing(false);
          }
        }}
        onPaste={(event) => {
          onPaste?.(event);
          if (event.defaultPrevented || unavailable) return;
          const text = event.clipboardData?.getData("text/plain") ?? "";
          event.preventDefault();
          if (!insertPlainTextAtSelection(event.currentTarget, text)) return;
          event.currentTarget.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              data: text,
              inputType: "insertFromPaste"
            })
          );
        }}
      >
        {editing
          ? null
          : restingPresentation?.(() => requestEdit()) ?? (
              <NoteTokenText
                text={publishedSource}
                markdownMode={markdown ? "rendered" : undefined}
                onTagClick={onTagClick}
                today={today}
                onDateClick={unavailable ? undefined : onDateClick}
                isTagActive={isTagActive}
              />
            )}
      </div>
      {slashMenu && rootRef.current ? (
        <NotesSlashCommandMenu
          anchor={rootRef.current}
          commands={slashMenu.commands}
          activeIndex={slashMenu.activeIndex}
          menuId={slashMenuId}
          onSelect={applySlashCommand}
        />
      ) : null}
    </>
  );
});
