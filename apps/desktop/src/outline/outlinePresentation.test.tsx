import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import {
  parseOutlinePresentation,
  sourceOffsetFromOutlinePresentation,
  type OutlinePresentationToken
} from "./outlinePresentation";
import { OutlineTextField } from "./OutlineTextField";

describe("v2 outline resting presentation", () => {
  it("tokenizes the bounded Markdown, Unicode tag, and ISO date subset losslessly", () => {
    const source =
      "## Read **굵게** ~~취소~~ [문서](https://example.com) #프로젝트 @Person_1 2026-07-28";
    const parsed = parseOutlinePresentation(source);

    expect(parsed.kind).toBe("heading");
    expect(parsed.level).toBe(2);
    expect(parsed.markerEnd).toBe(3);
    expect(parsed.tokens.filter(({ kind }) => kind !== "text")).toEqual([
      expect.objectContaining({ kind: "strong", display: "굵게" }),
      expect.objectContaining({ kind: "strike", display: "취소" }),
      expect.objectContaining({
        kind: "link",
        display: "문서",
        href: "https://example.com"
      }),
      expect.objectContaining({
        kind: "tag",
        display: "#프로젝트",
        prefix: "#",
        normalized: "프로젝트"
      }),
      expect.objectContaining({
        kind: "tag",
        display: "@Person_1",
        prefix: "@",
        normalized: "person_1"
      }),
      expect.objectContaining({ kind: "date", display: "2026-07-28" })
    ]);
    expect(source.slice(parsed.markerEnd) === parsed.tokens.map(
      (token: OutlinePresentationToken) => token.raw
    ).join("")).toBe(true);
  });

  it("keeps malformed or unsafe Markdown as ordinary source text", () => {
    const parsed = parseOutlinePresentation(
      "[bad](javascript:alert(1)) ** open** 2026-02-30"
    );
    expect(parsed.tokens).toEqual([
      expect.objectContaining({
        kind: "text",
        raw: "[bad](javascript:alert(1)) ** open** 2026-02-30"
      })
    ]);
  });

  it("maps rendered UTF-16 offsets across hidden block and inline markers", () => {
    const source = "## 한😀글 **굵게**";
    const parsed = parseOutlinePresentation(source);

    expect(sourceOffsetFromOutlinePresentation(parsed, 0)).toBe(3);
    expect(sourceOffsetFromOutlinePresentation(parsed, 1)).toBe(4);
    expect(sourceOffsetFromOutlinePresentation(parsed, 3)).toBe(6);
    expect(sourceOffsetFromOutlinePresentation(parsed, 5)).toBe(10);
    expect(sourceOffsetFromOutlinePresentation(parsed, 6)).toBe(11);
    expect(sourceOffsetFromOutlinePresentation(parsed, 8)).toBe(source.length);
    expect(sourceOffsetFromOutlinePresentation(parsed, 999)).toBe(source.length);
  });

  it("renders Markdown at rest and restores raw source editing without unmounting textarea", () => {
    const ref = createRef<HTMLTextAreaElement>();
    const onTagClick = vi.fn();
    const source = "## **Launch** #프로젝트 2026-07-28";
    const { container } = render(
      <OutlineTextField
        ref={ref}
        markdown
        className="notes-node-title"
        containerClassName="notes-node-title-field"
        value={source}
        aria-label="Note text"
        onChange={vi.fn()}
        onTagClick={onTagClick}
      />
    );

    const field = container.querySelector(".notes-node-title-field")!;
    const presentation = screen.getByRole("group", { name: "Note text" });
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(field).toHaveAttribute("data-markdown-block", "heading");
    expect(field).toHaveAttribute("data-markdown-level", "2");
    expect(presentation).toHaveTextContent("Launch #프로젝트 2026-07-28");
    expect(presentation).not.toHaveTextContent("##");
    expect(presentation).not.toHaveTextContent("**");
    expect(container.querySelector(".notes-markdown-strong")).toHaveTextContent("Launch");
    expect(container.querySelector(".notes-date-token")).toHaveTextContent("2026-07-28");
    expect(textarea).toHaveValue(source);
    expect(textarea).toHaveStyle({ opacity: "0" });
    expect(textarea).toHaveAttribute("aria-hidden", "true");
    expect(textarea).toHaveAttribute("tabindex", "-1");
    expect(presentation).toHaveAttribute("tabindex", "0");

    fireEvent.click(screen.getByRole("button", {
      name: "#프로젝트 tag filter is inactive"
    }));
    expect(onTagClick).toHaveBeenCalledWith({
      prefix: "#",
      normalized: "프로젝트",
      raw: "#프로젝트"
    });

    fireEvent.pointerDown(presentation, { clientX: 999, clientY: 10 });
    expect(textarea).toHaveFocus();
    expect(container.querySelector("textarea")).toBe(textarea);
    expect(presentation).toHaveTextContent(source, {
      normalizeWhitespace: false
    });
    expect(presentation).toHaveAttribute("aria-hidden", "true");
    expect(textarea).not.toHaveAttribute("aria-hidden");
    expect(textarea.style.color).toBe("transparent");
    expect(textarea.style.caretColor).toBe("var(--notes-stable-caret-color)");

    fireEvent.blur(textarea);
    expect(container.querySelector("textarea")).toBe(textarea);
    expect(presentation).toHaveTextContent("Launch #프로젝트 2026-07-28");
  });

  it("exposes only http and https Markdown links with opener isolation", () => {
    const onOpenExternal = vi.fn();
    const { rerender } = render(
      <OutlineTextField
        markdown
        value="[Docs](https://example.com)"
        aria-label="Safe link"
        onChange={vi.fn()}
        onOpenExternal={onOpenExternal}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open link Docs" }));
    expect(onOpenExternal).toHaveBeenCalledWith("https://example.com");

    rerender(
      <OutlineTextField
        markdown
        value="[Bad](javascript:alert(1)) https://example.org/path"
        aria-label="Unsafe link"
        onChange={vi.fn()}
        onOpenExternal={onOpenExternal}
      />
    );
    expect(screen.queryByRole("button", { name: "Open link Bad" })).toBeNull();
    fireEvent.click(screen.getByRole("button", {
      name: "Open link https://example.org/path"
    }));
    expect(onOpenExternal).toHaveBeenLastCalledWith(
      "https://example.org/path"
    );
  });

  it("keeps supporting-note Markdown source while exposing tags, dates, and raw URLs", () => {
    const onTagClick = vi.fn();
    render(
      <OutlineTextField
        value="**raw** #프로젝트 2026-07-28 https://example.com"
        aria-label="Supporting note"
        onChange={vi.fn()}
        onTagClick={onTagClick}
        onOpenExternal={vi.fn()}
      />
    );

    const presentation = screen.getByRole("group", {
      name: "Supporting note"
    });
    expect(presentation).toHaveTextContent(
      "**raw** #프로젝트 2026-07-28 https://example.com"
    );
    expect(presentation.querySelector(".notes-markdown-strong")).toBeNull();
    expect(screen.getByRole("button", {
      name: "#프로젝트 tag filter is inactive"
    })).toBeVisible();
    expect(screen.getByRole("button", {
      name: "Open link https://example.com"
    })).toBeVisible();
    expect(presentation.querySelector(".notes-date-token")).toHaveTextContent(
      "2026-07-28"
    );
  });
});

describe("caret layer geometry", () => {
  it("stands the caret one pixel before the glyph it belongs to", () => {
    const { container } = render(
      <OutlineTextField
        value="제목에 없는"
        aria-label="Row title"
        onChange={vi.fn()}
      />
    );
    const textarea = container.querySelector("textarea");
    if (textarea === null) throw new Error("no caret layer");
    const px = (value: string) => Number.parseFloat(value);
    const start = px(textarea.style.insetInlineStart);
    const padding = px(textarea.style.paddingInlineStart);

    // The caret sits at the layer's content origin, so the layer -- not the
    // glyphs -- moves: one pixel left puts the caret in the gap before the
    // glyph instead of on its left stem.
    expect(start + padding).toBe(-1);
    // Both edges move by the same pixel, so the content box keeps its width
    // and the two layers still wrap at the same places -- which only holds
    // while the edges, not a `width: 100%` from the row stylesheet, decide it.
    expect(px(textarea.style.insetInlineEnd)).toBe(1);
    expect(textarea.style.width).toBe("auto");
    // The caret's pixel stays inside the layer's own padding, where the row's
    // `overflow: hidden` cannot clip it.
    expect(padding).toBeGreaterThanOrEqual(1);
  });
});
