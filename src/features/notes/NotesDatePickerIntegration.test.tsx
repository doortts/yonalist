import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { NoteTextField } from "./NoteTextField";
import { NoteTokenText } from "./NoteTokenText";
import {
  NotesDatePickerHost,
  NotesDateTodayProvider,
  createExistingDateContext,
  getLocalToday,
  replaceUtf16Range,
  useNotesDatePickerIntegration,
  type NotesDatePickerTarget
} from "./NotesDatePickerIntegration";
import { findNoteDateMatches } from "./noteDates";
import {
  readPlainText,
  readPlainTextSelection,
  replacePlainText,
} from "./plainTextContenteditable";

const today = { year: 2026, month: 7, day: 11 } as const;
const notesStyles = readFileSync(
  join(process.cwd(), "src/features/notes/notes.css"),
  "utf8"
);

function target(
  overrides: Partial<NotesDatePickerTarget> = {}
): NotesDatePickerTarget {
  const anchor = document.createElement("button");
  const focusElement = document.createElement("textarea");
  document.body.append(anchor, focusElement);
  vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
    x: 24,
    y: 40,
    left: 24,
    top: 40,
    right: 104,
    bottom: 64,
    width: 80,
    height: 24,
    toJSON: () => ({})
  });
  const pickerTarget: NotesDatePickerTarget = {
    field: "title",
    source: "Plan !! later",
    anchor,
    focusElement,
    context: {
      kind: "typed-trigger",
      startUtf16: 5,
      endUtf16: 7
    },
    ...overrides
  };
  focusElement.value = pickerTarget.source;
  return pickerTarget;
}

function ControlledTitleDateFieldContent() {
  const [title, setTitle] = useState("Plan ");
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const datePicker = useNotesDatePickerIntegration({
    values: { title, note: "" },
    refs: { title: titleRef, note: noteRef },
    onCommit: (_field, value) => setTitle(value)
  });

  return (
    <>
      <NoteTextField
        ref={titleRef}
        value={title}
        today={datePicker.today}
        aria-label="Controlled title"
        onChange={(event) => setTitle(event.currentTarget.value)}
        onTagClick={vi.fn()}
        onDateClick={(token, anchor) =>
          datePicker.openExistingDate("title", token, anchor)
        }
        onDateTrigger={(range, anchor) =>
          datePicker.openTypedDate("title", range, anchor)
        }
      />
      {datePicker.picker}
    </>
  );
}

function ControlledTitleDateField() {
  return (
    <NotesDateTodayProvider today={today}>
      <ControlledTitleDateFieldContent />
    </NotesDateTodayProvider>
  );
}

function LegacyCaretDateField() {
  const [title, setTitle] = useState("PlanNext");
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const datePicker = useNotesDatePickerIntegration({
    values: { title, note: "" },
    refs: { title: titleRef, note: noteRef },
    onCommit: (_field, value) => setTitle(value)
  });

  return (
    <>
      <NoteTextField
        ref={titleRef}
        value={title}
        today={datePicker.today}
        aria-label="Legacy title"
        onChange={(event) => setTitle(event.currentTarget.value)}
        onTagClick={vi.fn()}
      />
      <button type="button" onClick={() => datePicker.openTitleDate(4)}>
        Add date
      </button>
      {datePicker.picker}
    </>
  );
}

function ControlledLiveTitleDateFieldContent() {
  const [title, setTitle] = useState("State source");
  const titleRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const datePicker = useNotesDatePickerIntegration({
    values: { title, note: "" },
    refs: { title: titleRef, note: noteRef },
    onCommit: (_field, value) => setTitle(value),
  });

  return (
    <>
      <div
        ref={titleRef}
        data-notes-bullet-title
        role="textbox"
        tabIndex={0}
      >
        {title}
      </div>
      <button
        type="button"
        onClick={() => {
          const editor = titleRef.current!;
          replacePlainText(editor, "DOM !! source", {
            anchorUtf16: 6,
            focusUtf16: 6,
          });
          datePicker.openTypedDate(
            "title",
            { startUtf16: 4, endUtf16: 6 },
            editor,
          );
        }}
      >
        Open live title date
      </button>
      {datePicker.picker}
    </>
  );
}

