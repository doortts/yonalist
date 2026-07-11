import {
  createContext,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";
import {
  NotesDatePicker,
  type NotesDatePickerCommit,
  type NotesDatePickerContext
} from "./NotesDatePicker";
import type { LocalDate, NoteDateMatch } from "./noteDates";

export type NotesDateField = "title" | "note";

export interface NotesDatePickerTarget {
  readonly field: NotesDateField;
  readonly source: string;
  readonly context: NotesDatePickerContext;
  readonly anchor: HTMLElement;
  readonly focusElement: HTMLTextAreaElement;
}

interface NotesDatePickerHostProps {
  readonly target: NotesDatePickerTarget | null;
  readonly today: LocalDate;
  readonly onCommit: (field: NotesDateField, value: string) => void;
  readonly onClose: () => void;
}

interface NotesDateTodayProviderProps {
  readonly children: ReactNode;
  readonly today: LocalDate;
}

interface UseNotesDatePickerIntegrationOptions {
  readonly values: Readonly<Record<NotesDateField, string>>;
  readonly refs: Readonly<
    Record<NotesDateField, RefObject<HTMLTextAreaElement>>
  >;
  readonly onCommit: (field: NotesDateField, value: string) => void;
}

const NotesDateTodayContext = createContext<LocalDate | null>(null);

interface PickerPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly maxHeight: number;
}

const viewportMargin = 8;
const anchorGap = 6;
const preferredPickerWidth = 320;
const estimatedPickerHeight = 480;

export function getLocalToday(now: Date = new Date()): LocalDate {
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate()
  };
}

export function NotesDateTodayProvider({
  children,
  today
}: NotesDateTodayProviderProps) {
  return (
    <NotesDateTodayContext.Provider value={today}>
      {children}
    </NotesDateTodayContext.Provider>
  );
}

function useNotesDateToday(): LocalDate {
  const injectedToday = useContext(NotesDateTodayContext);
  const [localToday] = useState(getLocalToday);
  return injectedToday ?? localToday;
}

export function replaceUtf16Range(
  source: string,
  replacement: NotesDatePickerCommit["replacement"]
): string {
  return (
    source.slice(0, replacement.startUtf16) +
    replacement.text +
    source.slice(replacement.endUtf16)
  );
}

export function createExistingDateContext(
  match: NoteDateMatch
): NotesDatePickerContext {
  return {
    kind: "existing-date",
    raw: match.raw,
    startUtf16: match.startUtf16,
    endUtf16: match.endUtf16,
    value: {
      start: match.start,
      end: match.end,
      format:
        match.source.kind === "numeric"
          ? match.source.startFormat
          : "MM/DD/YYYY"
    }
  };
}

function pickerPlacement(
  anchor: DOMRect,
  pickerHeight = estimatedPickerHeight
): PickerPlacement {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.max(
    0,
    Math.min(preferredPickerWidth, viewportWidth - viewportMargin * 2)
  );
  const left = Math.min(
    Math.max(viewportMargin, anchor.left),
    Math.max(viewportMargin, viewportWidth - viewportMargin - width)
  );
  const maxHeight = Math.max(0, viewportHeight - viewportMargin * 2);
  const visibleHeight = Math.min(pickerHeight, maxHeight);
  const below = anchor.bottom + anchorGap;
  const top =
    below + visibleHeight <= viewportHeight - viewportMargin
      ? below
      : Math.max(viewportMargin, anchor.top - anchorGap - visibleHeight);
  return { left, top, width, maxHeight };
}

function placementStyle(placement: PickerPlacement): CSSProperties {
  return {
    position: "fixed",
    zIndex: 80,
    left: placement.left,
    top: placement.top,
    width: placement.width,
    maxHeight: placement.maxHeight,
    overflowY: "auto"
  };
}

