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
    expect(textarea.style.inset).toBe("0px");
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

  it("gives both layers the same metrics class", () => {
    const { presentation, textarea } = renderField("abc");

    expect(presentation.className).toBe("notes-node-title");
    expect(textarea.className).toBe(presentation.className);
  });
});
