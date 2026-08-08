import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import {
  keepCaretRightOfInjectedText,
  readInjectedTextAttachment,
  registerOutlineContribution
} from "./internalAdapter";
import {
  bindImageIngest,
  type MonacoImageAnchor,
  type MonacoImageIngestPort,
  type MonacoImagePayload
} from "./imageIngest";
import type { OutlineMetadataSnapshot } from "./metadata";
import type { MonacoOutlineSession } from "./session";
import type { OutlineSlashMenuTracker } from "./slashMenu";
import { canApplyNativeBoundaryEdit } from "./structuralChanges";

export interface MonacoOutlinePaneBinding {
  activeNodeId(): string | null;
  handleBullet(nodeId: string, shiftKey: boolean): void;
  handleChevron(nodeId: string): void;
  /** The open `/` menu, which takes Enter and the arrows before Monaco. */
  readonly slashMenu: Pick<OutlineSlashMenuTracker, "handleKeyDown">;
}

export interface YonalistOutlineEditorBinding {
  readonly session: MonacoOutlineSession;
  readonly pane: MonacoOutlinePaneBinding;
  /** Absent until the host wires the store's image writes to the pane. */
  readonly images?: MonacoImageIngestPort;
}

export type OutlineCommandId =
  | "yonalist.outline.indent"
  | "yonalist.outline.outdent"
  | "yonalist.outline.toggleCompleted";

/** The subset of a keyboard event the note key contract reads. */
export interface OutlineNoteKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
}

export type OutlineNoteGesture =
  | { readonly kind: "openNote"; readonly nodeId: string }
  | { readonly kind: "titleEnd"; readonly nodeId: string }
  | {
      readonly kind: "nextTitle";
      readonly nodeId: string;
      readonly create: boolean;
    }
  | {
      readonly kind: "splitTitle";
      readonly nodeId: string;
      readonly column: number;
    }
  | { readonly kind: "removeNote"; readonly nodeId: string }
  | { readonly kind: "siblingBelow"; readonly nodeId: string }
  | { readonly kind: "block" };

export interface OutlineNoteCaret {
  setPosition(position: monaco.IPosition): void;
}

const CONTRIBUTION_ID = "yonalist.outline.contribution";
const CONTEXT_KEY = "yonalistOutlineEditor";
const NOTE_GESTURE_KEYS = new Set([
  "Enter",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "Backspace",
  "Tab"
]);
/** Named keys that rewrite a line; Enter belongs to the note gesture above. */
const TEXT_EDIT_KEYS = new Set(["Backspace", "Delete", "Tab"]);
let registered = false;
const bindings =
  new WeakMap<monaco.editor.ICodeEditor, YonalistOutlineEditorBinding>();

class YonalistOutlineContribution {
  dispose(): void {}
}

export function registerYonalistOutlinePlugin(): void {
  if (registered) return;
  registered = true;
  registerOutlineContribution(
    CONTRIBUTION_ID,
    YonalistOutlineContribution
  );
}

export function runOutlineCommand(
  command: OutlineCommandId,
  binding: YonalistOutlineEditorBinding
): boolean {
  if (!binding.session.canAcceptStructuralEdit()) return true;
  const nodeId = binding.pane.activeNodeId();
  if (!nodeId) return false;
  if (command === "yonalist.outline.indent") {
    binding.session.indent(nodeId);
  } else if (command === "yonalist.outline.outdent") {
    binding.session.outdent(nodeId);
  } else {
    binding.session.toggleCompleted(nodeId);
  }
  return true;
}

/**
 * The note key contract, read off the legacy oracle
 * (`resolveSupportingNoteKey`, outlineKeyboard.ts) and widened to the two
 * title-side gestures Monaco needs: Shift+Enter opens a run, and Enter on a
 * title that owns one cannot go native (it would land between the two).
 * Returns null when the key belongs to Monaco.
 */
