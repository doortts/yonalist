import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotesResizableImageFrame } from "./NotesResizableImageFrame";

const resizeCallbacks = new Map<Element, ResizeObserverCallback>();

beforeEach(() => {
  resizeCallbacks.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}

      observe(target: Element) {
        resizeCallbacks.set(target, this.callback);
      }

      unobserve(target: Element) {
        resizeCallbacks.delete(target);
      }

      disconnect() {}
    }
  );
});

afterEach(() => vi.unstubAllGlobals());

function resizeContainer(width: number) {
  const group = screen.getByRole("group", { name: "Image: diagram" });
  act(() =>
    resizeCallbacks.get(group)?.(
      [
        {
          target: group,
          contentRect: { width }
        } as unknown as ResizeObserverEntry
      ],
      {} as ResizeObserver
    )
  );
}

function renderFrame(onCommit = vi.fn()) {
  render(
    <NotesResizableImageFrame
      id="node-1"
      accessibleLabel="diagram"
      sourceUrl="https://example.com/diagram.png"
      sourceStatus="ready"
      intrinsicWidth={640}
      intrinsicHeight={320}
      persistedWidth={320}
      onDisplayWidthCommit={onCommit}
    />
  );
  resizeContainer(500);
  return onCommit;
}

it("previews pointer resizing and commits once on release", () => {
  const onCommit = renderFrame();
  const handle = screen.getByRole("separator", { name: "Resize diagram" });
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(handle, { button: 0, clientX: 320, pointerId: 7 });
  fireEvent.pointerMove(handle, { clientX: 400, pointerId: 7 });
  expect(document.querySelector(".notes-image-attachment-frame")).toHaveStyle({
    width: "400px"
  });
  expect(onCommit).not.toHaveBeenCalled();

  fireEvent.pointerUp(handle, { clientX: 400, pointerId: 7 });
  expect(onCommit).toHaveBeenCalledOnce();
  expect(onCommit).toHaveBeenCalledWith(400);
});

it("restores the persisted target after cancellation and responsive clamping", () => {
  const onCommit = renderFrame();
  const handle = screen.getByRole("separator", { name: "Resize diagram" });
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(handle, { button: 0, clientX: 320, pointerId: 8 });
  fireEvent.pointerMove(handle, { clientX: 400, pointerId: 8 });
  fireEvent.pointerCancel(handle, { pointerId: 8 });
  expect(document.querySelector(".notes-image-attachment-frame")).toHaveStyle({
    width: "320px"
  });

  resizeContainer(240);
  expect(document.querySelector(".notes-image-attachment-frame")).toHaveStyle({
    width: "240px"
  });
  resizeContainer(500);
  expect(document.querySelector(".notes-image-attachment-frame")).toHaveStyle({
    width: "320px"
  });
  expect(onCommit).not.toHaveBeenCalled();
});

it("commits keyboard resizing once on key release", () => {
  const onCommit = renderFrame();
  const handle = screen.getByRole("separator", { name: "Resize diagram" });

  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.keyUp(handle, { key: "ArrowRight" });

  expect(onCommit).toHaveBeenCalledOnce();
  expect(onCommit).toHaveBeenCalledWith(336);
});
