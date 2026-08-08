import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { ImageView } from "../../../../packages/contracts/generated/ImageView";
import type { ImageLease } from "../imageResidency";
import type { OutlineLineMetadata } from "./metadata";
import {
  imageZoneSize,
  PaneImageZones,
  type ImageZonePort,
  type ImageZoneSyncInput
} from "./imageZones";

function image(overrides: Partial<ImageView> = {}): ImageView {
  return {
    contentHash: "hash",
    originalName: "shot.png",
    mimeType: "image/png",
    byteLength: 1_024,
    pixelWidth: 800,
    pixelHeight: 400,
    displayWidth: 800,
    ...overrides
  };
}

function line(
  nodeId: string,
  kind: OutlineLineMetadata["kind"] = "text",
  depth = 0
): OutlineLineMetadata {
  return {
    nodeId,
    parentId: "page",
    depth,
    kind,
    collapsed: false,
    completed: false
  };
}

function fakeEditor(contentWidth = 900): {
  readonly editor: monaco.editor.ICodeEditor;
  readonly addZone: ReturnType<typeof vi.fn>;
  readonly removeZone: ReturnType<typeof vi.fn>;
  readonly layoutZone: ReturnType<typeof vi.fn>;
  readonly zones: Map<string, monaco.editor.IViewZone>;
} {
  const zones = new Map<string, monaco.editor.IViewZone>();
  let nextId = 0;
  const addZone = vi.fn((zone: monaco.editor.IViewZone) => {
    const id = `zone-${++nextId}`;
    zones.set(id, zone);
    return id;
  });
  const removeZone = vi.fn((id: string) => zones.delete(id));
  const layoutZone = vi.fn();
  return {
    editor: {
      getLayoutInfo: () => ({ contentWidth }),
      changeViewZones: (
        callback: (accessor: monaco.editor.IViewZoneChangeAccessor) => void
      ) => callback({
        addZone,
        removeZone,
        layoutZone
      } as unknown as monaco.editor.IViewZoneChangeAccessor)
    } as unknown as monaco.editor.ICodeEditor,
    addZone,
    removeZone,
    layoutZone,
    zones
  };
}

function fakePort(lease: ImageLease = { status: "idle" }): {
  readonly port: ImageZonePort;
  readonly activate: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
  readonly resize: ReturnType<typeof vi.fn>;
  readonly openLightbox: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  const activate = vi.fn(() => release);
  const resize = vi.fn().mockResolvedValue(undefined);
  const openLightbox = vi.fn();
  return {
    port: {
      residency: {
        activate,
        subscribe: () => () => undefined,
        getSnapshot: () => lease
      },
      resize,
      openLightbox
    },
    activate,
    release,
    resize,
    openLightbox
  };
}

function pointer(type: string, clientX: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, button: 0, clientX });
}

function arrow(type: string, key: string, shiftKey = false): KeyboardEvent {
  return new KeyboardEvent(type, {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true
  });
}

function syncInput(
  overrides: Partial<ImageZoneSyncInput> = {}
): ImageZoneSyncInput {
  return {
    lines: [line("first"), line("picture", "image")],
    images: new Map([["picture", image()]]),
    window: [1, 2],
    hidden: [],
    ...overrides
  };
}

describe("image zone size", () => {
  it("keeps a small image at its own pixels instead of upscaling", () => {
    expect(imageZoneSize(
      image({ pixelWidth: 40, pixelHeight: 20, displayWidth: 40 }),
      900
    )).toEqual({ width: 40, height: 20 });
  });

  it("clamps a stored display width to the original and the content width", () => {
    expect(imageZoneSize(image({ displayWidth: 2_000 }), 900).width).toBe(800);
    expect(imageZoneSize(image({ displayWidth: 600 }), 900).width).toBe(600);
    expect(imageZoneSize(image({ displayWidth: 600 }), 320).width).toBe(320);
  });

  it("derives the height from the original aspect ratio", () => {
    expect(imageZoneSize(image({ displayWidth: 400 }), 900)).toEqual({
      width: 400,
      height: 200
    });
  });

  it("falls back to the original width when measurements are missing", () => {
    expect(imageZoneSize(image({ displayWidth: 0 }), 0)).toEqual({
      width: 800,
      height: 400
    });
    expect(imageZoneSize(
      image({ pixelWidth: 0, pixelHeight: 0, displayWidth: 0 }),
      900
    )).toEqual({ width: 0, height: 0 });
  });
});

