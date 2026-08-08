import type { NoteView } from "../../../packages/contracts/generated/NoteView";

export interface OutlinePane {
  /** Every visible row of the pane, in visible order — model order, not
   * whatever happens to be mounted. */
  readonly visibleNodes: readonly NoteView[];
  /** Brings a row into the rendered window. False when the pane does not hold
   * that node at all. */
  readonly reveal: (nodeId: string) => boolean;
}

const panes = new WeakMap<HTMLElement, OutlinePane>();

export function registerOutlinePane(scope: HTMLElement, pane: OutlinePane): void {
  panes.set(scope, pane);
}

export function outlinePane(scope: HTMLElement): OutlinePane | undefined {
  return panes.get(scope);
}
