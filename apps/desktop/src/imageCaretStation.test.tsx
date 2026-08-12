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

async function renderImageOutline() {
  const notesApi = appApi();
  notesApi.bootstrap = vi.fn().mockResolvedValue(imageBoot());
  notesApi.readImage = vi.fn().mockResolvedValue(Uint8Array.from([1]));
  const view = render(<App api={notesApi} />);
  await screen.findByRole("group", { name: "Image: cat.png" });
  const station = view.container.querySelector<HTMLElement>(
    ".notes-image-caret-stop"
  );
  return { notesApi, view, station };
}

describe("image caret station", () => {
  it("stops on the image caret station when arrowing down from above",
    async () => {
      const { station } = await renderImageOutline();
      const first = screen.getByDisplayValue<HTMLTextAreaElement>(
        "First thought"
      );
      first.focus();

      fireEvent.keyDown(first, { key: "ArrowDown" });

      expect(station).toHaveFocus();
      expect(station).toHaveAttribute("data-node-id", "image");
    });

  it("leaves the station downward and comes back upward", async () => {
    const { station } = await renderImageOutline();
    const first = screen.getByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    const second = screen.getByDisplayValue<HTMLTextAreaElement>(
      "Second thought"
    );
    station!.focus();

    fireEvent.keyDown(station!, { key: "ArrowDown" });
    expect(second).toHaveFocus();

    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(station).toHaveFocus();

    fireEvent.keyDown(station!, { key: "ArrowUp" });
    expect(first).toHaveFocus();
  });

  it("creates a bullet below the image on Enter at the station", async () => {
    const { notesApi, station } = await renderImageOutline();
    station!.focus();

    fireEvent.keyDown(station!, { key: "Enter" });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          kind: "createNode",
          parent_id: "page-1",
          before_id: "bullet-2"
        })
      })
    ));
  });

  it("parks the caret at the station when the margin beside the image is clicked",
    async () => {
      const { view, station } = await renderImageOutline();
      const row = view.container.querySelector<HTMLElement>(
        ".notes-image-frame-row"
      );

      fireEvent.click(row!);

      expect(station).toHaveFocus();
    });
});
