import { readFileSync } from "node:fs";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  StrictMode,
  useLayoutEffect,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppNavigationContext } from "../../AppNavigationContext";
import type { NoteAttachment } from "../../domain/notes";
import {
  NotesImageAttachment,
  NotesImageNodeContent,
  type NotesImageAttachmentMetadata
} from "./NotesImageAttachment";
import { NotesImageResidencyProvider } from "./NotesImageResidencyContext";

const workspaceActions = vi.hoisted(() => ({
  loadAttachmentBytes: vi.fn(),
  resizeImage: vi.fn(),
  viewImageOriginal: vi.fn(),
  downloadImage: vi.fn(),
  deleteNode: vi.fn()
}));

vi.mock("./NotesWorkspaceContext", () => ({
  useNotesActions: () => ({ actions: workspaceActions })
}));

const attachment: NotesImageAttachmentMetadata = {
  id: "attachment-1",
  originalName: "diagram.png",
  mimeType: "image/png",
  intrinsicWidth: 640,
  intrinsicHeight: 320,
  displayWidth: 640
};

const imageBytes = new Uint8Array([137, 80, 78, 71]);
const imageNodeAttachment: NoteAttachment = {
  ...attachment,
  mimeType: "image/png",
  nodeId: "image-node",
  sortKey: 1024,
  relativePath: `notes-assets/${"a".repeat(64)}.png`,
  contentHash: "a".repeat(64),
  byteSize: imageBytes.byteLength,
  createdAt: "2026-07-14T00:00:00Z",
  updatedAt: "2026-07-14T00:00:00Z"
};
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
const notesCss = readFileSync("src/features/notes/notes.css", "utf8");

function ResolveOnLayout({ run }: { readonly run: () => void }) {
  useLayoutEffect(run, [run]);
  return null;
}

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

function getImageNodeGroup(originalName = imageNodeAttachment.originalName) {
  return screen.getByRole("group", { name: `Image: ${originalName}` });
}

