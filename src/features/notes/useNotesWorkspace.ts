import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { createNoteId } from "../../domain/notes";
import type {
  MoveNoteNodeInput,
  NoteId,
  NoteNode,
  NotesStore,
  NotesWorkspace
} from "../../domain/notes";
import {
  notesWorkspaceCoordinatorRegistry,
  type NotesWorkspaceCoordinatorSession,
  type NotesWorkspaceQueueContext,
  type NotesWorkspaceQueueResult,
  type NotesWorkspaceQueueWork,
  type NotesWorkspaceUiUpdate
} from "./notesWorkspaceCoordinator";
import {
  normalizeWorkspace,
  notesWorkspaceReducer,
  type NormalizedNotesWorkspace
} from "./notesWorkspaceReducer";

export interface NotesWorkspaceActions {
  acknowledgeFocus(nodeId: NoteId): Promise<void>;
  focusNode(nodeId: NoteId): Promise<void>;
  createRoot(): Promise<void>;
  splitNode(
    nodeId: NoteId,
    newNodeId: NoteId,
    prefix: string,
    suffix: string,
    options?: NotesWorkspaceCompoundOptions
  ): Promise<void>;
  createChild(nodeId: NoteId): Promise<void>;
  updateNode(
    nodeId: NoteId,
    patch: Pick<NoteNode, "title" | "note">
  ): Promise<void>;
  moveNode(
    input: MoveNoteNodeInput,
    focusNodeId?: NoteId | null,
    options?: NotesWorkspaceCompoundOptions
  ): Promise<void>;
  toggleComplete(nodeId: NoteId): Promise<void>;
  toggleCollapsed(nodeId: NoteId): Promise<void>;
  duplicateNode(nodeId: NoteId): Promise<void>;
  removeEmptyNode(
    nodeId: NoteId,
    focusNodeId?: NoteId | null,
    options?: NotesWorkspaceCompoundOptions
  ): Promise<void>;
  deleteNode(nodeId: NoteId): Promise<void>;
  restoreNode(nodeId: NoteId): Promise<void>;
  zoomTo(nodeId: NoteId | null): Promise<void>;
}

export interface NotesWorkspaceCompoundOptions {
  draft?: Pick<NoteNode, "title" | "note">;
  expandNodeId?: NoteId;
  onSuccess?: () => void;
}

export interface UseNotesWorkspaceOptions {
  vaultRoot: string;
  repository: NotesStore;
}

export interface UseNotesWorkspaceResult {
  state: NormalizedNotesWorkspace;
  actions: NotesWorkspaceActions;
  status: NormalizedNotesWorkspace["status"];
  loading: boolean;
  error: string | null;
}

function authoritative(
  workspace: NotesWorkspace,
  uiUpdate?: NotesWorkspaceUiUpdate
): NotesWorkspaceQueueResult {
  return { kind: "authoritative", workspace, uiUpdate };
}

type NotesWorkspaceQueueStep = () => Promise<NotesWorkspace>;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function runCompoundQueueWork(
  context: NotesWorkspaceQueueContext,
  steps: NotesWorkspaceQueueStep[],
  uiUpdate?: NotesWorkspaceUiUpdate
): Promise<NotesWorkspaceQueueResult> {
  let workspace = context.confirmedWorkspace;
  let hasAuthoritativeStep = false;

  try {
    for (const step of steps) {
      workspace = await step();
      hasAuthoritativeStep = true;
    }
    return authoritative(workspace, uiUpdate);
  } catch (cause) {
    return {
      kind: "failure",
      error: errorMessage(cause),
      ...(hasAuthoritativeStep ? { workspace } : {})
    };
  }
}

function notifySuccess(callback: (() => void) | undefined): void {
  if (!callback) {
    return;
  }
  try {
    callback();
  } catch {
    // Local completion handlers cannot change an authoritative queue result.
  }
}

function confirmedState(
  context: NotesWorkspaceQueueContext
): NormalizedNotesWorkspace {
  return normalizeWorkspace(context.confirmedWorkspace);
}

function focusedUiUpdate(
  focusNodeId: NoteId | null | undefined
): NotesWorkspaceUiUpdate | undefined {
  return focusNodeId == null
    ? undefined
    : {
        selectedId: focusNodeId,
        editingNoteId: focusNodeId,
        pendingFocusId: focusNodeId
      };
}

function duplicateRootId(
  before: NormalizedNotesWorkspace,
  after: NotesWorkspace,
  sourceId: NoteId
): NoteId | null {
  const source = before.nodesById[sourceId];
  if (!source) {
    return null;
  }
  return (
    after.nodes.find(
      (node) =>
        node.parentId === source.parentId && !before.nodesById[node.id]
    )?.id ?? null
  );
}

