import type { NoteView } from "../../../../packages/contracts/generated/NoteView";

export interface OutlinePane {
  /** Every visible row of the pane, in visible order — model order, not
   * whatever happens to be mounted. */
  readonly visibleNodes: readonly NoteView[];
  /** Brings a row into the rendered window. False when the pane does not hold
   * that node at all. */
  readonly reveal: (nodeId: string) => boolean;
  /** The whole band, mounted rows and windowed-out rows alike. */
  readonly selectedIds: () => readonly string[];
  /**
   * Puts a band back, an empty list clearing it. The ids are the band's whole
   * forest, as `selectedIds` reports it.
   */
  readonly replaceSelection: (ids: readonly string[]) => void;
}

const panes = new WeakMap<HTMLElement, OutlinePane>();

export function registerOutlinePane(scope: HTMLElement, pane: OutlinePane): void {
  panes.set(scope, pane);
}

export function outlinePane(scope: HTMLElement): OutlinePane | undefined {
  return panes.get(scope);
}
