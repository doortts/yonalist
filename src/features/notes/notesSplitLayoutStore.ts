import type { NoteId } from "../../domain/notes";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";
import type { NotesPaneId } from "./notesPaneSession";

export const NOTES_SPLIT_LAYOUT_STORAGE_KEY =
  "yonalist.notesSplitLayout.v1";

export interface PersistedPaneNavigation {
  readonly zoomRootId: NoteId | null;
  readonly expandedNodeIds: readonly NoteId[];
  readonly scrollAnchorId: NoteId | null;
  readonly scrollOffset: number;
}

export interface NotesSplitLayoutStateV1 {
  readonly splitOpen: boolean;
  readonly splitRatio: number;
  readonly activePaneId: NotesPaneId;
  readonly panes: Readonly<
    Record<NotesPaneId, PersistedPaneNavigation>
  >;
}

interface PersistedNotesSplitLayoutMapV1 {
  readonly version: 1;
  readonly vaults: Readonly<Record<string, NotesSplitLayoutStateV1>>;
}

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem">;

function emptyPaneNavigation(): PersistedPaneNavigation {
  return {
    zoomRootId: null,
    expandedNodeIds: [],
    scrollAnchorId: null,
    scrollOffset: 0
  };
}

export function defaultNotesSplitLayout(): NotesSplitLayoutStateV1 {
  return {
    splitOpen: false,
    splitRatio: 0.5,
    activePaneId: "primary",
    panes: {
      primary: emptyPaneNavigation(),
      secondary: emptyPaneNavigation()
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNodeId(value: unknown): NoteId | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ratio(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value)
    ? value
    : 0.5;
  return Math.min(0.75, Math.max(0.25, numeric));
}

function offset(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function parsePaneNavigation(value: unknown): PersistedPaneNavigation {
  if (!isRecord(value)) return emptyPaneNavigation();
  const expandedNodeIds = Array.isArray(value.expandedNodeIds)
    ? [...new Set(value.expandedNodeIds.filter(
        (nodeId): nodeId is NoteId =>
          typeof nodeId === "string" && nodeId.length > 0
      ))]
    : [];
  return {
    zoomRootId: optionalNodeId(value.zoomRootId),
    expandedNodeIds,
    scrollAnchorId: optionalNodeId(value.scrollAnchorId),
    scrollOffset: offset(value.scrollOffset)
  };
}

function parseLayout(value: unknown): NotesSplitLayoutStateV1 {
  if (!isRecord(value)) return defaultNotesSplitLayout();
  const panes = isRecord(value.panes) ? value.panes : {};
  return {
    splitOpen: value.splitOpen === true,
    splitRatio: ratio(value.splitRatio),
    activePaneId:
      value.activePaneId === "secondary" ? "secondary" : "primary",
    panes: {
      primary: parsePaneNavigation(panes.primary),
      secondary: parsePaneNavigation(panes.secondary)
    }
  };
}

function readMap(storage: ReadStorage): PersistedNotesSplitLayoutMapV1 {
  try {
    const raw = storage.getItem(NOTES_SPLIT_LAYOUT_STORAGE_KEY);
    if (!raw) return { version: 1, vaults: {} };
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !isRecord(parsed.vaults)
    ) {
      return { version: 1, vaults: {} };
    }
    const vaults: Record<string, NotesSplitLayoutStateV1> = {};
    for (const [vaultRoot, value] of Object.entries(parsed.vaults)) {
      vaults[vaultRoot] = parseLayout(value);
    }
    return { version: 1, vaults };
  } catch {
    return { version: 1, vaults: {} };
  }
}

export function loadNotesSplitLayout(
  storage: ReadStorage,
  vaultRoot: string
): NotesSplitLayoutStateV1 {
  return readMap(storage).vaults[vaultRoot] ?? defaultNotesSplitLayout();
}

export function saveNotesSplitLayout(
  storage: WriteStorage,
  vaultRoot: string,
  state: NotesSplitLayoutStateV1
): void {
  try {
    const current = readMap(storage);
    storage.setItem(
      NOTES_SPLIT_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        vaults: {
          ...current.vaults,
          [vaultRoot]: parseLayout(state)
        }
      } satisfies PersistedNotesSplitLayoutMapV1)
    );
  } catch {
    // Local preferences must never prevent Notes from opening.
  }
}

export function reconcilePersistedSplitLayout(
  state: NotesSplitLayoutStateV1,
  workspace: NormalizedNotesWorkspace
): NotesSplitLayoutStateV1 {
  const reconcilePane = (
    pane: PersistedPaneNavigation
  ): PersistedPaneNavigation => {
    const exists = (nodeId: NoteId | null): nodeId is NoteId =>
      nodeId !== null && workspace.nodesById[nodeId] !== undefined;
    const zoomRootId = exists(pane.zoomRootId) ? pane.zoomRootId : null;
    const scrollAnchorId = exists(pane.scrollAnchorId)
      ? pane.scrollAnchorId
      : null;
    return {
      zoomRootId,
      expandedNodeIds: pane.expandedNodeIds.filter((nodeId) =>
        exists(nodeId)
      ),
      scrollAnchorId,
      scrollOffset: scrollAnchorId === null ? 0 : offset(pane.scrollOffset)
    };
  };
  return {
    splitOpen: state.splitOpen,
    splitRatio: ratio(state.splitRatio),
    activePaneId: state.activePaneId,
    panes: {
      primary: reconcilePane(state.panes.primary),
      secondary: reconcilePane(state.panes.secondary)
    }
  };
}
