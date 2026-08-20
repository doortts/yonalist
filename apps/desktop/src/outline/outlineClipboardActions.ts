import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { writeImageClipboard } from "../image/imageClipboard";
import {
  buildOutlineClipboardFormats, CUT_OVER_CLIPBOARD_BOUNDS,
  OUTLINE_WINDOW_INCOMPLETE, writeOutlineClipboard
} from "./outlineClipboard";
import type { OutlineClipboardSource } from "./outlineClipboard";

/**
 * What copy and cut read the outline through. Structural on purpose: the pane's
 * store, selection and index satisfy it, and the branch matrix below is then
 * exercisable without a mounted pane.
 */
export interface OutlineClipboardCollaborators {
  readonly store: {
    readonly getSnapshot: () => OutlineClipboardSource;
    readonly images: { readonly read: (nodeId: string) => Promise<Uint8Array> };
    readonly deleteSubtrees: (ids: readonly string[]) => Promise<void>;
  };
  readonly selection: {
    readonly selectedIds: readonly string[];
    readonly selectedNodes: readonly NoteView[];
    readonly canCut: boolean;
    readonly copyToSystem: (
      payloadRequired: boolean
    ) => Promise<string | null>;
  };
  readonly index: { readonly node: (nodeId: string) => NoteView | undefined };
  readonly structuralContextComplete: boolean;
  readonly setSelectionFeedback: (message: string) => void;
  readonly runExclusive: (action: () => Promise<unknown> | unknown) => void;
  readonly clearSelection: () => void;
  readonly deleteSelection: () => Promise<void>;
  readonly handOffCaret: (rootIds: readonly string[]) => () => void;
}

