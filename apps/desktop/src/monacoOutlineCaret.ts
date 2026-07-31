import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import type { MonacoOutlineProjection } from "./monacoOutlineProjection";

// Monaco publishes this enum through the full editor runtime. Keeping the
// value typed here avoids loading that runtime in caret unit tests.
const INJECTED_TEXT_CURSOR_STOP_RIGHT:
  monaco.editor.InjectedTextCursorStops = 1;

interface MonacoCaretPosition {
  readonly lineNumber: number;
  readonly column: number;
}

interface MonacoCaretEditor {
  getPosition(): MonacoCaretPosition | null;
  trigger(source: string, handlerId: string, payload: unknown): void;
}

export function scheduleMonacoOutlineCaretNormalization({
  editor,
  position,
  isCurrent,
  isCaretOnTextSide,
  hideCaret,
  showCaret,
  moveCaretToTextSide = () =>
    editor.trigger("yonalist-outline", "cursorRight", undefined),
  requestFrame = (callback) => requestAnimationFrame(callback)
}: {
  readonly editor: MonacoCaretEditor;
  readonly position: MonacoCaretPosition;
  readonly isCurrent: () => boolean;
  readonly isCaretOnTextSide: () => boolean;
  readonly hideCaret: () => void;
  readonly showCaret: () => void;
  readonly moveCaretToTextSide?: () => void;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
}): void {
  hideCaret();
  let attempts = 0;
  requestFrame(normalize);

  function normalize(): void {
    if (!isCurrent()) return;
    const current = editor.getPosition();
    if (
      current?.lineNumber !== position.lineNumber ||
      current.column !== position.column ||
      isCaretOnTextSide()
    ) {
      showCaret();
      return;
    }
    try {
      attempts += 1;
      moveCaretToTextSide();
    } catch {
      showCaret();
      return;
    }
    if (isCaretOnTextSide() || attempts >= 3) {
      showCaret();
      return;
    }
    requestFrame(normalize);
  }
}

export function isMonacoCaretOnTextSide(host: HTMLElement): boolean {
  const cursor = [...host.querySelectorAll<HTMLElement>(".cursor")]
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .find(({ rect }) => rect.width > 0 && rect.height > 0);
  if (!cursor) return false;
  const prefix = [
    ...host.querySelectorAll<HTMLElement>(
      ".notes-monaco-bullet-prefix, .notes-monaco-image-prefix"
    )
  ]
    .map((element) => element.getBoundingClientRect())
    .find(
      (rect) =>
        rect.top < cursor.rect.bottom &&
        rect.bottom > cursor.rect.top
    );
  return prefix !== undefined && cursor.rect.left >= prefix.right - 3;
}

export function buildMonacoOutlineDecorations(
  projection: MonacoOutlineProjection
): monaco.editor.IModelDeltaDecoration[] {
  return projection.lines.map((line, position) => ({
    range: {
      startLineNumber: position + 1,
      startColumn: 1,
      endLineNumber: position + 1,
      endColumn: 1
    },
    options: {
      before: {
        content: `${"\u00a0".repeat(line.depth * 4)}\u2022\u00a0\u00a0`,
        inlineClassName: line.editable
          ? "notes-monaco-bullet-prefix"
          : "notes-monaco-image-prefix",
        cursorStops: INJECTED_TEXT_CURSOR_STOP_RIGHT
      },
      showIfCollapsed: true,
      isWholeLine: true,
      className: line.editable ? undefined : "notes-monaco-image-line"
    }
  }));
}
