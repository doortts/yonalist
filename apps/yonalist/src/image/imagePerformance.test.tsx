import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { ImageNodeContent } from "./ImageNodeContent";
import { ImageResidency } from "./imageResidency";
import type { NotesStore } from "../notesStore";

class ControlledIntersectionObserver implements IntersectionObserver {
  static instances: ControlledIntersectionObserver[] = [];

  readonly root = null;
  readonly rootMargin = "";
  readonly scrollMargin = "";
  readonly thresholds = [0];
  private target: Element | null = null;

  constructor(private readonly callback: IntersectionObserverCallback) {
    ControlledIntersectionObserver.instances.push(this);
  }

  observe(target: Element) {
    this.target = target;
  }

  unobserve() {}

  disconnect() {
    this.target = null;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  trigger(isIntersecting: boolean) {
    if (!this.target) return;
    this.callback([{
      target: this.target,
      isIntersecting
    } as IntersectionObserverEntry], this);
  }
}

function imageNode(index: number): NoteView {
  return {
    id: `image-${index}`,
    parentId: "page-1",
    sortKey: index,
    kind: "image",
    image: {
      contentHash: index.toString(16).padStart(64, "0"),
      originalName: `image-${index}.png`,
      mimeType: "image/png",
      byteLength: 1,
      pixelWidth: 1,
      pixelHeight: 1,
      displayWidth: 120
    },
    text: `image-${index}.png`,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

describe("image rendering performance guards", () => {
  beforeEach(() => {
    ControlledIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", ControlledIntersectionObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps no more than eight byte-backed URLs across 512 mixed rows", async () => {
    const read = vi.fn(async (nodeId: string) =>
      Uint8Array.from([Number(nodeId.slice(6)) % 256]));
    const liveUrls = new Map<string, Blob>();
    let nextUrl = 0;
    const residency = new ImageResidency(read, {
      createObjectURL: (blob) => {
        const url = `blob:mixed-${nextUrl++}`;
        liveUrls.set(url, blob);
        return url;
      },
      revokeObjectURL: (url) => {
        liveUrls.delete(url);
      },
      maximumUrls: 8
    });

    const view = render(
      <div>
        {Array.from({ length: 512 }, (_, index) => index % 2 === 0 ? (
          <ImageNodeContent
            key={index}
            node={imageNode(index / 2)}
            residency={residency}
          />
        ) : (
          <div key={index} data-outline-field="title">
            Text row {index}
          </div>
        ))}
      </div>
    );
    expect(ControlledIntersectionObserver.instances).toHaveLength(256);

    await act(async () => {
      for (const observer of ControlledIntersectionObserver.instances) {
        observer.trigger(true);
        await Promise.resolve();
        await Promise.resolve();
        observer.trigger(false);
      }
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(256));

    expect(liveUrls.size).toBeLessThanOrEqual(8);
    view.unmount();
    residency.dispose();
  });

  it("opens one hundred image menus without reading image bytes", () => {
    const read = vi.fn();
    const residency = new ImageResidency(read);
    const store = {
      images: { resize: vi.fn() },
      deleteSubtree: vi.fn()
    } as unknown as NotesStore;
    const view = render(
      <ImageNodeContent
        node={imageNode(1)}
        residency={residency}
        store={store}
      />
    );
    const trigger = screen.getByRole("button", {
      name: "Image actions for image-1.png"
    });

    for (let index = 0; index < 100; index += 1) {
      fireEvent.click(trigger);
      fireEvent.click(trigger);
    }

    expect(read).not.toHaveBeenCalled();
    view.unmount();
    residency.dispose();
  });
});
