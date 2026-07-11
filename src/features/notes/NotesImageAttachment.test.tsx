import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NotesImageAttachment,
  type NotesImageAttachmentMetadata
} from "./NotesImageAttachment";

const attachment: NotesImageAttachmentMetadata = {
  id: "attachment-1",
  originalName: "diagram.png",
  mimeType: "image/png",
  intrinsicWidth: 640,
  intrinsicHeight: 320,
  displayWidth: 640
};

const imageBytes = new Uint8Array([137, 80, 78, 71]);
const resizeCallbacks = new Map<Element, ResizeObserverCallback>();
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL"
);
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL"
);
const createObjectURL = vi.fn((_blob: Blob) => "blob:notes-image");
const revokeObjectURL = vi.fn((_url: string) => undefined);

function standardProps(
  overrides: Partial<ComponentProps<typeof NotesImageAttachment>> = {}
): ComponentProps<typeof NotesImageAttachment> {
  return {
    attachment,
    bytes: imageBytes,
    onDisplayWidthCommit: vi.fn(),
    ...overrides
  };
}

function getAttachmentGroup() {
  return screen.getByRole("group", { name: "Image: diagram.png" });
}

function getFrame() {
  return getAttachmentGroup().querySelector<HTMLElement>(
    ".notes-image-attachment-frame"
  )!;
}

function resizeContent(width: number) {
  const group = getAttachmentGroup();
  const callback = resizeCallbacks.get(group);

  expect(callback).toBeDefined();
  act(() =>
    callback?.(
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resizeCallbacks.clear();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

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

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }
  if (originalRevokeObjectURL) {
    Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
  } else {
    Reflect.deleteProperty(URL, "revokeObjectURL");
  }
});

