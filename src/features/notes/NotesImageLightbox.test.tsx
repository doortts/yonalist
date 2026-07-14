import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NotesImageLightbox } from "./NotesImageLightbox";

describe("NotesImageLightbox", () => {
  it("shows the resident image in a contained modal and closes by button", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <NotesImageLightbox
        open
        onOpenChange={onOpenChange}
        originalName="diagram.png"
        sourceUrl="blob:resident-image"
        intrinsicWidth={1200}
        intrinsicHeight={600}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "diagram.png" });
    expect(dialog).toHaveClass("notes-image-lightbox");
    expect(screen.getByRole("img", { name: "diagram.png" })).toHaveAttribute(
      "src",
      "blob:resident-image"
    );

    await user.click(screen.getByRole("button", { name: "Close full-screen image" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not render modal content while closed", () => {
    render(
      <NotesImageLightbox
        open={false}
        onOpenChange={vi.fn()}
        originalName="diagram.png"
        sourceUrl="blob:resident-image"
        intrinsicWidth={1200}
        intrinsicHeight={600}
      />
    );

    expect(screen.queryByRole("dialog", { name: "diagram.png" })).toBeNull();
  });
});