describe("pane image zones", () => {
  it("draws one zone above each visible caption and leases its bytes", () => {
    const fake = fakeEditor();
    const port = fakePort();
    const zones = new PaneImageZones({ editor: fake.editor, port: port.port });

    zones.sync(syncInput());

    expect(fake.addZone).toHaveBeenCalledOnce();
    const zone = fake.zones.get("zone-1")!;
    expect(zone.afterLineNumber).toBe(1);
    expect(zone.heightInPx).toBe(400);
    expect(port.activate).toHaveBeenCalledWith({
      nodeId: "picture",
      contentHash: "hash",
      mimeType: "image/png"
    });
    expect(zones.size).toBe(1);
    zones.dispose();
    expect(port.release).toHaveBeenCalledOnce();
  });

  it("drops the zone of a caption that leaves the decoration window", () => {
    const fake = fakeEditor();
    const port = fakePort();
    const zones = new PaneImageZones({ editor: fake.editor, port: port.port });
    const lines = [line("first"), line("picture", "image"), line("tail")];

    zones.sync(syncInput({ lines, window: [1, 3] }));
    expect(zones.size).toBe(1);

    zones.sync(syncInput({ lines, window: [3, 3] }));

    expect(fake.removeZone).toHaveBeenCalledWith("zone-1");
    expect(port.release).toHaveBeenCalledOnce();
    expect(zones.size).toBe(0);
    zones.dispose();
  });

  it("drops the zone of a caption a hidden area swallows", () => {
    const fake = fakeEditor();
    const port = fakePort();
    const zones = new PaneImageZones({ editor: fake.editor, port: port.port });

    zones.sync(syncInput());
    zones.sync(syncInput({ hidden: [new monaco.Range(2, 1, 2, 1)] }));

    expect(fake.removeZone).toHaveBeenCalledOnce();
    expect(zones.size).toBe(0);
    zones.dispose();
  });

  it("relayouts in place when the caption moves or the width changes", () => {
    const fake = fakeEditor();
    const port = fakePort();
    const zones = new PaneImageZones({ editor: fake.editor, port: port.port });

    zones.sync(syncInput());
    zones.sync(syncInput({
      lines: [line("a"), line("b"), line("picture", "image")],
      window: [1, 3],
      images: new Map([["picture", image({ displayWidth: 400 })]])
    }));

    expect(fake.addZone).toHaveBeenCalledOnce();
    expect(fake.layoutZone).toHaveBeenCalledWith("zone-1");
    const zone = fake.zones.get("zone-1")!;
    expect(zone.afterLineNumber).toBe(2);
    expect(zone.heightInPx).toBe(200);
    zones.dispose();
  });

  it("follows the pointer while resizing and commits once on release", async () => {
    const fake = fakeEditor();
    const port = fakePort();
    const zones = new PaneImageZones({ editor: fake.editor, port: port.port });
    zones.sync(syncInput({
      images: new Map([["picture", image({ displayWidth: 600 })]])
    }));
    const frame = fake.zones.get("zone-1")!.domNode
      .querySelector<HTMLElement>(".yonalist-outline-image-frame")!;
    const handle = frame.querySelector<HTMLElement>(
      ".yonalist-outline-image-resize"
    )!;

    handle.dispatchEvent(pointer("pointerdown", 500));
    handle.dispatchEvent(pointer("pointermove", 400));

    expect(frame.style.width).toBe("500px");
    expect(fake.zones.get("zone-1")!.heightInPx).toBe(250);
    expect(port.resize).not.toHaveBeenCalled();

    handle.dispatchEvent(pointer("pointermove", 300));
    handle.dispatchEvent(pointer("pointerup", 300));

    expect(port.resize).toHaveBeenCalledExactlyOnceWith("picture", 400);
    await vi.waitFor(() => expect(frame.style.width).toBe("600px"));
    zones.dispose();
  });

  it("keeps a released width no wider than the original pixels", () => {
    const fake = fakeEditor();
    const port = fakePort();
    const zones = new PaneImageZones({ editor: fake.editor, port: port.port });
    zones.sync(syncInput());
    const handle = fake.zones.get("zone-1")!.domNode
      .querySelector<HTMLElement>(".yonalist-outline-image-resize")!;

    handle.dispatchEvent(pointer("pointerdown", 500));
    handle.dispatchEvent(pointer("pointermove", 5_000));
    handle.dispatchEvent(pointer("pointerup", 5_000));

    expect(port.resize).toHaveBeenCalledExactlyOnceWith("picture", 800);
    zones.dispose();
  });

  it("resizes from the keyboard in the same steps the rows use", async () => {
    const fake = fakeEditor();
    const port = fakePort();
    const zones = new PaneImageZones({ editor: fake.editor, port: port.port });
    zones.sync(syncInput({
      images: new Map([["picture", image({ displayWidth: 600 })]])
    }));
    const frame = fake.zones.get("zone-1")!.domNode
      .querySelector<HTMLElement>(".yonalist-outline-image-frame")!;
    const handle = frame.querySelector<HTMLElement>(
      ".yonalist-outline-image-resize"
    )!;

    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-label")).toBe("Resize shot.png");
    expect(handle.getAttribute("aria-valuemin")).toBe("120");
    expect(handle.getAttribute("aria-valuemax")).toBe("800");

    const step = arrow("keydown", "ArrowLeft");
    handle.dispatchEvent(step);
    // The caret must not travel with the arrow key.
    expect(step.defaultPrevented).toBe(true);
    handle.dispatchEvent(arrow("keydown", "ArrowLeft", true));

    expect(frame.style.width).toBe("540px");
    expect(handle.getAttribute("aria-valuenow")).toBe("540");
    expect(fake.zones.get("zone-1")!.heightInPx).toBe(270);
    expect(port.resize).not.toHaveBeenCalled();

    handle.dispatchEvent(arrow("keyup", "ArrowLeft"));

    expect(port.resize).toHaveBeenCalledExactlyOnceWith("picture", 540);
    await vi.waitFor(() => expect(frame.style.width).toBe("600px"));
    zones.dispose();
  });

  it("commits a keyboard resize on blur, and only when it moved", () => {
    const fake = fakeEditor();
    const port = fakePort();
    const zones = new PaneImageZones({ editor: fake.editor, port: port.port });
    zones.sync(syncInput());
    const handle = fake.zones.get("zone-1")!.domNode
      .querySelector<HTMLElement>(".yonalist-outline-image-resize")!;

    // Already at the original pixels: the step clamps away to nothing.
    handle.dispatchEvent(arrow("keydown", "ArrowRight"));
    handle.dispatchEvent(new FocusEvent("blur"));
    expect(port.resize).not.toHaveBeenCalled();

    handle.dispatchEvent(arrow("keydown", "ArrowLeft", true));
    handle.dispatchEvent(new FocusEvent("blur"));

    expect(port.resize).toHaveBeenCalledExactlyOnceWith("picture", 750);
    zones.dispose();
  });

  it("shows the image and opens the lightbox once the lease is ready", () => {
    const fake = fakeEditor();
    const port = fakePort({ status: "ready", url: "blob:picture" });
    const zones = new PaneImageZones({ editor: fake.editor, port: port.port });

    zones.sync(syncInput());

    const picture = fake.zones.get("zone-1")!.domNode
      .querySelector("img")!;
    expect(picture.getAttribute("src")).toBe("blob:picture");
    picture.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(port.openLightbox).toHaveBeenCalledWith({
      nodeId: "picture",
      sourceUrl: "blob:picture",
      originalName: "shot.png",
      pixelWidth: 800,
      pixelHeight: 400
    });
    zones.dispose();
  });
});