export function NotesDatePickerHost({
  target,
  today,
  onCommit,
  onClose
}: NotesDatePickerHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const focusReturnRef = useRef<{
    readonly element: HTMLTextAreaElement;
    readonly caretUtf16: number;
  } | null>(null);
  const [placement, setPlacement] = useState<PickerPlacement | null>(() =>
    target ? pickerPlacement(target.anchor.getBoundingClientRect()) : null
  );

  const updatePlacement = useCallback(() => {
    if (!target) {
      setPlacement(null);
      return;
    }
    const measuredHeight = hostRef.current?.getBoundingClientRect().height;
    setPlacement(
      pickerPlacement(
        target.anchor.getBoundingClientRect(),
        measuredHeight && measuredHeight > 0
          ? measuredHeight
          : estimatedPickerHeight
      )
    );
  }, [target]);

  useLayoutEffect(() => {
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [updatePlacement]);

  if (!target || !placement) {
    return null;
  }

  const prepareFocusReturn = (caretUtf16: number) => {
    focusReturnRef.current = {
      element: target.focusElement,
      caretUtf16
    };
  };

  const requestFocusReturn = () => {
    const focusReturn = focusReturnRef.current ?? {
      element: target.focusElement,
      caretUtf16: target.context.endUtf16
    };
    focusReturnRef.current = null;
    focusReturn.element.focus();
    focusReturn.element.setSelectionRange(
      focusReturn.caretUtf16,
      focusReturn.caretUtf16
    );
  };

  return createPortal(
    <div
      ref={hostRef}
      className="notes-date-picker-host"
      data-testid="notes-date-picker-host"
      style={placementStyle(placement)}
    >
      <NotesDatePicker
        open
        context={target.context}
        today={today}
        onCommit={(commit) => {
          const nextValue = replaceUtf16Range(target.source, commit.replacement);
          prepareFocusReturn(
            commit.replacement.startUtf16 + commit.replacement.text.length
          );
          onCommit(target.field, nextValue);
          onClose();
        }}
        onDismiss={() => {
          prepareFocusReturn(target.context.endUtf16);
          onClose();
        }}
        onRequestFocusReturn={requestFocusReturn}
      />
    </div>,
    document.body
  );
}

export function useNotesDatePickerIntegration({
  values,
  refs,
  onCommit
}: UseNotesDatePickerIntegrationOptions) {
  const today = useNotesDateToday();
  const [target, setTarget] = useState<NotesDatePickerTarget | null>(null);
  const targetRef = useRef<NotesDatePickerTarget | null>(null);

  const openTarget = (nextTarget: NotesDatePickerTarget) => {
    targetRef.current = nextTarget;
    setTarget(nextTarget);
  };

  const openExistingDate = (
    field: NotesDateField,
    match: NoteDateMatch,
    anchor: HTMLButtonElement
  ) => {
    const focusElement = refs[field].current;
    if (!focusElement) {
      return;
    }
    openTarget({
      field,
      source: values[field],
      context: createExistingDateContext(match),
      anchor,
      focusElement
    });
  };

  const openTypedDate = (
    field: NotesDateField,
    range: { readonly startUtf16: number; readonly endUtf16: number },
    focusElement: HTMLTextAreaElement
  ) => {
    openTarget({
      field,
      source: focusElement.value,
      context: { kind: "typed-trigger", ...range },
      anchor: focusElement,
      focusElement
    });
  };

  const openTitleDate = (caretUtf16?: number) => {
    const focusElement = refs.title.current;
    if (!focusElement) {
      return;
    }
    const source = values.title;
    const caret = Math.min(
      Math.max(0, caretUtf16 ?? source.length),
      source.length
    );
    openTarget({
      field: "title",
      source,
      context: {
        kind: "typed-trigger",
        startUtf16: caret,
        endUtf16: caret
      },
      anchor: focusElement,
      focusElement
    });
  };

  const closePicker = () => {
    targetRef.current = null;
    setTarget(null);
  };

  return {
    today,
    openExistingDate,
    openTypedDate,
    openTitleDate,
    shouldSuppressBlur: () => targetRef.current !== null,
    picker: (
      <NotesDatePickerHost
        target={target}
        today={today}
        onCommit={onCommit}
        onClose={closePicker}
      />
    )
  };
}
