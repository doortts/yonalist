import { afterEach, describe, expect, it, vi } from "vitest";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { outlineClipboardActions } from "./outlineClipboardActions";
import {
  CUT_OVER_CLIPBOARD_BOUNDS, MAX_TEXT_UTF8_BYTES, OUTLINE_WINDOW_INCOMPLETE
} from "./outlineClipboard";

function bullet(id: string, sortKey: number, parentId = "page"): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: "bullet",
    image: null,
    text: id,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

function picture(id: string, sortKey: number): NoteView {
  return {
    ...bullet(id, sortKey),
    kind: "image",
    text: "shot.png",
    image: {
      contentHash: "a".repeat(64),
      originalName: "shot.png",
      mimeType: "image/png",
      byteLength: 3,
      pixelWidth: 4,
      pixelHeight: 4,
      displayWidth: 320
    }
  };
}

/** jsdom has no ClipboardItem, so the written formats are read off this one. */
class FakeClipboardItem {
  constructor(readonly data: Record<string, Promise<Blob>>) {}
}

const SHOT = picture("shot", 2_048);
const BULLET = bullet("bullet-1", 1_024);
/** A child of the bullet, so a copy off that row has a subtree to carry. */
const KID = bullet("kid", 1_024, "bullet-1");
/** A caption under the picture that no clipboard payload can carry. */
const OVERSIZED_CAPTION = {
  ...bullet("caption", 1_024, "shot"),
  note: "x".repeat(MAX_TEXT_UTF8_BYTES + 1)
};

