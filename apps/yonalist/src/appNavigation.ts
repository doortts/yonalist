import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { outlinePane } from "./outline/outlinePaneRegistry";
import { ROOT_ID } from "./store/storeSupport";

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

/**
 * Where the caret lands on the way into a zoomed row. A row with nothing under
 * it leaves the reader in its own title, at the end, since that line is all
 * there is to write in. A row with one child puts them at the end of that
 * child, which is where the writing left off. A row with several puts them in
 * front of the first, because a list that already has an order is arrived at to
 * be read, not appended to.
 */
export function zoomEntryFocus(
  nodeId: string,
  nodes: readonly NoteView[],
  drafts: Readonly<Record<string, string>>
): PaneFocusSnapshot {
  const children = nodes
    .filter((node) => node.parentId === nodeId)
    .sort((left, right) => left.sortKey - right.sortKey);
  if (children.length > 1) {
    return {
      nodeId: children[0]!.id,
      field: "title",
      selectionStart: 0,
      selectionEnd: 0
    };
  }
  const target = children[0] ?? nodes.find((node) => node.id === nodeId);
  const landing = target?.id ?? nodeId;
  // The draft is what the field is showing, so it is what its end measures.
  const end = (drafts[landing] ?? target?.text ?? "").length;
  return {
    nodeId: landing,
    field: "title",
    selectionStart: end,
    selectionEnd: end
  };
}

/**
 * The page a row belongs to: the ancestor of it that is a child of the root. A
 * zoom is still inside its page, so this is the page the sidebar names however
 * deep the reader has gone. Null once the walk leaves the loaded rows -- on a
 * page other than home the page's own node is kept out of them, and the open
 * page already answers for that case.
 */
export function owningPageId(
  nodeId: string | null,
  nodes: readonly NoteView[]
): string | null {
  if (!nodeId) return null;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const walked = new Set<string>();
  let current = byId.get(nodeId);
  while (current && current.parentId !== ROOT_ID) {
    if (walked.has(current.id)) return null;
    walked.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return current?.id ?? null;
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