export function resolveOutlineNoteGesture(input: {
  readonly event: OutlineNoteKeyEvent;
  readonly snapshot: OutlineMetadataSnapshot;
  readonly selection: monaco.Selection;
  readonly lineText: string;
}): OutlineNoteGesture | null {
  const { event, snapshot, selection } = input;
  if (event.isComposing || event.key === "Process") return null;
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const line = snapshot.lines[selection.positionLineNumber - 1];
  if (!line) return null;
  const run = snapshot.noteRangeByNodeId.get(line.nodeId);

  if (event.key === "Enter") {
    if (line.kind === "image") {
      // An image node owns no note, and its caption never splits: plain Enter
      // is a new empty sibling below it (design §2a).
      return event.shiftKey || !selection.isEmpty()
        ? { kind: "block" }
        : { kind: "siblingBelow", nodeId: line.nodeId };
    }
    if (event.shiftKey) {
      return line.kind === "note"
        ? { kind: "nextTitle", nodeId: line.nodeId, create: true }
        : { kind: "openNote", nodeId: line.nodeId };
    }
    if (line.kind !== "text" || !run) return null;
    return selection.isEmpty()
      ? {
          kind: "splitTitle",
          nodeId: line.nodeId,
          column: selection.positionColumn
        }
      : { kind: "block" };
  }

  if (line.kind !== "note" || !run) return null;
  // A note is plain text with no structure of its own (design §2a).
  if (event.key === "Tab") return { kind: "block" };
  if (event.shiftKey) return null;
  if (event.key === "Escape") return { kind: "titleEnd", nodeId: line.nodeId };
  if (!selection.isEmpty()) return null;
  const lineNumber = selection.positionLineNumber;
  const atRunStart = lineNumber === run[0] && selection.positionColumn === 1;
  if (event.key === "ArrowUp") {
    return atRunStart ? { kind: "titleEnd", nodeId: line.nodeId } : null;
  }
  if (event.key === "ArrowDown") {
    return lineNumber === run[1] &&
      selection.positionColumn === input.lineText.length + 1
      ? { kind: "nextTitle", nodeId: line.nodeId, create: false }
      : null;
  }
  if (event.key === "Backspace" && atRunStart) {
    // An empty run disappears; a filled one only sends the caret home.
    return run[0] === run[1] && input.lineText.length === 0
      ? { kind: "removeNote", nodeId: line.nodeId }
      : { kind: "titleEnd", nodeId: line.nodeId };
  }
  return null;
}

/**
 * An image node's text is its filename, assigned once at creation, and
 * notes-core refuses `UpdateText` on one — so an image line is read-only here.
 * True for every gesture that would rewrite a line the caret or selection
 * touches; navigation, selection, copy and the outline commands read false.
 * Enter is absent on purpose: the note gesture already turns it into the new
 * sibling below, which leaves the caption alone.
 */
export function refusesImageLineEdit(input: {
  readonly event: OutlineNoteKeyEvent;
  readonly snapshot: OutlineMetadataSnapshot;
  readonly selection: monaco.Selection;
}): boolean {
  return writesText(input.event) &&
    touchesImageLine(input.snapshot, input.selection);
}

function writesText(event: OutlineNoteKeyEvent): boolean {
  // A composition types through the IME rather than through the key itself,
  // and refusing this keydown is the only moment that can stop it opening.
  if (event.isComposing || event.key === "Process") return true;
  if (TEXT_EDIT_KEYS.has(event.key)) return true;
  return !event.altKey && !event.ctrlKey && !event.metaKey &&
    event.key.length === 1;
}

function touchesImageLine(
  snapshot: OutlineMetadataSnapshot,
  selection: monaco.Selection
): boolean {
  for (
    let lineNumber = selection.startLineNumber;
    lineNumber <= selection.endLineNumber;
    lineNumber += 1
  ) {
    if (snapshot.lines[lineNumber - 1]?.kind === "image") return true;
  }
  return false;
}

