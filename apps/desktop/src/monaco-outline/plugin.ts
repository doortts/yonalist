import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import {
  keepCaretRightOfInjectedText,
  readInjectedTextAttachment,
  registerOutlineContribution
} from "./internalAdapter";
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

const CONTRIBUTION_ID = "yonalist.outline.contribution";
const CONTEXT_KEY = "yonalistOutlineEditor";
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
    const key = event.browserEvent.key;
    if (isBlockedStructuralGesture(event, editor, binding.session)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (key !== "Backspace" && key !== "Delete") return;
    const selection = editor.getSelection();
    if (!selection || !crossesLineBoundary(editor.getModel(), selection, key)) {
      return;
    }
    const model = editor.getModel();
    if (
      !model ||
      !canApplyNativeBoundaryEdit({
        snapshot: binding.session.metadata.current(),
        texts: readModelLines(model),
        selection,
        command: key === "Backspace" ? "backspace" : "delete"
      })
    ) {
      event.preventDefault();
      event.stopPropagation();
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
