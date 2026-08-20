import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { ImageNodeContent } from "./ImageNodeContent";
import { ImageResidency } from "./imageResidency";
import type { NotesStore } from "../notesStore";

const imageActionMocks = vi.hoisted(() => ({
  replace: vi.fn().mockResolvedValue(undefined),
  viewOriginal: vi.fn().mockResolvedValue(undefined),
  download: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("./imageActions", () => ({
  replaceImageFromPicker: imageActionMocks.replace,
  viewImageOriginal: imageActionMocks.viewOriginal,
  downloadImage: imageActionMocks.download
}));

function node(): NoteView {
  return {
    id: "image-1",
    parentId: "page-1",
    sortKey: 1_024,
    kind: "image",
    image: {
      contentHash: "a".repeat(64),
      originalName: "cat.png",
      mimeType: "image/png",
      byteLength: 3,
      pixelWidth: 640,
      pixelHeight: 480,
      displayWidth: 320
    },
    text: "cat.png",
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

describe("ImageNodeContent", () => {
  it("renders a lazy resident image without exposing its hidden filename as text", async () => {
    const residency = new ImageResidency(
      vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3])),
      {
        createObjectURL: vi.fn(() => "blob:cat"),
        revokeObjectURL: vi.fn()
      }
    );

    const view = render(
      <ImageNodeContent node={node()} residency={residency} />
    );

    expect(screen.queryByText("cat.png")).not.toBeInTheDocument();
    const image = await screen.findByRole("img", { name: "cat.png" });
    expect(image).toHaveAttribute("src", "blob:cat");
    expect(view.container.querySelector(".notes-image-attachment-frame"))
      .toHaveStyle({ width: "320px", aspectRatio: "640 / 480" });
  });

  it("shows the existing unavailable state when verified reading fails", async () => {
    const residency = new ImageResidency(
      vi.fn().mockRejectedValue(new Error("hash mismatch")),
      {
        createObjectURL: vi.fn(),
        revokeObjectURL: vi.fn()
      }
    );

    render(<ImageNodeContent node={node()} residency={residency} />);

    await waitFor(() =>
      expect(screen.getByRole("alert", { name: "Image unavailable: cat.png" }))
        .toHaveTextContent("Image unavailable")
    );
  });

  it("paints resize locally and commits one width at gesture end", async () => {
    const residency = new ImageResidency(
      vi.fn().mockResolvedValue(Uint8Array.from([1])),
      {
        createObjectURL: vi.fn(() => "blob:cat"),
        revokeObjectURL: vi.fn()
      }
    );
    const resize = vi.fn().mockResolvedValue(undefined);
    const store = {
      images: { resize },
      deleteSubtree: vi.fn()
    } as unknown as NotesStore;
    render(
      <ImageNodeContent node={node()} residency={residency} store={store} />
    );
    const handle = await screen.findByRole("separator", {
      name: "Resize cat.png"
    });

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 7,
      clientX: 320
    });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 400 });
    expect(resize).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 400 });

    // One commit, and ungrouped: a drag is already a single undo step.
    await waitFor(() =>
      expect(resize).toHaveBeenCalledWith("image-1", 400, null));
    expect(resize).toHaveBeenCalledOnce();
  });

  it("marks the handle while a pointer resize is in flight", async () => {
    const residency = new ImageResidency(
      vi.fn().mockResolvedValue(Uint8Array.from([1])),
      {
        createObjectURL: vi.fn(() => "blob:cat"),
        revokeObjectURL: vi.fn()
      }
    );
    const store = {
      images: { resize: vi.fn().mockResolvedValue(undefined) },
      deleteSubtree: vi.fn()
    } as unknown as NotesStore;
    render(
      <ImageNodeContent node={node()} residency={residency} store={store} />
    );
    const handle = await screen.findByRole("separator", {
      name: "Resize cat.png"
    });

    fireEvent.pointerDown(handle, { button: 0, pointerId: 9, clientX: 320 });
    expect(handle).toHaveAttribute("data-resizing", "true");

    fireEvent.pointerUp(handle, { pointerId: 9, clientX: 360 });
    expect(handle).not.toHaveAttribute("data-resizing");
  });

  it("gives the caret station a role that carries its name", async () => {
    const residency = new ImageResidency(
      vi.fn().mockResolvedValue(Uint8Array.from([1])),
      {
        createObjectURL: vi.fn(() => "blob:cat"),
        revokeObjectURL: vi.fn()
      }
    );
    render(
      <ImageNodeContent
        node={node()}
        residency={residency}
        onKeyDown={vi.fn()}
      />
    );

    await screen.findByRole("img", { name: "cat.png" });

    expect(screen.getByRole("group", { name: "Cursor after cat.png" }))
      .toHaveClass("notes-image-caret-stop");
  });

  it("takes the node selection when the image itself is clicked", async () => {
    const residency = new ImageResidency(
      vi.fn().mockResolvedValue(Uint8Array.from([1])),
      {
        createObjectURL: vi.fn(() => "blob:cat"),
        revokeObjectURL: vi.fn()
      }
    );
    const view = render(
      <ImageNodeContent node={node()} residency={residency} />
    );

    fireEvent.click(await screen.findByRole("img", { name: "cat.png" }));

    expect(view.container.querySelector(".notes-image-node-content"))
      .toHaveFocus();
  });

  it("keeps the caret station on a surface with no key handler", async () => {
    const residency = new ImageResidency(
      vi.fn().mockResolvedValue(Uint8Array.from([1])),
      {
        createObjectURL: vi.fn(() => "blob:cat"),
        revokeObjectURL: vi.fn()
      }
    );
    const view = render(
      <ImageNodeContent node={node()} residency={residency} />
    );
    await screen.findByRole("img", { name: "cat.png" });

    expect(view.container.querySelector(".notes-image-caret-stop"))
      .toHaveAttribute("data-outline-field", "image");
  });

  it("drops the drag flag when the width changes mid-drag", async () => {
    const residency = new ImageResidency(
      vi.fn().mockResolvedValue(Uint8Array.from([1])),
      {
        createObjectURL: vi.fn(() => "blob:cat"),
        revokeObjectURL: vi.fn()
      }
    );
    const store = {
      images: { resize: vi.fn().mockResolvedValue(undefined) },
      deleteSubtree: vi.fn()
    } as unknown as NotesStore;
    const view = render(
      <ImageNodeContent node={node()} residency={residency} store={store} />
    );
    const handle = await screen.findByRole("separator", {
      name: "Resize cat.png"
    });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 11, clientX: 320 });

    // An undo landing mid-drag replaces the width the drag started from.
    const undone = node();
    view.rerender(
      <ImageNodeContent
        node={{ ...undone, image: { ...undone.image!, displayWidth: 240 } }}
        residency={residency}
        store={store}
      />
    );
    fireEvent.pointerUp(handle, { pointerId: 11, clientX: 360 });

    expect(handle).not.toHaveAttribute("data-resizing");
  });

  it("keeps a run of keyboard nudges in one undo step", async () => {
    const residency = new ImageResidency(
      vi.fn().mockResolvedValue(Uint8Array.from([1])),
      {
        createObjectURL: vi.fn(() => "blob:cat"),
        revokeObjectURL: vi.fn()
      }
    );
    const resize = vi.fn().mockResolvedValue(undefined);
    const store = {
      images: { resize },
      deleteSubtree: vi.fn()
    } as unknown as NotesStore;
    render(
      <ImageNodeContent node={node()} residency={residency} store={store} />
    );
    const handle = await screen.findByRole("separator", {
      name: "Resize cat.png"
    });

    for (let press = 0; press < 3; press += 1) {
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      fireEvent.keyUp(handle, { key: "ArrowRight" });
    }
    await waitFor(() => expect(resize).toHaveBeenCalledTimes(3));
    const runGroups = resize.mock.calls.map((call) => call[2]);
    expect(runGroups.every((group) => typeof group === "string")).toBe(true);
    expect(new Set(runGroups).size).toBe(1);

    // Leaving the handle ends the run, so the next nudge undoes on its own.
    fireEvent.blur(handle);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyUp(handle, { key: "ArrowRight" });

    await waitFor(() => expect(resize).toHaveBeenCalledTimes(4));
    expect(resize.mock.calls[3]![2]).not.toBe(runGroups[0]);
  });

  it("opens full-screen with the resident URL and deletes through the node command", async () => {
    const residency = new ImageResidency(
      vi.fn().mockResolvedValue(Uint8Array.from([1])),
      {
        createObjectURL: vi.fn(() => "blob:cat"),
        revokeObjectURL: vi.fn()
      }
    );
    const deleteSubtree = vi.fn().mockResolvedValue(undefined);
    const store = {
      images: { resize: vi.fn() },
      deleteSubtree
    } as unknown as NotesStore;
    render(
      <ImageNodeContent node={node()} residency={residency} store={store} />
    );
    await screen.findByRole("img", { name: "cat.png" });

    fireEvent.click(screen.getByRole("button", {
      name: "Image actions for cat.png"
    }));
    fireEvent.click(screen.getByRole("menuitem", {
      name: "Show full-screen"
    }));
    expect(screen.getAllByRole("img", { name: "cat.png" }))
      .toHaveLength(2);
    fireEvent.click(screen.getByRole("button", {
      name: "Close full-screen image"
    }));

    fireEvent.click(screen.getByRole("button", {
      name: "Image actions for cat.png"
    }));
    fireEvent.click(screen.getByRole("menuitem", {
      name: "Move to Trash"
    }));
    expect(deleteSubtree).toHaveBeenCalledWith("image-1");
  });

  it("opens the same resident image from double-click without another read", async () => {
    const read = vi.fn().mockResolvedValue(Uint8Array.from([1]));
    const residency = new ImageResidency(read, {
      createObjectURL: vi.fn(() => "blob:cat"),
      revokeObjectURL: vi.fn()
    });
    render(<ImageNodeContent node={node()} residency={residency} />);
    const image = await screen.findByRole("img", { name: "cat.png" });

    fireEvent.doubleClick(image);

    expect(screen.getAllByRole("img", { name: "cat.png" })).toHaveLength(2);
    expect(read).toHaveBeenCalledOnce();
  });

  it("supports keyboard menu navigation and routes every file action", async () => {
    imageActionMocks.replace.mockClear();
    imageActionMocks.viewOriginal.mockClear();
    imageActionMocks.download.mockClear();
    const residency = new ImageResidency(
      vi.fn().mockResolvedValue(Uint8Array.from([1])),
      {
        createObjectURL: vi.fn(() => "blob:cat"),
        revokeObjectURL: vi.fn()
      }
    );
    const store = {
      images: { resize: vi.fn() },
      deleteSubtree: vi.fn()
    } as unknown as NotesStore;
    render(
      <ImageNodeContent node={node()} residency={residency} store={store} />
    );
    const trigger = screen.getByRole("button", {
      name: "Image actions for cat.png"
    });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Show full-screen" }))
      .toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    for (const [label, action] of [
      ["Replace image", imageActionMocks.replace],
      ["View original", imageActionMocks.viewOriginal],
      ["Download", imageActionMocks.download]
    ] as const) {
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
      await waitFor(() => expect(action).toHaveBeenCalledOnce());
    }
    expect(imageActionMocks.replace).toHaveBeenCalledWith(store, "image-1");
    expect(imageActionMocks.viewOriginal)
      .toHaveBeenCalledWith(store, "image-1", "image/png");
    expect(imageActionMocks.download)
      .toHaveBeenCalledWith(store, "image-1", "cat.png", "image/png");
  });
  // The menu sits inside this row and the lightbox is a portal of it, so keys
  // from either bubble through the React tree into the row's own handler. The
  // row answers Backspace by deleting the picture, which is no answer to a key
  // aimed at the layer standing over it.
  it("suspends the row's key surface while a layer is open", async () => {
    const residency = new ImageResidency(
      vi.fn().mockResolvedValue(Uint8Array.from([1])),
      {
        createObjectURL: vi.fn(() => "blob:cat"),
        revokeObjectURL: vi.fn()
      }
    );
    const store = {
      images: { resize: vi.fn() },
      deleteSubtree: vi.fn()
    } as unknown as NotesStore;
    const onKeyDown = vi.fn();
    render(
      <ImageNodeContent
        node={node()}
        residency={residency}
        store={store}
        onKeyDown={onKeyDown}
      />
    );
    const image = await screen.findByRole("img", { name: "cat.png" });
    const trigger = screen.getByRole("button", {
      name: "Image actions for cat.png"
    });

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Backspace" });
    expect(onKeyDown).not.toHaveBeenCalled();

    // Closed again, the row hears its own keys as it always did.
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.keyDown(
      screen.getByRole("group", { name: "Cursor after cat.png" }),
      { key: "Backspace" }
    );
    expect(onKeyDown).toHaveBeenCalledOnce();

    fireEvent.doubleClick(image);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Backspace" });
    expect(onKeyDown).toHaveBeenCalledOnce();
  });
});