function ControlledLiveTitleDateField() {
  return (
    <NotesDateTodayProvider today={today}>
      <ControlledLiveTitleDateFieldContent />
    </NotesDateTodayProvider>
  );
}

describe("NotesDatePicker integration helpers", () => {
  it("styles resting dates as rounded pills and constrains the picker to its host", () => {
    expect(notesStyles).toMatch(
      /\.notes-date-token\s*\{[^}]*border-radius:\s*6px;[^}]*background:\s*var\(--bg-active\);/s
    );
    expect(notesStyles).toMatch(
      /\.notes-date-picker-host\s*>\s*\.notes-date-picker\s*\{[^}]*width:\s*100%\s*!important;[^}]*max-width:\s*100%;/s
    );
  });

  it("derives today from local calendar fields through an injectable Date seam", () => {
    const localDate = new Date(2026, 6, 11, 23, 59, 59);

    expect(getLocalToday(localDate)).toEqual(today);
  });

  it("replaces only the targeted UTF-16 range", () => {
    expect(
      replaceUtf16Range("🚀 Plan today and later", {
        startUtf16: 8,
        endUtf16: 13,
        text: "07/12/2026"
      })
    ).toBe("🚀 Plan 07/12/2026 and later");
  });

  it.each([
    ["", 0, 0, "07/12/2026"],
    ["Plan", 0, 0, "07/12/2026 Plan"],
    ["Plan", 4, 4, "Plan 07/12/2026"],
    ["PlanNext", 4, 4, "Plan 07/12/2026 Next"],
    ["Plan  next", 5, 5, "Plan 07/12/2026 next"],
    ["Plan replace next", 5, 12, "Plan 07/12/2026 next"]
  ] as const)(
    "spaces a date insertion without changing unrelated text in %j",
    (source, startUtf16, endUtf16, expected) => {
      expect(
        replaceUtf16Range(
          source,
          { startUtf16, endUtf16, text: "07/12/2026" },
          "date-insertion"
        )
      ).toBe(expected);
    }
  );

  it("produces a parser-compatible resting pill after an end insertion", () => {
    const result = replaceUtf16Range(
      "Plan",
      { startUtf16: 4, endUtf16: 4, text: "07/12/2026" },
      "date-insertion"
    );

    expect(findNoteDateMatches(result, { today })).toEqual([
      expect.objectContaining({
        raw: "07/12/2026",
        startUtf16: 5,
        endUtf16: 15
      })
    ]);
    render(
      <NoteTokenText
        text={result}
        today={today}
        onTagClick={vi.fn()}
        onDateClick={vi.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: "Edit date 07/12/2026" })
    ).toBeVisible();
  });

  it("keeps the numeric menu-caret contract parseable", async () => {
    const user = userEvent.setup();
    render(
      <NotesDateTodayProvider today={today}>
        <LegacyCaretDateField />
      </NotesDateTodayProvider>
    );

    await user.click(screen.getByRole("button", { name: "Add date" }));
    const picker = await screen.findByRole("dialog", { name: "Choose date" });
    await user.click(within(picker).getByRole("button", { name: "Tomorrow" }));
    await user.keyboard("{Enter}");

    expect(screen.getByText("Plan 07/12/2026 Next")).toBeVisible();
  });

  it("maps an existing parsed date to the shared picker context and preserves format", () => {
    expect(
      createExistingDateContext({
        raw: "07-13-26",
        startUtf16: 5,
        endUtf16: 13,
        start: { year: 2026, month: 7, day: 13 },
        end: null,
        source: {
          kind: "numeric",
          startFormat: "MM-DD-YY",
          endFormat: null
        }
      })
    ).toEqual({
      kind: "existing-date",
      raw: "07-13-26",
      startUtf16: 5,
      endUtf16: 13,
      value: {
        start: { year: 2026, month: 7, day: 13 },
        end: null,
        format: "MM-DD-YY"
      }
    });
  });
});

