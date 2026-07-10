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
  normalizeWorkspace,
  notesWorkspaceReducer,
  type NormalizedNotesWorkspace
} from "./notesWorkspaceReducer";

export interface NotesWorkspaceActions {
  createRoot(): Promise<void>;
  splitNode(
    nodeId: NoteId,
    newNodeId: NoteId,
    prefix: string,
    suffix: string
  ): Promise<void>;
  createChild(nodeId: NoteId): Promise<void>;
  updateNode(
    nodeId: NoteId,
    patch: Pick<NoteNode, "title" | "note">
  ): Promise<void>;
  moveNode(input: MoveNoteNodeInput): Promise<void>;
  toggleComplete(nodeId: NoteId): Promise<void>;
  toggleCollapsed(nodeId: NoteId): Promise<void>;
  duplicateNode(nodeId: NoteId): Promise<void>;
  removeEmptyNode(nodeId: NoteId): Promise<void>;
  deleteNode(nodeId: NoteId): Promise<void>;
  restoreNode(nodeId: NoteId): Promise<void>;
  zoomTo(nodeId: NoteId | null): Promise<void>;
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

type UiUpdate = Partial<
  Pick<
    NormalizedNotesWorkspace,
    "selectedId" | "zoomRootId" | "editingNoteId" | "pendingFocusId"
  >
>;

interface WorkspaceCoordinator {
  vaultRoot: string;
  repository: NotesStore;
  subscribers: number;
  active: boolean;
  initialLoadQueued: boolean;
  pendingWork: number;
  confirmedWorkspace: NotesWorkspace;
  tail: Promise<void>;
}

interface QueueSuccess {
  workspace: NotesWorkspace;
  uiUpdate?: UiUpdate;
}

type QueueWork = (
  confirmedWorkspace: NotesWorkspace
) => Promise<QueueSuccess | null>;

type WorkspaceCommand = (
  store: NotesStore,
  vaultPath: string,
  confirmedState: NormalizedNotesWorkspace,
  confirmedWorkspace: NotesWorkspace
) => Promise<NotesWorkspace> | NotesWorkspace;

type UiUpdateFactory = (
  before: NormalizedNotesWorkspace,
  after: NotesWorkspace
) => UiUpdate;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
        node.parentId === source.parentId &&
        !before.nodesById[node.id]
    )?.id ?? null
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
  const identityRef = useRef({ vaultRoot, repository });
  const mountedRef = useRef(false);
  const coordinatorRef = useRef<WorkspaceCoordinator | null>(null);
  identityRef.current = { vaultRoot, repository };

  const isCurrentCoordinator = useCallback(
    (coordinator: WorkspaceCoordinator) => {
      const current = identityRef.current;
      return (
        mountedRef.current &&
        coordinator.active &&
        coordinator.subscribers > 0 &&
        coordinatorRef.current === coordinator &&
        current.vaultRoot === coordinator.vaultRoot &&
        current.repository === coordinator.repository
      );
    },
    []
  );

  const enqueueCoordinatorWork = useCallback(
    (
      coordinator: WorkspaceCoordinator,
      work: QueueWork,
      announceLoading = true
    ): Promise<void> => {
      coordinator.pendingWork += 1;
      if (announceLoading && isCurrentCoordinator(coordinator)) {
        dispatch({ type: "setLoading" });
      }

      const completion = coordinator.tail.then(async () => {
        if (!isCurrentCoordinator(coordinator)) {
          coordinator.pendingWork -= 1;
          return;
        }

        try {
          const result = await work(coordinator.confirmedWorkspace);
          if (!result || !isCurrentCoordinator(coordinator)) {
            coordinator.pendingWork -= 1;
            return;
          }

          coordinator.confirmedWorkspace = result.workspace;
          coordinator.pendingWork -= 1;
          dispatch({
            type: "settleQueueWork",
            result: {
              kind: "success",
              workspace: result.workspace,
              uiUpdate: result.uiUpdate
            },
            hasPendingWork: coordinator.pendingWork > 0
          });
        } catch (cause) {
          coordinator.pendingWork -= 1;
          if (isCurrentCoordinator(coordinator)) {
            dispatch({
              type: "settleQueueWork",
              result: { kind: "failure", error: errorMessage(cause) },
              hasPendingWork: coordinator.pendingWork > 0
            });
          }
        }
      });

      coordinator.tail = completion;
      return completion;
    },
    [isCurrentCoordinator]
  );

  useEffect(() => {
    mountedRef.current = true;
    let coordinator = coordinatorRef.current;
    if (
      !coordinator ||
      coordinator.vaultRoot !== vaultRoot ||
      coordinator.repository !== repository
    ) {
      if (coordinator) {
        coordinator.active = false;
      }
      coordinator = {
        vaultRoot,
        repository,
        subscribers: 0,
        active: true,
        initialLoadQueued: false,
        pendingWork: 0,
        confirmedWorkspace: { nodes: [] },
        tail: Promise.resolve()
      };
      coordinatorRef.current = coordinator;
    }
    coordinator.subscribers += 1;
    coordinator.active = true;
    dispatch({ type: "startWorkspaceLoad" });

    if (!coordinator.initialLoadQueued) {
      coordinator.initialLoadQueued = true;
      let initialization: Promise<void>;
      try {
        initialization = repository.initialize(vaultRoot);
      } catch (cause) {
        initialization = Promise.reject(cause);
      }

      void enqueueCoordinatorWork(
        coordinator,
        async () => {
          await initialization;
          if (!isCurrentCoordinator(coordinator)) {
            return null;
          }
          const workspace = await repository.loadWorkspace(vaultRoot, {
            kind: "active"
          });
          return { workspace };
        },
        false
      );
    }

    return () => {
      coordinator.subscribers -= 1;
      if (coordinator.subscribers === 0) {
        coordinator.active = false;
      }
      mountedRef.current = false;
    };
  }, [
    enqueueCoordinatorWork,
    isCurrentCoordinator,
    repository,
    vaultRoot
  ]);

  const runCommand = useCallback(
    (
      command: WorkspaceCommand,
      uiUpdate: UiUpdate | UiUpdateFactory = {}
    ): Promise<void> => {
      const coordinator = coordinatorRef.current;
      if (
        !coordinator ||
        coordinator.vaultRoot !== vaultRoot ||
        coordinator.repository !== repository ||
        !isCurrentCoordinator(coordinator)
      ) {
        return Promise.resolve();
      }

      return enqueueCoordinatorWork(
        coordinator,
        async (confirmedWorkspace) => {
          const before = normalizeWorkspace(confirmedWorkspace);
          const workspace = await command(
            coordinator.repository,
            coordinator.vaultRoot,
            before,
            confirmedWorkspace
          );
          return {
            workspace,
            uiUpdate:
              typeof uiUpdate === "function"
                ? uiUpdate(before, workspace)
                : uiUpdate
          };
        }
      );
    },
    [
      enqueueCoordinatorWork,
      isCurrentCoordinator,
      repository,
      vaultRoot
    ]
  );

  const createRoot = useCallback(async () => {
    const id = createNoteId();
    await runCommand(
      (store, vaultPath, confirmed) =>
        store.createNode(vaultPath, {
          id,
          parentId: null,
          afterId: confirmed.rootIds.at(-1) ?? null,
          title: "",
          note: ""
        }),
      { selectedId: id, editingNoteId: id, pendingFocusId: id }
    );
  }, [runCommand]);

  const createChild = useCallback(
    async (nodeId: NoteId) => {
      const id = createNoteId();
      await runCommand(
        (store, vaultPath, confirmed, confirmedWorkspace) => {
          if (!confirmed.nodesById[nodeId]) {
            return confirmedWorkspace;
          }
          const afterId = confirmed.childIdsByParent[nodeId]?.at(-1) ?? null;
          return store.createNode(vaultPath, {
            id,
            parentId: nodeId,
            afterId,
            title: "",
            note: ""
          });
        },
        { selectedId: id, editingNoteId: id, pendingFocusId: id }
      );
    },
    [runCommand]
  );

  const splitNode = useCallback(
    async (
      nodeId: NoteId,
      newNodeId: NoteId,
      prefix: string,
      suffix: string
    ) => {
      await runCommand(
        (store, vaultPath) =>
          store.splitNode(vaultPath, {
            id: nodeId,
            newNodeId,
            prefix,
            suffix
          }),
        {
          selectedId: newNodeId,
          editingNoteId: newNodeId,
          pendingFocusId: newNodeId
        }
      );
    },
    [runCommand]
  );

  const updateNode = useCallback(
    async (nodeId: NoteId, patch: Pick<NoteNode, "title" | "note">) => {
      await runCommand((store, vaultPath) =>
        store.updateNode(vaultPath, { id: nodeId, ...patch })
      );
    },
    [runCommand]
  );

  const moveNode = useCallback(
    async (input: MoveNoteNodeInput) => {
      await runCommand((store, vaultPath) => store.moveNode(vaultPath, input));
    },
    [runCommand]
  );

  const toggleComplete = useCallback(
    async (nodeId: NoteId) => {
      await runCommand((store, vaultPath) =>
        store.toggleComplete(vaultPath, nodeId)
      );
    },
    [runCommand]
  );

  const toggleCollapsed = useCallback(
    async (nodeId: NoteId) => {
      await runCommand((store, vaultPath) =>
        store.toggleCollapsed(vaultPath, nodeId)
      );
    },
    [runCommand]
  );

  const duplicateNode = useCallback(
    async (nodeId: NoteId) => {
      await runCommand(
        (store, vaultPath) => store.duplicateNode(vaultPath, nodeId),
        (before, workspace) => {
          const duplicateId = duplicateRootId(before, workspace, nodeId);
          return duplicateId
            ? {
                selectedId: duplicateId,
                editingNoteId: duplicateId,
                pendingFocusId: duplicateId
              }
            : {};
        }
      );
    },
    [runCommand]
  );

  const removeEmptyNode = useCallback(
    async (nodeId: NoteId) => {
      await runCommand((store, vaultPath) =>
        store.removeEmptyNode(vaultPath, nodeId)
      );
    },
    [runCommand]
  );

  const deleteNode = useCallback(
    async (nodeId: NoteId) => {
      await runCommand((store, vaultPath) => store.softDeleteNode(vaultPath, nodeId));
    },
    [runCommand]
  );

  const restoreNode = useCallback(
    async (nodeId: NoteId) => {
      await runCommand((store, vaultPath) => store.restoreNode(vaultPath, nodeId));
    },
    [runCommand]
  );

  const zoomTo = useCallback(async (nodeId: NoteId | null) => {
    dispatch({ type: "setZoomRoot", zoomRootId: nodeId });
  }, []);

  const actions = useMemo<NotesWorkspaceActions>(
    () => ({
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