function hasMoveDependencies(
  workspace: NormalizedNotesWorkspace,
  input: MoveNoteNodeInput
): boolean {
  return Boolean(
    workspace.nodesById[input.id] &&
      (input.parentId === null || workspace.nodesById[input.parentId]) &&
      (input.afterId === null || workspace.nodesById[input.afterId])
  );
}

export function useNotesWorkspace({
  vaultRoot,
  repository
}: UseNotesWorkspaceOptions): UseNotesWorkspaceResult {
  const [state, dispatch] = useReducer(
    notesWorkspaceReducer,
    undefined,
    () => normalizeWorkspace({ nodes: [] })
  );
  const sessionRef = useRef<NotesWorkspaceCoordinatorSession | null>(null);

  useEffect(() => {
    dispatch({ type: "startWorkspaceLoad" });
    const session = notesWorkspaceCoordinatorRegistry.openSession({
      repository,
      vaultRoot,
      onEvent(event) {
        if (event.type === "pending") {
          dispatch({ type: "setLoading" });
          return;
        }
        dispatch({
          type: "settleQueueWork",
          result: event.result,
          hasPendingWork: event.hasPendingWork
        });
      }
    });
    sessionRef.current = session;

    return () => {
      if (sessionRef.current === session) {
        sessionRef.current = null;
      }
      session.close();
    };
  }, [repository, vaultRoot]);

  const runCommand = useCallback((work: NotesWorkspaceQueueWork): Promise<void> => {
    return sessionRef.current?.enqueue(work) ?? Promise.resolve();
  }, []);

  const acknowledgeFocus = useCallback(async (nodeId: NoteId) => {
    dispatch({ type: "acknowledgePendingFocus", nodeId });
  }, []);

  const focusNode = useCallback(async (nodeId: NoteId) => {
    dispatch({ type: "focusNode", nodeId });
  }, []);

  const createRoot = useCallback(() => {
    return runCommand(async (context) => {
      const before = confirmedState(context);
      const id = createNoteId();
      const workspace = await context.repository.createNode(context.vaultRoot, {
        id,
        parentId: null,
        afterId: before.rootIds.at(-1) ?? null,
        title: "",
        note: ""
      });
      return authoritative(workspace, {
        selectedId: id,
        editingNoteId: id,
        pendingFocusId: id
      });
    });
  }, [runCommand]);

  const createChild = useCallback(
    (nodeId: NoteId) => {
      return runCommand(async (context) => {
        const before = confirmedState(context);
        if (!before.nodesById[nodeId]) {
          return { kind: "skipped" };
        }
        const id = createNoteId();
        const workspace = await context.repository.createNode(
          context.vaultRoot,
          {
            id,
            parentId: nodeId,
            afterId: before.childIdsByParent[nodeId]?.at(-1) ?? null,
            title: "",
            note: ""
          }
        );
        return authoritative(workspace, {
          selectedId: id,
          editingNoteId: id,
          pendingFocusId: id
        });
      });
    },
    [runCommand]
  );

  const splitNode = useCallback(
    (
      nodeId: NoteId,
      newNodeId: NoteId,
      prefix: string,
      suffix: string,
      options?: NotesWorkspaceCompoundOptions
    ) => {
      let succeeded = false;
      const completion = runCommand(async (context) => {
        if (!confirmedState(context).nodesById[nodeId]) {
          return { kind: "skipped" };
        }
        const steps: NotesWorkspaceQueueStep[] = [];
        const draft = options?.draft;
        if (draft) {
          steps.push(() =>
            context.repository.updateNode(context.vaultRoot, {
              id: nodeId,
              ...draft
            })
          );
        }
        steps.push(() =>
          context.repository.splitNode(context.vaultRoot, {
            id: nodeId,
            newNodeId,
            prefix,
            suffix
          })
        );
        const result = await runCompoundQueueWork(context, steps, {
          selectedId: newNodeId,
          editingNoteId: newNodeId,
          pendingFocusId: newNodeId
        });
        succeeded = result.kind === "authoritative";
        return result;
      });
      return completion.then(() => {
        if (succeeded) {
          notifySuccess(options?.onSuccess);
        }
      });
    },
    [runCommand]
  );

  const updateNode = useCallback(
    (nodeId: NoteId, patch: Pick<NoteNode, "title" | "note">) => {
      return runCommand(async (context) => {
        if (!confirmedState(context).nodesById[nodeId]) {
          return { kind: "skipped" };
        }
        return authoritative(
          await context.repository.updateNode(context.vaultRoot, {
            id: nodeId,
            ...patch
          })
        );
      });
    },
    [runCommand]
  );

  const moveNode = useCallback(
    (
      input: MoveNoteNodeInput,
      focusNodeId?: NoteId | null,
      options?: NotesWorkspaceCompoundOptions
    ) => {
      return runCommand(async (context) => {
        const before = confirmedState(context);
        const expandNodeId = options?.expandNodeId;
        if (
          !hasMoveDependencies(before, input) ||
          (expandNodeId !== undefined && !before.nodesById[expandNodeId])
        ) {
          return { kind: "skipped" };
        }
        const steps: NotesWorkspaceQueueStep[] = [];
        const draft = options?.draft;
        if (draft) {
          steps.push(() =>
            context.repository.updateNode(context.vaultRoot, {
              id: input.id,
              ...draft
            })
          );
        }
        if (
          expandNodeId !== undefined &&
          before.nodesById[expandNodeId].isCollapsed
        ) {
          steps.push(() =>
            context.repository.toggleCollapsed(
              context.vaultRoot,
              expandNodeId
            )
          );
        }
        steps.push(() => context.repository.moveNode(context.vaultRoot, input));
        return runCompoundQueueWork(
          context,
          steps,
          focusedUiUpdate(focusNodeId)
        );
      });
    },
    [runCommand]
  );

  const toggleComplete = useCallback(
    (nodeId: NoteId) => {
      return runCommand(async (context) => {
        if (!confirmedState(context).nodesById[nodeId]) {
          return { kind: "skipped" };
        }
        return authoritative(
          await context.repository.toggleComplete(context.vaultRoot, nodeId)
        );
      });
    },
    [runCommand]
  );

  const toggleCollapsed = useCallback(
    (nodeId: NoteId) => {
      return runCommand(async (context) => {
        if (!confirmedState(context).nodesById[nodeId]) {
          return { kind: "skipped" };
        }
        return authoritative(
          await context.repository.toggleCollapsed(context.vaultRoot, nodeId)
        );
      });
    },
    [runCommand]
  );

  const duplicateNode = useCallback(
    (nodeId: NoteId) => {
      return runCommand(async (context) => {
        const before = confirmedState(context);
        if (!before.nodesById[nodeId]) {
          return { kind: "skipped" };
        }
        const workspace = await context.repository.duplicateNode(
          context.vaultRoot,
          nodeId
        );
        const duplicateId = duplicateRootId(before, workspace, nodeId);
        return authoritative(
          workspace,
          duplicateId
            ? {
                selectedId: duplicateId,
                editingNoteId: duplicateId,
                pendingFocusId: duplicateId
              }
            : undefined
        );
      });
    },
    [runCommand]
  );

  const removeEmptyNode = useCallback(
    (
      nodeId: NoteId,
      focusNodeId?: NoteId | null,
      options?: NotesWorkspaceCompoundOptions
    ) => {
      return runCommand(async (context) => {
        if (!confirmedState(context).nodesById[nodeId]) {
          return { kind: "skipped" };
        }
        const steps: NotesWorkspaceQueueStep[] = [];
        const draft = options?.draft;
        if (draft) {
          steps.push(() =>
            context.repository.updateNode(context.vaultRoot, {
              id: nodeId,
              ...draft
            })
          );
        }
        steps.push(() =>
          context.repository.removeEmptyNode(context.vaultRoot, nodeId)
        );
        return runCompoundQueueWork(
          context,
          steps,
          focusedUiUpdate(focusNodeId)
        );
      });
    },
    [runCommand]
  );

  const deleteNode = useCallback(
    (nodeId: NoteId) => {
      return runCommand(async (context) => {
        if (!confirmedState(context).nodesById[nodeId]) {
          return { kind: "skipped" };
        }
        return authoritative(
          await context.repository.softDeleteNode(context.vaultRoot, nodeId)
        );
      });
    },
    [runCommand]
  );

  const restoreNode = useCallback(
    (nodeId: NoteId) => {
      return runCommand(async (context) =>
        authoritative(
          await context.repository.restoreNode(context.vaultRoot, nodeId)
        )
      );
    },
    [runCommand]
  );

  const zoomTo = useCallback(async (nodeId: NoteId | null) => {
    dispatch({ type: "setZoomRoot", zoomRootId: nodeId });
  }, []);

  const actions = useMemo<NotesWorkspaceActions>(
    () => ({
      acknowledgeFocus,
      focusNode,
      createRoot,
      splitNode,
      createChild,
      updateNode,
      moveNode,
      toggleComplete,
      toggleCollapsed,
      duplicateNode,
      removeEmptyNode,
      deleteNode,
      restoreNode,
      zoomTo
    }),
    [
      acknowledgeFocus,
      focusNode,
      createRoot,
      splitNode,
      createChild,
      updateNode,
      moveNode,
      toggleComplete,
      toggleCollapsed,
      duplicateNode,
      removeEmptyNode,
      deleteNode,
      restoreNode,
      zoomTo
    ]
  );

  return {
    state,
    actions,
    status: state.status,
    loading: state.status === "loading",
    error: state.error
  };
}
