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
  it("keeps one native textarea mounted while focus changes presentation modes", () => {
    const textareaRef = createRef<HTMLTextAreaElement>();
    const { rerender } = render(
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
    const textarea = screen.getByRole("textbox", {
      name: "Edit node title"
    });
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
      expect(screen.getByRole("textbox", { name: "Edit title" })).not.toHaveFocus();
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
    const textarea = screen.getByRole("textbox", { name: "Edit title" });
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
});
