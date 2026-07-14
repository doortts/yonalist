import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoteTokenText } from "./NoteTokenText";

const openExternalMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("../../services/browser", () => ({
  openExternal: openExternalMock
}));

describe("NoteTokenText", () => {
  const today = { year: 2026, month: 7, day: 11 } as const;

  beforeEach(() => {
    openExternalMock.mockReset();
  });

  it("reconstructs the source text losslessly with textarea whitespace semantics", () => {
    const source = "  Plan\t#Today  \n담당: @수원\n";
    const { container } = render(
      <NoteTokenText text={source} onTagClick={vi.fn()} />
    );

    const presentation = container.querySelector<HTMLElement>(
      ".notes-token-text"
    );
    expect(presentation).not.toBeNull();
    expect(presentation).toHaveTextContent(source, { normalizeWhitespace: false });
    expect(presentation?.style.font).toBe("inherit");
    expect(presentation).toHaveStyle({
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

  it("renders inline formatting spans without altering the source text or tags", () => {
    const source =
      "Do **bold** then *slant* also ~~gone~~ plus `mono` #done at https://ex.com/#f";
    const { container } = render(
      <NoteTokenText text={source} onTagClick={vi.fn()} />
    );

    const presentation = container.querySelector(".notes-token-text");
    // The overlay MUST reproduce the source character-for-character: markers stay
    // in the flow (dimmed) and only the enclosed content is styled.
    expect(presentation).toHaveTextContent(source, { normalizeWhitespace: false });

    // The tag is interactive; so is the trailing URL (formatting spans render as
    // non-interactive styled spans).
    expect(
      screen.getAllByRole("button").map((button) => button.textContent)
    ).toEqual(["#done", "https://ex.com/#f"]);

    expect(
      container.querySelector(".notes-format-strong .notes-format-content")
    ).toHaveTextContent("bold");
    expect(
      container.querySelector(".notes-format-em .notes-format-content")
    ).toHaveTextContent("slant");
    expect(
      container.querySelector(".notes-format-strike .notes-format-content")
    ).toHaveTextContent("gone");
    expect(
      container.querySelector(".notes-format-code .notes-format-content")
    ).toHaveTextContent("mono");

    const markers = Array.from(
      container.querySelectorAll(".notes-format-marker")
    ).map((marker) => marker.textContent);
    expect(markers).toEqual(["**", "**", "*", "*", "~~", "~~", "`", "`"]);
  });

  it("keeps a date that falls inside a formatting span from becoming a pill", () => {
    const onDateClick = vi.fn();
    const source = "**meet today** on 07/13/2026";
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
    // The natural-language date inside the bold span stays styled text (the span
    // renders non-recursively); only the date outside the span is interactive.
    expect(
      screen.queryByRole("button", { name: "Edit date today" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit date 07/13/2026" })
    ).toBeVisible();
    expect(
      container.querySelector(".notes-format-strong .notes-format-content")
    ).toHaveTextContent("meet today");
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

  it("linkifies http and https URLs and opens them externally on click", async () => {
    const user = userEvent.setup();
    const source = "docs at https://example.com/guide#top and http://x.test/a";
    const { container } = render(
      <NoteTokenText text={source} onTagClick={vi.fn()} />
    );

    // The overlay reproduces the source verbatim (the raw URL text stays in the
    // flow, so caret/selection mapping is preserved).
    expect(container.querySelector(".notes-token-text")).toHaveTextContent(
      source,
      { normalizeWhitespace: false }
    );

    const links = screen.getAllByRole("button");
    expect(links.map((button) => button.textContent)).toEqual([
      "https://example.com/guide#top",
      "http://x.test/a"
    ]);
    expect(links[0]).toHaveClass("notes-url-token");

    await user.click(links[0]);

    expect(openExternalMock).toHaveBeenCalledTimes(1);
    expect(openExternalMock).toHaveBeenCalledWith(
      "https://example.com/guide#top"
    );
  });

  it("keeps trimmed trailing punctuation as plain text after a URL", () => {
    const source = "See (https://example.com).";
    const { container } = render(
      <NoteTokenText text={source} onTagClick={vi.fn()} />
    );

    expect(container.querySelector(".notes-token-text")).toHaveTextContent(
      source,
      { normalizeWhitespace: false }
    );
    const link = screen.getByRole("button");
    expect(link).toHaveClass("notes-url-token");
    expect(link).toHaveTextContent("https://example.com");
    expect(link.textContent).toBe("https://example.com");
  });

  it("does not linkify non-http schemes or bare hosts", () => {
    const source =
      "run javascript:alert(1) or email me@example.com or www.example.com";
    render(<NoteTokenText text={source} onTagClick={vi.fn()} />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
