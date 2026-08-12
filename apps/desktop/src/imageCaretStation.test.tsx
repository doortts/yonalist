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

/** The image carries a child, so a zoom into it has a body row to reach. */
function zoomBoot(): BootSnapshot {
  return {
    ...snapshot,
    viewport: {
      ...snapshot.viewport!,
      nodes: [
        snapshot.viewport!.nodes[0]!,
        imageNode,
        {
          ...snapshot.viewport!.nodes[1]!,
          id: "caption",
          parentId: "image",
          sortKey: 1_024,
          text: "Caption thought"
        }
      ]
    }
  };
}

async function renderZoomedImage() {
  const notesApi = appApi();
  notesApi.bootstrap = vi.fn().mockResolvedValue(zoomBoot());
  notesApi.readImage = vi.fn().mockResolvedValue(Uint8Array.from([1]));
  const view = render(<App api={notesApi} />);
  await screen.findByRole("group", { name: "Image: cat.png" });

  fireEvent.click(screen.getAllByRole("button", { name: "Zoom to item" })[1]!);
  const headerStation = () => view.container.querySelector<HTMLElement>(
    ".notes-page-header .notes-image-caret-stop"
  );
  await waitFor(() => expect(headerStation()).not.toBeNull());
  return { notesApi, view, station: headerStation() };
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

function stations(view: { container: HTMLElement }): readonly HTMLElement[] {
  return [...view.container.querySelectorAll<HTMLElement>(
    ".notes-outline-list .notes-image-caret-stop"
  )];
}

describe("image caret station", () => {
  it("parks a station on each side of the image", async () => {
    const { view } = await renderImageOutline();

    const sides = stations(view);
    expect(sides.map((side) => side.dataset.imageEdge))
      .toEqual(["before", "after"]);
    sides.forEach((side) =>
      expect(side).toHaveAttribute("data-node-id", "image"));
  });

  it("steps caret, image, caret before it leaves the row", async () => {
    const { view } = await renderImageOutline();
    const [before, after] = stations(view);
    const picture = screen.getByRole("group", { name: "Image: cat.png" });
    const first = screen.getByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    const second = screen.getByDisplayValue<HTMLTextAreaElement>(
      "Second thought"
    );
    first.focus();

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(before).toHaveFocus();

    fireEvent.keyDown(before!, { key: "ArrowRight" });
    expect(picture).toHaveFocus();

    fireEvent.keyDown(picture, { key: "ArrowRight" });
    expect(after).toHaveFocus();

    fireEvent.keyDown(after!, { key: "ArrowRight" });
    expect(second).toHaveFocus();

    fireEvent.keyDown(second, { key: "ArrowLeft" });
    expect(after).toHaveFocus();

    fireEvent.keyDown(after!, { key: "ArrowLeft" });
    expect(picture).toHaveFocus();

    fireEvent.keyDown(picture, { key: "ArrowLeft" });
    expect(before).toHaveFocus();
  });

  // Tab belongs to the fields; the outline's own rows are not tab stops either.
  it("keeps the image out of the tab order", async () => {
    await renderImageOutline();

    expect(screen.getByRole("group", { name: "Image: cat.png" }))
      .toHaveAttribute("tabindex", "-1");
  });

  it("takes the image with a shifted arrow and collapses back off it",
    async () => {
      const { view } = await renderImageOutline();
      const [before, after] = stations(view);
      const row = view.container.querySelector<HTMLElement>(
        '.notes-node[data-outline-id="image"]'
      );
      before!.focus();

      fireEvent.keyDown(before!, { key: "ArrowRight", shiftKey: true });

      expect(row).toHaveAttribute("data-range-selected", "true");
      // The row band is the wrong shape for one image; the image itself carries
      // the selection instead.
      expect(row).toHaveAttribute("data-solo-image-selection", "true");

      fireEvent.keyDown(before!, { key: "ArrowRight" });

      expect(row).not.toHaveAttribute("data-range-selected");
      expect(after).toHaveFocus();
    });

  it("collapses a selected image back to the side the arrow names",
    async () => {
      const { view } = await renderImageOutline();
      const [before, after] = stations(view);
      const row = view.container.querySelector<HTMLElement>(
        '.notes-node[data-outline-id="image"]'
      );
      after!.focus();

      fireEvent.keyDown(after!, { key: "ArrowLeft", shiftKey: true });
      expect(row).toHaveAttribute("data-range-selected", "true");

      fireEvent.keyDown(after!, { key: "ArrowLeft" });

      expect(row).not.toHaveAttribute("data-range-selected");
      expect(before).toHaveFocus();
    });

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

  it("arrows off the zoomed image header onto the first body row", async () => {
    const { station } = await renderZoomedImage();
    expect(station).toHaveAttribute("data-node-id", "image");

    station!.focus();
    fireEvent.keyDown(station!, { key: "ArrowDown" });

    expect(screen.getByDisplayValue("Caption thought")).toHaveFocus();
  });

  it("creates a first child from the zoomed image header on Enter", async () => {
    const { notesApi, station } = await renderZoomedImage();
    station!.focus();

    fireEvent.keyDown(station!, { key: "Enter" });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          kind: "createNode",
          parent_id: "image",
          before_id: "caption"
        })
      })
    ));
  });

  it("parks the caret past the image when the margin beside it is clicked",
    async () => {
      const { view } = await renderImageOutline();
      const row = view.container.querySelector<HTMLElement>(
        ".notes-image-frame-row"
      );

      fireEvent.click(row!);

      expect(stations(view)[1]).toHaveFocus();
    });
});
