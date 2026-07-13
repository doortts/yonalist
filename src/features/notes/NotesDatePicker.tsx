import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import {
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  addLocalDateDays,
  addLocalDateMonths,
  compareLocalDates,
  formatLocalDateIso,
  parseNoteDateExpression,
  startOfLocalWeek,
  type LocalDate,
  type NumericDateFormat,
  type WeekStartsOn
} from "./noteDates";

export interface NotesDatePickerValue {
  readonly start: LocalDate;
  readonly end: LocalDate | null;
  readonly format: NumericDateFormat;
}

export type NotesDatePickerContext =
  | {
      readonly kind: "typed-trigger";
      readonly startUtf16: number;
      readonly endUtf16: number;
    }
  | {
      readonly kind: "existing-date";
      readonly startUtf16: number;
      readonly endUtf16: number;
      readonly raw: string;
      readonly value: NotesDatePickerValue;
    };

export interface NotesDatePickerCommit {
  readonly replacement: {
    readonly startUtf16: number;
    readonly endUtf16: number;
    readonly text: string;
  };
  readonly value: NotesDatePickerValue | null;
}

export interface NotesDatePickerProps {
  readonly open: boolean;
  readonly context: NotesDatePickerContext;
  readonly today: LocalDate;
  readonly weekStartsOn?: WeekStartsOn;
  readonly initialFormat?: NumericDateFormat;
  readonly onCommit: (commit: NotesDatePickerCommit) => void;
  readonly onDismiss: (reason: "escape" | "outside") => void;
  readonly onRequestFocusReturn: () => void;
}

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
] as const;

const sundayFirstWeekdays = [
  { short: "S", long: "Sunday" },
  { short: "M", long: "Monday" },
  { short: "T", long: "Tuesday" },
  { short: "W", long: "Wednesday" },
  { short: "T", long: "Thursday" },
  { short: "F", long: "Friday" },
  { short: "S", long: "Saturday" }
] as const;

const formats: readonly NumericDateFormat[] = [
  "MM/DD/YYYY",
  "MM-DD-YYYY",
  "MM/DD/YY",
  "MM-DD-YY",
  "MM/DD",
  "MM-DD"
];

const minimumLocalDate: LocalDate = { year: 1, month: 1, day: 1 };
const maximumLocalDate: LocalDate = { year: 9999, month: 12, day: 31 };

