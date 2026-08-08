import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import {
  keepCaretRightOfInjectedText,
  readInjectedTextAttachment,
  registerOutlineContribution
} from "./internalAdapter";
import type { OutlineMetadataSnapshot } from "./metadata";
import type { MonacoOutlineSession } from "./session";
import { canApplyNativeBoundaryEdit } from "./structuralChanges";

export interface MonacoOutlinePaneBinding {
  activeNodeId(): string | null;
  handleBullet(nodeId: string, shiftKey: boolean): void;
  handleChevron(nodeId: string): void;
}

export interface YonalistOutlineEditorBinding {
  readonly session: MonacoOutlineSession;
  readonly pane: MonacoOutlinePaneBinding;
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
    if (line.kind === "image") return { kind: "block" };
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

export function bindYonalistOutlineEditor(
  editor: monaco.editor.IStandaloneCodeEditor,
  binding: YonalistOutlineEditorBinding
): monaco.IDisposable {
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
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection) return;
    if (NOTE_GESTURE_KEYS.has(browser.key)) {
      const gesture = resolveOutlineNoteGesture({
        event: browser,
        snapshot: binding.session.metadata.current(),
        selection,
        lineText: model.getLineContent(selection.positionLineNumber)
      });
      if (gesture) {
        refuse(event);
        applyOutlineNoteGesture(gesture, binding.session, editor);
        return;
      }
    }
    if (!replacesLineRange(model, selection, browser)) return;
    if (
      !canApplyNativeBoundaryEdit({
        snapshot: binding.session.metadata.current(),
        texts: readModelLines(model),
        selection,
        command: browser.key === "Backspace" ? "backspace" : "delete"
      })
    ) {
      refuse(event);
    }
  });
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
    binding.pane.handleBullet(
      attachment.nodeId,
      event.event.browserEvent.shiftKey
    );
  });

  return {
    dispose: () => {
      mouse.dispose();
      caret.dispose();
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
