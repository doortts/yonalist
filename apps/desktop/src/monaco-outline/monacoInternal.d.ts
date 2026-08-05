declare module "monaco-editor/esm/vs/editor/browser/editorExtensions.js" {
  export class EditorCommand {}

  export function registerEditorCommand<T>(command: T): T;

  export function registerEditorContribution(
    id: string,
    ctor: new (...args: never[]) => unknown,
    instantiation: number
  ): void;
}

declare module "monaco-editor/esm/vs/editor/common/cursor/cursorMoveOperations.js" {
  export class MoveOperations {}
}

declare module "monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js" {
  export enum PositionAffinity {
    Left = 0,
    Right = 1,
    None = 2,
    LeftOfInjectedText = 3,
    RightOfInjectedText = 4
  }
}

declare module "monaco-editor/esm/vs/editor/common/core/range.js" {
  export { Range } from "monaco-editor/esm/vs/editor/editor.api";
}

declare module "monaco-editor/esm/vs/editor/common/cursorCommon.js" {
  export class SingleCursorState {
    constructor(
      selectionStart: import("monaco-editor/esm/vs/editor/editor.api").Range,
      selectionStartKind: number,
      selectionStartLeftoverVisibleColumns: number,
      position: import("monaco-editor/esm/vs/editor/editor.api").Position,
      leftoverVisibleColumns: number
    );
  }

  export class CursorState {
    static fromViewState(state: SingleCursorState): unknown;
  }
}

declare module "monaco-editor/esm/vs/platform/undoRedo/common/undoRedo.js" {
  export const IUndoRedoService: unknown;

  export class UndoRedoGroup {
    readonly id: number;
  }
}
