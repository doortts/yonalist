import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotesRemoteMarkdownImage } from "./NotesRemoteMarkdownImage";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 500,
    height: 0,
    top: 0,
    right: 500,
    bottom: 0,
    left: 0,
    toJSON: () => ({})
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(_callback: ResizeObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("loads an HTTPS image with its natural geometry and persisted width", () => {
  render(
    <NotesRemoteMarkdownImage
      nodeId="node-1"
      alt="Quarterly chart"
      url="https://example.com/chart.png"
      persistedWidth={360}
      onDisplayWidthCommit={vi.fn()}
      onEditRequest={vi.fn()}
    />
  );

  const image = document.querySelector("img")!;
  expect(image).toHaveAttribute("src", "https://example.com/chart.png");
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 720 },
    naturalHeight: { configurable: true, value: 360 }
  });
  fireEvent.load(image);

  expect(
    screen.getByRole("img", { name: "Quarterly chart" })
  ).toBeVisible();
  expect(document.querySelector(".notes-image-attachment-frame")).toHaveStyle({
    width: "360px",
    aspectRatio: "720 / 360"
  });
});

it("shows an editable alt fallback when the remote source fails", () => {
  const onEditRequest = vi.fn();
  render(
    <NotesRemoteMarkdownImage
      nodeId="node-1"
      alt="Quarterly chart"
      url="https://example.com/chart.png"
      persistedWidth={null}
      onDisplayWidthCommit={vi.fn()}
      onEditRequest={onEditRequest}
    />
  );

  fireEvent.error(document.querySelector("img")!);

  expect(screen.getByRole("alert")).toHaveTextContent("Quarterly chart");
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown" }));
  expect(onEditRequest).toHaveBeenCalledOnce();
});

it("keeps a disabled remote image visible without a resize control", () => {
  render(
    <NotesRemoteMarkdownImage
      nodeId="node-1"
      alt=""
      url="https://example.com/chart.png"
      persistedWidth={null}
      disabled
      onDisplayWidthCommit={vi.fn()}
      onEditRequest={vi.fn()}
    />
  );
  const image = document.querySelector("img")!;
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 720 },
    naturalHeight: { configurable: true, value: 360 }
  });
  fireEvent.load(image);

  expect(screen.getByRole("img", { name: "Image" })).toBeVisible();
  expect(screen.queryByRole("separator")).toBeNull();
});