describe("NotesImageAttachment", () => {
  it("caps the persisted width at content and intrinsic bounds while preserving its exact ratio", async () => {
    const view = render(
      <NotesImageAttachment
        {...standardProps({
          attachment: { ...attachment, displayWidth: 800 }
        })}
      />
    );

    resizeContent(480);

    const image = await screen.findByRole("img", { name: "diagram.png" });
    expect(image).toHaveAttribute("src", "blob:notes-image");
    expect(image).toHaveAttribute("width", "640");
    expect(image).toHaveAttribute("height", "320");
    expect(getFrame()).toHaveStyle({
      width: "480px",
      aspectRatio: "640 / 320"
    });

    resizeContent(900);
    expect(getFrame()).toHaveStyle({ width: "640px" });

    view.rerender(
      <NotesImageAttachment
        {...standardProps({
          attachment: {
            ...attachment,
            intrinsicWidth: 100,
            intrinsicHeight: 50,
            displayWidth: 80
          }
        })}
      />
    );
    resizeContent(500);
    expect(getFrame()).toHaveStyle({
      width: "100px",
      aspectRatio: "100 / 50"
    });

    view.rerender(
      <NotesImageAttachment
        {...standardProps({
          attachment: { ...attachment, displayWidth: 80 }
        })}
      />
    );
    resizeContent(120);
    expect(getFrame()).toHaveStyle({ width: "120px" });
    resizeContent(400);
    expect(getFrame()).toHaveStyle({ width: "160px" });
  });

  it("previews pointer resizing with capture and persists exactly once on release", async () => {
    const onDisplayWidthCommit = vi.fn();
    render(
      <NotesImageAttachment
        {...standardProps({
          attachment: { ...attachment, displayWidth: 320 },
          onDisplayWidthCommit
        })}
      />
    );
    resizeContent(500);
    await screen.findByRole("img", { name: "diagram.png" });
    const handle = screen.getByRole("separator", {
      name: "Resize diagram.png"
    });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    handle.setPointerCapture = setPointerCapture;
    handle.releasePointerCapture = releasePointerCapture;

    fireEvent.pointerDown(handle, { button: 0, clientX: 320, pointerId: 7 });
    fireEvent.pointerMove(handle, { clientX: 390, pointerId: 7 });
    fireEvent.pointerMove(handle, { clientX: 560, pointerId: 7 });

    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(getFrame()).toHaveStyle({ width: "500px" });
    expect(handle).toHaveAttribute("aria-valuenow", "500");
    expect(onDisplayWidthCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { clientX: 560, pointerId: 7 });

    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(onDisplayWidthCommit).toHaveBeenCalledOnce();
    expect(onDisplayWidthCommit).toHaveBeenCalledWith(500);
  });

  it("resizes from the accessible handle keyboard contract and commits on key release", async () => {
    const onDisplayWidthCommit = vi.fn();
    render(
      <NotesImageAttachment
        {...standardProps({
          attachment: { ...attachment, displayWidth: 320 },
          onDisplayWidthCommit
        })}
      />
    );
    resizeContent(500);
    const handle = screen.getByRole("separator", {
      name: "Resize diagram.png"
    });

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(getFrame()).toHaveStyle({ width: "336px" });
    expect(onDisplayWidthCommit).not.toHaveBeenCalled();
    fireEvent.keyUp(handle, { key: "ArrowRight" });
    expect(onDisplayWidthCommit).toHaveBeenLastCalledWith(336);

    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyUp(handle, { key: "Home" });
    expect(getFrame()).toHaveStyle({ width: "160px" });
    expect(onDisplayWidthCommit).toHaveBeenLastCalledWith(160);

    fireEvent.keyDown(handle, { key: "End" });
    fireEvent.keyUp(handle, { key: "End" });
    expect(getFrame()).toHaveStyle({ width: "500px" });
    expect(onDisplayWidthCommit).toHaveBeenLastCalledWith(500);
    expect(onDisplayWidthCommit).toHaveBeenCalledTimes(3);
    expect(handle).toHaveAttribute("aria-valuemin", "160");
    expect(handle).toHaveAttribute("aria-valuemax", "500");
  });

  it("clamps on container resize without persisting and restores the persisted target when space returns", () => {
    const onDisplayWidthCommit = vi.fn();
    render(
      <NotesImageAttachment
        {...standardProps({
          attachment: { ...attachment, displayWidth: 480 },
          onDisplayWidthCommit
        })}
      />
    );

    resizeContent(500);
    expect(getFrame()).toHaveStyle({ width: "480px" });
    resizeContent(300);
    expect(getFrame()).toHaveStyle({ width: "300px" });
    resizeContent(600);
    expect(getFrame()).toHaveStyle({ width: "480px" });
    expect(onDisplayWidthCommit).not.toHaveBeenCalled();
  });

  it("creates Blob URLs only from supplied bytes and revokes replaced and unmounted URLs", async () => {
    createObjectURL
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const firstBytes = new Uint8Array([1]);
    const secondBytes = new Uint8Array([2]);
    const view = render(
      <NotesImageAttachment {...standardProps({ bytes: firstBytes })} />
    );

    expect(await screen.findByRole("img", { name: "diagram.png" })).toHaveAttribute(
      "src",
      "blob:first"
    );
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);

    view.rerender(
      <NotesImageAttachment {...standardProps({ bytes: secondBytes })} />
    );
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "diagram.png" })).toHaveAttribute(
        "src",
        "blob:second"
      )
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");

    view.unmount();
    expect(revokeObjectURL).toHaveBeenLastCalledWith("blob:second");
  });

  it("keeps reserved dimensions while a loader is pending and shows a stable error fallback", async () => {
    const pending = deferred<Uint8Array>();
    const view = render(
      <NotesImageAttachment
        {...standardProps({ bytes: undefined, loadBytes: () => pending.promise })}
      />
    );
    resizeContent(480);

    expect(screen.getByRole("status")).toHaveTextContent("Loading image");
    expect(getFrame()).toHaveStyle({
      width: "480px",
      aspectRatio: "640 / 320"
    });

    await act(async () => pending.resolve(imageBytes));
    const image = await screen.findByRole("img", { name: "diagram.png" });
    fireEvent.error(image);
    expect(screen.getByRole("alert")).toHaveTextContent("Image unavailable");
    expect(getFrame()).toHaveStyle({
      width: "480px",
      aspectRatio: "640 / 320"
    });

    const failed = deferred<Uint8Array>();
    view.rerender(
      <NotesImageAttachment
        {...standardProps({ bytes: undefined, loadBytes: () => failed.promise })}
      />
    );
    await act(async () => failed.reject(new Error("read failed")));
    expect(screen.getByRole("alert")).toHaveTextContent("Image unavailable");
  });

  it("offers an accessible icon removal action only when a callback is supplied", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <NotesImageAttachment {...standardProps({ onRemove })} />
    );

    const remove = screen.getByRole("button", { name: "Remove diagram.png" });
    expect(remove).toHaveAttribute("title", "Remove image");
    await user.click(remove);
    expect(onRemove).toHaveBeenCalledOnce();

    view.rerender(<NotesImageAttachment {...standardProps()} />);
    expect(
      screen.queryByRole("button", { name: "Remove diagram.png" })
    ).not.toBeInTheDocument();
  });
});
