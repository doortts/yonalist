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

export interface NotesTextSelection {
  readonly startUtf16: number;
  readonly endUtf16: number;
}

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
  readonly onRequestFocusReturn: (request: NotesDateFocusRequest) => void;
}

interface NotesDateFocusRequest {
  readonly field: NotesDateField;
  readonly element: HTMLTextAreaElement;
  readonly caretUtf16: number;
  readonly expectedValue: string;
}

interface NotesDateTodayProviderProps {
  readonly children: ReactNode;
  readonly today: LocalDate;
}

interface UseNotesDatePickerIntegrationOptions {
  readonly values: Readonly<Record<NotesDateField, string>>;
  readonly refs: Readonly<
    Record<NotesDateField, RefObject<HTMLTextAreaElement | null>>
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
  replacement: NotesDatePickerCommit["replacement"],
  mode: "verbatim" | "date-insertion" = "verbatim"
): string {
  const leadingSpace =
    mode === "date-insertion" &&
    replacement.text.length > 0 &&
    replacement.startUtf16 > 0 &&
    !/\s/u.test(source[replacement.startUtf16 - 1])
      ? " "
      : "";
  const trailingSpace =
    mode === "date-insertion" &&
    replacement.text.length > 0 &&
    replacement.endUtf16 < source.length &&
    !/\s/u.test(source[replacement.endUtf16])
      ? " "
      : "";
  return (
    source.slice(0, replacement.startUtf16) +
    leadingSpace +
    replacement.text +
    trailingSpace +
    source.slice(replacement.endUtf16)
  );
}

function dateInsertionText(
  source: string,
  replacement: NotesDatePickerCommit["replacement"]
): string {
  const inserted = replaceUtf16Range(source, replacement, "date-insertion");
  const suffixLength = source.length - replacement.endUtf16;
  return inserted.slice(
    replacement.startUtf16,
    inserted.length - suffixLength
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
  onClose,
  onRequestFocusReturn
}: NotesDatePickerHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const focusReturnRef = useRef<NotesDateFocusRequest | null>(null);
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

  const prepareFocusReturn = (
    caretUtf16: number,
    expectedValue: string
  ) => {
    focusReturnRef.current = {
      field: target.field,
      element: target.focusElement,
      caretUtf16,
      expectedValue
    };
  };

  const requestFocusReturn = () => {
    const focusReturn = focusReturnRef.current ?? {
      field: target.field,
      element: target.focusElement,
      caretUtf16: target.context.endUtf16,
      expectedValue: target.source
    };
    focusReturnRef.current = null;
    onRequestFocusReturn(focusReturn);
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
          const insertionText =
            target.context.kind === "typed-trigger"
              ? dateInsertionText(target.source, commit.replacement)
              : commit.replacement.text;
          const replacement = {
            ...commit.replacement,
            text: insertionText
          };
          const nextValue = replaceUtf16Range(target.source, replacement);
          prepareFocusReturn(
            replacement.startUtf16 + replacement.text.length,
            nextValue
          );
          onCommit(target.field, nextValue);
          onClose();
        }}
        onDismiss={() => {
          prepareFocusReturn(target.context.endUtf16, target.source);
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
  const focusRevisionRef = useRef(0);
  const [pendingFocus, setPendingFocus] = useState<
    (NotesDateFocusRequest & { readonly revision: number }) | null
  >(null);

  useLayoutEffect(() => {
    if (!pendingFocus) {
      return;
    }
    const currentElement = refs[pendingFocus.field].current;
    if (
      currentElement !== pendingFocus.element ||
      !currentElement?.isConnected
    ) {
      setPendingFocus(null);
      return;
    }
    if (
      values[pendingFocus.field] !== pendingFocus.expectedValue ||
      currentElement.value !== pendingFocus.expectedValue
    ) {
      return;
    }
    const caretUtf16 = Math.min(
      pendingFocus.caretUtf16,
      currentElement.value.length
    );
    currentElement.focus();
    currentElement.setSelectionRange(caretUtf16, caretUtf16);
    setPendingFocus(null);
    // values is decomposed into note/title (the only fields read via
    // values[pendingFocus.field]); depending on the whole object would re-run
    // this focus restore on unrelated value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFocus, refs, values.note, values.title]);

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

  const openTitleDate = (selection?: NotesTextSelection | number) => {
    const focusElement = refs.title.current;
    if (!focusElement) {
      return;
    }
    const source = values.title;
    const requestedStart =
      typeof selection === "number" ? selection : selection?.startUtf16;
    const requestedEnd =
      typeof selection === "number" ? selection : selection?.endUtf16;
    const startUtf16 = Math.min(
      Math.max(0, requestedStart ?? source.length),
      source.length
    );
    const endUtf16 = Math.min(
      Math.max(startUtf16, requestedEnd ?? startUtf16),
      source.length
    );
    openTarget({
      field: "title",
      source,
      context: {
        kind: "typed-trigger",
        startUtf16,
        endUtf16
      },
      anchor: focusElement,
      focusElement
    });
  };

  const closePicker = () => {
    targetRef.current = null;
    setTarget(null);
  };

  const requestFocusReturn = (request: NotesDateFocusRequest) => {
    focusRevisionRef.current += 1;
    setPendingFocus({ ...request, revision: focusRevisionRef.current });
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
        onRequestFocusReturn={requestFocusReturn}
      />
    )
  };
}