const pickerStyles = `
  .notes-date-picker {
    box-sizing: border-box;
    padding: 12px;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    background: var(--bg-card);
    box-shadow: var(--shadow-modal);
    color: var(--text-1);
    font-family: inherit;
    font-size: 13px;
  }
  .notes-date-picker *, .notes-date-picker *::before, .notes-date-picker *::after {
    box-sizing: border-box;
  }
  .notes-date-picker button, .notes-date-picker input, .notes-date-picker select {
    font: inherit;
  }
  .notes-date-picker-input {
    width: 100%;
    height: 34px;
    padding: 0 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    outline: 0;
    background: var(--bg-input);
    color: var(--text-1);
  }
  .notes-date-picker-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .notes-date-picker-input[aria-invalid="true"] {
    border-color: var(--danger);
  }
  .notes-date-picker-quick {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 5px;
    margin: 8px 0 10px;
  }
  .notes-date-picker-quick button,
  .notes-date-picker-icon-button,
  .notes-date-picker-day,
  .notes-date-picker-remove {
    border: 0;
    border-radius: 6px;
    outline: 0;
    background: transparent;
    color: var(--text-2);
  }
  .notes-date-picker-quick button {
    min-width: 0;
    height: 30px;
    padding: 0 6px;
    background: var(--bg-hover);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }
  .notes-date-picker-quick button:disabled {
    opacity: 0.42;
  }
  .notes-date-picker button:hover {
    background: var(--bg-hover);
    color: var(--text-1);
  }
  .notes-date-picker button:focus-visible,
  .notes-date-picker select:focus-visible,
  .notes-date-picker input[type="checkbox"]:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .notes-date-picker-month-row {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr) 30px;
    align-items: center;
    height: 34px;
  }
  .notes-date-picker-month {
    margin: 0;
    overflow: hidden;
    font-size: 13px;
    font-weight: 700;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .notes-date-picker-icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
  }
  .notes-date-picker-calendar {
    display: grid;
    grid-template-rows: 18px repeat(6, 1fr);
    gap: 3px;
    margin-top: 4px;
  }
  .notes-date-picker-calendar-row {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 3px;
    min-height: 0;
  }
  .notes-date-picker-weekday {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-3);
    font-size: 10px;
    font-weight: 700;
  }
  .notes-date-picker-cell {
    display: flex;
    min-width: 0;
    min-height: 0;
  }
  .notes-date-picker-day {
    width: 100%;
    min-width: 0;
    height: 100%;
    padding: 0;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .notes-date-picker-day[data-outside-month="true"] {
    color: var(--text-3);
    opacity: 0.5;
  }
  .notes-date-picker-day:disabled {
    opacity: 0;
    pointer-events: none;
  }
  .notes-date-picker-day[data-in-range="true"] {
    border-radius: 3px;
    background: var(--bg-active);
    color: var(--text-1);
  }
  .notes-date-picker-day[aria-pressed="true"] {
    background: var(--accent);
    color: var(--bg-card);
    font-weight: 700;
  }
  .notes-date-picker-day[aria-current="date"]:not([aria-pressed="true"]) {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .notes-date-picker-footer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 10px;
    min-height: 48px;
    margin-top: 9px;
    padding-top: 9px;
    border-top: 1px solid var(--border);
  }
  .notes-date-picker-range {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
  }
  .notes-date-picker-range input {
    width: 14px;
    height: 14px;
    margin: 0;
    accent-color: var(--accent);
  }
  .notes-date-picker-format {
    display: grid;
    gap: 3px;
    color: var(--text-3);
    font-size: 10px;
    font-weight: 700;
  }
  .notes-date-picker-format select {
    width: 112px;
    height: 30px;
    padding: 0 24px 0 7px;
    border: 1px solid var(--border);
    border-radius: 6px;
    outline: 0;
    background: var(--bg-input);
    color: var(--text-1);
    font-size: 11px;
  }
  .notes-date-picker-remove {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    margin-top: 7px;
    padding: 0 7px;
    color: var(--danger);
    font-size: 12px;
    font-weight: 600;
  }
`;

function sameDate(left: LocalDate, right: LocalDate): boolean {
  return compareLocalDates(left, right) === 0;
}

function firstOfMonth(date: LocalDate): LocalDate {
  return { year: date.year, month: date.month, day: 1 };
}

function formatDate(date: LocalDate, format: NumericDateFormat): string {
  const separator = format.includes("/") ? "/" : "-";
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  if (format === "MM/DD" || format === "MM-DD") {
    return `${month}${separator}${day}`;
  }
  const year = format.endsWith("YYYY")
    ? String(date.year).padStart(4, "0")
    : String(date.year % 100).padStart(2, "0");
  return `${month}${separator}${day}${separator}${year}`;
}

function formatValue(value: NotesDatePickerValue): string {
  const start = formatDate(value.start, value.format);
  return value.end === null
    ? start
    : `${start} - ${formatDate(value.end, value.format)}`;
}

function tryAddLocalDateDays(
  date: LocalDate,
  amount: number
): LocalDate | null {
  try {
    return addLocalDateDays(date, amount);
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }
    throw error;
  }
}

function tryAddLocalDateMonths(
  date: LocalDate,
  amount: number
): LocalDate | null {
  try {
    return addLocalDateMonths(date, amount);
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }
    throw error;
  }
}

function addLocalDateDaysClamped(date: LocalDate, amount: number): LocalDate {
  return (
    tryAddLocalDateDays(date, amount) ??
    (amount < 0 ? minimumLocalDate : maximumLocalDate)
  );
}

function addLocalDateMonthsClamped(
  date: LocalDate,
  amount: number
): LocalDate {
  return (
    tryAddLocalDateMonths(date, amount) ??
    (amount < 0 ? minimumLocalDate : maximumLocalDate)
  );
}

function weekdayIndex(date: LocalDate): number {
  const monday = startOfLocalWeek(date, "monday");
  for (let index = 0; index < 7; index += 1) {
    if (sameDate(addLocalDateDays(monday, index), date)) {
      return (index + 1) % 7;
    }
  }
  return 0;
}

