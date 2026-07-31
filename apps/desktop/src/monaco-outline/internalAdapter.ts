import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import {
  EditorCommand,
  registerEditorCommand,
  registerEditorContribution
} from "monaco-editor/esm/vs/editor/browser/editorExtensions.js";
import { MoveOperations } from "monaco-editor/esm/vs/editor/common/cursor/cursorMoveOperations.js";
import { PositionAffinity } from "monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js";
import {
  IUndoRedoService,
  UndoRedoGroup
} from "monaco-editor/esm/vs/platform/undoRedo/common/undoRedo.js";

export interface MonacoInternalCapabilities {
  readonly editorContribution: boolean;
  readonly editorCommand: boolean;
  readonly cursorAffinity: boolean;
  readonly hiddenAreas: boolean;
  readonly injectedMouseTarget: boolean;
  readonly metadataUndo: boolean;
}

export interface YonalistInjectedBulletAttachment {
  readonly kind: "yonalist-bullet";
  readonly nodeId: string;
}

export interface MetadataUndoElement {
  readonly resource: monaco.Uri;
  readonly label: string;
  readonly code: string;
  undo(): void | Promise<void>;
  redo(): void | Promise<void>;
}

interface PrivateCodeEditor {
  setHiddenAreas?(
    ranges: readonly monaco.IRange[],
    source: unknown,
    forceUpdate?: boolean
  ): void;
  invokeWithinContext?<T>(
    callback: (accessor: { get(service: unknown): unknown }) => T
  ): T;
}

interface UndoRedoService {
  pushElement(
    element: MetadataUndoElement & { readonly type: 0 },
    group: InstanceType<typeof UndoRedoGroup>
  ): void;
}

const capabilities: MonacoInternalCapabilities = Object.freeze({
  editorContribution: typeof registerEditorContribution === "function",
  editorCommand:
    typeof EditorCommand === "function" &&
    typeof registerEditorCommand === "function",
  cursorAffinity:
    typeof MoveOperations === "function" &&
    PositionAffinity.LeftOfInjectedText === 3 &&
    PositionAffinity.RightOfInjectedText === 4,
  hiddenAreas: true,
  injectedMouseTarget: true,
  metadataUndo:
    typeof UndoRedoGroup === "function" && IUndoRedoService !== undefined
});

export function readMonacoInternalCapabilities(): MonacoInternalCapabilities {
  return capabilities;
}

export function assertMonacoInternalCapabilities(): void {
  const missing = Object.entries(capabilities)
    .filter(([, available]) => !available)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `The pinned Monaco adapter is missing: ${missing.join(", ")}.`
    );
  }
}

export function setEditorHiddenAreas(
  editor: monaco.editor.ICodeEditor,
  ranges: readonly monaco.IRange[],
  sourceToken: string
): void {
  const privateEditor = editor as unknown as PrivateCodeEditor;
  if (typeof privateEditor.setHiddenAreas !== "function") {
    throw new Error("The pinned Monaco editor does not expose setHiddenAreas.");
  }
  privateEditor.setHiddenAreas(ranges, sourceToken, true);
}

export function readInjectedTextAttachment(
  event: unknown
): YonalistInjectedBulletAttachment | null {
  const attachedData = readPath(event, [
    "target",
    "detail",
    "injectedText",
    "options",
    "attachedData"
  ]);
  if (
    !isRecord(attachedData) ||
    attachedData.kind !== "yonalist-bullet" ||
    typeof attachedData.nodeId !== "string"
  ) {
    return null;
  }
  return {
    kind: "yonalist-bullet",
    nodeId: attachedData.nodeId
  };
}

export function registerOutlineContribution(
  id: string,
  ctor: new (...args: never[]) => { dispose(): void }
): string {
  registerEditorContribution(id, ctor, 0);
  return id;
}

export function moveWithInjectedTextAffinity<T>(
  direction: "left" | "right",
  operation: (
    moveOperations: typeof MoveOperations,
    affinity: PositionAffinity
  ) => T
): T {
  return operation(
    MoveOperations,
    direction === "left"
      ? PositionAffinity.LeftOfInjectedText
      : PositionAffinity.RightOfInjectedText
  );
}

export function pushMetadataUndo(
  editor: monaco.editor.ICodeEditor,
  element: MetadataUndoElement
): void {
  const privateEditor = editor as unknown as PrivateCodeEditor;
  if (typeof privateEditor.invokeWithinContext !== "function") {
    throw new Error(
      "The pinned Monaco editor does not expose its Undo/Redo service."
    );
  }
  privateEditor.invokeWithinContext((accessor) => {
    const service = accessor.get(IUndoRedoService) as UndoRedoService;
    if (typeof service?.pushElement !== "function") {
      throw new Error(
        "The pinned Monaco editor does not expose pushElement for metadata Undo."
      );
    }
    service.pushElement({ type: 0, ...element }, new UndoRedoGroup());
  });
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
