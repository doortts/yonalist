import type { HistoryState } from "../../../../packages/contracts/generated/HistoryState";

export function previewHistory(
  undoDepth: number,
  redoDepth: number
): HistoryState {
  return {
    canUndo: undoDepth > 0,
    canRedo: redoDepth > 0,
    undoDepth,
    redoDepth
  };
}
