export interface PaneFocusSnapshot {
  readonly nodeId: string;
  readonly field: "title" | "note";
  readonly selectionStart: number;
  readonly selectionEnd: number;
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

export function capturePane(paneId: "primary" | "secondary"): {
  readonly selectedIds: readonly string[];
  readonly focus: PaneFocusSnapshot | null;
} {
  const scope = document.querySelector<HTMLElement>(
    `[data-outline-pane-id="${paneId}"]`
  );
  const selectedIds = scope
    ? [...scope.querySelectorAll<HTMLElement>(
        "[data-outline-id][data-selected='true']"
      )].flatMap((node) => node.dataset.outlineId
        ? [node.dataset.outlineId]
        : [])
    : [];
  const active = document.activeElement;
  if (
    !scope ||
    !(active instanceof HTMLTextAreaElement) ||
    !scope.contains(active)
  ) {
    return { selectedIds, focus: null };
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
  return { selectedIds, focus };
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
