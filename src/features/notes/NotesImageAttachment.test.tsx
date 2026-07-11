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

function getAttachmentGroup(originalName = "diagram.png") {
  return screen.getByRole("group", { name: `Image: ${originalName}` });
}

function getFrame(originalName = "diagram.png") {
  return getAttachmentGroup(originalName).querySelector<HTMLElement>(
    ".notes-image-attachment-frame"
  )!;
}

function resizeContent(width: number, originalName = "diagram.png") {
  const group = getAttachmentGroup(originalName);
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
  it("renders a read-only image without resize or remove controls", async () => {
    const onDisplayWidthCommit = vi.fn();
    const onRemove = vi.fn();
    render(
      <NotesImageAttachment
        {...standardProps({ onDisplayWidthCommit, onRemove })}
        readOnly
      />
    );

    expect(await screen.findByRole("img", { name: "diagram.png" })).toBeVisible();
    expect(
      screen.queryByRole("separator", { name: "Resize diagram.png" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Remove diagram.png" })
    ).toBeNull();
    expect(onDisplayWidthCommit).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });

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

  it("discards a pointer resize on pointercancel and restores persisted width", () => {
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
    const releasePointerCapture = vi.fn();
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = releasePointerCapture;

    fireEvent.pointerDown(handle, { button: 0, clientX: 320, pointerId: 8 });
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 8 });
    expect(getFrame()).toHaveStyle({ width: "400px" });

    fireEvent.pointerCancel(handle, { clientX: 400, pointerId: 8 });

    expect(releasePointerCapture).toHaveBeenCalledWith(8);
    expect(getFrame()).toHaveStyle({ width: "320px" });
    expect(handle).toHaveAttribute("aria-valuenow", "320");
    expect(onDisplayWidthCommit).not.toHaveBeenCalled();
  });

  it("cancels pointer and keyboard interactions across attachment, loader, and unmount boundaries", async () => {
    const firstCommit = vi.fn();
    const secondCommit = vi.fn();
    const thirdCommit = vi.fn();
    const firstLoader = vi.fn(async () => imageBytes);
    const secondLoader = vi.fn(async () => imageBytes);
    const thirdLoader = vi.fn(async () => imageBytes);
    const view = render(
      <NotesImageAttachment
        {...standardProps({
          attachment: { ...attachment, displayWidth: 320 },
          bytes: undefined,
          loadBytes: firstLoader,
          onDisplayWidthCommit: firstCommit
        })}
      />
    );
    resizeContent(500);
    const retainedHandle = screen.getByRole("separator", {
      name: "Resize diagram.png"
    });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    retainedHandle.setPointerCapture = setPointerCapture;
    retainedHandle.releasePointerCapture = releasePointerCapture;

    fireEvent.pointerDown(retainedHandle, {
      button: 0,
      clientX: 320,
      pointerId: 11
    });
    fireEvent.pointerMove(retainedHandle, { clientX: 380, pointerId: 11 });
    view.rerender(
      <NotesImageAttachment
        {...standardProps({
          attachment: {
            ...attachment,
            id: "attachment-2",
            originalName: "replacement.png",
            displayWidth: 280
          },
          bytes: undefined,
          loadBytes: secondLoader,
          onDisplayWidthCommit: secondCommit
        })}
      />
    );
    fireEvent.pointerUp(retainedHandle, { clientX: 380, pointerId: 11 });

    expect(releasePointerCapture).toHaveBeenCalledWith(11);
    expect(firstCommit).not.toHaveBeenCalled();
    expect(secondCommit).not.toHaveBeenCalled();
    expect(getFrame("replacement.png")).toHaveStyle({ width: "280px" });

    const replacementHandle = screen.getByRole("separator", {
      name: "Resize replacement.png"
    });
    fireEvent.keyDown(replacementHandle, { key: "ArrowRight" });
    view.rerender(
      <NotesImageAttachment
        {...standardProps({
          attachment: {
            ...attachment,
            id: "attachment-2",
            originalName: "replacement.png",
            displayWidth: 280
          },
          bytes: undefined,
          loadBytes: thirdLoader,
          onDisplayWidthCommit: thirdCommit
        })}
      />
    );
    fireEvent.keyUp(replacementHandle, { key: "ArrowRight" });

    expect(secondCommit).not.toHaveBeenCalled();
    expect(thirdCommit).not.toHaveBeenCalled();
    expect(getFrame("replacement.png")).toHaveStyle({ width: "280px" });

    fireEvent.pointerDown(replacementHandle, {
      button: 0,
      clientX: 280,
      pointerId: 12
    });
    view.unmount();
    fireEvent.pointerUp(retainedHandle, { clientX: 340, pointerId: 12 });
    expect(releasePointerCapture).toHaveBeenCalledWith(12);
    expect(thirdCommit).not.toHaveBeenCalled();
  });

  it("cancels a pointer interaction when its commit callback owner changes", () => {
    const firstCommit = vi.fn();
    const replacementCommit = vi.fn();
    const view = render(
      <NotesImageAttachment
        {...standardProps({
          attachment: { ...attachment, displayWidth: 320 },
          onDisplayWidthCommit: firstCommit
        })}
      />
    );
    resizeContent(500);
    const retainedHandle = screen.getByRole("separator", {
      name: "Resize diagram.png"
    });
    const releasePointerCapture = vi.fn();
    retainedHandle.setPointerCapture = vi.fn();
    retainedHandle.releasePointerCapture = releasePointerCapture;

    fireEvent.pointerDown(retainedHandle, {
      button: 0,
      clientX: 320,
      pointerId: 13
    });
    fireEvent.pointerMove(retainedHandle, { clientX: 380, pointerId: 13 });
    view.rerender(
      <NotesImageAttachment
        {...standardProps({
          attachment: { ...attachment, displayWidth: 320 },
          onDisplayWidthCommit: replacementCommit
        })}
      />
    );
    fireEvent.pointerUp(retainedHandle, { clientX: 380, pointerId: 13 });

    expect(releasePointerCapture).toHaveBeenCalledWith(13);
    expect(firstCommit).not.toHaveBeenCalled();
    expect(replacementCommit).not.toHaveBeenCalled();
    expect(getFrame()).toHaveStyle({ width: "320px" });
  });

  it("cancels a keyboard interaction when its commit callback owner changes", () => {
    const firstCommit = vi.fn();
    const replacementCommit = vi.fn();
    const view = render(
      <NotesImageAttachment
        {...standardProps({
          attachment: { ...attachment, displayWidth: 320 },
          onDisplayWidthCommit: firstCommit
        })}
      />
    );
    resizeContent(500);
    const retainedHandle = screen.getByRole("separator", {
      name: "Resize diagram.png"
    });

    fireEvent.keyDown(retainedHandle, { key: "ArrowRight" });
    view.rerender(
      <NotesImageAttachment
        {...standardProps({
          attachment: { ...attachment, displayWidth: 320 },
          onDisplayWidthCommit: replacementCommit
        })}
      />
    );
    fireEvent.keyUp(retainedHandle, { key: "ArrowRight" });

    expect(firstCommit).not.toHaveBeenCalled();
    expect(replacementCommit).not.toHaveBeenCalled();
    expect(getFrame()).toHaveStyle({ width: "320px" });
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

  it("collapses deterministically at zero content width and clamps at a tiny positive width", () => {
    const onDisplayWidthCommit = vi.fn();
    render(
      <NotesImageAttachment
        {...standardProps({
          attachment: { ...attachment, displayWidth: 320 },
          onDisplayWidthCommit
        })}
      />
    );
    const handle = screen.getByRole("separator", {
      name: "Resize diagram.png"
    });
    const setPointerCapture = vi.fn();
    handle.setPointerCapture = setPointerCapture;
    handle.releasePointerCapture = vi.fn();

    resizeContent(0);
    expect(getFrame()).toHaveStyle({
      width: "0px",
      aspectRatio: "640 / 320"
    });
    expect(handle).toHaveAttribute("aria-valuemin", "0");
    expect(handle).toHaveAttribute("aria-valuemax", "0");
    expect(handle).toHaveAttribute("aria-valuenow", "0");
    expect(handle).toHaveAttribute("aria-disabled", "true");
    expect(handle).toHaveAttribute("tabindex", "-1");

    fireEvent.pointerDown(handle, { button: 0, clientX: 0, pointerId: 21 });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyUp(handle, { key: "ArrowRight" });
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(onDisplayWidthCommit).not.toHaveBeenCalled();

    resizeContent(48.8);
    expect(getFrame()).toHaveStyle({
      width: "48px",
      aspectRatio: "640 / 320"
    });
    expect(handle).toHaveAttribute("aria-valuemin", "48");
    expect(handle).toHaveAttribute("aria-valuemax", "48");
    expect(handle).toHaveAttribute("aria-valuenow", "48");
    expect(handle).toHaveAttribute("aria-disabled", "false");
    expect(onDisplayWidthCommit).not.toHaveBeenCalled();
  });

  it("does not turn a pointer-only container collapse into a persisted zero width", () => {
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
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { button: 0, clientX: 320, pointerId: 22 });
    resizeContent(0);
    expect(getFrame()).toHaveStyle({ width: "0px" });
    fireEvent.pointerUp(handle, { clientX: 320, pointerId: 22 });

    expect(onDisplayWidthCommit).not.toHaveBeenCalled();
  });

  it("cancels a pointer proposal when responsive rendering collapses", () => {
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
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { button: 0, clientX: 320, pointerId: 23 });
    resizeContent(0);
    fireEvent.pointerMove(handle, { clientX: 380, pointerId: 23 });
    expect(getFrame()).toHaveStyle({ width: "0px" });
    resizeContent(500);
    expect(getFrame()).toHaveStyle({ width: "320px" });
    fireEvent.pointerUp(handle, { clientX: 380, pointerId: 23 });

    expect(onDisplayWidthCommit).not.toHaveBeenCalled();
  });

  it("does not persist zero when responsive collapse follows a keyboard proposal", () => {
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
    resizeContent(0);
    fireEvent.keyUp(handle, { key: "ArrowRight" });

    expect(getFrame()).toHaveStyle({ width: "0px" });
    expect(onDisplayWidthCommit).not.toHaveBeenCalled();
    resizeContent(500);
    expect(getFrame()).toHaveStyle({ width: "320px" });
  });

  it("cancels a pointer resize when positive content width shrinks", () => {
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
    const releasePointerCapture = vi.fn();
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = releasePointerCapture;

    fireEvent.pointerDown(handle, { button: 0, clientX: 320, pointerId: 25 });
    fireEvent.pointerMove(handle, { clientX: 336, pointerId: 25 });
    expect(getFrame()).toHaveStyle({ width: "336px" });
    resizeContent(250);

    expect(releasePointerCapture).toHaveBeenCalledWith(25);
    expect(getFrame()).toHaveStyle({ width: "250px" });
    fireEvent.pointerUp(handle, { clientX: 336, pointerId: 25 });
    expect(onDisplayWidthCommit).not.toHaveBeenCalled();
  });

  it("cancels a keyboard resize when positive content width shrinks", () => {
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
    resizeContent(250);
    expect(getFrame()).toHaveStyle({ width: "250px" });
    fireEvent.keyUp(handle, { key: "ArrowRight" });

    expect(onDisplayWidthCommit).not.toHaveBeenCalled();
  });

  it.each([
    ["changes", 400, 200],
    ["becomes invalid", 0, 200]
  ])(
    "cancels and releases an active pointer interaction when intrinsic geometry %s",
    async (_caseName, intrinsicWidth, intrinsicHeight) => {
      const onDisplayWidthCommit = vi.fn();
      const view = render(
        <NotesImageAttachment
          {...standardProps({
            attachment: { ...attachment, displayWidth: 300 },
            onDisplayWidthCommit
          })}
        />
      );
      resizeContent(500);
      await screen.findByRole("img", { name: "diagram.png" });
      const retainedHandle = screen.getByRole("separator", {
        name: "Resize diagram.png"
      });
      const releasePointerCapture = vi.fn();
      retainedHandle.setPointerCapture = vi.fn();
      retainedHandle.releasePointerCapture = releasePointerCapture;

      fireEvent.pointerDown(retainedHandle, {
        button: 0,
        clientX: 300,
        pointerId: 24
      });
      fireEvent.pointerMove(retainedHandle, { clientX: 350, pointerId: 24 });
      view.rerender(
        <NotesImageAttachment
          {...standardProps({
            attachment: {
              ...attachment,
              displayWidth: 300,
              intrinsicWidth,
              intrinsicHeight
            },
            onDisplayWidthCommit
          })}
        />
      );

      expect(releasePointerCapture).toHaveBeenCalledWith(24);
      fireEvent.pointerUp(retainedHandle, { clientX: 350, pointerId: 24 });
      expect(onDisplayWidthCommit).not.toHaveBeenCalled();
    }
  );

  it("does not commit a pointer resize that returns to its clamped starting width", () => {
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
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { button: 0, clientX: 320, pointerId: 31 });
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 31 });
    fireEvent.pointerMove(handle, { clientX: 320, pointerId: 31 });
    fireEvent.pointerUp(handle, { clientX: 320, pointerId: 31 });

    expect(getFrame()).toHaveStyle({ width: "320px" });
    expect(onDisplayWidthCommit).not.toHaveBeenCalled();
  });

  it("does not commit a keyboard resize that returns to its clamped starting width", () => {
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
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyUp(handle, { key: "ArrowLeft" });

    expect(getFrame()).toHaveStyle({ width: "320px" });
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

  it.each([
    ["zero width", 0, 320],
    ["nonfinite width", Number.POSITIVE_INFINITY, 320],
    ["zero height", 640, 0],
    ["nonfinite height", 640, Number.NaN]
  ])(
    "renders %s metadata as an immediate stable error without image geometry",
    async (_caseName, intrinsicWidth, intrinsicHeight) => {
      const view = render(
        <NotesImageAttachment
          {...standardProps({
            attachment: {
              ...attachment,
              intrinsicWidth,
              intrinsicHeight
            }
          })}
        />
      );

      expect(screen.getByRole("alert")).toHaveTextContent("Image unavailable");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(screen.queryByRole("separator")).not.toBeInTheDocument();
      expect(getFrame()).toHaveStyle({ width: "100%", minHeight: "96px" });
      expect(getFrame().style.aspectRatio).toBe("");
      expect(createObjectURL).not.toHaveBeenCalled();

      view.rerender(
        <NotesImageAttachment
          {...standardProps({ attachment: { ...attachment } })}
        />
      );
      expect(await screen.findByRole("img", { name: "diagram.png" })).toHaveAttribute(
        "width",
        "640"
      );
    }
  );

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