function harness({
  nodes = [BULLET, SHOT],
  selectedIds = [] as readonly string[],
  canCut = true,
  structuralContextComplete = true,
  copyToSystem = vi.fn<(required: boolean) => Promise<string | null>>()
    .mockResolvedValue(null),
  write = vi.fn().mockResolvedValue(undefined)
} = {}) {
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  Object.defineProperty(navigator, "clipboard", {
    value: { write },
    configurable: true
  });
  const feedback: string[] = [];
  const running: Promise<unknown>[] = [];
  const deleteSubtrees = vi.fn().mockResolvedValue(undefined);
  const deleteSelection = vi.fn().mockResolvedValue(undefined);
  const clearSelection = vi.fn();
  const takeCaret = vi.fn();
  const handOffCaret = vi.fn(() => takeCaret);
  const actions = outlineClipboardActions({
    store: {
      getSnapshot: () => ({ nodes, drafts: {}, noteDrafts: {} }),
      images: { read: () => Promise.resolve(Uint8Array.from([1, 2, 3])) },
      deleteSubtrees
    },
    selection: {
      selectedIds,
      selectedNodes: nodes.filter((node) => selectedIds.includes(node.id)),
      canCut,
      copyToSystem
    },
    index: { node: (id) => nodes.find((node) => node.id === id) },
    structuralContextComplete,
    setSelectionFeedback: (message: string) => feedback.push(message),
    runExclusive: (action) => {
      running.push(Promise.resolve().then(action));
    },
    clearSelection,
    deleteSelection,
    handOffCaret
  });
  return {
    actions,
    feedback,
    write,
    copyToSystem,
    deleteSubtrees,
    deleteSelection,
    clearSelection,
    takeCaret,
    handOffCaret,
    /** The work `runExclusive` took over, which is where a cut finishes. */
    settle: async () => {
      while (running.length > 0) await running.shift();
    },
    written: (at = 0) => (write.mock.calls[at][0][0] as FakeClipboardItem).data
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("outline clipboard actions", () => {
  it("copies a bullet band through the selection's own writer", async () => {
    const bench = harness({ selectedIds: ["bullet-1"] });

    await bench.actions.copySelection();

    expect(bench.copyToSystem).toHaveBeenCalledWith(false);
    expect(bench.write).not.toHaveBeenCalled();
    expect(bench.feedback).toEqual(["Copied selected outline."]);
  });

  it("names a bullet band the writer refused instead of claiming a copy", async () => {
    const bench = harness({
      selectedIds: ["bullet-1"],
      copyToSystem: vi.fn<(required: boolean) => Promise<string | null>>()
        .mockResolvedValue(CUT_OVER_CLIPBOARD_BOUNDS)
    });

    await bench.actions.copySelection();

    expect(bench.feedback)
      .toEqual(["Could not write the selected outline to the clipboard."]);
    expect(bench.write).not.toHaveBeenCalled();
  });

  it("copies one selected image row as the picture and its payload", async () => {
    const bench = harness({ selectedIds: ["shot"] });

    await bench.actions.copySelection();

    expect(bench.copyToSystem).not.toHaveBeenCalled();
    expect(Object.keys(bench.written())).toContain("text/html");
    expect(bench.feedback).toEqual(["Copied image."]);
  });

  it("treats a band that merely contains an image as a bullet band", async () => {
    const bench = harness({ selectedIds: ["bullet-1", "shot"] });

    await bench.actions.copySelection();

    expect(bench.copyToSystem).toHaveBeenCalledWith(false);
    expect(bench.write).not.toHaveBeenCalled();
  });

  it("copies an image whose subtree outruns the format as the picture alone", async () => {
    const bench = harness({
      nodes: [BULLET, SHOT, OVERSIZED_CAPTION],
      selectedIds: ["shot"]
    });

    await bench.actions.copySelection();

    expect(Object.keys(bench.written())).not.toContain("text/html");
    expect(bench.feedback).toEqual(["Copied image."]);
  });

  it("requires the payload before a bullet cut removes anything", async () => {
    const bench = harness({ selectedIds: ["bullet-1"] });

    await bench.actions.cutSelection();

    expect(bench.copyToSystem).toHaveBeenCalledWith(true);
    expect(bench.deleteSelection).toHaveBeenCalled();
    expect(bench.feedback).toEqual(["Cut selected outline."]);
  });

  it("keeps the rows when the bullet cut is refused over the bound", async () => {
    const bench = harness({
      selectedIds: ["bullet-1"],
      copyToSystem: vi.fn<(required: boolean) => Promise<string | null>>()
        .mockResolvedValue(CUT_OVER_CLIPBOARD_BOUNDS)
    });

    await bench.actions.cutSelection();

    expect(bench.deleteSelection).not.toHaveBeenCalled();
    expect(bench.feedback).toEqual([CUT_OVER_CLIPBOARD_BOUNDS]);
  });

  it("refuses an image cut whose subtree outruns the format", async () => {
    const bench = harness({
      nodes: [BULLET, SHOT, OVERSIZED_CAPTION],
      selectedIds: ["shot"]
    });

    await bench.actions.cutSelection();

    expect(bench.write).not.toHaveBeenCalled();
    expect(bench.deleteSelection).not.toHaveBeenCalled();
    expect(bench.feedback).toEqual([CUT_OVER_CLIPBOARD_BOUNDS]);
  });

  it("writes nothing when the selection itself cannot be cut", async () => {
    const bench = harness({ selectedIds: ["bullet-1"], canCut: false });

    await bench.actions.cutSelection();

    expect(bench.copyToSystem).not.toHaveBeenCalled();
    expect(bench.deleteSelection).not.toHaveBeenCalled();
    expect(bench.feedback).toEqual([]);
  });

  it("blames the write and removes nothing when the clipboard rejects", async () => {
    const bench = harness({
      selectedIds: ["shot"],
      write: vi.fn().mockRejectedValue(new Error("denied"))
    });

    await bench.actions.cutSelection();

    expect(bench.deleteSelection).not.toHaveBeenCalled();
    expect(bench.feedback).toEqual([
      "Could not write the image to the clipboard."
    ]);
  });

  it("names the outline when a bullet copy's write rejects", async () => {
    const bench = harness({
      selectedIds: ["bullet-1"],
      copyToSystem: vi.fn<(required: boolean) => Promise<string | null>>()
        .mockRejectedValue(new Error("denied"))
    });

    await bench.actions.copySelection();

    expect(bench.feedback).toEqual([
      "Could not write the selected outline to the clipboard."
    ]);
  });

  it("starts an image row's write inside the gesture that asked for it", async () => {
    const bench = harness();
    const done = vi.fn();

    bench.actions.putImageOnClipboard("shot", done);

    expect(bench.write).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    await bench.settle();
    expect(done).toHaveBeenCalled();
  });

  it("skips the follow-up work when an image row's write rejects", async () => {
    const bench = harness({
      write: vi.fn().mockRejectedValue(new Error("denied"))
    });
    const done = vi.fn();

    bench.actions.putImageOnClipboard("shot", done);
    await bench.settle();

    expect(done).not.toHaveBeenCalled();
    expect(bench.feedback).toEqual([
      "Could not write the image to the clipboard."
    ]);
  });

  it("cuts an image row and hands the caret on after the delete", async () => {
    const bench = harness();

    bench.actions.cutImageNode("shot");

    // The caret destination is read off the rows as they still stand, and the
    // write leaves inside the keydown -- both before anything is awaited.
    expect(bench.handOffCaret).toHaveBeenCalledWith(["shot"]);
    expect(bench.write).toHaveBeenCalledTimes(1);
    expect(bench.deleteSubtrees).not.toHaveBeenCalled();
    await bench.settle();
    expect(bench.deleteSubtrees).toHaveBeenCalledWith(["shot"]);
    expect(bench.clearSelection).toHaveBeenCalled();
    expect(bench.takeCaret).toHaveBeenCalled();
    expect(bench.feedback).toEqual(["Cut image."]);
  });

  it("refuses an image row cut while the outline window is partial", async () => {
    const bench = harness({ structuralContextComplete: false });

    bench.actions.cutImageNode("shot");
    await bench.settle();

    expect(bench.write).not.toHaveBeenCalled();
    expect(bench.handOffCaret).not.toHaveBeenCalled();
    expect(bench.deleteSubtrees).not.toHaveBeenCalled();
    expect(bench.feedback).toEqual([OUTLINE_WINDOW_INCOMPLETE]);
  });

  it("refuses an image row cut whose subtree outruns the format", async () => {
    const bench = harness({ nodes: [BULLET, SHOT, OVERSIZED_CAPTION] });

    bench.actions.cutImageNode("shot");
    await bench.settle();

    expect(bench.write).not.toHaveBeenCalled();
    expect(bench.deleteSubtrees).not.toHaveBeenCalled();
    expect(bench.feedback).toEqual([CUT_OVER_CLIPBOARD_BOUNDS]);
  });

  it("copies a caret row's subtree without a selection", async () => {
    const bench = harness({ nodes: [BULLET, KID, SHOT] });

    bench.actions.copyRow("bullet-1");
    await bench.settle();

    expect(bench.copyToSystem).not.toHaveBeenCalled();
    expect(bench.write).toHaveBeenCalledTimes(1);
    await expect((await bench.written()["text/plain"]).text())
      .resolves.toContain("kid");
    expect(bench.feedback).toEqual(["Copied selected outline."]);
  });

  it("names the outline when a caret row copy cannot write", async () => {
    const bench = harness({
      nodes: [BULLET, KID, SHOT],
      write: vi.fn().mockRejectedValue(new Error("denied"))
    });

    bench.actions.copyRow("bullet-1");
    await bench.settle();

    expect(bench.deleteSubtrees).not.toHaveBeenCalled();
    expect(bench.feedback).toEqual([
      "Could not write the selected outline to the clipboard."
    ]);
  });

  it("names the outline when a caret row outruns the format on copy", async () => {
    const bench = harness({
      nodes: [BULLET, { ...OVERSIZED_CAPTION, parentId: "bullet-1" }]
    });

    bench.actions.copyRow("bullet-1");
    await bench.settle();

    expect(bench.write).not.toHaveBeenCalled();
    expect(bench.feedback).toEqual([
      "Could not write the selected outline to the clipboard."
    ]);
  });

  it("refuses a caret row cut while the outline window is partial", async () => {
    const bench = harness({ structuralContextComplete: false });

    bench.actions.cutRow("bullet-1");
    await bench.settle();

    expect(bench.write).not.toHaveBeenCalled();
    expect(bench.handOffCaret).not.toHaveBeenCalled();
    expect(bench.deleteSubtrees).not.toHaveBeenCalled();
    expect(bench.feedback).toEqual([OUTLINE_WINDOW_INCOMPLETE]);
  });

  it("refuses a caret row cut whose subtree outruns the format", async () => {
    const bench = harness({
      nodes: [BULLET, { ...OVERSIZED_CAPTION, parentId: "bullet-1" }]
    });

    bench.actions.cutRow("bullet-1");
    await bench.settle();

    expect(bench.write).not.toHaveBeenCalled();
    expect(bench.deleteSubtrees).not.toHaveBeenCalled();
    expect(bench.feedback).toEqual([CUT_OVER_CLIPBOARD_BOUNDS]);
  });

  it("keeps the caret row when its cut write rejects", async () => {
    const bench = harness({
      write: vi.fn().mockRejectedValue(new Error("denied"))
    });

    bench.actions.cutRow("bullet-1");
    await bench.settle();

    expect(bench.deleteSubtrees).not.toHaveBeenCalled();
    expect(bench.takeCaret).not.toHaveBeenCalled();
    expect(bench.feedback).toEqual([
      "Could not write the selected outline to the clipboard."
    ]);
  });

  it("cuts a caret row and hands the caret on after the delete", async () => {
    const bench = harness({ nodes: [BULLET, KID, SHOT] });

    bench.actions.cutRow("bullet-1");

    // The caret destination is read off the rows as they still stand, and the
    // write leaves inside the keydown -- both before anything is awaited.
    expect(bench.handOffCaret).toHaveBeenCalledWith(["bullet-1"]);
    expect(bench.write).toHaveBeenCalledTimes(1);
    expect(bench.deleteSubtrees).not.toHaveBeenCalled();
    await bench.settle();
    expect(bench.deleteSubtrees).toHaveBeenCalledWith(["bullet-1"]);
    expect(bench.clearSelection).toHaveBeenCalled();
    expect(bench.takeCaret).toHaveBeenCalled();
    expect(bench.feedback).toEqual(["Cut selected outline."]);
  });

  it("blames the delete but keeps the copy when a caret row will not go", async () => {
    const bench = harness();
    bench.deleteSubtrees.mockRejectedValue(new Error("gone"));

    bench.actions.cutRow("bullet-1");
    await bench.settle();

    expect(bench.write).toHaveBeenCalledTimes(1);
    expect(bench.takeCaret).not.toHaveBeenCalled();
    expect(bench.feedback).toEqual([
      "Copied, but couldn't remove the selected outline."
    ]);
  });

  it("keeps an image row whose cut could not reach the clipboard", async () => {
    const bench = harness({
      write: vi.fn().mockRejectedValue(new Error("denied"))
    });

    bench.actions.cutImageNode("shot");
    await bench.settle();

    expect(bench.deleteSubtrees).not.toHaveBeenCalled();
    expect(bench.takeCaret).not.toHaveBeenCalled();
    expect(bench.feedback).toEqual([
      "Could not write the image to the clipboard."
    ]);
  });
});
