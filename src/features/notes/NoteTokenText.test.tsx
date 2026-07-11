import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NoteTokenText } from "./NoteTokenText";

describe("NoteTokenText", () => {
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
});
