import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import { App } from "./App";
import { appApi, snapshot } from "./test/appApiFixture";

const imageNode = {
  id: "image",
  parentId: "page-1",
  sortKey: 2_048,
  kind: "image" as const,
  image: {
    contentHash: "a".repeat(64),
    originalName: "cat.png",
    mimeType: "image/png",
    byteLength: 1,
    pixelWidth: 1,
    pixelHeight: 1,
    displayWidth: 320
  },
  text: "cat.png",
  note: "",
  marker: "bullet" as const,
  collapsed: false,
  completed: false,
  starred: false,
  deleted: false
};

function imageBoot(): BootSnapshot {
  return {
    ...snapshot,
    viewport: {
      ...snapshot.viewport!,
      nodes: [
        snapshot.viewport!.nodes[0]!,
        imageNode,
        {
          ...snapshot.viewport!.nodes[1]!,
          sortKey: 3_072
        }
      ]
    }
  };
}

/** The image carries a child, so cutting it would strand the caption. */
function childBoot(): BootSnapshot {
  const boot = imageBoot();
  return {
    ...boot,
    viewport: {
      ...boot.viewport!,
      nodes: [
        ...boot.viewport!.nodes,
        {
          ...boot.viewport!.nodes[2]!,
          id: "caption",
          parentId: "image",
          sortKey: 1_024,
          text: "Caption thought"
        }
      ]
    }
  };
}

/** jsdom has no ClipboardItem, so the write is read off this one. */
class FakeClipboardItem {
  constructor(readonly data: Record<string, Promise<Blob>>) {}
}

function stubClipboard() {
  const write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  Object.defineProperty(navigator, "clipboard", {
    value: { write },
    configurable: true
  });
  return write;
}

function selectableImageApi() {
  const notesApi = appApi();
  notesApi.bootstrap = vi.fn().mockResolvedValue(imageBoot());
  notesApi.queryForest = vi.fn().mockImplementation(async (request) => ({
    revision: 7,
    nodes: imageBoot().viewport!.nodes.filter((node) =>
      request.rootIds.includes(node.id)),
    complete: true
  }));
  notesApi.readImage = vi.fn().mockResolvedValue(Uint8Array.from([1]));
  return notesApi;
}

describe("image node structural parity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("selects the image from its caret and copies the bytes themselves",
    async () => {
      const notesApi = selectableImageApi();
      const write = stubClipboard();
      const view = render(<App api={notesApi} />);
      await screen.findByRole("group", { name: "Image: cat.png" });
      const station = view.container.querySelector<HTMLElement>(
        ".notes-image-caret-stop"
      )!;
      station.focus();

      fireEvent.keyDown(station, { key: "ArrowRight", shiftKey: true });

      await waitFor(() => expect(station.closest(".notes-node"))
        .toHaveAttribute("data-range-selected", "true"));
      fireEvent.copy(screen.getByRole("region", { name: "Notes outline" }), {
        clipboardData: { setData: vi.fn() }
      });

      await waitFor(() => expect(write).toHaveBeenCalledOnce());
      const item = write.mock.calls[0]![0]![0] as FakeClipboardItem;
      expect((await item.data["image/png"])!.type).toBe("image/png");
      expect(notesApi.execute).not.toHaveBeenCalled();
    });

  it("cuts the selected image once its bytes are on the clipboard", async () => {
    const notesApi = selectableImageApi();
    const write = stubClipboard();
    const view = render(<App api={notesApi} />);
    await screen.findByRole("group", { name: "Image: cat.png" });
    const station = view.container.querySelector<HTMLElement>(
      ".notes-image-caret-stop"
    )!;
    station.focus();
    fireEvent.keyDown(station, { key: "ArrowRight", shiftKey: true });
    await waitFor(() => expect(notesApi.queryForest).toHaveBeenCalled());

    fireEvent.cut(screen.getByRole("region", { name: "Notes outline" }), {
      clipboardData: { setData: vi.fn() }
    });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { kind: "deleteSubtrees", ids: ["image"] }
      })
    ));
    expect(write).toHaveBeenCalledOnce();
  });

  it("multi-selects an image with a bullet and indents one ordered batch", async () => {
    const notesApi = appApi();
    notesApi.bootstrap = vi.fn().mockResolvedValue(imageBoot());
    notesApi.queryForest = vi.fn().mockImplementation(async (request) => ({
      revision: 7,
      nodes: imageBoot().viewport!.nodes.filter((node) =>
        request.rootIds.includes(node.id)),
      complete: true
    }));
    notesApi.readImage = vi.fn().mockResolvedValue(Uint8Array.from([1]));
    render(<App api={notesApi} />);
    const image = await screen.findByRole("group", {
      name: "Image: cat.png"
    });
    const second = screen.getByDisplayValue("Second thought");

    fireEvent.pointerDown(image, {
      button: 0,
      pointerId: 3,
      ctrlKey: true
    });
    fireEvent.pointerDown(second, {
      button: 0,
      pointerId: 4,
      ctrlKey: true
    });
    await screen.findByRole("toolbar", {
      name: "Actions for 2 selected notes"
    });
    fireEvent.click(await screen.findByRole("button", { name: "Indent" }));

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          kind: "moveNodes",
          moves: [
            { id: "image", parentId: "bullet-1", beforeId: null },
            { id: "bullet-2", parentId: "bullet-1", beforeId: null }
          ]
        }
      })
    ));
  });

  it("duplicates image metadata structurally without importing bytes again", async () => {
    const notesApi = appApi();
    notesApi.bootstrap = vi.fn().mockResolvedValue(imageBoot());
    notesApi.readImage = vi.fn().mockResolvedValue(Uint8Array.from([1]));
    render(<App api={notesApi} />);
    await screen.findByRole("group", { name: "Image: cat.png" });

    fireEvent.click(screen.getByRole("button", {
      name: "Actions for cat.png"
    }));
    fireEvent.click(await screen.findByRole(
      "menuitem", { name: "Duplicate" }));

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          kind: "duplicate",
          id: "image",
          parent_id: "page-1",
          before_id: "bullet-2"
        })
      })
    ));
    expect(notesApi.importImageBytes).not.toHaveBeenCalled();
    expect(notesApi.importImagePaths).not.toHaveBeenCalled();
  });
});