function accessibleDateName(date: LocalDate): string {
  return `${sundayFirstWeekdays[weekdayIndex(date)].long}, ${
    monthNames[date.month - 1]
  } ${date.day}, ${date.year}`;
}

interface QuickDateValue {
  readonly start: LocalDate;
  readonly end: LocalDate | null;
}

function resolveQuickDateValues(
  today: LocalDate,
  weekStartsOn: WeekStartsOn
): {
  readonly today: QuickDateValue;
  readonly tomorrow: QuickDateValue | null;
  readonly nextWeek: QuickDateValue | null;
} {
  const tomorrow = tryAddLocalDateDays(today, 1);
  const weekdayOffset =
    weekStartsOn === "sunday"
      ? weekdayIndex(today)
      : (weekdayIndex(today) + 6) % 7;
  const nextWeekStart = tryAddLocalDateDays(today, 7 - weekdayOffset);
  const nextWeekEnd =
    nextWeekStart === null ? null : tryAddLocalDateDays(nextWeekStart, 6);
  return {
    today: { start: today, end: null },
    tomorrow:
      tomorrow === null ? null : { start: tomorrow, end: null },
    nextWeek:
      nextWeekStart === null || nextWeekEnd === null
        ? null
        : { start: nextWeekStart, end: nextWeekEnd }
  };
}

function contextIdentity(
  context: NotesDatePickerContext,
  today: LocalDate,
  initialFormat: NumericDateFormat,
  weekStartsOn: WeekStartsOn
): string {
  const base = `${context.kind}:${context.startUtf16}:${context.endUtf16}:${formatLocalDateIso(today)}:${initialFormat}:${weekStartsOn}`;
  if (context.kind === "typed-trigger") {
    return base;
  }
  const end = context.value.end ? formatLocalDateIso(context.value.end) : "";
  return `${base}:${context.raw}:${formatLocalDateIso(context.value.start)}:${end}:${context.value.format}`;
}

function initialValue(
  context: NotesDatePickerContext,
  today: LocalDate,
  initialFormat: NumericDateFormat
): NotesDatePickerValue {
  return context.kind === "existing-date"
    ? context.value
    : { start: today, end: null, format: initialFormat };
}

interface NotesDatePickerSessionProps
  extends Omit<
    NotesDatePickerProps,
    "open" | "weekStartsOn" | "initialFormat"
  > {
  readonly weekStartsOn: WeekStartsOn;
  readonly initialFormat: NumericDateFormat;
}

