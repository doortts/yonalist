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

/** jsdom lays nothing out, so the window the fit is measured against is given. */
function sizeWindow(width: number, height: number): void {
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(height);
}

function scaled(pixelWidth: number, pixelHeight: number) {
  render(
    <ImageLightbox
      originalName="cat.png"
      sourceUrl="blob:resident"
      pixelWidth={pixelWidth}
      pixelHeight={pixelHeight}
      onClose={vi.fn()}
    />
  );
  return {
    image: screen.getByRole("img", { name: "cat.png" }),
    zoomIn: screen.getByRole("button", { name: "Zoom in" }),
    zoomOut: screen.getByRole("button", { name: "Zoom out" }),
    rotateRight: screen.getByRole("button", { name: "Rotate right" }),
    rotateLeft: screen.getByRole("button", { name: "Rotate left" })
  };
}

describe("ImageLightbox fit and zoom", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fits a large image inside the window and reports the scale", () => {
    sizeWindow(800, 600);

    const { image } = scaled(640, 905);

    // The height is the binding side: (600 - 48) / 905.
    expect(screen.getByText("640 × 905 · 61%")).toBeInTheDocument();
    expect(image).toHaveStyle({ width: "390px" });
  });

  it("leaves an image smaller than the window at its own size", () => {
    sizeWindow(800, 600);

    const { image, zoomOut } = scaled(120, 80);

    expect(screen.getByText("120 × 80 · 100%")).toBeInTheDocument();
    expect(image).toHaveStyle({ width: "120px" });
    expect(zoomOut).toBeDisabled();
    expect(screen.getByRole("button", { name: "100%" })).toBeDisabled();
  });

  it("steps the scale by ten points and stops at two hundred percent", () => {
    sizeWindow(800, 600);
    const { zoomIn } = scaled(640, 905);

    fireEvent.click(zoomIn);
    expect(screen.getByText("640 × 905 · 71%")).toBeInTheDocument();

    for (let press = 0; press < 20; press += 1) fireEvent.click(zoomIn);

    expect(screen.getByText("640 × 905 · 200%")).toBeInTheDocument();
    expect(zoomIn).toBeDisabled();
  });

  it("turns the image a quarter at a time and refits it", () => {
    sizeWindow(800, 600);
    const { image, rotateRight, rotateLeft } = scaled(640, 905);

    fireEvent.click(rotateRight);

    expect(image).toHaveStyle({
      transform: "translate(-50%, -50%) rotate(90deg)"
    });
    // Lying down, the width binds instead: (800 - 48) / 905.
    expect(screen.getByText("640 × 905 · 83%")).toBeInTheDocument();

    fireEvent.click(rotateLeft);
    fireEvent.click(rotateLeft);

    expect(image).toHaveStyle({
      transform: "translate(-50%, -50%) rotate(270deg)"
    });
  });

  it("swaps between the fitted scale and full size", () => {
    sizeWindow(800, 600);
    scaled(640, 905);

    // The label names the scale the press moves to.
    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    expect(screen.getByText("640 × 905 · 100%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(screen.getByText("640 × 905 · 61%")).toBeInTheDocument();
  });
});

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

  // The trap has to reach the whole control row, and step over the controls
  // the current scale has switched off.
  it("cycles Tab through every live control and back", () => {
    sizeWindow(400, 300);
    const { scroll } = lightbox(vi.fn());
    const close = screen.getByRole("button", {
      name: "Close full-screen image"
    });
    expect(close).toHaveFocus();
    // Zoom out is off at the fitted scale, so the cycle skips it.
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();

    for (const name of ["Rotate left", "Rotate right", "Zoom in", "100%"]) {
      fireEvent.keyDown(document, { key: "Tab" });
      expect(screen.getByRole("button", { name })).toHaveFocus();
    }

    fireEvent.keyDown(document, { key: "Tab" });
    expect(scroll).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();

    vi.restoreAllMocks();
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
    // The scale rides with the pixel size, in the same line.
    expect(screen.getByText("640 × 480 · 100%")).toBeInTheDocument();
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
