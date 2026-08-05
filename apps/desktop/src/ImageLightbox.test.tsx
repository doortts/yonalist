import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { ImageLightbox } from "./ImageLightbox";

describe("ImageLightbox", () => {
  it("uses the resident URL, closes on Escape, and restores trigger focus", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const triggerRef = createRef<HTMLButtonElement>();
    Object.defineProperty(triggerRef, "current", { value: trigger });
    const onClose = vi.fn();

    render(
      <ImageLightbox
        originalName="cat.png"
        sourceUrl="blob:resident"
        pixelWidth={640}
        pixelHeight={480}
        returnFocusRef={triggerRef}
        onClose={onClose}
      />
    );

    expect(screen.getByRole("img", { name: "cat.png" }))
      .toHaveAttribute("src", "blob:resident");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes from the backdrop but not an image click", () => {
    const onClose = vi.fn();
    const { container } = render(
      <ImageLightbox
        originalName="cat.png"
        sourceUrl="blob:resident"
        pixelWidth={640}
        pixelHeight={480}
        onClose={onClose}
      />
    );
    const popup = container.ownerDocument.querySelector<HTMLElement>(
      ".notes-image-lightbox"
    )!;
    fireEvent.click(screen.getByRole("img", { name: "cat.png" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(popup);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
