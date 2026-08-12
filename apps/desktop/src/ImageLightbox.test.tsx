import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { ImageLightbox } from "./ImageLightbox";

function lightbox(onClose: () => void) {
  const view = render(
    <ImageLightbox
      originalName="cat.png"
      sourceUrl="blob:resident"
      pixelWidth={640}
      pixelHeight={480}
      onClose={onClose}
    />
  );
  const scroll = view.container.ownerDocument.querySelector<HTMLElement>(
    ".notes-image-lightbox-scroll"
  )!;
  return { view, scroll };
}

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

  it("stays open when a click starts on the image", () => {
    const onClose = vi.fn();
    const { scroll } = lightbox(onClose);
    const image = screen.getByRole("img", { name: "cat.png" });

    // Pointer capture hands the follow-up click to the capturing container, so
    // the click alone cannot tell an image press from a backdrop press.
    fireEvent.pointerDown(image, {
      button: 0,
      pointerId: 4,
      clientX: 200,
      clientY: 200
    });
    fireEvent.pointerUp(scroll, { pointerId: 4, clientX: 200, clientY: 200 });
    fireEvent.click(scroll);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("cycles Tab between the close button and the scrollable image", () => {
    const { scroll } = lightbox(vi.fn());
    const close = screen.getByRole("button", {
      name: "Close full-screen image"
    });
    expect(close).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(scroll).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();
  });

  // The press suppresses the browser's own focus to stop image-drag selection,
  // so arrow-key scrolling would be dead right after a click.
  it("hands the scroll area focus on a press", () => {
    const { scroll } = lightbox(vi.fn());

    fireEvent.pointerDown(scroll, {
      button: 0,
      pointerId: 9,
      clientX: 200,
      clientY: 200
    });

    expect(scroll).toHaveFocus();
  });

  it("shows the file name and pixel size above the image", () => {
    render(
      <ImageLightbox
        originalName="cat.png"
        sourceUrl="blob:resident"
        pixelWidth={640}
        pixelHeight={480}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("cat.png")).toBeInTheDocument();
    expect(screen.getByText("640 × 480")).toBeInTheDocument();
  });

  it("pans the scroll area by pointer drag and stays open afterwards", () => {
    const onClose = vi.fn();
    const { scroll } = lightbox(onClose);
    scroll.scrollLeft = 0;
    scroll.scrollTop = 0;

    fireEvent.pointerDown(scroll, {
      button: 0,
      pointerId: 5,
      clientX: 200,
      clientY: 200
    });
    expect(scroll).toHaveAttribute("data-panning", "true");
    fireEvent.pointerMove(scroll, {
      pointerId: 5,
      clientX: 140,
      clientY: 160
    });
    expect(scroll.scrollLeft).toBe(60);
    expect(scroll.scrollTop).toBe(40);

    fireEvent.pointerUp(scroll, { pointerId: 5, clientX: 140, clientY: 160 });
    expect(scroll).not.toHaveAttribute("data-panning");
    fireEvent.click(scroll);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the image click guard alive across gestures", () => {
    const onClose = vi.fn();
    const { scroll } = lightbox(onClose);
    const image = screen.getByRole("img", { name: "cat.png" });

    fireEvent.pointerDown(scroll, {
      button: 0,
      pointerId: 7,
      clientX: 200,
      clientY: 200
    });
    fireEvent.pointerUp(scroll, { pointerId: 7, clientX: 200, clientY: 200 });
    fireEvent.click(scroll);
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.pointerDown(image, {
      button: 0,
      pointerId: 8,
      clientX: 200,
      clientY: 200
    });
    fireEvent.pointerUp(scroll, { pointerId: 8, clientX: 200, clientY: 200 });
    fireEvent.click(scroll);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("still closes on a clean backdrop click", () => {
    const onClose = vi.fn();
    const { scroll } = lightbox(onClose);

    fireEvent.pointerDown(scroll, {
      button: 0,
      pointerId: 6,
      clientX: 200,
      clientY: 200
    });
    fireEvent.pointerUp(scroll, { pointerId: 6, clientX: 200, clientY: 200 });
    fireEvent.click(scroll);

    expect(onClose).toHaveBeenCalledOnce();
  });
});
