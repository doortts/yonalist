import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppNavigationContext } from "../../AppNavigationContext";
import {
  MAX_NOTE_ATTACHMENTS_PER_NODE,
  type NoteAttachment
} from "../../domain/notes";
import { NotesAttachmentList } from "./NotesAttachmentList";
import { NotesImageResidencyProvider } from "./NotesImageResidencyContext";

const workspaceActions = vi.hoisted(() => ({
  loadAttachmentBytes: vi.fn(),
  resizeImage: vi.fn(),
  viewImageOriginal: vi.fn(),
  downloadImage: vi.fn(),
  removeImage: vi.fn(),
  deleteNode: vi.fn(),
  retryImageUpload: vi.fn()
}));

vi.mock("./NotesWorkspaceContext", () => ({
  useNotesActions: () => ({ actions: workspaceActions })
}));

const intersectionCallbacks = new Map<Element, IntersectionObserverCallback>();
const intersectionOptions: IntersectionObserverInit[] = [];
const disconnectIntersection = vi.fn();
const createObjectURL = vi.fn(() => "blob:attachment");
const revokeObjectURL = vi.fn();
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL"
);
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL"
);

function attachment(index: number): NoteAttachment {
  return {
    id: `attachment-${index}`,
    nodeId: "node-1",
    sortKey: index,
    relativePath: `notes-assets/${"a".repeat(64)}.png`,
    contentHash: "a".repeat(64),
    originalName: `image-${index}.png`,
    mimeType: "image/png",
    byteSize: 4,
    intrinsicWidth: 640,
    intrinsicHeight: 320,
    displayWidth: 320,
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z"
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function installIntersectionObserver() {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly callback: IntersectionObserverCallback;

      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit
      ) {
        this.callback = callback;
        intersectionOptions.push(options ?? {});
      }

      observe(target: Element) {
        intersectionCallbacks.set(target, this.callback);
      }

      unobserve() {}

      disconnect() {
        disconnectIntersection();
      }

      takeRecords() {
        return [];
      }

      root = null;
      rootMargin = "600px 0px";
      thresholds = [0];
    }
  );
}

function ResidencyWrapper({ children }: PropsWithChildren) {
  return (
    <NotesImageResidencyProvider scopeKey="attachment-list-test">
      {children}
    </NotesImageResidencyProvider>
  );
}

function renderWithResidency(ui: ReactElement) {
  return render(ui, { wrapper: ResidencyWrapper });
}

