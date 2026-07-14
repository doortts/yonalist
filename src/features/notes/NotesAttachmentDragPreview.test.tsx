import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotesAttachmentDragPreview } from "./NotesAttachmentDragPreview";

const originalInnerWidth = Object.getOwnPropertyDescriptor(
  window,
  "innerWidth"
);

afterEach(() => {
  vi.restoreAllMocks();
  if (originalInnerWidth) {
    Object.defineProperty(window, "innerWidth", originalInnerWidth);
  }
});

describe("NotesAttachmentDragPreview", () => {
  it("remeasures and reclamps the filename badge when the viewport resizes", () => {
    render(
      <NotesAttachmentDragPreview
        paths={["/incoming/photo.png"]}
        position={{ x: 180, y: 20 }}
      />
    );
    const preview = screen.getByTestId("notes-attachment-drag-preview");
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      bottom: 0,
      height: 26,
      left: 0,
      right: 0,
      top: 0,
      width: 120,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 200
    });

    act(() => window.dispatchEvent(new Event("resize")));

    expect(preview).toHaveStyle({ left: "72px" });
  });
});
