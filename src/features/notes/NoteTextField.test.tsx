import {
  act,
  fireEvent,
  render,
  screen
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { NoteTextField } from "./NoteTextField";

describe("NoteTextField", () => {
  const today = { year: 2026, month: 7, day: 11 } as const;

  it("exposes and activates exactly one text representation per mode", async () => {
    const user = userEvent.setup();
    const textareaRef = createRef<HTMLTextAreaElement>();
    const { container } = render(
      <NoteTextField
        ref={textareaRef}
        value="Plan #today"
        aria-label="Edit node title"
        tabIndex={2}
        onChange={vi.fn()}
        onTagClick={vi.fn()}
      />
    );
    const textarea = container.querySelector("textarea");
    const presentation = container.querySelector(".notes-token-text");

    expect(textarea).toBe(textareaRef.current);
    expect(screen.queryByRole("textbox", { name: "Edit node title" }))
      .not.toBeInTheDocument();
    expect(textarea).toHaveAttribute("aria-hidden", "true");
    expect(textarea).toHaveAttribute("tabindex", "-1");
    expect(textarea).toHaveStyle({ pointerEvents: "none" });
    expect(
      screen.getByRole("group", { name: "Edit node title" })
    ).toBe(presentation);
    expect(presentation).toHaveAttribute("tabindex", "0");
    expect(presentation).not.toHaveAttribute("aria-hidden", "true");
    expect(
      screen.getByRole("button", {
        name: "#today tag filter is inactive"
      })
    ).toBeVisible();

    await user.tab();
    expect(presentation).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("textbox", { name: "Edit node title" })).toBe(
      textarea
    );
    expect(textarea).toHaveFocus();
    expect(textarea).not.toHaveAttribute("aria-hidden");
    expect(textarea).toHaveAttribute("tabindex", "2");
    expect(textarea).not.toHaveStyle({ pointerEvents: "none" });
    expect(presentation).toHaveAttribute("aria-hidden", "true");
    expect(presentation).toHaveAttribute("tabindex", "-1");
    expect(
      screen.queryByRole("button", {
        name: "#today tag filter is inactive"
      })
    ).not.toBeInTheDocument();

    act(() => textarea?.blur());

    expect(container.querySelector("textarea")).toBe(textarea);
    expect(screen.queryByRole("textbox", { name: "Edit node title" }))
      .not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "#today tag filter is inactive"
      })
    ).toBeVisible();
  });

  it("keeps one native textarea mounted while focus changes presentation modes", () => {
    const textareaRef = createRef<HTMLTextAreaElement>();
    const { container, rerender } = render(
      <NoteTextField
        ref={textareaRef}
        className="notes-node-title"
        value="Plan #today"
        aria-label="Edit node title"
        rows={1}
        onChange={vi.fn()}
        onTagClick={vi.fn()}
      />
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const field = textarea.closest(".notes-text-field");

    expect(textarea).toBe(textareaRef.current);
    expect(textarea).toHaveClass("notes-node-title");
    expect(textarea).toHaveAttribute("rows", "1");
    expect(textarea).toHaveStyle({ opacity: "0" });
    expect(field).toHaveAttribute("data-editing", "false");
    expect(
      screen.getByRole("button", {
        name: "#today tag filter is inactive"
      })
    ).toBeVisible();

    act(() => textarea.focus());

    expect(field).toHaveAttribute("data-editing", "true");
    expect(screen.getByRole("textbox", { name: "Edit node title" })).toBe(
      textarea
    );
    expect(textarea).toHaveStyle({ opacity: "1" });
    expect(
      screen.queryByRole("button", {
        name: "#today tag filter is inactive"
      })
    ).not.toBeInTheDocument();

    rerender(
      <NoteTextField
        ref={textareaRef}
        className="notes-node-title"
        value="Plan #tomorrow"
        aria-label="Edit node title"
        rows={1}
        onChange={vi.fn()}
        onTagClick={vi.fn()}
      />
    );
    expect(screen.getByRole("textbox", { name: "Edit node title" })).toBe(
      textarea
    );

    act(() => textarea.blur());

    expect(field).toHaveAttribute("data-editing", "false");
    expect(textarea).toHaveStyle({ opacity: "0" });
    expect(
      screen.getByRole("button", {
        name: "#tomorrow tag filter is inactive"
      })
    ).toBeVisible();
  });

  it("renders the resting value losslessly with the textarea typography class", () => {
    const source = "  first\t#tag  \nsecond";
    const { container } = render(
      <NoteTextField
        className="notes-node-note"
        value={source}
        aria-label="Supporting note"
        onChange={vi.fn()}
        onTagClick={vi.fn()}
      />
    );

    const presentation = container.querySelector(".notes-token-text");
    expect(presentation).toHaveClass("notes-node-note");
    expect(presentation).toHaveTextContent(source, { normalizeWhitespace: false });
    expect(presentation).toHaveStyle({
      overflowWrap: "anywhere",
      whiteSpace: "pre-wrap"
    });
  });

  it("activates a tag without focusing the textarea first", async () => {
    const user = userEvent.setup();
    const focusOrder: string[] = [];
    const onFocus = vi.fn(() => focusOrder.push("textarea"));
    const onTagClick = vi.fn(() => {
      focusOrder.push("tag");
      expect(document.querySelector("textarea")).not.toHaveFocus();
    });
    render(
      <NoteTextField
        value="Ship #today"
        aria-label="Edit title"
        onChange={vi.fn()}
        onFocus={onFocus}
        onTagClick={onTagClick}
      />
    );

    const tag = screen.getByRole("button", {
      name: "#today tag filter is inactive"
    });
    await user.click(tag);

    expect(tag).toHaveFocus();
    expect(focusOrder).toEqual(["tag"]);
    expect(onFocus).not.toHaveBeenCalled();
    expect(onTagClick).toHaveBeenCalledOnce();
    expect(tag.closest(".notes-text-field")).toHaveAttribute(
      "data-editing",
      "false"
    );
  });

  it("keeps editing locked across blur until compositionend", () => {
    const onBlur = vi.fn();
    const onCompositionStart = vi.fn();
    const onCompositionEnd = vi.fn();
    render(
      <NoteTextField
        value="한국어 #태그"
        aria-label="Edit title"
        onChange={vi.fn()}
        onBlur={onBlur}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onTagClick={vi.fn()}
      />
    );
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    const field = textarea.closest(".notes-text-field");

    act(() => textarea.focus());
    fireEvent.compositionStart(textarea, { data: "한" });
    act(() => textarea.blur());

    expect(onCompositionStart).toHaveBeenCalledOnce();
    expect(onBlur).toHaveBeenCalledOnce();
    expect(field).toHaveAttribute("data-editing", "true");

    fireEvent.compositionEnd(textarea, { data: "한" });

    expect(onCompositionEnd).toHaveBeenCalledOnce();
    expect(field).toHaveAttribute("data-editing", "false");
    expect(
      screen.getByRole("button", {
        name: "#태그 tag filter is inactive"
      })
    ).toBeVisible();
  });

  it("keeps tag buttons keyboard-operable without entering editing mode", async () => {
    const user = userEvent.setup();
    const onTagClick = vi.fn();
    render(
      <NoteTextField
        value="Review @Alice"
        aria-label="Edit title"
        onChange={vi.fn()}
        onTagClick={onTagClick}
      />
    );
    const tag = screen.getByRole("button", {
      name: "@Alice tag filter is inactive"
    });

    tag.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onTagClick).toHaveBeenCalledTimes(2);
    expect(tag).toHaveFocus();
    expect(tag.closest(".notes-text-field")).toHaveAttribute(
      "data-editing",
      "false"
    );
  });

  it("keeps raw date text in the mounted textarea while a resting pill opens its exact token", async () => {
    const user = userEvent.setup();
    const onDateClick = vi.fn();
    const source = "🚀 Review today and 07/13/2026";
    const { container } = render(
      <NoteTextField
        value={source}
        today={today}
        aria-label="Edit title"
        onChange={vi.fn()}
        onTagClick={vi.fn()}
        onDateClick={onDateClick}
      />
    );
    const textarea = container.querySelector("textarea");
    const date = screen.getByRole("button", {
      name: "Edit date 07/13/2026"
    });

    expect(textarea).toHaveValue(source);
    await user.click(date);

    expect(textarea).toHaveValue(source);
    expect(textarea).not.toHaveFocus();
    expect(onDateClick).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: "07/13/2026",
        startUtf16: 20,
        endUtf16: 30
      }),
      date
    );
  });

  it("opens a typed date replacement for exactly the second non-composing exclamation", () => {
    const onDateTrigger = vi.fn();
    const { container } = render(
      <NoteTextField
        value="Plan !"
        today={today}
        aria-label="Edit title"
        onChange={vi.fn()}
        onTagClick={vi.fn()}
        onDateTrigger={onDateTrigger}
      />
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => textarea.focus());

    fireEvent.input(textarea, {
      target: {
        value: "Plan !!",
        selectionStart: 7,
        selectionEnd: 7
      },
      inputType: "insertText",
      data: "!"
    });

    expect(onDateTrigger).toHaveBeenCalledOnce();
    expect(onDateTrigger).toHaveBeenCalledWith(
      { startUtf16: 5, endUtf16: 7 },
      textarea
    );
  });

  it("does not open the typed date replacement during IME composition", () => {
    const onDateTrigger = vi.fn();
    const { container } = render(
      <NoteTextField
        value="Plan !"
        today={today}
        aria-label="Edit title"
        onChange={vi.fn()}
        onTagClick={vi.fn()}
        onDateTrigger={onDateTrigger}
      />
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => textarea.focus());
    fireEvent.compositionStart(textarea, { data: "!" });

    fireEvent.input(textarea, {
      target: {
        value: "Plan !!",
        selectionStart: 7,
        selectionEnd: 7
      },
      inputType: "insertCompositionText",
      data: "!",
      isComposing: true
    });

    expect(onDateTrigger).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled", { disabled: true }, "aria-disabled"],
    ["read-only", { readOnly: true }, "aria-readonly"]
  ] as const)(
    "renders a noneditable presentation and suppresses date triggers when %s",
    async (_label, state, stateAttribute) => {
      const user = userEvent.setup();
      const onDateClick = vi.fn();
      const onDateTrigger = vi.fn();
      const { container } = render(
        <>
          <NoteTextField
            {...state}
            value="Due 07/12/2026"
            today={today}
            aria-label="Title"
            onChange={vi.fn()}
            onTagClick={vi.fn()}
            onDateClick={onDateClick}
            onDateTrigger={onDateTrigger}
          />
          <button type="button">After field</button>
        </>
      );
      const textarea = container.querySelector(
        "textarea"
      ) as HTMLTextAreaElement;
      const presentation = screen.getByRole("group", { name: "Title" });

      expect(presentation).toHaveAttribute("tabindex", "-1");
      expect(presentation).toHaveAttribute(stateAttribute, "true");
      expect(textarea).toHaveAttribute("aria-hidden", "true");
      expect(textarea).toHaveAttribute("tabindex", "-1");
      expect(
        screen.queryByRole("textbox", { name: "Title" })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Edit date 07/12/2026" })
      ).not.toBeInTheDocument();
      expect(container.querySelector(".notes-date-token")).toHaveTextContent(
        "07/12/2026"
      );
      fireEvent.pointerDown(presentation);
      fireEvent.keyDown(presentation, { key: "Enter" });
      fireEvent.keyDown(presentation, { key: " " });
      expect(
        screen.queryByRole("textbox", { name: "Title" })
      ).not.toBeInTheDocument();
      expect(presentation.closest(".notes-text-field")).toHaveAttribute(
        "data-editing",
        "false"
      );

      await user.tab();
      expect(screen.getByRole("button", { name: "After field" })).toHaveFocus();

      fireEvent.input(textarea, {
        target: {
          value: "Due 07/12/2026 !!",
          selectionStart: 18,
          selectionEnd: 18
        },
        inputType: "insertText",
        data: "!"
      });
      expect(onDateClick).not.toHaveBeenCalled();
      expect(onDateTrigger).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["read-only", { readOnly: true }, "aria-readonly"],
    ["disabled", { disabled: true }, "aria-disabled"]
  ] as const)(
    "moves focus to the body before a focused field becomes %s",
    (_label, state, stateAttribute) => {
      const onBlur = vi.fn();
      const onTagClick = vi.fn();
      const props = {
        value: "Project #today",
        "aria-label": "Title",
        onChange: vi.fn(),
        onBlur,
        onTagClick
      };
      const { container, rerender } = render(<NoteTextField {...props} />);
      const textarea = container.querySelector(
        "textarea"
      ) as HTMLTextAreaElement;

      act(() => textarea.focus());
      expect(screen.getByRole("textbox", { name: "Title" })).toBe(textarea);
      expect(textarea).toHaveFocus();

      rerender(<NoteTextField {...props} {...state} />);

      expect(document.activeElement).toBe(document.body);
      expect(textarea).not.toHaveFocus();
      expect(onBlur).toHaveBeenCalledOnce();
      expect(
        screen.queryByRole("textbox", { name: "Title" })
      ).not.toBeInTheDocument();
      const presentation = screen.getByRole("group", { name: "Title" });
      expect(presentation).toHaveAttribute(stateAttribute, "true");
      expect(presentation).toHaveAttribute("tabindex", "-1");
      const tag = screen.getByRole("button", {
        name: "#today tag filter is inactive"
      });
      expect(tag).toBeVisible();
      fireEvent.click(tag);
      expect(onTagClick).toHaveBeenCalledOnce();

      act(() => textarea.focus());
      expect(document.activeElement).toBe(document.body);
      expect(textarea).not.toHaveFocus();
      expect(
        screen.queryByRole("textbox", { name: "Title" })
      ).not.toBeInTheDocument();
    }
  );

  it("releases focus safely when an editing field unmounts", () => {
    const { container, unmount } = render(
      <NoteTextField
        value="Project"
        aria-label="Title"
        onChange={vi.fn()}
        onTagClick={vi.fn()}
      />
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => textarea.focus());
    expect(textarea).toHaveFocus();

    expect(() => unmount()).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps focus and editing active across enabled rerenders", () => {
    const onBlur = vi.fn();
    const props = {
      "aria-label": "Title",
      onBlur,
      onChange: vi.fn(),
      onTagClick: vi.fn()
    };
    const { container, rerender } = render(
      <NoteTextField {...props} value="Project" />
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => textarea.focus());

    rerender(<NoteTextField {...props} value="Project updated" />);

    expect(textarea).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Title" })).toBe(textarea);
    expect(onBlur).not.toHaveBeenCalled();
  });
});
