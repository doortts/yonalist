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

describe("image node structural parity", () => {
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

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
