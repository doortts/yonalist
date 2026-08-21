import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BootSnapshot } from "../../../../packages/contracts/generated/BootSnapshot";
import { App } from "../App";
import { appApi, snapshot } from "../test/appApiFixture";

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

/** Two pictures stacked, the shape a run of pasted screenshots makes. */
function stackedBoot(): BootSnapshot {
  return {
    ...snapshot,
    viewport: {
      ...snapshot.viewport!,
      nodes: [
        snapshot.viewport!.nodes[0]!,
        imageNode,
        {
          ...imageNode,
          id: "lower",
          sortKey: 2_560,
          text: "dog.png",
          image: { ...imageNode.image, originalName: "dog.png" }
        },
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

async function renderStackedImages() {
  const notesApi = appApi();
  notesApi.bootstrap = vi.fn().mockResolvedValue(stackedBoot());
  notesApi.readImage = vi.fn().mockResolvedValue(Uint8Array.from([1]));
  // The stock receipt reports nothing deleted, and a row that never leaves the
  // DOM cannot tell a caret that stayed from a caret nobody moved.
  notesApi.execute = vi.fn().mockImplementation(async (envelope) => ({
    revision: 8,
    changedNodes: [],
    deletedIds: envelope.command.kind === "deleteSubtree"
      ? [envelope.command.id]
      : [],
    history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
  }));
  const view = render(<App api={notesApi} />);
  await screen.findByRole("group", { name: "Image: dog.png" });
  return { notesApi, view };
}

function stations(
  view: { container: HTMLElement },
  nodeId?: string
): readonly HTMLElement[] {
  const stops = [...view.container.querySelectorAll<HTMLElement>(
    ".notes-outline-list .notes-image-caret-stop"
  )];
  return nodeId
    ? stops.filter((stop) => stop.dataset.nodeId === nodeId)
    : stops;
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

  // Taking one row anchors the band on it. A plain click leaves an anchor
  // behind with nothing selected, and growing from that one would hand back a
  // band reaching all the way to whichever row was clicked last.
  it("takes only the image after a click anchored another row", async () => {
    const { view } = await renderImageOutline();
    const [before] = stations(view);
    fireEvent.pointerDown(screen.getByDisplayValue("First thought"), {
      button: 0,
      pointerId: 21
    });
    fireEvent.pointerUp(screen.getByDisplayValue("First thought"), {
      pointerId: 21
    });
    before!.focus();

    fireEvent.keyDown(before!, { key: "ArrowRight", shiftKey: true });

    expect([...view.container.querySelectorAll<HTMLElement>(
      ".notes-node[data-range-selected='true']"
    )].map((row) => row.dataset.outlineId)).toEqual(["image"]);
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

  // The station's own caret hops would otherwise walk out from under a band
  // that reaches past the image, leaving it standing.
  it("drops a band reaching past the image before it hops a station",
    async () => {
      const { view } = await renderImageOutline();
      const [before] = stations(view);
      before!.focus();

      // Take the image, then the row below it: a band of two.
      fireEvent.keyDown(before!, { key: "ArrowDown", shiftKey: true });
      fireEvent.keyDown(before!, { key: "ArrowDown", shiftKey: true });
      expect([...view.container.querySelectorAll<HTMLElement>(
        ".notes-node[data-range-selected='true']"
      )].map((row) => row.dataset.outlineId)).toEqual(["image", "bullet-2"]);

      fireEvent.keyDown(before!, { key: "ArrowLeft" });

      expect(view.container.querySelector(
        ".notes-node[data-range-selected='true']"
      )).toBeNull();
      expect(before).toHaveFocus();
    });

  // The note field answers to none of the band's keys here either.
  it("drops a band off an image row when the caret leaves for its note",
    async () => {
      const { view } = await renderImageOutline();
      const [before] = stations(view);
      before!.focus();

      fireEvent.keyDown(before!, { key: "ArrowDown", shiftKey: true });
      fireEvent.keyDown(before!, { key: "ArrowDown", shiftKey: true });
      expect(view.container.querySelectorAll(
        ".notes-node[data-range-selected='true']"
      )).toHaveLength(2);

      fireEvent.keyDown(before!, { key: "Enter", shiftKey: true });

      expect(view.container.querySelector(
        ".notes-node[data-range-selected='true']"
      )).toBeNull();
      await waitFor(() => expect(view.container.querySelector(
        "textarea[data-node-id='image'][data-outline-field='note']"
      )).toHaveFocus());
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

  // The station the key came from unmounts with the row it deletes, so the
  // caret has to be handed on before it falls to the document body.
  it("deletes the image from the station past it and hands the caret up",
    async () => {
      const { notesApi, view } = await renderImageOutline();
      const [, after] = stations(view);
      after!.focus();

      fireEvent.keyDown(after!, { key: "Backspace" });

      await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.objectContaining({
            kind: "deleteSubtree",
            id: "image"
          })
        })
      ));
      await waitFor(() => expect(
        screen.getByDisplayValue("First thought")
      ).toHaveFocus());
    });
  // The row this key takes is not the row it stands on, so nothing unmounts
  // under the caret and nothing may move it. The held reference is the whole
  // point: the station has to be the same element afterwards, which is what
  // would break if these rows were ever keyed by position instead of by id.
  it("takes the image above from the before station and stands its ground",
    async () => {
      const { notesApi, view } = await renderStackedImages();
      const [before] = stations(view, "lower");
      before!.focus();

      fireEvent.keyDown(before!, { key: "Backspace" });

      await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.objectContaining({
            kind: "deleteSubtree",
            id: "image"
          })
        })
      ));
      await waitFor(() => expect(
        screen.queryByRole("group", { name: "Image: cat.png" })
      ).not.toBeInTheDocument());
      expect(screen.getByRole("group", { name: "Image: dog.png" }))
        .toBeInTheDocument();
      expect(before).toHaveFocus();
    });
});
