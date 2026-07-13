import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_NOTE_ATTACHMENTS_PER_NODE,
  type NoteAttachment
} from "../../domain/notes";
import { NotesAttachmentList } from "./NotesAttachmentList";

const workspaceActions = vi.hoisted(() => ({
  loadAttachmentBytes: vi.fn(),
  resizeImage: vi.fn(),
  removeImage: vi.fn(),
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
  it("renders a fixed insertion placeholder after existing attachments", () => {
    render(
      <NotesAttachmentList
        nodeId="node-1"
        attachments={[attachment(1)]}
        showDropPlaceholder
      />
    );

    const list = screen
      .getByRole("group", { name: "Image: image-1.png" })
      .closest<HTMLElement>(".notes-attachment-list")!;
    const placeholder = within(list).getByTestId(
      "notes-image-drop-placeholder"
    );
    expect(placeholder).toHaveAttribute("aria-hidden", "true");
    expect(list.lastElementChild).toBe(placeholder);
  });

  it("can render the insertion placeholder without existing attachments", () => {
    render(
      <NotesAttachmentList
        nodeId="node-1"
        attachments={[]}
        showDropPlaceholder
      />
    );

    expect(screen.getByTestId("notes-image-drop-placeholder")).toBeVisible();
  });

  it("binds retry to the visible failed attempt and suppresses it for validation errors", async () => {
    const user = userEvent.setup();
    const view = render(
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
    const view = render(
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
    render(
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

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(10));
    expect(screen.getAllByRole("img")).toHaveLength(8);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(intersectionOptions.every(({ rootMargin }) => rootMargin === "160px 0px")).toBe(
      true
    );
  });

  it("ignores a retained observer callback after replacement without evicting a live image", async () => {
    installIntersectionObserver();
    const view = render(
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
    const view = render(
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

  it("offers a manual accessible loader when viewport observation is unavailable", async () => {
    const user = userEvent.setup();
    render(
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

  it("cancels a pending offscreen release when keyboard loading manually", async () => {
    installIntersectionObserver();
    const user = userEvent.setup();
    render(
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
    const view = render(
      <NotesAttachmentList nodeId="node-1" attachments={[attachment(1)]} />
    );

    view.unmount();

    expect(disconnectIntersection).toHaveBeenCalled();
    expect(workspaceActions.loadAttachmentBytes).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("bounds defensive list rendering to the per-node metadata limit", () => {
    render(
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
    render(
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
});
