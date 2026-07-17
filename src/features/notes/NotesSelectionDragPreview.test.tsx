import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotesSelectionDragPreview } from "./NotesSelectionDragPreview";

describe("NotesSelectionDragPreview", () => {
  it("shows only the first title and the full selected count", () => {
    render(
      <NotesSelectionDragPreview
        labels={["Alpha", "Bravo", "Charlie", "Delta"]}
        total={4}
      />
    );

    const preview = screen.getByTestId("notes-selection-drag-preview");
    expect(preview).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Bravo")).not.toBeInTheDocument();
    expect(screen.queryByText("Charlie")).not.toBeInTheDocument();
    expect(screen.queryByText("Delta")).not.toBeInTheDocument();
    expect(screen.getByText("4")).toHaveClass(
      "notes-selection-drag-preview-count"
    );
    expect(screen.queryByText("4 selected")).not.toBeInTheDocument();
  });

  it("uses Untitled for an empty presentation label", () => {
    render(<NotesSelectionDragPreview labels={[""]} total={1} />);

    expect(screen.getByText("Untitled")).toBeInTheDocument();
  });
});