export function outlineClipboardActions({
  store, selection, index, structuralContextComplete, setSelectionFeedback,
  runExclusive, clearSelection, deleteSelection, handOffCaret
}: OutlineClipboardCollaborators) {
  // One image on its own goes to the clipboard as the image, not as the line
  // its filename would serialize to.
  const selectedImage = selection.selectedIds.length === 1 &&
    selection.selectedNodes[0]?.kind === "image"
    ? selection.selectedNodes[0]
    : null;
  // The whole snapshot, not the row on its own: an image row can have children
  // and drafts of its own, and a payload built from `[node]` would paste the
  // picture back with its subtree missing. Undefined when the subtree runs past
  // what the clipboard format holds.
  const nodeClipboardHtml = (node: NoteView) =>
    buildOutlineClipboardFormats(store.getSnapshot(), [node.id])?.html;
  // The read promise goes straight into the write: WebKit refuses a clipboard
  // write that starts after the gesture that asked for it, so nothing may be
  // awaited between the key and `writeImageClipboard`.
  const writeNodeImage = (
    node: NoteView,
    // The row's own payload rides along, so pasting the image back here
    // restores the node by hash while other apps still get the picture.
    html = nodeClipboardHtml(node)
  ) => writeImageClipboard(
    store.images.read(node.id),
    node.image?.mimeType ?? "application/octet-stream",
    node.image?.originalName ?? node.text,
    html
  );
  // A copy may fall back to the picture alone -- nothing is lost either way.
  // A cut may not: the payload is the only thing that can bring the rows under
  // the image back, so without one there is nothing to delete against.
  const writeSelectionToClipboard = async (
    payloadRequired: boolean
  ): Promise<string | null> => {
    if (!selectedImage) return selection.copyToSystem(payloadRequired);
    const html = nodeClipboardHtml(selectedImage);
    if (!html && payloadRequired) return CUT_OVER_CLIPBOARD_BOUNDS;
    await writeNodeImage(selectedImage, html);
    return null;
  };
  const reportWriteFailure = () => setSelectionFeedback(selectedImage
    ? "Could not write the image to the clipboard."
    : "Could not write the selected outline to the clipboard.");
  const copySelection = async () => {
    try {
      // A copy deletes nothing, so a refusal and a failed write come to the
      // same thing here: the words that name the size belong to the Cut.
      if (await writeSelectionToClipboard(false)) {
        reportWriteFailure();
        return;
      }
      setSelectionFeedback(selectedImage
        ? "Copied image."
        : "Copied selected outline.");
    } catch {
      reportWriteFailure();
    }
  };
  const cutSelection = async () => {
    if (!selection.canCut) return;
    let refusal: string | null;
    try {
      refusal = await writeSelectionToClipboard(true);
    } catch {
      reportWriteFailure();
      return;
    }
    if (refusal) {
      setSelectionFeedback(refusal);
      return;
    }
    try {
      await deleteSelection();
      setSelectionFeedback("Cut selected outline.");
    } catch {
      setSelectionFeedback("Copied, but couldn't remove the selected outline.");
    }
  };
  // The caret's own row when nothing is selected: the same subtree serializer a
  // one-row band runs, plus the caret handoff and the feedback line the row
  // menu's Copy and Cut never had. The write starts inside the keydown for the
  // same reason `putImageOnClipboard` does.
  const rowFormats = (nodeId: string) => index.node(nodeId)
    ? buildOutlineClipboardFormats(store.getSnapshot(), [nodeId])
    : undefined;
  const copyRow = (nodeId: string) => {
    const formats = rowFormats(nodeId);
    // A copy asks for no window gate: it deletes nothing, so it loses nothing
    // that was not already off screen. Only the size can turn it down.
    if (!formats) return reportWriteFailure();
    const written = writeOutlineClipboard(formats, false)
      .then(() => true, () => false);
    runExclusive(async () => {
      if (!await written) return reportWriteFailure();
      setSelectionFeedback("Copied selected outline.");
    });
  };
  const cutRow = (nodeId: string) => {
    if (!index.node(nodeId)) return;
    // The same gate `cutImageNode` reads: the payload is built from the loaded
    // window and the delete takes the whole subtree the server holds, so past
    // the window those two disagree.
    if (!structuralContextComplete) {
      setSelectionFeedback(OUTLINE_WINDOW_INCOMPLETE);
      return;
    }
    const formats = rowFormats(nodeId);
    if (!formats) {
      setSelectionFeedback(CUT_OVER_CLIPBOARD_BOUNDS);
      return;
    }
    const takeCaret = handOffCaret([nodeId]);
    const written = writeOutlineClipboard(formats, true)
      .then(() => true, () => false);
    runExclusive(async () => {
      if (!await written) return reportWriteFailure();
      try {
        await store.deleteSubtrees([nodeId]);
        clearSelection();
        takeCaret();
        setSelectionFeedback("Cut selected outline.");
      } catch {
        setSelectionFeedback(
          "Copied, but couldn't remove the selected outline."
        );
      }
    });
  };
  // A bullet gets its copy and cut as clipboard events; WebKit sends none to an
  // image row, so its own keydown lands here with nothing selected. The write
  // leaves inside that keydown -- only what follows it waits on the guard.
  const putImageOnClipboard = (
    nodeId: string,
    done: () => Promise<void> | void,
    html?: string
  ) => {
    const node = index.node(nodeId);
    if (!node) return;
    const written = writeNodeImage(node, html)
      .then(() => true, () => false);
    runExclusive(async () => {
      if (!await written) {
        setSelectionFeedback("Could not write the image to the clipboard.");
        return;
      }
      await done();
    });
  };
  // The refusals the rich payload replaced are gone, so a picture with a
  // caption under it cuts and pastes back with the caption. One guard survives
  // them: the payload beside the bytes is the only thing that brings those rows
  // back, so a subtree too big to carry is a subtree too big to delete.
  const cutImageNode = (nodeId: string) => {
    const node = index.node(nodeId);
    if (!node) return;
    // The payload is built from the loaded window, and the delete takes the
    // whole subtree the server holds: past the window those two disagree, so
    // this waits on the window being whole. The selection's own forest says
    // nothing here -- this row was never part of a selection.
    if (!structuralContextComplete) {
      setSelectionFeedback(OUTLINE_WINDOW_INCOMPLETE);
      return;
    }
    const html = nodeClipboardHtml(node);
    if (!html) {
      setSelectionFeedback(CUT_OVER_CLIPBOARD_BOUNDS);
      return;
    }
    const takeCaret = handOffCaret([nodeId]);
    putImageOnClipboard(nodeId, async () => {
      await store.deleteSubtrees([nodeId]);
      clearSelection();
      takeCaret();
      setSelectionFeedback("Cut image.");
    }, html);
  };
  return {
    selectedImage,
    copySelection,
    cutSelection,
    copyRow,
    cutRow,
    putImageOnClipboard,
    cutImageNode
  };
}
