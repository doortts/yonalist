import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NoteTokenText } from "./NoteTokenText";

describe("NoteTokenText", () => {
  const today = { year: 2026, month: 7, day: 11 } as const;

  it("reconstructs the source text losslessly with textarea whitespace semantics", () => {
    const source = "  Plan\t#Today  \n담당: @수원\n";
    const { container } = render(
      <NoteTokenText text={source} onTagClick={vi.fn()} />
    );

    const presentation = container.querySelector(".notes-token-text");
    expect(presentation).not.toBeNull();
    expect(presentation).toHaveTextContent(source, { normalizeWhitespace: false });
    expect(presentation).toHaveStyle({
      font: "inherit",
      letterSpacing: "inherit",
      overflowWrap: "anywhere",
      whiteSpace: "pre-wrap"
    });
    expect(
      screen.getAllByRole("button").map((button) => button.textContent)
    ).toEqual(["#Today", "@수원"]);
  });

  it("names tag filters with their state and returns the complete tag token", async () => {
    const user = userEvent.setup();
    const onTagClick = vi.fn();
    render(
      <NoteTokenText
        text="#Project and @Alice"
        isTagActive={(token) => token.normalized === "project"}
        onTagClick={onTagClick}
      />
    );

    expect(
      screen.getByRole("button", {
        name: "#Project tag filter is active"
      })
    ).toHaveAttribute("aria-pressed", "true");
    const personTag = screen.getByRole("button", {
      name: "@Alice tag filter is inactive"
    });
    expect(personTag).toHaveAttribute("aria-pressed", "false");

    await user.click(personTag);

    expect(onTagClick).toHaveBeenCalledOnce();
    expect(onTagClick).toHaveBeenCalledWith({
      kind: "tag",
      prefix: "@",
      display: "Alice",
      normalized: "alice",
      raw: "@Alice",
      startUtf16: 13,
      endUtf16: 19
    });
  });

  it("activates a focused tag with Enter and Space", async () => {
    const user = userEvent.setup();
    const onTagClick = vi.fn();
    render(<NoteTokenText text="Open #later" onTagClick={onTagClick} />);
    const tag = screen.getByRole("button", {
      name: "#later tag filter is inactive"
    });

    tag.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onTagClick).toHaveBeenCalledTimes(2);
    expect(tag).toHaveFocus();
  });

  it("renders independent date pills and tags without changing source text or UTF-16 spans", async () => {
    const user = userEvent.setup();
    const onDateClick = vi.fn();
    const source = "🚀 #today today, then 07/13/2026 and @owner";
    const { container } = render(
      <NoteTokenText
        text={source}
        today={today}
        onTagClick={vi.fn()}
        onDateClick={onDateClick}
      />
    );

    expect(container.querySelector(".notes-token-text")).toHaveTextContent(
      source,
      { normalizeWhitespace: false }
    );
    expect(
      screen.getByRole("button", { name: "#today tag filter is inactive" })
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "@owner tag filter is inactive" })
    ).toBeVisible();

    const naturalDate = screen.getByRole("button", {
      name: "Edit date today"
    });
    const numericDate = screen.getByRole("button", {
      name: "Edit date 07/13/2026"
    });
    expect(naturalDate).toHaveClass("notes-date-token");
    expect(numericDate).toHaveClass("notes-date-token");

    await user.click(numericDate);

    expect(onDateClick).toHaveBeenCalledOnce();
    expect(onDateClick).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: "07/13/2026",
        startUtf16: 22,
        endUtf16: 32
      }),
      numericDate
    );
  });

  it("keeps a resting date pill visible without exposing token interactivity", () => {
    const { container } = render(
      <NoteTokenText
        text="Due 07/12/2026"
        today={today}
        onTagClick={vi.fn()}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Edit date 07/12/2026" })
    ).not.toBeInTheDocument();
    expect(container.querySelector(".notes-date-token")).toHaveTextContent(
      "07/12/2026"
    );
  });
});
