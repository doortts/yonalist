import { outlinePane } from "./outlinePaneRegistry";

export type PaneId = "primary" | "secondary";

export interface PaneFocusSnapshot {
  readonly nodeId: string;
  readonly field: "title" | "note";
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

/**
 * What one pane had selected and where its caret sat. Either half can stand
 * alone: a band lives on without a caret once a toolbar button takes focus,
 * and an ordinary edit has a caret with no band behind it.
 */
export interface PaneSnapshot {
  readonly paneId: PaneId;
  readonly selectedIds: readonly string[];
  readonly focus: PaneFocusSnapshot | null;
}

export interface AppNavigationLocation {
  readonly pageId: string | null;
  readonly primaryZoomRootId: string | null;
  readonly splitOpen: boolean;
  readonly secondaryZoomRootId: string | null;
  readonly primarySelectedIds: readonly string[];
  readonly primaryFocus: PaneFocusSnapshot | null;
  readonly secondarySelectedIds: readonly string[];
  readonly secondaryFocus: PaneFocusSnapshot | null;
}

export function paneScope(paneId: PaneId): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-outline-pane-id="${paneId}"]`
  );
}

function mountedSelectedIds(scope: HTMLElement): readonly string[] {
  return [...scope.querySelectorAll<HTMLElement>(
    "[data-outline-id][data-selected='true']"
  )].flatMap((node) => node.dataset.outlineId ? [node.dataset.outlineId] : []);
}

export function capturePane(paneId: PaneId): PaneSnapshot {
  const scope = paneScope(paneId);
  // The pane keeps the band, and only the pane: the rows are windowed, so
  // reading the band off the DOM would truncate it to whatever is on screen.
  // The rows answer for a pane that has not registered itself yet.
  const selectedIds = scope
    ? outlinePane(scope)?.selectedIds() ?? mountedSelectedIds(scope)
    : [];
  const active = document.activeElement;
  if (
    !scope ||
    !(active instanceof HTMLTextAreaElement) ||
    !scope.contains(active)
  ) {
    return { paneId, selectedIds, focus: null };
  }
  const nodeId = active.dataset.nodeId;
  const field = active.dataset.outlineField;
  const focus = nodeId && (field === "title" || field === "note")
    ? {
        nodeId,
        field,
        selectionStart: active.selectionStart,
        selectionEnd: active.selectionEnd
      } satisfies PaneFocusSnapshot
    : null;
  return { paneId, selectedIds, focus };
}

export function emptyPaneLocation(
  pageId: string | null
): AppNavigationLocation {
  return {
    pageId,
    primaryZoomRootId: null,
    splitOpen: false,
    secondaryZoomRootId: null,
    primarySelectedIds: [],
    primaryFocus: null,
    secondarySelectedIds: [],
    secondaryFocus: null
  };
}