export function applyOutlineNoteGesture(
  gesture: OutlineNoteGesture,
  session: MonacoOutlineSession,
  caret: OutlineNoteCaret
): void {
  if (gesture.kind === "block") return;
  if (gesture.kind === "openNote") {
    placeCaret(caret, session.createNote(gesture.nodeId));
    return;
  }
  if (gesture.kind === "splitTitle") {
    placeCaret(
      caret,
      session.splitTitleWithNote(gesture.nodeId, gesture.column)
    );
    return;
  }
  if (gesture.kind === "siblingBelow") {
    placeCaret(caret, session.createSiblingBelow(gesture.nodeId));
    return;
  }
  if (gesture.kind === "removeNote") {
    if (session.removeNote(gesture.nodeId)) {
      moveToTitleEnd(session, gesture.nodeId, caret);
    }
    return;
  }
  if (gesture.kind === "titleEnd") {
    moveToTitleEnd(session, gesture.nodeId, caret);
    return;
  }
  const snapshot = session.metadata.current();
  const run = snapshot.noteRangeByNodeId.get(gesture.nodeId);
  const titleLine = snapshot.titleLineByNodeId.get(gesture.nodeId);
  if (!run || titleLine === undefined) return;
  if (run[1] < session.model.getLineCount()) {
    placeCaret(caret, run[1] + 1);
    return;
  }
  // Nothing follows the run, so Shift+Enter has to make the next bullet: an
  // empty split at the title end puts it below the whole block.
  if (!gesture.create) return;
  placeCaret(
    caret,
    session.splitTitleWithNote(
      gesture.nodeId,
      session.model.getLineMaxColumn(titleLine)
    )
  );
}

export interface BoundYonalistOutlineEditor extends monaco.IDisposable {
  /** An image gesture the pane caught outside the editor: the OS file drop,
   * the header's picker, a row menu's. It anchors where the gesture says, or
   * at the active node when it says nothing. Rejects with what the import
   * refused on, so the pane can show it. */
  ingestImages(
    payload: MonacoImagePayload,
    at?: MonacoImageAnchor | null
  ): Promise<void>;
  /** Drag feedback for the OS drop the editor's own DOM never sees. */
  markImageDropPoint(at: MonacoImageAnchor | null): void;
}