function NotesDatePickerSession({
  context,
  today,
  weekStartsOn,
  initialFormat,
  onCommit,
  onDismiss,
  onRequestFocusReturn
}: NotesDatePickerSessionProps) {
  const initial = initialValue(context, today, initialFormat);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dayRefs = useRef(new Map<string, HTMLButtonElement>());
  const composingRef = useRef(false);
  const focusGridRef = useRef(false);
  const [value, setValue] = useState<NotesDatePickerValue>(initial);
  const [inputValue, setInputValue] = useState(
    context.kind === "existing-date" ? context.raw : ""
  );
  const [inputValid, setInputValid] = useState(true);
  const [rangeEnabled, setRangeEnabled] = useState(initial.end !== null);
  const [rangePhase, setRangePhase] = useState<"start" | "end">("start");
  const [displayMonth, setDisplayMonth] = useState(firstOfMonth(initial.start));
  const [focusDate, setFocusDate] = useState(initial.start);

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!focusGridRef.current) {
      return;
    }
    focusGridRef.current = false;
    dayRefs.current.get(formatLocalDateIso(focusDate))?.focus();
  }, [displayMonth, focusDate]);

  const requestDismiss = useCallback(
    (reason: "escape" | "outside") => {
      onDismiss(reason);
      onRequestFocusReturn();
    },
    [onDismiss, onRequestFocusReturn]
  );

  useEffect(() => {
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !dialogRef.current?.contains(target)) {
        requestDismiss("outside");
      }
    };
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
    };
  }, [requestDismiss]);

  const leadingCalendarCells = useMemo(() => {
    const firstWeekday = weekdayIndex(firstOfMonth(displayMonth));
    return weekStartsOn === "sunday"
      ? firstWeekday
      : (firstWeekday + 6) % 7;
  }, [displayMonth, weekStartsOn]);
  const calendarDays = useMemo(
    () =>
      Array.from({ length: 42 }, (_, index) =>
        tryAddLocalDateDays(
          firstOfMonth(displayMonth),
          index - leadingCalendarCells
        )
      ),
    [displayMonth, leadingCalendarCells]
  );
  const previousMonth = tryAddLocalDateMonths(displayMonth, -1);
  const nextMonth = tryAddLocalDateMonths(displayMonth, 1);
  const quickDateValues = useMemo(
    () => resolveQuickDateValues(today, weekStartsOn),
    [today, weekStartsOn]
  );
  const weekdayHeaders =
    weekStartsOn === "sunday"
      ? sundayFirstWeekdays
      : [...sundayFirstWeekdays.slice(1), sundayFirstWeekdays[0]];

  const commitValue = useCallback(
    (nextValue: NotesDatePickerValue) => {
      onCommit({
        replacement: {
          startUtf16: context.startUtf16,
          endUtf16: context.endUtf16,
          text: formatValue(nextValue)
        },
        value: nextValue
      });
      onRequestFocusReturn();
    },
    [context.endUtf16, context.startUtf16, onCommit, onRequestFocusReturn]
  );

  const updateFromParsedInput = useCallback(
    (source: string) => {
      const parsed = parseNoteDateExpression(source, { today, weekStartsOn });
      if (parsed === null) {
        setInputValid(source.trim().length === 0);
        return;
      }
      const format =
        parsed.source.kind === "numeric"
          ? parsed.source.startFormat
          : value.format;
      const next = { start: parsed.start, end: parsed.end, format };
      setValue(next);
      setInputValid(true);
      setRangeEnabled(next.end !== null);
      setRangePhase("start");
      setDisplayMonth(firstOfMonth(next.start));
      setFocusDate(next.start);
    },
    [today, value.format, weekStartsOn]
  );

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextInput = event.currentTarget.value;
    setInputValue(nextInput);
    if (!composingRef.current) {
      updateFromParsedInput(nextInput);
    }
  };

  const handleCompositionEnd = (event: CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    updateFromParsedInput(event.currentTarget.value);
  };

  const chooseQuickDate = (quickDate: QuickDateValue | null) => {
    if (quickDate === null) {
      return;
    }
    const next = { ...quickDate, format: value.format };
    setValue(next);
    setInputValue(formatValue(next));
    setInputValid(true);
    setRangeEnabled(next.end !== null);
    setRangePhase("start");
    setDisplayMonth(firstOfMonth(next.start));
    setFocusDate(next.start);
    inputRef.current?.focus();
  };

  const daySelection = (date: LocalDate) => {
    let next: NotesDatePickerValue;
    let nextPhase: "start" | "end" = "start";
    if (!rangeEnabled) {
      next = { ...value, start: date, end: null };
    } else if (rangePhase === "start") {
      next = { ...value, start: date, end: date };
      nextPhase = "end";
    } else if (compareLocalDates(date, value.start) < 0) {
      next = { ...value, start: date, end: value.start };
    } else {
      next = { ...value, end: date };
    }
    return { next, nextPhase };
  };

  const applyDaySelection = (date: LocalDate) => {
    const selection = daySelection(date);
    const { next, nextPhase } = selection;
    setRangePhase(nextPhase);
    setValue(next);
    setInputValue(formatValue(next));
    setInputValid(true);
    setFocusDate(date);
    setDisplayMonth(firstOfMonth(date));
    return selection;
  };

  const moveGridFocus = (date: LocalDate) => {
    focusGridRef.current = true;
    setFocusDate(date);
    setDisplayMonth(firstOfMonth(date));
  };

  const handleDayKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    date: LocalDate
  ) => {
    if (
      composingRef.current ||
      event.nativeEvent.isComposing ||
      event.key === "Process"
    ) {
      return;
    }
    let target: LocalDate | null = null;
    if (event.key === "ArrowLeft") {
      target = addLocalDateDaysClamped(date, -1);
    } else if (event.key === "ArrowRight") {
      target = addLocalDateDaysClamped(date, 1);
    } else if (event.key === "ArrowUp") {
      target = addLocalDateDaysClamped(date, -7);
    } else if (event.key === "ArrowDown") {
      target = addLocalDateDaysClamped(date, 7);
    } else if (event.key === "Home") {
      const offset =
        weekStartsOn === "sunday"
          ? weekdayIndex(date)
          : (weekdayIndex(date) + 6) % 7;
      target = addLocalDateDaysClamped(date, -offset);
    } else if (event.key === "End") {
      const offset =
        weekStartsOn === "sunday"
          ? weekdayIndex(date)
          : (weekdayIndex(date) + 6) % 7;
      target = addLocalDateDaysClamped(date, 6 - offset);
    } else if (event.key === "PageUp") {
      target = addLocalDateMonthsClamped(date, -1);
    } else if (event.key === "PageDown") {
      target = addLocalDateMonthsClamped(date, 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!rangeEnabled) {
        commitValue({ ...value, start: date, end: null });
      } else {
        const selection = applyDaySelection(date);
        if (rangePhase === "end") {
          commitValue(selection.next);
        }
      }
      return;
    }
    if (target !== null) {
      event.preventDefault();
      moveGridFocus(target);
    }
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      composingRef.current ||
      event.nativeEvent.isComposing ||
      event.key === "Process"
    ) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      requestDismiss("escape");
      return;
    }
    if (event.key === "Enter" && event.target === inputRef.current) {
      event.preventDefault();
      if (inputValid) {
        commitValue(value);
      }
    }
  };

  const renderCalendarCell = (date: LocalDate | null, index: number) => {
    if (date === null) {
      return (
        <div
          className="notes-date-picker-cell"
          role="gridcell"
          key={`outside-range-${index}`}
        >
          <button
            className="notes-date-picker-day"
            type="button"
            aria-label="Outside supported date range"
            disabled
            tabIndex={-1}
          />
        </div>
      );
    }
    const iso = formatLocalDateIso(date);
    const endpoint =
      sameDate(date, value.start) ||
      (value.end !== null && sameDate(date, value.end));
    const inRange =
      value.end !== null &&
      compareLocalDates(date, value.start) > 0 &&
      compareLocalDates(date, value.end) < 0;
    return (
      <div className="notes-date-picker-cell" role="gridcell" key={iso}>
        <button
          ref={(button) => {
            if (button) {
              dayRefs.current.set(iso, button);
            } else {
              dayRefs.current.delete(iso);
            }
          }}
          className="notes-date-picker-day"
          type="button"
          aria-label={accessibleDateName(date)}
          aria-current={sameDate(date, today) ? "date" : undefined}
          aria-pressed={endpoint}
          data-date={iso}
          data-in-range={inRange || undefined}
          data-outside-month={
            date.month !== displayMonth.month ||
            date.year !== displayMonth.year ||
            undefined
          }
          tabIndex={sameDate(date, focusDate) ? 0 : -1}
          onClick={() => applyDaySelection(date)}
          onKeyDown={(event) => handleDayKeyDown(event, date)}
        >
          {date.day}
        </button>
      </div>
    );
  };

  return (
    <>
      <style>{pickerStyles}</style>
      <div
        ref={dialogRef}
        className="notes-date-picker"
        role="dialog"
        aria-label="Choose date"
        aria-modal="false"
        style={{ width: 320 }}
        onKeyDown={handleDialogKeyDown}
      >
        <input
          ref={inputRef}
          className="notes-date-picker-input"
          aria-label="Date"
          aria-invalid={!inputValid}
          autoComplete="off"
          spellCheck={false}
          value={inputValue}
          onChange={handleInputChange}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={handleCompositionEnd}
        />

        <div className="notes-date-picker-quick" aria-label="Quick dates">
          <button
            type="button"
            onClick={() => chooseQuickDate(quickDateValues.today)}
          >
            Today
          </button>
          <button
            type="button"
            disabled={quickDateValues.tomorrow === null}
            onClick={() => chooseQuickDate(quickDateValues.tomorrow)}
          >
            Tomorrow
          </button>
          <button
            type="button"
            disabled={quickDateValues.nextWeek === null}
            onClick={() => chooseQuickDate(quickDateValues.nextWeek)}
          >
            Next week
          </button>
        </div>

        <div className="notes-date-picker-month-row">
          <button
            className="notes-date-picker-icon-button"
            type="button"
            aria-label="Previous month"
            title="Previous month"
            disabled={previousMonth === null}
            onClick={() => {
              if (previousMonth !== null) {
                setDisplayMonth(previousMonth);
              }
            }}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <h2 className="notes-date-picker-month" aria-live="polite">
            {monthNames[displayMonth.month - 1]} {displayMonth.year}
          </h2>
          <button
            className="notes-date-picker-icon-button"
            type="button"
            aria-label="Next month"
            title="Next month"
            disabled={nextMonth === null}
            onClick={() => {
              if (nextMonth !== null) {
                setDisplayMonth(nextMonth);
              }
            }}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>

        <div
          className="notes-date-picker-calendar"
          role="grid"
          aria-label={`${monthNames[displayMonth.month - 1]} ${displayMonth.year}`}
          style={{ height: 228 }}
        >
          <div className="notes-date-picker-calendar-row" role="row">
            {weekdayHeaders.map((weekday, index) => (
              <div
                className="notes-date-picker-weekday"
                role="columnheader"
                aria-label={weekday.long}
                key={`${weekday.long}-${index}`}
              >
                {weekday.short}
              </div>
            ))}
          </div>
          {Array.from({ length: 6 }, (_, weekIndex) => (
            <div
              className="notes-date-picker-calendar-row"
              role="row"
              key={`week-${weekIndex}`}
            >
              {calendarDays
                .slice(weekIndex * 7, weekIndex * 7 + 7)
                .map((date, dayIndex) =>
                  renderCalendarCell(date, weekIndex * 7 + dayIndex)
                )}
            </div>
          ))}
        </div>

        <div className="notes-date-picker-footer">
          <label className="notes-date-picker-range">
            <input
              type="checkbox"
              checked={rangeEnabled}
              onChange={(event) => {
                const enabled = event.currentTarget.checked;
                const next = {
                  ...value,
                  end: enabled ? value.start : null
                };
                setRangeEnabled(enabled);
                setRangePhase("start");
                setValue(next);
                setInputValue(formatValue(next));
                setInputValid(true);
              }}
            />
            <span>Range</span>
          </label>
          <label className="notes-date-picker-format">
            <span>Format</span>
            <select
              aria-label="Format"
              value={value.format}
              onChange={(event) => {
                const next = {
                  ...value,
                  format: event.currentTarget.value as NumericDateFormat
                };
                setValue(next);
                setInputValue(formatValue(next));
                setInputValid(true);
              }}
            >
              {formats.map((format) => (
                <option value={format} key={format}>
                  {format}
                </option>
              ))}
            </select>
          </label>
        </div>

        {context.kind === "existing-date" && (
          <button
            className="notes-date-picker-remove"
            type="button"
            onClick={() => {
              onCommit({
                replacement: {
                  startUtf16: context.startUtf16,
                  endUtf16: context.endUtf16,
                  text: ""
                },
                value: null
              });
              onRequestFocusReturn();
            }}
          >
            <Trash2 size={14} aria-hidden="true" />
            Remove date
          </button>
        )}
      </div>
    </>
  );
}

export function NotesDatePicker({
  open,
  context,
  today,
  weekStartsOn = "sunday",
  initialFormat = "MM/DD/YYYY",
  onCommit,
  onDismiss,
  onRequestFocusReturn
}: NotesDatePickerProps) {
  if (!open) {
    return null;
  }

  const identity = contextIdentity(
    context,
    today,
    initialFormat,
    weekStartsOn
  );
  return (
    <NotesDatePickerSession
      key={identity}
      context={context}
      today={today}
      weekStartsOn={weekStartsOn}
      initialFormat={initialFormat}
      onCommit={onCommit}
      onDismiss={onDismiss}
      onRequestFocusReturn={onRequestFocusReturn}
    />
  );
}
