import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotesTodoProgress } from "./TodoProgressIndicator";

describe("NotesTodoProgress", () => {
  it("renders only the progress line and direct count", () => {
    render(<NotesTodoProgress value={{ completed: 1, total: 3 }} />);

    const progress = screen.getByRole("progressbar", {
      name: "1 of 3 To-dos complete"
    });
    expect(progress).toHaveAttribute("aria-valuemin", "0");
    expect(progress).toHaveAttribute("aria-valuemax", "3");
    expect(progress).toHaveAttribute("aria-valuenow", "1");
    expect(progress).toHaveTextContent("(1/3)");
    expect(progress).not.toHaveAttribute("data-complete");
  });

  it("marks a fully completed group for the green completion style", () => {
    render(<NotesTodoProgress value={{ completed: 2, total: 2 }} />);

    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "data-complete",
      "true"
    );
  });

  it("renders nothing when there are no direct To-dos", () => {
    const { container } = render(<NotesTodoProgress value={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});