beforeEach(() => {
  intersectionCallbacks.clear();
  intersectionOptions.length = 0;
  disconnectIntersection.mockClear();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.values(workspaceActions).forEach((mock) => mock.mockReset());
  workspaceActions.loadAttachmentBytes.mockResolvedValue(
    new Uint8Array([137, 80, 78, 71])
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL
  });
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

describe("NotesAttachmentList", () => {
  it("binds retry to the visible failed attempt and suppresses it for validation errors", async () => {
    const user = userEvent.setup();
    const view = renderWithResidency(
      <NotesAttachmentList
        nodeId="node-1"
        attachments={[]}
        uploadError="Image upload failed: disk full"
        uploadRetryAttemptId="attempt-1"
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Retry image upload" })
    );
    expect(workspaceActions.retryImageUpload).toHaveBeenCalledWith(
      "node-1",
      "attempt-1"
    );

    view.rerender(
      <NotesAttachmentList
        nodeId="node-1"
        attachments={[]}
        uploadError="Drop one image at a time."
      />
    );
    expect(
      screen.queryByRole("button", { name: "Retry image upload" })
    ).toBeNull();
  });

  it("releases an offscreen image after hysteresis and reloads it on return", async () => {
    installIntersectionObserver();
    const view = renderWithResidency(
      <NotesAttachmentList
        nodeId="node-1"
        attachments={[attachment(1), attachment(2)]}
      />
    );
    const first = screen.getByRole("group", { name: "Image: image-1.png" });
    const firstObserver = intersectionCallbacks.get(first);

    expect(firstObserver).toBeDefined();
    expect(workspaceActions.loadAttachmentBytes).not.toHaveBeenCalled();
    act(() => {
      firstObserver?.(
        [
          {
            target: first,
            isIntersecting: true
          } as unknown as IntersectionObserverEntry
        ],
        {} as IntersectionObserver
      );
    });

    await screen.findByRole("img", { name: "image-1.png" });
    expect(workspaceActions.loadAttachmentBytes).toHaveBeenCalledOnce();
    expect(workspaceActions.loadAttachmentBytes).toHaveBeenCalledWith(
      "attachment-1"
    );
    expect(createObjectURL).toHaveBeenCalledOnce();

    act(() => {
      firstObserver?.(
        [
          {
            target: first,
            isIntersecting: false
          } as unknown as IntersectionObserverEntry
        ],
        {} as IntersectionObserver
      );
      firstObserver?.(
        [
          {
            target: first,
            isIntersecting: true
          } as unknown as IntersectionObserverEntry
        ],
        {} as IntersectionObserver
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByRole("img", { name: "image-1.png" })).toBeVisible();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    act(() => {
      firstObserver?.(
        [
          {
            target: first,
            isIntersecting: false
          } as unknown as IntersectionObserverEntry
        ],
        {} as IntersectionObserver
      );
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "image-1.png" })
      ).toBeNull()
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:attachment");

    act(() => {
      firstObserver?.(
        [
          {
            target: first,
            isIntersecting: true
          } as unknown as IntersectionObserverEntry
        ],
        {} as IntersectionObserver
      );
    });
    await screen.findByRole("img", { name: "image-1.png" });
    expect(workspaceActions.loadAttachmentBytes).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(disconnectIntersection).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:attachment");
  });

  it("uses a small observation margin and bounds concurrently resident images", async () => {
    installIntersectionObserver();
    const user = userEvent.setup();
    renderWithResidency(
      <NotesAttachmentList
        nodeId="node-1"
        attachments={Array.from({ length: 10 }, (_, index) =>
          attachment(index + 1)
        )}
      />
    );
    const groups = screen.getAllByRole("group", { name: /^Image:/ });

    for (const group of groups) {
      const observer = intersectionCallbacks.get(group);
      act(() => {
        observer?.(
          [
            {
              target: group,
              isIntersecting: true
            } as unknown as IntersectionObserverEntry
          ],
          {} as IntersectionObserver
        );
      });
    }

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(8));
    expect(screen.getAllByRole("img")).toHaveLength(8);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(intersectionOptions.every(({ rootMargin }) => rootMargin === "160px 0px")).toBe(
      true
    );

    const evictedGroup = groups[0]!;
    const readsBeforeMenuOpen = workspaceActions.loadAttachmentBytes.mock.calls.length;
    const placeholder = evictedGroup.querySelector<HTMLElement>(
      ".notes-image-attachment-placeholder"
    );
    const trigger = within(evictedGroup).getByRole("button", {
      name: "Image actions for image-1.png"
    });

    expect(placeholder).toContainElement(trigger);
    fireEvent.mouseEnter(placeholder!);
    act(() => trigger.focus());
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("menu")).toBeVisible();
    expect(workspaceActions.loadAttachmentBytes).toHaveBeenCalledTimes(
      readsBeforeMenuOpen
    );
    expect(screen.getAllByRole("img")).toHaveLength(8);
  });

  it("shares the resident image limit across independent attachment lists", async () => {
    installIntersectionObserver();
    renderWithResidency(
      <>
        <NotesAttachmentList
          nodeId="node-1"
          attachments={Array.from({ length: 6 }, (_, index) =>
            attachment(index + 1)
          )}
        />
        <NotesAttachmentList
          nodeId="node-2"
          attachments={Array.from({ length: 6 }, (_, index) =>
            attachment(index + 7)
          )}
        />
      </>
    );

    for (const group of screen.getAllByRole("group", { name: /^Image:/ })) {
      act(() => {
        intersectionCallbacks.get(group)?.(
          [
            {
              target: group,
              isIntersecting: true
            } as unknown as IntersectionObserverEntry
          ],
          {} as IntersectionObserver
        );
      });
    }

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(8));
    expect(screen.getAllByRole("img")).toHaveLength(8);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("ignores a retained observer callback after replacement without evicting a live image", async () => {
    installIntersectionObserver();
    const view = renderWithResidency(
      <NotesAttachmentList
        nodeId="node-1"
        attachments={Array.from({ length: 8 }, (_, index) =>
          attachment(index + 1)
        )}
      />
    );
    const initialGroups = screen.getAllByRole("group", { name: /^Image:/ });
    const removedGroup = initialGroups[0]!;
    const retainedCallback = intersectionCallbacks.get(removedGroup)!;

    for (const group of initialGroups) {
      act(() => {
        intersectionCallbacks.get(group)?.(
          [
            {
              target: group,
              isIntersecting: true
            } as unknown as IntersectionObserverEntry
          ],
          {} as IntersectionObserver
        );
      });
    }
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(8));

    view.rerender(
      <NotesAttachmentList
        nodeId="node-1"
        attachments={Array.from({ length: 8 }, (_, index) =>
          attachment(index + 2)
        )}
      />
    );
    const replacement = screen.getByRole("group", {
      name: "Image: image-9.png"
    });
    act(() => {
      intersectionCallbacks.get(replacement)?.(
        [
          {
            target: replacement,
            isIntersecting: true
          } as unknown as IntersectionObserverEntry
        ],
        {} as IntersectionObserver
      );
    });
    await screen.findByRole("img", { name: "image-9.png" });

    act(() => {
      retainedCallback(
        [
          {
            target: removedGroup,
            isIntersecting: true
          } as unknown as IntersectionObserverEntry
        ],
        {} as IntersectionObserver
      );
    });

    expect(screen.getByRole("img", { name: "image-2.png" })).toBeVisible();
    expect(screen.getAllByRole("img")).toHaveLength(8);
  });

  it("prunes resident identity when an attachment leaves the metadata set", async () => {
    installIntersectionObserver();
    const view = renderWithResidency(
      <NotesAttachmentList nodeId="node-1" attachments={[attachment(1)]} />
    );
    const first = screen.getByRole("group", { name: "Image: image-1.png" });
    act(() => {
      intersectionCallbacks.get(first)?.(
        [
          {
            target: first,
            isIntersecting: true
          } as unknown as IntersectionObserverEntry
        ],
        {} as IntersectionObserver
      );
    });
    await screen.findByRole("img", { name: "image-1.png" });

    view.rerender(
      <NotesAttachmentList nodeId="node-1" attachments={[attachment(2)]} />
    );
    view.rerender(
      <NotesAttachmentList
        nodeId="node-1"
        attachments={[attachment(1), attachment(2)]}
      />
    );

    expect(
      screen.getByRole("button", { name: "Load image image-1.png" })
    ).toBeVisible();
    expect(workspaceActions.loadAttachmentBytes).toHaveBeenCalledOnce();
  });

  it("revokes resident image URLs when the workspace scope changes", async () => {
    installIntersectionObserver();
    const view = render(
      <NotesImageResidencyProvider scopeKey="vault-1">
        <NotesAttachmentList
          nodeId="node-1"
          attachments={[attachment(1)]}
        />
      </NotesImageResidencyProvider>
    );
    const first = screen.getByRole("group", { name: "Image: image-1.png" });
    act(() => {
      intersectionCallbacks.get(first)?.(
        [
          {
            target: first,
            isIntersecting: true
          } as unknown as IntersectionObserverEntry
        ],
        {} as IntersectionObserver
      );
    });
    await screen.findByRole("img", { name: "image-1.png" });

    view.rerender(
      <NotesImageResidencyProvider scopeKey="vault-2">
        <NotesAttachmentList
          nodeId="node-1"
          attachments={[attachment(1)]}
        />
      </NotesImageResidencyProvider>
    );

    expect(
      screen.getByRole("button", { name: "Load image image-1.png" })
    ).toBeVisible();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:attachment");
  });

  it("offers a manual accessible loader when viewport observation is unavailable", async () => {
    const user = userEvent.setup();
    renderWithResidency(
      <NotesAttachmentList nodeId="node-1" attachments={[attachment(1)]} />
    );
    const group = screen.getByRole("group", { name: "Image: image-1.png" });

    expect(workspaceActions.loadAttachmentBytes).not.toHaveBeenCalled();
    await user.click(
      within(group).getByRole("button", { name: "Load image image-1.png" })
    );

    await screen.findByRole("img", { name: "image-1.png" });
    expect(workspaceActions.loadAttachmentBytes).toHaveBeenCalledWith(
      "attachment-1"
    );
    expect(group).toHaveFocus();
  });

  it("preserves the exact persisted geometry for an inactive panoramic legacy image", () => {
    renderWithResidency(
      <NotesAttachmentList
        nodeId="node-1"
        attachments={[
          {
            ...attachment(1),
            displayWidth: 280,
            intrinsicWidth: 1_200,
            intrinsicHeight: 120
          }
        ]}
      />
    );

    const placeholder = screen
      .getByRole("group", { name: "Image: image-1.png" })
      .querySelector<HTMLElement>(".notes-image-attachment-placeholder");
    expect(placeholder).toHaveStyle({
      width: "280px",
      minHeight: "0",
      aspectRatio: "1200 / 120"
    });
  });

  it("keeps inactive legacy image actions byte-free with resident action parity", async () => {
    const user = userEvent.setup();
    const openSettings = vi.fn();
    render(
      <AppNavigationContext.Provider value={{ openSettings }}>
        <ResidencyWrapper>
          <NotesAttachmentList
            nodeId="node-1"
            attachments={[attachment(1)]}
          />
        </ResidencyWrapper>
      </AppNavigationContext.Provider>
    );

    const group = screen.getByRole("group", { name: "Image: image-1.png" });
    const placeholder = group.querySelector<HTMLElement>(
      ".notes-image-attachment-placeholder"
    );
    const trigger = within(group).getByRole("button", {
      name: "Image actions for image-1.png"
    });
    const openMenu = async () => {
      await user.click(trigger);
      await screen.findByRole("menu");
    };

    expect(placeholder).toContainElement(trigger);
    act(() => trigger.focus());
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");

    expect(workspaceActions.loadAttachmentBytes).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: "Show full-screen" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    for (const name of ["View original", "Download", "Delete", "Settings"]) {
      expect(screen.getByRole("menuitem", { name })).not.toHaveAttribute(
        "aria-disabled",
        "true"
      );
    }

    await user.click(screen.getByRole("menuitem", { name: "View original" }));
    expect(workspaceActions.viewImageOriginal).toHaveBeenCalledWith(
      "attachment-1"
    );
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Download" }));
    expect(workspaceActions.downloadImage).toHaveBeenCalledWith(
      "attachment-1",
      "image-1.png",
      "image/png"
    );
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(openSettings).toHaveBeenCalledWith("notes", "images");
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await user.click(
      within(screen.getByRole("alertdialog", { name: "Remove image?" })).getByRole(
        "button",
        { name: "Remove image" }
      )
    );

    expect(workspaceActions.removeImage).toHaveBeenCalledWith("attachment-1");
    expect(workspaceActions.deleteNode).not.toHaveBeenCalled();
    expect(workspaceActions.loadAttachmentBytes).not.toHaveBeenCalled();
  });

  it("cancels a pending offscreen release when keyboard loading manually", async () => {
    installIntersectionObserver();
    const user = userEvent.setup();
    renderWithResidency(
      <NotesAttachmentList nodeId="node-1" attachments={[attachment(1)]} />
    );
    const group = screen.getByRole("group", { name: "Image: image-1.png" });
    const observer = intersectionCallbacks.get(group)!;
    act(() => {
      observer(
        [
          {
            target: group,
            isIntersecting: false
          } as unknown as IntersectionObserverEntry
        ],
        {} as IntersectionObserver
      );
    });

    await user.tab();
    expect(
      screen.getByRole("button", { name: "Load image image-1.png" })
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByRole("img", { name: "image-1.png" });
    expect(group).toHaveFocus();

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(screen.getByRole("img", { name: "image-1.png" })).toBeVisible();
    expect(group).toHaveFocus();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("disconnects a dormant observer without loading bytes on cleanup", () => {
    installIntersectionObserver();
    const view = renderWithResidency(
      <NotesAttachmentList nodeId="node-1" attachments={[attachment(1)]} />
    );

    view.unmount();

    expect(disconnectIntersection).toHaveBeenCalled();
    expect(workspaceActions.loadAttachmentBytes).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("bounds defensive list rendering to the per-node metadata limit", () => {
    renderWithResidency(
      <NotesAttachmentList
        nodeId="node-1"
        attachments={Array.from(
          { length: MAX_NOTE_ATTACHMENTS_PER_NODE + 1 },
          (_, index) => attachment(index + 1)
        )}
      />
    );

    expect(screen.getAllByRole("group")).toHaveLength(
      MAX_NOTE_ATTACHMENTS_PER_NODE
    );
    expect(workspaceActions.loadAttachmentBytes).not.toHaveBeenCalled();
  });

  it("shows the image fallback when an activated byte load fails", async () => {
    const user = userEvent.setup();
    workspaceActions.loadAttachmentBytes.mockRejectedValueOnce(
      new Error("read failed")
    );
    renderWithResidency(
      <NotesAttachmentList nodeId="node-1" attachments={[attachment(1)]} />
    );

    await user.click(
      screen.getByRole("button", { name: "Load image image-1.png" })
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Image unavailable")
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("does not create Blob URLs for evicted in-flight image loads", async () => {
    installIntersectionObserver();
    const pendingLoads = new Map<string, ReturnType<typeof deferred<Uint8Array>>>();
    workspaceActions.loadAttachmentBytes.mockImplementation((attachmentId: string) => {
      const pending = deferred<Uint8Array>();
      pendingLoads.set(attachmentId, pending);
      return pending.promise;
    });
    renderWithResidency(
      <NotesAttachmentList
        nodeId="node-1"
        attachments={Array.from({ length: 9 }, (_, index) =>
          attachment(index + 1)
        )}
      />
    );

    const groups = screen.getAllByRole("group", { name: /^Image:/ });
    for (const group of groups) {
      act(() => {
        intersectionCallbacks.get(group)?.(
          [
            {
              target: group,
              isIntersecting: true
            } as unknown as IntersectionObserverEntry
          ],
          {} as IntersectionObserver
        );
      });
    }
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Load image image-1.png" })
      ).toBeVisible()
    );

    await act(async () => {
      for (const pending of pendingLoads.values()) {
        pending.resolve(new Uint8Array([137, 80, 78, 71]));
      }
    });

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(8));
    expect(createObjectURL).toHaveBeenCalledTimes(8);
  });

  it("adds view original and download actions to legacy attachments", async () => {
    const user = userEvent.setup();
    const view = renderWithResidency(
      <NotesAttachmentList nodeId="node-1" attachments={[attachment(1)]} />
    );

    await user.click(
      screen.getByRole("button", { name: "Load image image-1.png" })
    );
    await screen.findByRole("img", { name: "image-1.png" });

    await user.click(
      screen.getByRole("button", { name: "Image actions for image-1.png" })
    );
    await user.click(screen.getByRole("menuitem", { name: "View original" }));
    expect(workspaceActions.viewImageOriginal).toHaveBeenCalledOnce();
    expect(workspaceActions.viewImageOriginal).toHaveBeenCalledWith(
      "attachment-1"
    );

    view.unmount();
    renderWithResidency(
      <NotesAttachmentList nodeId="node-1" attachments={[attachment(1)]} />
    );
    await user.click(
      screen.getByRole("button", { name: "Load image image-1.png" })
    );
    await screen.findByRole("img", { name: "image-1.png" });
    await user.click(
      screen.getByRole("button", { name: "Image actions for image-1.png" })
    );
    await user.click(screen.getByRole("menuitem", { name: "Download" }));
    expect(workspaceActions.downloadImage).toHaveBeenCalledOnce();
    expect(workspaceActions.downloadImage).toHaveBeenCalledWith(
      "attachment-1",
      "image-1.png",
      "image/png"
    );
  });

  it("keeps legacy attachment delete attachment-only and cancelable", async () => {
    const user = userEvent.setup();
    const view = renderWithResidency(
      <NotesAttachmentList nodeId="node-1" attachments={[attachment(1)]} />
    );

    await user.click(
      screen.getByRole("button", { name: "Load image image-1.png" })
    );
    await screen.findByRole("img", { name: "image-1.png" });

    await user.click(
      screen.getByRole("button", { name: "Image actions for image-1.png" })
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const cancelDialog = screen.getByRole("alertdialog", {
      name: "Remove image?"
    });
    expect(cancelDialog).toHaveTextContent("Remove this image from the note?");
    expect(cancelDialog).not.toHaveTextContent("image-1.png");
    await user.click(within(cancelDialog).getByRole("button", { name: "Cancel" }));
    expect(workspaceActions.removeImage).not.toHaveBeenCalled();
    expect(workspaceActions.deleteNode).not.toHaveBeenCalled();

    view.unmount();
    renderWithResidency(
      <NotesAttachmentList nodeId="node-1" attachments={[attachment(1)]} />
    );
    await user.click(
      screen.getByRole("button", { name: "Load image image-1.png" })
    );
    await screen.findByRole("img", { name: "image-1.png" });
    await user.click(
      screen.getByRole("button", { name: "Image actions for image-1.png" })
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const confirmDialog = screen.getByRole("alertdialog", {
      name: "Remove image?"
    });
    await user.click(
      within(confirmDialog).getByRole("button", { name: "Remove image" })
    );

    expect(workspaceActions.removeImage).toHaveBeenCalledOnce();
    expect(workspaceActions.removeImage).toHaveBeenCalledWith("attachment-1");
    expect(workspaceActions.deleteNode).not.toHaveBeenCalled();
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
    "keeps a ready legacy image healthy when %s rejects and offers retry",
    async (menuItem, action, message) => {
      const user = userEvent.setup();
      action.mockRejectedValueOnce(new Error("action failed"));
      renderWithResidency(
        <NotesAttachmentList nodeId="node-1" attachments={[attachment(1)]} />
      );

      await user.click(
        screen.getByRole("button", { name: "Load image image-1.png" })
      );
      const image = await screen.findByRole("img", { name: "image-1.png" });
      await user.click(
        screen.getByRole("button", { name: "Image actions for image-1.png" })
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
    "keeps a pending legacy %s failure retryable after offscreen eviction",
    async (menuItem, action, message) => {
      installIntersectionObserver();
      const user = userEvent.setup();
      const pending = deferred<void>();
      action.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined);
      renderWithResidency(
        <NotesAttachmentList nodeId="node-1" attachments={[attachment(1)]} />
      );

      const group = screen.getByRole("group", { name: "Image: image-1.png" });
      const observer = intersectionCallbacks.get(group);
      expect(observer).toBeDefined();
      act(() => {
        observer?.(
          [
            {
              target: group,
              isIntersecting: true
            } as unknown as IntersectionObserverEntry
          ],
          {} as IntersectionObserver
        );
      });
      await within(group).findByRole("img");
      await user.click(
        within(group).getByRole("button", { name: /^Image actions/ })
      );
      await user.click(screen.getByRole("menuitem", { name: menuItem }));

      act(() => {
        observer?.(
          [
            {
              target: group,
              isIntersecting: false
            } as unknown as IntersectionObserverEntry
          ],
          {} as IntersectionObserver
        );
      });
      await waitFor(() => expect(within(group).queryByRole("img")).toBeNull());

      await act(async () => pending.reject(new Error("action failed")));

      const alert = await within(group).findByRole("alert", {
        name: "Image action failed"
      });
      expect(alert).toHaveTextContent(message);
      expect(within(group).queryByText("Image unavailable")).toBeNull();

      await user.click(within(alert).getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
      expect(
        within(group).queryByRole("alert", { name: "Image action failed" })
      ).toBeNull();
    }
  );
});
