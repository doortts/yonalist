import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { NotesDatePicker } from "./NotesDatePicker";

const today = { year: 2026, month: 7, day: 11 } as const;

function pickerProps(
  overrides: Partial<ComponentProps<typeof NotesDatePicker>> = {}
): ComponentProps<typeof NotesDatePicker> {
  return {
    open: true,
    context: {
      kind: "typed-trigger",
      startUtf16: 7,
      endUtf16: 9
    },
    today,
    weekStartsOn: "sunday",
    onCommit: vi.fn(),
    onDismiss: vi.fn(),
    onRequestFocusReturn: vi.fn(),
    ...overrides
  };
}

function getPicker() {
  return screen.getByRole("dialog", { name: "Choose date" });
}

function getDateButton(name: string) {
  return within(getPicker()).getByRole("button", { name });
}

describe("NotesDatePicker", () => {
  it("opens from a typed !! context with an editable input and Sunday-first calendar", async () => {
    render(<NotesDatePicker {...pickerProps()} />);

    const picker = getPicker();
    const input = within(picker).getByRole("textbox", { name: "Date" });
    const headers = within(picker)
      .getAllByRole("columnheader")
      .map((header) => header.textContent);

    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue("");
    expect(headers).toEqual(["S", "M", "T", "W", "T", "F", "S"]);
    expect(within(picker).getByText("July 2026")).toBeVisible();
    expect(getDateButton("Saturday, July 11, 2026")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(picker).toHaveStyle({ width: "320px" });
    expect(within(picker).getByRole("grid")).toHaveStyle({ height: "228px" });
  });

  it("hydrates an existing date context for editing and exposes removal", async () => {
    render(
      <NotesDatePicker
        {...pickerProps({
          context: {
            kind: "existing-date",
            startUtf16: 12,
            endUtf16: 22,
            raw: "07-14-26",
            value: {
              start: { year: 2026, month: 7, day: 14 },
              end: null,
              format: "MM-DD-YY"
            }
          }
        })}
      />
    );

    const picker = getPicker();
    expect(within(picker).getByRole("textbox", { name: "Date" })).toHaveValue(
      "07-14-26"
    );
    expect(within(picker).getByRole("combobox", { name: "Format" })).toHaveValue(
      "MM-DD-YY"
    );
    expect(getDateButton("Tuesday, July 14, 2026")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(
      within(picker).getByRole("button", { name: "Remove date" })
    ).toBeVisible();
  });

  it("updates an existing date with the original replacement span", async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(
      <NotesDatePicker
        {...pickerProps({
          context: {
            kind: "existing-date",
            startUtf16: 12,
            endUtf16: 22,
            raw: "07-14-26",
            value: {
              start: { year: 2026, month: 7, day: 14 },
              end: null,
              format: "MM-DD-YY"
            }
          },
          onCommit
        })}
      />
    );

    await user.click(
      within(getPicker()).getByRole("button", { name: "Tomorrow" })
    );
    await user.keyboard("{Enter}");

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith({
      replacement: {
        startUtf16: 12,
        endUtf16: 22,
        text: "07-12-26"
      },
      value: {
        start: { year: 2026, month: 7, day: 12 },
        end: null,
        format: "MM-DD-YY"
      }
    });
  });

  it("updates the selected day from editable natural-language input and commits on Enter", async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(<NotesDatePicker {...pickerProps({ onCommit })} />);
    const input = within(getPicker()).getByRole("textbox", { name: "Date" });

    await user.type(input, "tomorrow");

    expect(getDateButton("Sunday, July 12, 2026")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await user.keyboard("{Enter}");

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith({
      replacement: {
        startUtf16: 7,
        endUtf16: 9,
        text: "07/12/2026"
      },
      value: {
        start: { year: 2026, month: 7, day: 12 },
        end: null,
        format: "MM/DD/YYYY"
      }
    });
  });

  it("offers Today, Tomorrow, and injected-week-aware Next week choices", async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(
      <NotesDatePicker
        {...pickerProps({
          today: { year: 2026, month: 12, day: 31 },
          weekStartsOn: "monday",
          onCommit
        })}
      />
    );

    const picker = getPicker();
    expect(
      within(picker).getAllByRole("columnheader").map((header) => header.textContent)
    ).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
    await user.click(within(picker).getByRole("button", { name: "Next week" }));

    expect(within(picker).getByRole("checkbox", { name: "Range" })).toBeChecked();
    expect(within(picker).getByRole("textbox", { name: "Date" })).toHaveValue(
      "01/04/2027 - 01/10/2027"
    );
    expect(within(picker).getByText("January 2027")).toBeVisible();

    await user.click(within(picker).getByRole("button", { name: "Today" }));
    expect(within(picker).getByRole("checkbox", { name: "Range" })).not.toBeChecked();
    expect(within(picker).getByRole("textbox", { name: "Date" })).toHaveValue(
      "12/31/2026"
    );

    await user.click(within(picker).getByRole("button", { name: "Tomorrow" }));
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith({
      replacement: {
        startUtf16: 7,
        endUtf16: 9,
        text: "01/01/2027"
      },
      value: {
        start: { year: 2027, month: 1, day: 1 },
        end: null,
        format: "MM/DD/YYYY"
      }
    });
  });

  it("navigates the focused grid day across month boundaries with arrow keys", async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(
      <NotesDatePicker
        {...pickerProps({
          today: { year: 2026, month: 8, day: 1 },
          onCommit
        })}
      />
    );

    const augustFirst = getDateButton("Saturday, August 1, 2026");
    augustFirst.focus();
    await user.keyboard("{ArrowLeft}");

    const julyThirtyFirst = getDateButton("Friday, July 31, 2026");
    expect(julyThirtyFirst).toHaveFocus();
    expect(within(getPicker()).getByText("July 2026")).toBeVisible();

    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith({
      replacement: {
        startUtf16: 7,
        endUtf16: 9,
        text: "07/31/2026"
      },
      value: {
        start: { year: 2026, month: 7, day: 31 },
        end: null,
        format: "MM/DD/YYYY"
      }
    });
  });

  it("supports explicit previous and next month buttons without changing the value", async () => {
    const user = userEvent.setup();
    render(<NotesDatePicker {...pickerProps()} />);
    const picker = getPicker();

    await user.click(
      within(picker).getByRole("button", { name: "Next month" })
    );
    expect(within(picker).getByText("August 2026")).toBeVisible();
    expect(within(picker).getByRole("textbox", { name: "Date" })).toHaveValue("");

    await user.click(
      within(picker).getByRole("button", { name: "Previous month" })
    );
    expect(within(picker).getByText("July 2026")).toBeVisible();
  });

  it("orders range endpoints selected in reverse and commits one replacement", async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(<NotesDatePicker {...pickerProps({ onCommit })} />);
    const picker = getPicker();

    await user.click(within(picker).getByRole("checkbox", { name: "Range" }));
    await user.click(getDateButton("Monday, July 20, 2026"));
    await user.click(getDateButton("Wednesday, July 15, 2026"));

    expect(within(picker).getByRole("textbox", { name: "Date" })).toHaveValue(
      "07/15/2026 - 07/20/2026"
    );
    expect(getDateButton("Wednesday, July 15, 2026")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(getDateButton("Monday, July 20, 2026")).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    within(picker).getByRole("textbox", { name: "Date" }).focus();
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith({
      replacement: {
        startUtf16: 7,
        endUtf16: 9,
        text: "07/15/2026 - 07/20/2026"
      },
      value: {
        start: { year: 2026, month: 7, day: 15 },
        end: { year: 2026, month: 7, day: 20 },
        format: "MM/DD/YYYY"
      }
    });
  });

  it("selects both range endpoints by keyboard before committing", async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(<NotesDatePicker {...pickerProps({ onCommit })} />);
    const picker = getPicker();

    await user.click(within(picker).getByRole("checkbox", { name: "Range" }));
    const julyTwentieth = getDateButton("Monday, July 20, 2026");
    julyTwentieth.focus();
    await user.keyboard("{Enter}");

    expect(onCommit).not.toHaveBeenCalled();
    expect(within(picker).getByRole("textbox", { name: "Date" })).toHaveValue(
      "07/20/2026 - 07/20/2026"
    );

    const julyFifteenth = getDateButton("Wednesday, July 15, 2026");
    julyFifteenth.focus();
    await user.keyboard("{Enter}");

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith({
      replacement: {
        startUtf16: 7,
        endUtf16: 9,
        text: "07/15/2026 - 07/20/2026"
      },
      value: {
        start: { year: 2026, month: 7, day: 15 },
        end: { year: 2026, month: 7, day: 20 },
        format: "MM/DD/YYYY"
      }
    });
  });

  it("uses the selected numeric format for a single commit payload", async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(<NotesDatePicker {...pickerProps({ onCommit })} />);
    const picker = getPicker();

    await user.selectOptions(
      within(picker).getByRole("combobox", { name: "Format" }),
      "MM-DD-YY"
    );
    await user.click(within(picker).getByRole("button", { name: "Today" }));
    within(picker).getByRole("textbox", { name: "Date" }).focus();
    await user.keyboard("{Enter}");

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith({
      replacement: {
        startUtf16: 7,
        endUtf16: 9,
        text: "07-11-26"
      },
      value: {
        start: today,
        end: null,
        format: "MM-DD-YY"
      }
    });
  });

  it("removes an existing date with one empty replacement object", async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(
      <NotesDatePicker
        {...pickerProps({
          context: {
            kind: "existing-date",
            startUtf16: 4,
            endUtf16: 14,
            raw: "07/11/2026",
            value: {
              start: today,
              end: null,
              format: "MM/DD/YYYY"
            }
          },
          onCommit
        })}
      />
    );

    await user.click(
      within(getPicker()).getByRole("button", { name: "Remove date" })
    );

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith({
      replacement: { startUtf16: 4, endUtf16: 14, text: "" },
      value: null
    });
  });

  it("dismisses on Escape and outside press and requests editor focus return", async () => {
    const onDismiss = vi.fn();
    const onRequestFocusReturn = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <div>
        <NotesDatePicker
          {...pickerProps({ onDismiss, onRequestFocusReturn })}
        />
        <button type="button">Outside</button>
      </div>
    );

    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenLastCalledWith("escape");
    expect(onRequestFocusReturn).toHaveBeenCalledTimes(1);

    onDismiss.mockClear();
    onRequestFocusReturn.mockClear();
    rerender(
      <div>
        <NotesDatePicker
          {...pickerProps({ onDismiss, onRequestFocusReturn })}
        />
        <button type="button">Outside</button>
      </div>
    );
    await user.click(screen.getByRole("button", { name: "Outside" }));

    expect(onDismiss).toHaveBeenCalledWith("outside");
    expect(onRequestFocusReturn).toHaveBeenCalledOnce();
  });

  it("suppresses Enter, Escape, and Process while IME composition is active", async () => {
    const onCommit = vi.fn();
    const onDismiss = vi.fn();
    const onRequestFocusReturn = vi.fn();
    render(
      <NotesDatePicker
        {...pickerProps({ onCommit, onDismiss, onRequestFocusReturn })}
      />
    );
    const picker = getPicker();
    const input = within(picker).getByRole("textbox", { name: "Date" });

    fireEvent.compositionStart(input, { data: "내일" });
    fireEvent.change(input, { target: { value: "tomorrow" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    fireEvent.keyDown(input, { key: "Process" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onRequestFocusReturn).not.toHaveBeenCalled();
    expect(getDateButton("Saturday, July 11, 2026")).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    fireEvent.compositionEnd(input, { data: "tomorrow" });
    expect(getDateButton("Sunday, July 12, 2026")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("preserves in-progress state across equivalent parent rerenders", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<NotesDatePicker {...pickerProps()} />);
    const input = within(getPicker()).getByRole("textbox", { name: "Date" });

    await user.click(within(getPicker()).getByRole("button", { name: "Tomorrow" }));
    expect(input).toHaveValue("07/12/2026");

    rerender(<NotesDatePicker {...pickerProps()} />);
    await waitFor(() => expect(input).toHaveValue("07/12/2026"));
  });

  it("renders nothing while controlled closed", () => {
    render(<NotesDatePicker {...pickerProps({ open: false })} />);
    expect(screen.queryByRole("dialog", { name: "Choose date" })).toBeNull();
  });
});
