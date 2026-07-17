import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotesSelectionDragPreview } from "./NotesSelectionDragPreview";

describe("NotesSelectionDragPreview", () => {
  it("renders one plain card without a badge", () => {
    render(<NotesSelectionDragPreview labels={["Alpha"]} total={1} />);
    const preview = screen.getByTestId("notes-selection-drag-preview");
    expect(preview).not.toHaveAttribute("data-multiple");
    expect(
      preview.querySelector(".notes-selection-drag-preview-count")
    ).toBeNull();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("marks a multi-item preview and shows the full count", () => {
    render(<NotesSelectionDragPreview labels={["Parent"]} total={4} />);
    const preview = screen.getByTestId("notes-selection-drag-preview");
    expect(preview).toHaveAttribute("data-multiple", "true");
    expect(within(preview).getByText("4")).toHaveClass(
      "notes-selection-drag-preview-count"
    );
  });

  it("renders a decorative non-draggable thumbnail", () => {
    render(
      <NotesSelectionDragPreview
        labels={["diagram.png"]}
        total={1}
        thumbnailSrc="blob:diagram"
      />
    );
    const thumbnail = screen.getByTestId("notes-selection-drag-thumbnail");
    expect(thumbnail).toHaveAttribute("src", "blob:diagram");
    expect(thumbnail).toHaveAttribute("alt", "");
    expect(thumbnail).toHaveAttribute("draggable", "false");
    expect(screen.queryByText("diagram.png")).toBeNull();
  });

  it("falls back to Untitled when no thumbnail or label is ready", () => {
    render(<NotesSelectionDragPreview labels={[""]} total={1} />);

    expect(screen.getByText("Untitled")).toBeInTheDocument();
  });
});