// WebKit sends no copy or cut event to a focused div, so the station reads the
// chord itself. These run as a mac: the binding under test is the meta one.
describe("image clipboard chords at the caret station", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis.navigator, "platform", {
      value: "MacIntel",
      configurable: true
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis.navigator, "platform", {
      value: "",
      configurable: true
    });
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  async function stationOf(boot: BootSnapshot = imageBoot()) {
    const notesApi = selectableImageApi();
    notesApi.bootstrap = vi.fn().mockResolvedValue(boot);
    const write = stubClipboard();
    const view = render(<App api={notesApi} />);
    await screen.findByRole("group", { name: "Image: cat.png" });
    const station = view.container.querySelector<HTMLElement>(
      ".notes-image-caret-stop"
    )!;
    station.focus();
    return { notesApi, write, station };
  }

  it("copies the image on its own, with nothing selected", async () => {
    const { notesApi, write, station } = await stationOf();

    fireEvent.keyDown(station, { key: "c", metaKey: true });

    await waitFor(() => expect(write).toHaveBeenCalledOnce());
    const item = write.mock.calls[0]![0]![0] as FakeClipboardItem;
    expect((await item.data["image/png"])!.type).toBe("image/png");
    expect(notesApi.execute).not.toHaveBeenCalled();
  });

  // The chord answers on any image row, children and all, so the payload it
  // writes has to carry the subtree: a rich paste would otherwise bring the
  // picture back on its own and leave the caption behind.
  it("carries the image's own child in the payload it copies", async () => {
    const { write, station } = await stationOf(childBoot());

    fireEvent.keyDown(station, { key: "c", metaKey: true });

    await waitFor(() => expect(write).toHaveBeenCalledOnce());
    const item = write.mock.calls[0]![0]![0] as FakeClipboardItem;
    const html = await (await item.data["text/html"]!).text();
    const marker = "<!--yonalist-outline-clipboard:";
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(
      atob(html.slice(marker.length, html.indexOf("-->"))),
      (character: string) => character.charCodeAt(0)
    )));
    expect(payload.nodes).toEqual([expect.objectContaining({
      text: "cat.png",
      children: [expect.objectContaining({ text: "Caption thought" })]
    })]);
  });

  it("cuts a childless image on its own, with nothing selected", async () => {
    const { notesApi, write, station } = await stationOf();

    fireEvent.keyDown(station, { key: "x", metaKey: true });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { kind: "deleteSubtrees", ids: ["image"] }
      })
    ));
    expect(write).toHaveBeenCalledOnce();
  });

  // The caret was standing on the row that just went away, so it has to be
  // handed somewhere rather than dropped on the document.
  it("hands the caret to the row above the image it cut", async () => {
    const { notesApi, station } = await stationOf();

    fireEvent.keyDown(station, { key: "x", metaKey: true });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { kind: "deleteSubtrees", ids: ["image"] }
      })
    ));
    await waitFor(() => expect(
      screen.getByDisplayValue("First thought")
    ).toHaveFocus());
  });

  it("refuses to cut an image that carries a child", async () => {
    const { notesApi, write, station } = await stationOf(childBoot());

    fireEvent.keyDown(station, { key: "x", metaKey: true });

    await screen.findByText(/Cut is unavailable/u);
    expect(write).not.toHaveBeenCalled();
    expect(notesApi.execute).not.toHaveBeenCalled();
  });

  it("hands a selected image to the selection path, writing once", async () => {
    const { notesApi, write, station } = await stationOf();
    fireEvent.keyDown(station, { key: "ArrowRight", shiftKey: true });
    await waitFor(() => expect(notesApi.queryForest).toHaveBeenCalled());

    fireEvent.keyDown(station, { key: "c", metaKey: true });

    await screen.findByText("Copied image.");
    expect(write).toHaveBeenCalledOnce();
  });
});