export function bindYonalistOutlineEditor(
  editor: monaco.editor.IStandaloneCodeEditor,
  binding: YonalistOutlineEditorBinding
): BoundYonalistOutlineEditor {
  registerYonalistOutlinePlugin();
  bindings.set(editor, binding);
  const context = editor.createContextKey<boolean>(CONTEXT_KEY, true);
  const unbindSession = binding.session.bindEditor(editor);
  editor.addCommand(
    monaco.KeyCode.Tab,
    () => runOutlineCommand("yonalist.outline.indent", binding),
    CONTEXT_KEY
  );
  editor.addCommand(
    monaco.KeyMod.Shift | monaco.KeyCode.Tab,
    () => runOutlineCommand("yonalist.outline.outdent", binding),
    CONTEXT_KEY
  );
  editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
    () => runOutlineCommand("yonalist.outline.toggleCompleted", binding),
    CONTEXT_KEY
  );

  const keyboard = editor.onKeyDown((event) => {
    const browser = event.browserEvent;
    if (isBlockedStructuralGesture(event, editor, binding.session)) {
      refuse(event);
      return;
    }
    // The open menu owns Enter and the arrows: Monaco would split the line and
    // walk the caret out from under it.
    if (binding.pane.slashMenu.handleKeyDown(browser)) {
      refuse(event);
      return;
    }
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection) return;
    const snapshot = binding.session.metadata.current();
    if (NOTE_GESTURE_KEYS.has(browser.key)) {
      const gesture = resolveOutlineNoteGesture({
        event: browser,
        snapshot,
        selection,
        lineText: model.getLineContent(selection.positionLineNumber)
      });
      if (gesture) {
        refuse(event);
        applyOutlineNoteGesture(gesture, binding.session, editor);
        return;
      }
    }
    if (refusesImageLineEdit({ event: browser, snapshot, selection })) {
      refuse(event);
      return;
    }
    if (!replacesLineRange(model, selection, browser)) return;
    if (
      !canApplyNativeBoundaryEdit({
        snapshot,
        texts: readModelLines(model),
        selection,
        command: browser.key === "Backspace" ? "backspace" : "delete"
      })
    ) {
      refuse(event);
    }
  });
  const ingest = binding.images
    ? bindImageIngest(editor, {
        session: binding.session,
        port: binding.images,
        activeNodeId: () => binding.pane.activeNodeId()
      })
    : null;
  // The clipboard never passes the key gate — a menu paste carries no keydown
  // at all — so an image line refuses these directly. An image payload was
  // already taken by the ingest above, which creates a row instead of typing.
  const host = editor.getDomNode();
  const refuseClipboardWrite = (event: Event): void => {
    const selection = editor.getSelection();
    if (!selection) return;
    if (!touchesImageLine(binding.session.metadata.current(), selection)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  host?.addEventListener("paste", refuseClipboardWrite, true);
  host?.addEventListener("cut", refuseClipboardWrite, true);
  const caret = keepCaretRightOfInjectedText(editor);
  const mouse = editor.onMouseDown((event) => {
    const attachment = readInjectedTextAttachment(event);
    if (!attachment) return;
    event.event.preventDefault();
    event.event.stopPropagation();
    if (attachment.kind === "yonalist-chevron") {
      binding.pane.handleChevron(attachment.nodeId);
      return;
    }
    // The checkbox stands where the bullet would, and clicking it is the
    // React surface's `TodoCheckbox`: it completes the row, not zooms into it.
    if (attachment.kind === "yonalist-todo") {
      binding.session.toggleCompleted(attachment.nodeId);
      return;
    }
    binding.pane.handleBullet(
      attachment.nodeId,
      event.event.browserEvent.shiftKey
    );
  });

  return {
    ingestImages: async (payload, at) => ingest?.run(payload, at),
    markImageDropPoint: (at) => ingest?.markDropPoint(at),
    dispose: () => {
      host?.removeEventListener("paste", refuseClipboardWrite, true);
      host?.removeEventListener("cut", refuseClipboardWrite, true);
      mouse.dispose();
      caret.dispose();
      ingest?.dispose();
      keyboard.dispose();
      unbindSession();
      context.set(false);
      bindings.delete(editor);
    }
  };
}

function isBlockedStructuralGesture(
  event: monaco.IKeyboardEvent,
  editor: monaco.editor.IStandaloneCodeEditor,
  session: MonacoOutlineSession
): boolean {
  if (session.canAcceptStructuralEdit()) return false;
  const browser = event.browserEvent;
  if (browser.key === "Enter" || browser.key === "Tab") return true;
  if (
    browser.key.toLowerCase() === "v" &&
    (browser.ctrlKey || browser.metaKey)
  ) {
    return true;
  }
  if (browser.key !== "Backspace" && browser.key !== "Delete") return false;
  const selection = editor.getSelection();
  return Boolean(
    selection &&
    crossesLineBoundary(editor.getModel(), selection, browser.key)
  );
}

function refuse(event: monaco.IKeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function placeCaret(caret: OutlineNoteCaret, lineNumber: number | null): void {
  if (lineNumber !== null) caret.setPosition({ lineNumber, column: 1 });
}

function moveToTitleEnd(
  session: MonacoOutlineSession,
  nodeId: string,
  caret: OutlineNoteCaret
): void {
  const lineNumber = session.metadata.current().titleLineByNodeId.get(nodeId);
  if (lineNumber === undefined) return;
  caret.setPosition({
    lineNumber,
    column: session.model.getLineMaxColumn(lineNumber)
  });
}

/** Every gesture that deletes a line range needs the boundary verdict. */
function replacesLineRange(
  model: monaco.editor.ITextModel,
  selection: monaco.Selection,
  event: OutlineNoteKeyEvent
): boolean {
  if (event.key === "Backspace" || event.key === "Delete") {
    return crossesLineBoundary(model, selection, event.key);
  }
  const pasting =
    (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
  return (
    (event.key === "Enter" || pasting) &&
    selection.startLineNumber !== selection.endLineNumber
  );
}

function crossesLineBoundary(
  model: monaco.editor.ITextModel | null,
  selection: monaco.Selection,
  key: string
): boolean {
  if (!model) return false;
  if (selection.startLineNumber !== selection.endLineNumber) return true;
  if (!selection.isEmpty()) return false;
  if (key === "Backspace") {
    return selection.positionColumn === 1 &&
      selection.positionLineNumber > 1;
  }
  return selection.positionColumn ===
      model.getLineMaxColumn(selection.positionLineNumber) &&
    selection.positionLineNumber < model.getLineCount();
}

function readModelLines(
  model: monaco.editor.ITextModel
): readonly string[] {
  return Array.from(
    { length: model.getLineCount() },
    (_, index) => model.getLineContent(index + 1)
  );
}
