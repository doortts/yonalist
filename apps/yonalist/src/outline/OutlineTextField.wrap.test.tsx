import { fireEvent, render, screen } from "@testing-library/react";
import { OutlineTextField } from "./OutlineTextField";

function renderField(value: string) {
  const { container } = render(
    <OutlineTextField
      className="notes-node-title"
      containerClassName="notes-node-title-field"
      value={value}
      aria-label="Note text"
      onChange={vi.fn()}
    />
  );
  return {
    presentation: screen.getByRole("group", { name: "Note text" }),
    textarea: container.querySelector<HTMLTextAreaElement>("textarea")!
  };
}

describe("v2 outline text wrapping", () => {
  it("keeps the wrapping presentation in flow and floats the textarea over it", () => {
    const { presentation, textarea } = renderField("긴 문장이 여러 줄로 접힙니다");

    expect(presentation.style.position).toBe("");
    expect(presentation.style.inset).toBe("");
    expect(presentation.style.whiteSpace).toBe("pre-wrap");
    expect(presentation.style.overflowWrap).toBe("anywhere");
    expect(textarea.style.position).toBe("absolute");
    expect(textarea.style.insetBlock).toBe("0px");
    // Both inline edges lead the presentation by the caret's own pixel, which
    // leaves the content box the width the glyphs wrap at.
    expect(textarea.style.insetInlineStart).toBe("-3px");
    expect(textarea.style.insetInlineEnd).toBe("1px");
    expect(textarea.style.paddingInlineStart).toBe("2px");
    expect(textarea.style.whiteSpace).toBe("pre-wrap");
    expect(textarea.style.overflowWrap).toBe("anywhere");
  });

  it("mirrors a trailing newline so resting and editing heights match", () => {
    const { presentation, textarea } = renderField("abc\n");

    expect(presentation.textContent).toBe("abc\n​");
    fireEvent.focus(textarea);
    expect(presentation.textContent).toBe("abc\n​");
  });

  it("leaves text without a trailing newline untouched", () => {
    const { presentation } = renderField("abc");

    expect(presentation.textContent).toBe("abc");
  });

  it("wraps a long link inside the row line boxes instead of its own centered box", () => {
    render(
      <OutlineTextField
        value="https://example.com/j/95078260144?pwd=NOaaLNOb54IHaoW3ot4rT7bb0bi2jq.1"
        aria-label="Note text"
        onChange={vi.fn()}
        onOpenExternal={vi.fn()}
      />
    );
    const link = screen.getByRole("button", { name: /^Open link/ });
    const linkStyle = getComputedStyle(link);

    expect(linkStyle.display).toBe("inline");
    expect(linkStyle.textAlign).not.toBe("center");
  });

  it("keeps the link keyboard-openable without a button element", () => {
    const onOpenExternal = vi.fn();
    render(
      <OutlineTextField
        value="https://example.com/docs"
        aria-label="Note text"
        onChange={vi.fn()}
        onOpenExternal={onOpenExternal}
      />
    );
    const link = screen.getByRole("button", { name: /^Open link/ });

    fireEvent.keyDown(link, { key: "Enter" });
    expect(onOpenExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("gives both layers the same metrics class", () => {
    const { presentation, textarea } = renderField("abc");

    expect(presentation.className).toBe("notes-node-title");
    expect(textarea.className).toBe(presentation.className);
  });
});
