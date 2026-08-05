import type {
  KeyboardEvent,
  PointerEvent
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { OutlineIndex } from "./outlineIndex";
import type { OutlineTagToken } from "./OutlineTextField";
import type { SelectionKeyboardActions } from "./outlineSupport";

export interface OutlineRowRuntimeState {
  readonly nodes: readonly NoteView[];
  readonly visibleNodes: readonly NoteView[];
  readonly index: OutlineIndex;
  readonly visibleIndex: OutlineIndex;
  readonly pageId: string;
  readonly selectionHeadId: string | null;
  readonly hasSelection: boolean;
  readonly onZoom: (nodeId: string, split: boolean) => void;
  readonly onZoomOut: () => void;
  readonly onExtendSelection: (originId: string, headId: string) => void;
  readonly onClearSelection: () => void;
  readonly onTagClick: (token: OutlineTagToken) => void;
  readonly onPickImage: (nodeId: string) => void;
  readonly selectionActions: SelectionKeyboardActions;
  readonly onDragHandlePointerDown: (
    nodeId: string,
    event: PointerEvent<HTMLButtonElement>
  ) => void;
  readonly onDragHandleKeyDown: (
    nodeId: string,
    event: KeyboardEvent<HTMLButtonElement>
  ) => void;
  readonly consumeDragHandleClick: (nodeId: string) => boolean;
}

export class OutlineRowRuntime {
  private state: OutlineRowRuntimeState | null = null;

  update(state: OutlineRowRuntimeState): void {
    this.state = state;
  }

  read(): OutlineRowRuntimeState {
    if (!this.state) throw new Error("Outline row runtime is not ready.");
    return this.state;
  }
}
