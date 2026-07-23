import type { NoteId, NotesWorkspaceScope } from "../../domain/notes";
import {
  notesExpansionSnapshotPool,
  type NotesHistoryFocus,
  type NotesHistorySnapshot,
  type NotesPaneHistoryLocationSnapshot
} from "./notesHistory";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";
import {
  cloneOwnedHistorySnapshot,
  cloneWorkspaceScope
} from "./notesWorkspaceNavigationSupport";
import { canonicalizeTagFilters } from "./notesWorkspaceScope";
import type {
  LiveNotesNavigation,
  NotesLibraryView,
  TagFilterOrigin
} from "./notesWorkspaceTypes";
import type { NotesPaneSessionsController } from "./useNotesPaneSessions";

interface CaptureNotesHistorySnapshotOptions {
  readonly navigation: LiveNotesNavigation;
  readonly expandedNodeIds: ReadonlySet<NoteId>;
  readonly focus?: NotesHistoryFocus | null;
  readonly scope: NotesWorkspaceScope;
  readonly libraryView: NotesLibraryView;
  readonly activeTagFilters: Parameters<typeof canonicalizeTagFilters>[0];
  readonly tagFilterOrigin: TagFilterOrigin | null;
  readonly paneSessions: NotesPaneSessionsController;
}

export function captureNotesHistorySnapshot({
  navigation,
  expandedNodeIds,
  focus,
  scope,
  libraryView,
  activeTagFilters,
  tagFilterOrigin,
  paneSessions
}: CaptureNotesHistorySnapshotOptions): NotesHistorySnapshot {
  const resolvedFocus =
    focus === undefined
      ? navigation.editingNoteId
        ? {
            nodeId: navigation.editingNoteId,
            field: navigation.pendingFocusField ?? "title"
          }
        : null
      : focus;
  return {
    scope: cloneWorkspaceScope(scope),
    libraryView,
    activeTagFilters:
      libraryView === "tags" ? canonicalizeTagFilters(activeTagFilters) : [],
    selectedId: navigation.selectedId,
    zoomRootId: navigation.zoomRootId,
    expansion: notesExpansionSnapshotPool.acquire([...expandedNodeIds]),
    focus: resolvedFocus,
    tagFilterOrigin: tagFilterOrigin
      ? {
          scope: cloneWorkspaceScope(tagFilterOrigin.scope),
          libraryView: tagFilterOrigin.libraryView,
          activeTagFilters: [],
          selectedId: tagFilterOrigin.navigation.selectedId,
          zoomRootId: tagFilterOrigin.navigation.zoomRootId,
          expansion: notesExpansionSnapshotPool.acquire([
            ...tagFilterOrigin.locallyExpandedNodeIds
          ]),
          focus: tagFilterOrigin.navigation.editingNoteId
            ? {
                nodeId: tagFilterOrigin.navigation.editingNoteId,
                field:
                  tagFilterOrigin.navigation.pendingFocusField ?? "title"
              }
            : null
        }
      : null,
    activePaneId: paneSessions.activePaneId,
    secondaryPane: captureSecondaryPaneHistory(paneSessions)
  };
}

export function captureSecondaryPaneHistory(
  sessions: NotesPaneSessionsController
): NotesPaneHistoryLocationSnapshot {
  const pane = sessions.getPaneSession("secondary");
  return {
    selectedId: pane.selectedId,
    zoomRootId: pane.zoomRootId,
    expansion: notesExpansionSnapshotPool.acquire([
      ...pane.locallyExpandedNodeIds
    ]),
    focus: pane.editingNoteId
      ? {
          nodeId: pane.editingNoteId,
          field: pane.pendingFocusField ?? "title"
        }
      : null
  };
}

export function isSecondaryPaneHistoryValid(
  snapshot: NotesPaneHistoryLocationSnapshot | undefined,
  workspace: NormalizedNotesWorkspace
): boolean {
  if (!snapshot) return true;
  const exists = (nodeId: NoteId | null): boolean =>
    nodeId === null || Boolean(workspace.nodesById[nodeId]);
  return (
    exists(snapshot.selectedId) &&
    exists(snapshot.zoomRootId) &&
    exists(snapshot.focus?.nodeId ?? null) &&
    snapshot.expansion.nodeIds.every((nodeId) =>
      Boolean(workspace.nodesById[nodeId])
    )
  );
}

export function applySecondaryPaneHistory(
  snapshot: NotesPaneHistoryLocationSnapshot | undefined,
  sessions: NotesPaneSessionsController
): void {
  if (!snapshot) return;
  sessions.dispatchPane("secondary", {
    type: "setSelection",
    selection: null
  });
  sessions.dispatchPane("secondary", {
    type: "setExpansion",
    nodeIds: new Set(snapshot.expansion.nodeIds)
  });
  sessions.dispatchPane("secondary", {
    type: "setNavigation",
    patch: {
      selectedId: snapshot.selectedId,
      zoomRootId: snapshot.zoomRootId,
      editingNoteId: snapshot.focus?.nodeId ?? null,
      pendingFocusId: snapshot.focus?.nodeId ?? null,
      pendingFocusField: snapshot.focus?.field ?? null
    }
  });
}

export function resolveSecondaryPaneHistory(
  snapshot: NotesPaneHistoryLocationSnapshot | undefined,
  workspace: NormalizedNotesWorkspace
): NotesPaneHistoryLocationSnapshot | undefined {
  if (!snapshot) return undefined;
  const existing = (nodeId: NoteId | null): NoteId | null =>
    nodeId !== null && workspace.nodesById[nodeId] ? nodeId : null;
  return {
    selectedId: existing(snapshot.selectedId),
    zoomRootId: existing(snapshot.zoomRootId),
    expansion: notesExpansionSnapshotPool.acquire(
      snapshot.expansion.nodeIds.filter((nodeId) =>
        Boolean(workspace.nodesById[nodeId])
      )
    ),
    focus:
      snapshot.focus && workspace.nodesById[snapshot.focus.nodeId]
        ? { ...snapshot.focus }
        : null
  };
}

export function mergeNavigationPaneHistory(
  target: NotesHistorySnapshot,
  live: NotesHistorySnapshot,
  originPaneId: "primary" | "secondary"
): NotesHistorySnapshot {
  const merged = cloneOwnedHistorySnapshot(target);
  if (originPaneId === "secondary") {
    notesExpansionSnapshotPool.release(merged.expansion);
    return {
      ...merged,
      selectedId: live.selectedId,
      zoomRootId: live.zoomRootId,
      expansion: notesExpansionSnapshotPool.acquire(live.expansion.nodeIds),
      focus: live.focus ? { ...live.focus } : null
    };
  }
  if (merged.secondaryPane) {
    notesExpansionSnapshotPool.release(merged.secondaryPane.expansion);
  }
  return {
    ...merged,
    secondaryPane: live.secondaryPane
      ? {
          ...live.secondaryPane,
          expansion: notesExpansionSnapshotPool.acquire(
            live.secondaryPane.expansion.nodeIds
          ),
          focus: live.secondaryPane.focus
            ? { ...live.secondaryPane.focus }
            : null
        }
      : undefined
  };
}
