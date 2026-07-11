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
  useNotesWorkspaceContext: () => ({ actions: workspaceActions })
}));

const intersectionCallbacks = new Map<Element, IntersectionObserverCallback>();
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

      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
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
  it("loads only an attachment that approaches the viewport and revokes its URL", async () => {
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

    view.unmount();
    expect(disconnectIntersection).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:attachment");
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