describe("NotesDatePickerHost", () => {
  it("commits a quick date into only the target and restores the textarea caret", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const pickerTarget = target();
    const onCommit = vi.fn();
    render(
      <NotesDatePickerHost
        target={pickerTarget}
        today={today}
        onCommit={onCommit}
        onClose={onClose}
        onRequestFocusReturn={vi.fn()}
      />
    );
    const picker = screen.getByRole("dialog", { name: "Choose date" });

    await user.click(within(picker).getByRole("button", { name: "Tomorrow" }));
    await user.keyboard("{Enter}");

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(
      "title",
      "Plan 07/12/2026 later",
      { startUtf16: 5, endUtf16: 7, text: "07/12/2026" }
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("restores the caret after the controlled long-date value renders", async () => {
    const user = userEvent.setup();
    render(<ControlledTitleDateField />);
    await user.click(
      screen.getByRole("group", { name: "Controlled title" })
    );
    const title = screen.getByRole("textbox", {
      name: "Controlled title"
    }) as HTMLTextAreaElement;
    title.setSelectionRange(title.value.length, title.value.length);

    await user.type(title, "!!");
    const picker = await screen.findByRole("dialog", { name: "Choose date" });
    await user.click(within(picker).getByRole("button", { name: "Tomorrow" }));
    await user.keyboard("{Enter}");

    await waitFor(() => expect(title).toHaveValue("Plan 07/12/2026"));
    await waitFor(() => expect(title).toHaveFocus());
    expect(title.selectionStart).toBe(15);
    expect(title.selectionEnd).toBe(15);
  });

  it("reads and restores a live title through its plain-text DOM source", async () => {
    const user = userEvent.setup();
    render(<ControlledLiveTitleDateField />);
    const title = document.querySelector<HTMLElement>(
      "[data-notes-bullet-title]",
    )!;

    await user.click(
      screen.getByRole("button", { name: "Open live title date" }),
    );
    const picker = await screen.findByRole("dialog", { name: "Choose date" });
    await user.click(within(picker).getByRole("button", { name: "Tomorrow" }));
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(readPlainText(title)).toBe("DOM 07/12/2026 source"),
    );
    await waitFor(() => expect(title).toHaveFocus());
    expect(readPlainTextSelection(title)).toEqual({
      anchorUtf16: 14,
      focusUtf16: 14,
    });
  });

  it("removes exactly one existing date and returns focus", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const pickerTarget = target({
      source: "First today, second tomorrow",
      context: {
        kind: "existing-date",
        raw: "today",
        startUtf16: 6,
        endUtf16: 11,
        value: { start: today, end: null, format: "MM/DD/YYYY" }
      }
    });
    render(
      <NotesDatePickerHost
        target={pickerTarget}
        today={today}
        onCommit={onCommit}
        onClose={vi.fn()}
        onRequestFocusReturn={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Remove date" }));

    expect(onCommit).toHaveBeenCalledWith(
      "title",
      "First , second tomorrow",
      { startUtf16: 6, endUtf16: 11, text: "" }
    );
  });

  it("clamps the picker width and horizontal placement on a narrow viewport", () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 280
    });
    const pickerTarget = target();
    vi.mocked(pickerTarget.anchor.getBoundingClientRect).mockReturnValue({
      x: 260,
      y: 40,
      left: 260,
      top: 40,
      right: 276,
      bottom: 64,
      width: 16,
      height: 24,
      toJSON: () => ({})
    });

    render(
      <NotesDatePickerHost
        target={pickerTarget}
        today={today}
        onCommit={vi.fn()}
        onClose={vi.fn()}
        onRequestFocusReturn={vi.fn()}
      />
    );

    expect(screen.getByTestId("notes-date-picker-host")).toHaveStyle({
      left: "8px",
      width: "264px"
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalWidth
    });
  });
});
