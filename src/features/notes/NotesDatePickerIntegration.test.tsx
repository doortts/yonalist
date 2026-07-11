import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  NotesDatePickerHost,
  createExistingDateContext,
  getLocalToday,
  replaceUtf16Range,
  type NotesDatePickerTarget
} from "./NotesDatePickerIntegration";

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
    const onCommit = vi.fn((_field: string, value: string) => {
      pickerTarget.focusElement.value = value;
    });
    render(
      <NotesDatePickerHost
        target={pickerTarget}
        today={today}
        onCommit={onCommit}
        onClose={onClose}
      />
    );
    const picker = screen.getByRole("dialog", { name: "Choose date" });

    await user.click(within(picker).getByRole("button", { name: "Tomorrow" }));
    await user.keyboard("{Enter}");

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(
      "title",
      "Plan 07/12/2026 later"
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(pickerTarget.focusElement).toHaveFocus();
    expect(pickerTarget.focusElement.selectionStart).toBe(15);
    expect(pickerTarget.focusElement.selectionEnd).toBe(15);
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
      />
    );

    await user.click(screen.getByRole("button", { name: "Remove date" }));

    expect(onCommit).toHaveBeenCalledWith(
      "title",
      "First , second tomorrow"
    );
    expect(pickerTarget.focusElement).toHaveFocus();
    expect(pickerTarget.focusElement.selectionStart).toBe(6);
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