function expectNoVisibleFilename(originalName = imageNodeAttachment.originalName) {
  expect(document.body).not.toHaveTextContent(originalName);
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
  workspaceActions.loadAttachmentBytes.mockReset();
  workspaceActions.resizeImage.mockReset();
  workspaceActions.viewImageOriginal.mockReset();
  workspaceActions.downloadImage.mockReset();
  workspaceActions.deleteNode.mockReset();
  workspaceActions.loadAttachmentBytes.mockResolvedValue(imageBytes);
  workspaceActions.deleteNode.mockResolvedValue("applied");
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
  it("keeps inactive image actions pointer-active without moving the placeholder layout", () => {
    const triggerRule = notesCss.match(
      /\.notes-image-menu-trigger\s*\{([\s\S]*?)\}/
    )?.[1];

    expect(triggerRule).toContain("position: absolute");
    expect(notesCss).toContain(
      ".notes-image-attachment-placeholder:hover .notes-image-menu-trigger"
    );
    expect(notesCss).toContain(
      ".notes-image-attachment-placeholder:focus-within .notes-image-menu-trigger"
    );
    expect(notesCss).toContain(
      ".notes-image-node-content:focus .notes-image-menu-trigger"
    );
    expect(notesCss).toMatch(
      /\.notes-image-node-content:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\);/
    );
    expect(notesCss).toMatch(
      /\.notes-image-menu-trigger\[data-popup-open\][^{]*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/
    );
    expect(notesCss).toMatch(
      /@media \(pointer: coarse\)[\s\S]*?\.notes-image-menu-trigger\s*\{[^}]*pointer-events:\s*auto;/
    );
  });

  it("opens inactive image-node actions from focus without loading bytes", async () => {
    const user = userEvent.setup();
    const openSettings = vi.fn();
    render(
      <AppNavigationContext.Provider value={{ openSettings }}>
        <NotesImageResidencyProvider scopeKey="inactive-image-node-menu-test">
          <NotesImageNodeContent
            nodeId="image-node"
            attachment={imageNodeAttachment}
          />
        </NotesImageResidencyProvider>
      </AppNavigationContext.Provider>
    );

    const content = getImageNodeGroup();
    const placeholder = content.querySelector<HTMLElement>(
      ".notes-image-attachment-placeholder"
    );
    const trigger = within(content).getByRole("button", {
      name: "Image actions for diagram.png"
    });

    expect(placeholder).toContainElement(trigger);
    fireEvent.mouseEnter(placeholder!);
    act(() => trigger.focus());
    expect(trigger).toHaveFocus();

    await user.keyboard("{Enter}");

    expect(workspaceActions.loadAttachmentBytes).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: "Show full-screen" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    for (const name of ["View original", "Download", "Settings"]) {
      expect(screen.getByRole("menuitem", { name })).not.toHaveAttribute(
        "aria-disabled",
        "true"
      );
    }

    await user.click(screen.getByRole("menuitem", { name: "View original" }));
    expect(workspaceActions.viewImageOriginal).toHaveBeenCalledWith(
      imageNodeAttachment.id
    );
    expect(workspaceActions.loadAttachmentBytes).not.toHaveBeenCalled();
  });

  it("exposes an image-node filename to assistive tech without visible filename text", async () => {
    const user = userEvent.setup();
    const pendingLoad = deferred<Uint8Array>();
    workspaceActions.loadAttachmentBytes.mockReturnValueOnce(pendingLoad.promise);
    render(
      <NotesImageResidencyProvider scopeKey="image-node-label-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
        />
      </NotesImageResidencyProvider>
    );

    const content = getImageNodeGroup();
    const loadButton = within(content).getByRole("button", {
      name: "Load image diagram.png"
    });
    expect(loadButton).toBeVisible();
    expect(loadButton).toHaveTextContent("Load image");
    expectNoVisibleFilename();

    await user.click(loadButton);
    expect(
      await within(content).findByRole("status", {
        name: "Loading image diagram.png"
      })
    ).toHaveTextContent("Loading image");
    expectNoVisibleFilename();

    await act(async () => pendingLoad.resolve(imageBytes));
    expect(
      await within(content).findByRole("img", { name: "diagram.png" })
    ).toBeVisible();
    expect(
      within(content).getByRole("separator", { name: "Resize diagram.png" })
    ).toBeVisible();
    await user.click(
      within(content).getByRole("button", {
        name: "Image actions for diagram.png"
      })
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Show full-screen" })
    );

    const dialog = screen.getByRole("dialog", { name: "diagram.png" });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole("img", { name: "diagram.png" })).toBeVisible();
    expectNoVisibleFilename();
  });

  it("keeps image-node load failures visually generic while exposing the filename to assistive tech", async () => {
    const user = userEvent.setup();
    workspaceActions.loadAttachmentBytes.mockRejectedValueOnce(
      new Error("missing bytes")
    );
    render(
      <NotesImageResidencyProvider scopeKey="image-node-missing-label-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
        />
      </NotesImageResidencyProvider>
    );

    const content = getImageNodeGroup();
    await user.click(
      within(content).getByRole("button", { name: "Load image diagram.png" })
    );

    const alert = await within(content).findByRole("alert", {
      name: "Image unavailable: diagram.png"
    });
    expect(alert).toHaveTextContent("Image unavailable");
    expectNoVisibleFilename();
  });

  it("keeps missing image-node content focusable without exposing filename text", () => {
    const onKeyDown = vi.fn();
    render(
      <NotesImageResidencyProvider scopeKey="image-node-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={undefined}
          onKeyDown={onKeyDown}
        />
      </NotesImageResidencyProvider>
    );

    const content = screen.getByRole("group", { name: "Image" });
    expect(content).toHaveAttribute("tabindex", "0");
    expect(within(content).getByRole("alert")).toHaveTextContent(
      "Image unavailable"
    );
    expect(content).not.toHaveTextContent("missing-diagram.png");

    fireEvent.focus(content);
    fireEvent.mouseEnter(content);
    fireEvent.keyDown(content, { key: "Enter" });

    expect(onKeyDown).toHaveBeenCalledOnce();
    expect(workspaceActions.loadAttachmentBytes).not.toHaveBeenCalled();
  });

  it("claims image-only Alt+Arrow structural shortcuts even when no move is available", () => {
    const onKeyDown = vi.fn();
    render(
      <NotesImageResidencyProvider scopeKey="image-node-boundary-shortcut-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={undefined}
          onKeyDown={onKeyDown}
        />
      </NotesImageResidencyProvider>
    );

    const content = screen.getByRole("group", { name: "Image" });

    expect(
      fireEvent.keyDown(content, { key: "ArrowLeft", altKey: true })
    ).toBe(false);
    expect(onKeyDown).toHaveBeenCalledOnce();
  });

  it("disables every nested image-node control while the node is disabled", () => {
    const { rerender } = render(
      <NotesImageResidencyProvider scopeKey="disabled-image-node-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
          disabled
        />
      </NotesImageResidencyProvider>
    );

    const content = getImageNodeGroup();
    expect(content).toHaveAttribute("aria-disabled", "true");
    expect(
      within(content).getByRole("button", { name: "Load image diagram.png" })
    ).toBeDisabled();
    expect(
      within(content).getByRole("button", {
        name: "Image actions for diagram.png"
      })
    ).toBeDisabled();

    rerender(
      <NotesImageResidencyProvider scopeKey="disabled-missing-image-node-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={undefined}
          originalName="missing.png"
          disabled
        />
      </NotesImageResidencyProvider>
    );

    expect(
      screen.getByRole("group", { name: "Image: missing.png" })
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("button", { name: "Image actions for missing.png" })
    ).toBeDisabled();
  });

  it("stops forwarding structural and history keys when a focused image node becomes disabled", () => {
    const onKeyDown = vi.fn();
    const view = render(
      <NotesImageResidencyProvider scopeKey="disabled-focused-image-node-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
          onKeyDown={onKeyDown}
        />
      </NotesImageResidencyProvider>
    );

    const content = getImageNodeGroup();
    content.focus();
    expect(content).toHaveFocus();

    view.rerender(
      <NotesImageResidencyProvider scopeKey="disabled-focused-image-node-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
          onKeyDown={onKeyDown}
          disabled
        />
      </NotesImageResidencyProvider>
    );

    expect(content).toHaveFocus();
    fireEvent.keyDown(content, { key: "Enter" });
    fireEvent.keyDown(content, { key: "z", metaKey: true });

    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it.each([
    ["Tab", false],
    ["Shift+Tab", true]
  ] as const)("keeps %s native in image-node content", (_name, shiftKey) => {
    const onKeyDown = vi.fn();
    render(
      <NotesImageResidencyProvider scopeKey={`image-node-tab-${shiftKey}`}>
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
          onKeyDown={onKeyDown}
        />
      </NotesImageResidencyProvider>
    );

    const content = getImageNodeGroup();
    content.focus();

    expect(fireEvent.keyDown(content, { key: "Tab", shiftKey })).toBe(true);
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("clears stale image-action retry controls when an image node becomes disabled", async () => {
    const user = userEvent.setup();
    workspaceActions.viewImageOriginal.mockRejectedValueOnce(
      new Error("action failed")
    );
    const view = render(
      <NotesImageResidencyProvider scopeKey="disabled-image-action-error-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
        />
      </NotesImageResidencyProvider>
    );

    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );
    await user.click(screen.getByRole("menuitem", { name: "View original" }));
    const alert = await screen.findByRole("alert", {
      name: "Image action failed"
    });
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();

    view.rerender(
      <NotesImageResidencyProvider scopeKey="disabled-image-action-error-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
          disabled
        />
      </NotesImageResidencyProvider>
    );

    expect(
      screen.queryByRole("alert", { name: "Image action failed" })
    ).toBeNull();
    expect(workspaceActions.viewImageOriginal).toHaveBeenCalledOnce();

    view.rerender(
      <NotesImageResidencyProvider scopeKey="disabled-image-action-error-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
        />
      </NotesImageResidencyProvider>
    );

    expect(
      screen.queryByRole("alert", { name: "Image action failed" })
    ).toBeNull();
    expect(workspaceActions.viewImageOriginal).toHaveBeenCalledOnce();
  });

  it("disables active image controls and resizing without treating read-only as disabled", () => {
    const view = render(
      <NotesImageAttachment {...standardProps()} disabled />
    );

    expect(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    ).toBeDisabled();
    expect(screen.queryByRole("separator", { name: "Resize diagram.png" })).toBeNull();

    view.rerender(<NotesImageAttachment {...standardProps()} readOnly />);

    expect(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    ).toBeEnabled();
  });

  it("keeps recovery settings but no ambiguous image-removal action when an image node has no attachment", async () => {
    const user = userEvent.setup();
    const openSettings = vi.fn();
    render(
      <AppNavigationContext.Provider value={{ openSettings }}>
        <NotesImageResidencyProvider scopeKey="missing-image-node-test">
          <NotesImageNodeContent
            nodeId="image-node"
            attachment={undefined}
          />
        </NotesImageResidencyProvider>
      </AppNavigationContext.Provider>
    );

    await user.click(
      screen.getByRole("button", {
        name: "Image actions"
      })
    );

    for (const name of ["Show full-screen", "View original", "Download"]) {
      expect(screen.getByRole("menuitem", { name })).toHaveAttribute(
        "aria-disabled",
        "true"
      );
    }
    expect(screen.queryByRole("menuitem", { name: "Remove image" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    expect(workspaceActions.deleteNode).not.toHaveBeenCalled();

    await user.click(screen.getByRole("menuitem", { name: "Settings" }));

    expect(openSettings).toHaveBeenCalledOnce();
    expect(openSettings).toHaveBeenCalledWith("notes", "images");
  });

  it("does not load a resident-managed image merely because primary content receives focus", () => {
    render(
      <NotesImageResidencyProvider scopeKey="image-node-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
        />
      </NotesImageResidencyProvider>
    );

    const content = getImageNodeGroup();
    fireEvent.focus(content);
    fireEvent.mouseEnter(content);

    expect(
      within(content).getByRole("button", { name: "Load image diagram.png" })
    ).toBeVisible();
    expect(workspaceActions.loadAttachmentBytes).not.toHaveBeenCalled();
  });

  it("preserves the exact persisted geometry for an inactive panoramic image node", () => {
    render(
      <NotesImageResidencyProvider scopeKey="image-node-placeholder-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={{
            ...imageNodeAttachment,
            displayWidth: 280,
            intrinsicWidth: 1_200,
            intrinsicHeight: 120
          }}
        />
      </NotesImageResidencyProvider>
    );

    const placeholder = screen
      .getByRole("group", { name: "Image: diagram.png" })
      .querySelector<HTMLElement>(".notes-image-attachment-placeholder");
    expect(placeholder).toHaveStyle({
      width: "280px",
      minHeight: "0",
      aspectRatio: "1200 / 120"
    });
  });

  it("reports the actual frame width across a sub-minimum resident swap and narrow reflow", async () => {
    const onFrameInlineSizeChange = vi.fn();
    const getBoundingClientRect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const width = this.classList.contains("notes-image-attachment-placeholder")
          ? 80
          : this.classList.contains("notes-image-attachment-frame")
            ? Number.parseFloat(this.style.width) || 0
            : this.firstElementChild?.classList.contains(
                  "notes-image-attachment-frame"
                )
              ? 400
              : 0;
        return {
          x: 0,
          y: 0,
          width,
          height: 0,
          top: 0,
          right: width,
          bottom: 0,
          left: 0,
          toJSON: () => ({})
        };
      });

    try {
      render(
        <NotesImageResidencyProvider scopeKey="image-node-frame-width-test">
          <NotesImageNodeContent
            nodeId="image-node"
            attachment={{ ...imageNodeAttachment, displayWidth: 80 }}
            onFrameInlineSizeChange={onFrameInlineSizeChange}
          />
        </NotesImageResidencyProvider>
      );

      expect(onFrameInlineSizeChange).toHaveBeenLastCalledWith(80);
      await userEvent.setup().click(
        screen.getByRole("button", { name: "Load image diagram.png" })
      );
      await screen.findByRole("img", { name: "diagram.png" });
      const frame = document.querySelector<HTMLElement>(
        ".notes-image-attachment-frame"
      )!;
      expect(frame).toHaveStyle({ width: "160px" });
      expect(onFrameInlineSizeChange).toHaveBeenLastCalledWith(160);

      const group = frame.parentElement!;
      act(() =>
        resizeCallbacks.get(group)?.(
          [
            {
              target: group,
              contentRect: { width: 96 }
            } as unknown as ResizeObserverEntry
          ],
          {} as ResizeObserver
        )
      );
      expect(frame).toHaveStyle({ width: "96px" });
      act(() =>
        resizeCallbacks.get(frame)?.(
          [
            {
              target: frame,
              contentRect: { width: 90 },
              borderBoxSize: [
                { blockSize: 0, inlineSize: 96 }
              ]
            } as unknown as ResizeObserverEntry
          ],
          {} as ResizeObserver
        )
      );
      expect(onFrameInlineSizeChange).toHaveBeenLastCalledWith(96);
    } finally {
      getBoundingClientRect.mockRestore();
    }
  });

  it("does not reload resident image bytes when only display width changes", async () => {
    const user = userEvent.setup();
    const view = render(
      <NotesImageResidencyProvider scopeKey="stable-image-source-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
        />
      </NotesImageResidencyProvider>
    );

    await user.click(
      screen.getByRole("button", { name: "Load image diagram.png" })
    );
    expect(await screen.findByRole("img", { name: "diagram.png" })).toBeVisible();
    expect(workspaceActions.loadAttachmentBytes).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();

    view.rerender(
      <NotesImageResidencyProvider scopeKey="stable-image-source-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={{ ...imageNodeAttachment, displayWidth: 320 }}
        />
      </NotesImageResidencyProvider>
    );

    await waitFor(() => {
      expect(workspaceActions.loadAttachmentBytes).toHaveBeenCalledOnce();
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(revokeObjectURL).not.toHaveBeenCalled();
    });
  });

  it("does not reload active image bytes when its actions trigger receives focus", async () => {
    const user = userEvent.setup();
    render(
      <NotesImageResidencyProvider scopeKey="focused-image-menu-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
        />
      </NotesImageResidencyProvider>
    );

    await user.click(
      screen.getByRole("button", { name: "Load image diagram.png" })
    );
    expect(await screen.findByRole("img", { name: "diagram.png" })).toBeVisible();
    expect(workspaceActions.loadAttachmentBytes).toHaveBeenCalledOnce();

    const actionsTrigger = screen.getByRole("button", {
      name: "Image actions for diagram.png"
    });
    actionsTrigger.focus();

    expect(actionsTrigger).toHaveFocus();
    expect(workspaceActions.loadAttachmentBytes).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", "ContextMenu"],
    ["missing", "Shift+F10"],
    ["evicted", "ContextMenu"],
    ["evicted", "Shift+F10"],
    ["loading", "ContextMenu"],
    ["loading", "Shift+F10"],
    ["ready", "ContextMenu"],
    ["ready", "Shift+F10"],
    ["error", "ContextMenu"],
    ["error", "Shift+F10"]
  ] as const)(
    "opens image actions from %s content with %s and restores structural focus",
    async (residencyState, shortcut) => {
      const user = userEvent.setup();
      const pendingLoad =
        residencyState === "loading" ? deferred<Uint8Array>() : null;
      if (residencyState === "loading") {
        workspaceActions.loadAttachmentBytes.mockReturnValueOnce(
          pendingLoad!.promise
        );
      } else if (residencyState === "error") {
        workspaceActions.loadAttachmentBytes.mockRejectedValueOnce(
          new Error("read failed")
        );
      }
      const onKeyDown = vi.fn(
        (event: ReactKeyboardEvent<HTMLDivElement>) => event.preventDefault()
      );
      render(
        <NotesImageResidencyProvider
          scopeKey={`image-node-context-menu-${residencyState}-${shortcut}`}
        >
          <NotesImageNodeContent
            nodeId="image-node"
            attachment={
              residencyState === "missing" ? undefined : imageNodeAttachment
            }
            onKeyDown={onKeyDown}
          />
        </NotesImageResidencyProvider>
      );

      if (
        residencyState === "loading" ||
        residencyState === "ready" ||
        residencyState === "error"
      ) {
        await user.click(
          screen.getByRole("button", { name: "Load image diagram.png" })
        );
      }
      if (residencyState === "loading") {
        expect(await screen.findByRole("status")).toHaveTextContent(
          "Loading image"
        );
      } else if (residencyState === "ready") {
        await screen.findByRole("img", { name: "diagram.png" });
      } else if (residencyState === "error") {
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "Image unavailable"
        );
      }

      const content =
        residencyState === "missing"
          ? screen.getByRole("group", { name: "Image" })
          : getImageNodeGroup();
      content.focus();
      if (shortcut === "ContextMenu") {
        fireEvent.keyDown(content, { key: "ContextMenu" });
      } else {
        fireEvent.keyDown(content, { key: "F10", shiftKey: true });
      }

      const menu = await screen.findByRole("menu");
      await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
      expect(onKeyDown).not.toHaveBeenCalled();

      await user.keyboard("{Escape}");
      await waitFor(() => expect(content).toHaveFocus());
      expect(
        screen.getByRole("button", {
          name:
            residencyState === "missing"
              ? "Image actions"
              : "Image actions for diagram.png"
        })
      ).not.toHaveFocus();

      if (residencyState === "loading") {
        await act(async () => {
          pendingLoad!.resolve(imageBytes);
          await pendingLoad!.promise;
        });
      }
    }
  );

  it("keeps group Escape separate from nested structural shortcuts", () => {
    const onKeyDown = vi.fn();
    const onEscape = vi.fn(() => true);
    const view = render(
      <NotesImageResidencyProvider scopeKey="image-node-escape-contract">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
          onKeyDown={onKeyDown}
          onEscape={onEscape}
        />
      </NotesImageResidencyProvider>
    );

    const content = getImageNodeGroup();
    const trigger = within(content).getByRole("button", {
      name: "Image actions for diagram.png"
    });
    content.focus();
    fireEvent.keyDown(content, { key: "Escape" });
    fireEvent.keyDown(trigger, { key: "Escape" });

    expect(onKeyDown).not.toHaveBeenCalled();
    expect(onEscape).toHaveBeenCalledTimes(2);

    view.rerender(
      <NotesImageResidencyProvider scopeKey="image-node-escape-contract">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
          onKeyDown={onKeyDown}
          onEscape={onEscape}
          disabled
        />
      </NotesImageResidencyProvider>
    );
    onKeyDown.mockClear();
    onEscape.mockClear();
    expect(fireEvent.keyDown(getImageNodeGroup(), { key: "Escape" })).toBe(true);
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();

    const onOuterKeyDown = vi.fn();
    const declinesEscape = vi.fn(() => false);
    view.rerender(
      <div onKeyDown={onOuterKeyDown}>
        <NotesImageResidencyProvider scopeKey="image-node-escape-contract">
          <NotesImageNodeContent
            nodeId="image-node"
            attachment={imageNodeAttachment}
            onKeyDown={onKeyDown}
            onEscape={declinesEscape}
          />
        </NotesImageResidencyProvider>
      </div>
    );
    onKeyDown.mockClear();
    expect(fireEvent.keyDown(getImageNodeGroup(), { key: "Escape" })).toBe(true);
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(declinesEscape).toHaveBeenCalledOnce();
    expect(onOuterKeyDown).toHaveBeenCalledOnce();

    onOuterKeyDown.mockClear();
    view.rerender(
      <div onKeyDown={onOuterKeyDown}>
        <NotesImageResidencyProvider scopeKey="image-node-escape-contract">
          <NotesImageNodeContent
            nodeId="image-node"
            attachment={imageNodeAttachment}
            onKeyDown={onKeyDown}
          />
        </NotesImageResidencyProvider>
      </div>
    );
    expect(fireEvent.keyDown(getImageNodeGroup(), { key: "Escape" })).toBe(true);
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(onOuterKeyDown).toHaveBeenCalledOnce();
  });

  it("wires image-node view original and download actions to the attachment id", async () => {
    const user = userEvent.setup();
    const view = render(
      <NotesImageResidencyProvider scopeKey="image-node-action-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
        />
      </NotesImageResidencyProvider>
    );

    await user.click(
      screen.getByRole("button", { name: "Load image diagram.png" })
    );
    expect(await screen.findByRole("img", { name: "diagram.png" })).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );
    await user.click(screen.getByRole("menuitem", { name: "View original" }));
    expect(workspaceActions.viewImageOriginal).toHaveBeenCalledOnce();
    expect(workspaceActions.viewImageOriginal).toHaveBeenCalledWith(
      imageNodeAttachment.id
    );

    view.unmount();
    render(
      <NotesImageResidencyProvider scopeKey="image-node-action-test-2">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
        />
      </NotesImageResidencyProvider>
    );
    await user.click(
      screen.getByRole("button", { name: "Load image diagram.png" })
    );
    await screen.findByRole("img", { name: "diagram.png" });
    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );
    await user.click(screen.getByRole("menuitem", { name: "Download" }));
    expect(workspaceActions.downloadImage).toHaveBeenCalledOnce();
    expect(workspaceActions.downloadImage).toHaveBeenCalledWith(
      imageNodeAttachment.id,
      imageNodeAttachment.originalName,
      imageNodeAttachment.mimeType
    );
  });

  it("routes only the current writable image-node removal callback without deleting the node", async () => {
    const user = userEvent.setup();
    const firstRemove = vi.fn();
    const secondRemove = vi.fn();
    const view = render(
      <NotesImageResidencyProvider scopeKey="image-node-delete-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
          onRemoveImage={firstRemove}
        />
      </NotesImageResidencyProvider>
    );

    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );
    await user.click(screen.getByRole("menuitem", { name: "Remove image" }));

    expect(firstRemove).toHaveBeenCalledOnce();

    view.rerender(
      <NotesImageResidencyProvider scopeKey="image-node-delete-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
          onRemoveImage={secondRemove}
        />
      </NotesImageResidencyProvider>
    );
    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );
    await user.click(screen.getByRole("menuitem", { name: "Remove image" }));

    expect(firstRemove).toHaveBeenCalledOnce();
    expect(secondRemove).toHaveBeenCalledOnce();

    view.rerender(
      <NotesImageResidencyProvider scopeKey="image-node-delete-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
          onRemoveImage={secondRemove}
          readOnly
        />
      </NotesImageResidencyProvider>
    );
    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );
    expect(screen.queryByRole("menuitem", { name: "Remove image" })).toBeNull();

    view.rerender(
      <NotesImageResidencyProvider scopeKey="image-node-delete-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
          onRemoveImage={secondRemove}
          disabled
        />
      </NotesImageResidencyProvider>
    );
    expect(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    ).toBeDisabled();
    expect(secondRemove).toHaveBeenCalledOnce();
    expect(workspaceActions.deleteNode).not.toHaveBeenCalled();
  });

  it("keeps read-only image-node viewing actions but disables delete and resize", async () => {
    const user = userEvent.setup();
    render(
      <NotesImageResidencyProvider scopeKey="readonly-image-node-action-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
          readOnly
        />
      </NotesImageResidencyProvider>
    );

    await user.click(
      screen.getByRole("button", { name: "Load image diagram.png" })
    );
    await screen.findByRole("img", { name: "diagram.png" });
    expect(
      screen.queryByRole("separator", { name: "Resize diagram.png" })
    ).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );
    expect(screen.queryByRole("menuitem", { name: "Remove image" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "View original" }));
    expect(workspaceActions.viewImageOriginal).toHaveBeenCalledWith(
      imageNodeAttachment.id
    );
  });

  it.each([
    [
      "View original",
      workspaceActions.viewImageOriginal,
      "Could not open the original image."
    ],
    [
      "Download",
      workspaceActions.downloadImage,
      "Could not download the image."
    ]
  ])(
    "keeps a ready image healthy when image-node %s rejects and offers retry",
    async (menuItem, action, message) => {
      const user = userEvent.setup();
      action.mockRejectedValueOnce(new Error("action failed"));
      render(
        <NotesImageResidencyProvider scopeKey="image-node-action-error-test">
          <NotesImageNodeContent
            nodeId="image-node"
            attachment={imageNodeAttachment}
          />
        </NotesImageResidencyProvider>
      );

      await user.click(
        screen.getByRole("button", { name: "Load image diagram.png" })
      );
      const image = await screen.findByRole("img", { name: "diagram.png" });
      await user.click(
        screen.getByRole("button", { name: "Image actions for diagram.png" })
      );
      await user.click(screen.getByRole("menuitem", { name: menuItem }));

      const alert = await screen.findByRole("alert", {
        name: "Image action failed"
      });
      expect(alert).toHaveTextContent(message);
      expect(image).toBeVisible();
      expect(screen.queryByText("Image unavailable")).toBeNull();

      await user.click(within(alert).getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
      expect(
        screen.queryByRole("alert", { name: "Image action failed" })
      ).toBeNull();
      expect(image).toBeVisible();
    }
  );

  it("drops a pending image-node View original failure after the workspace action changes and retries only the current action", async () => {
    const user = userEvent.setup();
    const pendingViewOriginal = deferred<void>();
    const oldViewOriginal = workspaceActions.viewImageOriginal;
    const currentViewOriginal = vi
      .fn()
      .mockRejectedValueOnce(new Error("current action failed"))
      .mockResolvedValueOnce(undefined);
    oldViewOriginal.mockReturnValueOnce(pendingViewOriginal.promise);
    const view = render(
      <NotesImageResidencyProvider scopeKey="image-node-view-action-change-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
        />
      </NotesImageResidencyProvider>
    );

    try {
      await user.click(
        screen.getByRole("button", { name: "Image actions for diagram.png" })
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "View original" })
      );
      expect(oldViewOriginal).toHaveBeenCalledOnce();

      workspaceActions.viewImageOriginal = currentViewOriginal;
      view.rerender(
        <NotesImageResidencyProvider scopeKey="image-node-view-action-change-test">
          <NotesImageNodeContent
            nodeId="image-node"
            attachment={imageNodeAttachment}
          />
        </NotesImageResidencyProvider>
      );
      await act(async () =>
        pendingViewOriginal.reject(new Error("obsolete action failed"))
      );

      expect(
        screen.queryByRole("alert", { name: "Image action failed" })
      ).toBeNull();

      await user.click(
        screen.getByRole("button", { name: "Image actions for diagram.png" })
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "View original" })
      );
      const alert = await screen.findByRole("alert", {
        name: "Image action failed"
      });
      await user.click(within(alert).getByRole("button", { name: "Retry" }));

      await waitFor(() => expect(currentViewOriginal).toHaveBeenCalledTimes(2));
      expect(oldViewOriginal).toHaveBeenCalledOnce();
      expect(currentViewOriginal).toHaveBeenNthCalledWith(
        1,
        imageNodeAttachment.id
      );
      expect(currentViewOriginal).toHaveBeenNthCalledWith(
        2,
        imageNodeAttachment.id
      );
      expect(
        screen.queryByRole("alert", { name: "Image action failed" })
      ).toBeNull();
    } finally {
      workspaceActions.viewImageOriginal = oldViewOriginal;
    }
  });

  it("drops a pending local Download failure after the action changes and retries only the current action", async () => {
    const user = userEvent.setup();
    const pendingDownload = deferred<void>();
    const oldDownload = vi.fn().mockReturnValueOnce(pendingDownload.promise);
    const currentDownload = vi
      .fn()
      .mockRejectedValueOnce(new Error("current action failed"))
      .mockResolvedValueOnce(undefined);
    const onDisplayWidthCommit = vi.fn();
    const view = render(
      <NotesImageAttachment
        {...standardProps({ onDisplayWidthCommit, onDownload: oldDownload })}
      />
    );

    await screen.findByRole("img", { name: "diagram.png" });
    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );
    await user.click(await screen.findByRole("menuitem", { name: "Download" }));
    expect(oldDownload).toHaveBeenCalledOnce();

    view.rerender(
      <NotesImageAttachment
        {...standardProps({
          onDisplayWidthCommit,
          onDownload: currentDownload
        })}
      />
    );
    await act(async () =>
      pendingDownload.reject(new Error("obsolete action failed"))
    );

    expect(
      screen.queryByRole("alert", { name: "Image action failed" })
    ).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );
    await user.click(await screen.findByRole("menuitem", { name: "Download" }));
    const alert = await screen.findByRole("alert", {
      name: "Image action failed"
    });
    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(currentDownload).toHaveBeenCalledTimes(2));
    expect(oldDownload).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("alert", { name: "Image action failed" })
    ).toBeNull();
  });

  it("ignores an older image-action failure after a newer action succeeds", async () => {
    const user = userEvent.setup();
    const olderView = deferred<void>();
    workspaceActions.viewImageOriginal.mockReturnValueOnce(olderView.promise);
    workspaceActions.downloadImage.mockResolvedValueOnce(undefined);
    render(
      <NotesImageResidencyProvider scopeKey="image-node-stale-action-test">
        <NotesImageNodeContent
          nodeId="image-node"
          attachment={imageNodeAttachment}
        />
      </NotesImageResidencyProvider>
    );

    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );
    await user.click(screen.getByRole("menuitem", { name: "View original" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );
    await user.click(await screen.findByRole("menuitem", { name: "Download" }));
    await waitFor(() =>
      expect(workspaceActions.downloadImage).toHaveBeenCalledOnce()
    );

    await act(async () => olderView.reject(new Error("late failure")));

    expect(
      screen.queryByRole("alert", { name: "Image action failed" })
    ).toBeNull();
  });

  it.each([
    [
      "View original",
      workspaceActions.viewImageOriginal,
      "Could not open the original image."
    ],
    [
      "Download",
      workspaceActions.downloadImage,
      "Could not download the image."
    ]
  ])(
    "keeps a pending image-node %s failure retryable after global-cap eviction",
    async (menuItem, action, message) => {
      const user = userEvent.setup();
      const pending = deferred<void>();
      action.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined);
      render(
        <NotesImageResidencyProvider scopeKey={`image-node-${menuItem}-eviction`}>
          {Array.from({ length: 9 }, (_, index) => {
            const nodeNumber = index + 1;
            return (
              <div data-testid={`image-node-${nodeNumber}`} key={nodeNumber}>
                <NotesImageNodeContent
                  nodeId={`image-node-${nodeNumber}`}
                  attachment={{
                    ...imageNodeAttachment,
                    id: `attachment-${nodeNumber}`,
                    nodeId: `image-node-${nodeNumber}`,
                    originalName: `private-${nodeNumber}.png`
                  }}
                />
              </div>
            );
          })}
        </NotesImageResidencyProvider>
      );

      const target = screen.getByTestId("image-node-1");
      await user.click(
        within(target).getByRole("button", { name: /^Load image/ })
      );
      await within(target).findByRole("img");
      await user.click(
        within(target).getByRole("button", { name: /^Image actions/ })
      );
      await user.click(screen.getByRole("menuitem", { name: menuItem }));

      for (let nodeNumber = 2; nodeNumber <= 9; nodeNumber += 1) {
        const blocker = screen.getByTestId(`image-node-${nodeNumber}`);
        await user.click(
          within(blocker).getByRole("button", { name: /^Load image/ })
        );
        await within(blocker).findByRole("img");
      }
      await waitFor(() =>
        expect(within(target).queryByRole("img")).toBeNull()
      );

      await act(async () => pending.reject(new Error("action failed")));

      const alert = await within(target).findByRole("alert", {
        name: "Image action failed"
      });
      expect(alert).toHaveTextContent(message);
      expect(within(target).queryByText("Image unavailable")).toBeNull();

      await user.click(within(alert).getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
      expect(
        within(target).queryByRole("alert", { name: "Image action failed" })
      ).toBeNull();
    }
  );

  it("renders a read-only image without resize or destructive controls", async () => {
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
    await userEvent.setup().click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
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

  it("skips byte copy and Blob URL creation when an in-flight load is disposed", async () => {
    const pending = deferred<Uint8Array>();
    const view = render(
      <NotesImageAttachment
        {...standardProps({
          bytes: undefined,
          loadBytes: () => pending.promise
        })}
      />
    );
    resizeContent(480);
    expect(screen.getByRole("status")).toHaveTextContent("Loading image");

    view.unmount();
    await act(async () => pending.resolve(imageBytes));

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    ["image/gif", new Uint8Array([71, 73, 70, 56, 57, 97])],
    ["image/webp", new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80])]
  ])("keeps original animated bytes in a %s Blob", async (mimeType, bytes) => {
    render(
      <NotesImageAttachment
        {...standardProps({
          attachment: { ...attachment, mimeType },
          bytes
        })}
      />
    );

    await screen.findByRole("img", { name: "diagram.png" });
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob).toMatchObject({ type: mimeType, size: bytes.byteLength });
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

  it("routes deletion through the hover action menu when a callback is supplied", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(<NotesImageAttachment {...standardProps({ onRemove })} />);

    const menuTrigger = screen.getByRole("button", {
      name: "Image actions for diagram.png"
    });
    await user.click(menuTrigger);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("marks only a lightbox-enabled resident image as image-atom interactive", async () => {
    const view = render(<NotesImageAttachment {...standardProps()} />);

    expect(await screen.findByRole("img", { name: "diagram.png" })).toHaveAttribute(
      "data-image-atom-interactive",
      "true"
    );
    expect(
      view.container.querySelector(".notes-image-attachment-frame")
    ).not.toHaveAttribute("data-image-atom-interactive");
    expect(view.container.firstElementChild).not.toHaveAttribute(
      "data-image-atom-interactive"
    );
  });

  it("opens Notes image settings through the app navigation context", async () => {
    const openSettings = vi.fn();
    const user = userEvent.setup();
    render(
      <AppNavigationContext.Provider value={{ openSettings }}>
        <NotesImageAttachment {...standardProps()} />
      </AppNavigationContext.Provider>
    );

    await user.click(
      screen.getByRole("button", { name: "Image actions for diagram.png" })
    );
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));

    expect(openSettings).toHaveBeenCalledOnce();
    expect(openSettings).toHaveBeenCalledWith("notes", "images");
  });

  it("opens the resident image full-screen without reading or allocating it again", async () => {
    const user = userEvent.setup();
    const loadBytes = vi.fn().mockResolvedValue(imageBytes);
    render(
      <NotesImageAttachment
        {...standardProps({ bytes: undefined, loadBytes })}
      />
    );

    await screen.findByRole("img", { name: "diagram.png" });
    expect(loadBytes).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();

    const menuTrigger = screen.getByRole("button", {
      name: "Image actions for diagram.png"
    });
    await user.click(menuTrigger);
    await user.click(screen.getByRole("menuitem", { name: "Show full-screen" }));

    expect(screen.getByRole("dialog", { name: "diagram.png" })).toBeVisible();
    expect(
      screen.getAllByRole("img", { name: "diagram.png" }).at(-1)
    ).toHaveAttribute("src", "blob:notes-image");
    expect(loadBytes).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();

    await user.click(
      screen.getByRole("button", { name: "Close full-screen image" })
    );
    expect(screen.queryByRole("dialog", { name: "diagram.png" })).toBeNull();
    await waitFor(() => expect(menuTrigger).toHaveFocus());
  });

  it("shares one byte read between active renderers for the same attachment ID", async () => {
    const pending = deferred<Uint8Array>();
    const load = vi.fn(() => pending.promise);
    render(
      <NotesImageResidencyProvider scopeKey="shared-renderer-byte-test">
        <NotesImageAttachment
          {...standardProps({ bytes: undefined, loadBytes: () => load() })}
        />
        <NotesImageAttachment
          {...standardProps({ bytes: undefined, loadBytes: () => load() })}
        />
      </NotesImageResidencyProvider>
    );

    expect(load).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(imageBytes));
    expect(await screen.findAllByRole("img", { name: "diagram.png" })).toHaveLength(
      2
    );
    expect(load).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });

  it("keeps a direct attachment byte lease usable through StrictMode effect replay", async () => {
    const loadBytes = vi.fn().mockResolvedValue(imageBytes);
    render(
      <StrictMode>
        <NotesImageAttachment
          {...standardProps({ bytes: undefined, loadBytes })}
        />
      </StrictMode>
    );

    expect(await screen.findByRole("img", { name: "diagram.png" })).toBeVisible();
    expect(loadBytes).toHaveBeenCalled();
  });

  it("keeps a provider attachment usable through StrictMode lifecycle replay", async () => {
    const loadBytes = vi.fn().mockResolvedValue(imageBytes);
    render(
      <StrictMode>
        <NotesImageResidencyProvider scopeKey="strict-provider-render-test">
          <NotesImageAttachment
            {...standardProps({ bytes: undefined, loadBytes })}
          />
        </NotesImageResidencyProvider>
      </StrictMode>
    );

    expect(await screen.findByRole("img", { name: "diagram.png" })).toBeVisible();
    expect(loadBytes).toHaveBeenCalled();
  });

  it("invalidates an old pending scope before a layout-time resolution can publish an object URL", async () => {
    const oldLoad = deferred<Uint8Array>();
    const newLoad = vi.fn().mockResolvedValue(new Uint8Array([...imageBytes, 1]));
    const view = render(
      <NotesImageResidencyProvider scopeKey="scope-a">
        <NotesImageAttachment
          {...standardProps({ bytes: undefined, loadBytes: () => oldLoad.promise })}
        />
      </NotesImageResidencyProvider>
    );

    view.rerender(
      <NotesImageResidencyProvider scopeKey="scope-b">
        <NotesImageAttachment
          {...standardProps({ bytes: undefined, loadBytes: newLoad })}
        />
        <ResolveOnLayout run={() => oldLoad.resolve(imageBytes)} />
      </NotesImageResidencyProvider>
    );

    expect(await screen.findByRole("img", { name: "diagram.png" })).toBeVisible();
    expect(newLoad).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it("releases a direct pending byte lease on unmount without creating an object URL", async () => {
    const pending = deferred<Uint8Array>();
    const view = render(
      <NotesImageAttachment
        {...standardProps({ bytes: undefined, loadBytes: () => pending.promise })}
      />
    );
    view.unmount();

    await act(async () => pending.resolve(imageBytes));
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("opens the resident image full-screen on double click", async () => {
    const user = userEvent.setup();
    render(<NotesImageAttachment {...standardProps()} />);

    const image = await screen.findByRole("img", { name: "diagram.png" });
    await user.dblClick(image);

    expect(screen.getByRole("dialog", { name: "diagram.png" })).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Close full-screen image" })
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "diagram.png" })).toBeNull()
    );
  });
});
