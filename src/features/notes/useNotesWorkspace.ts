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
  zoomTo(nodeId: NoteId | null): void;
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

interface InitialLoadEntry {
  vaultRoot: string;
  repository: NotesStore;
  subscribers: number;
  confirmedMutationVersion: number;
  promise: Promise<NotesWorkspace | null>;
}

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
  const stateRef = useRef(state);
  const identityRef = useRef({ vaultRoot, repository });
  const operationSequence = useRef(0);
  const confirmedMutationVersion = useRef(0);
  const mountedRef = useRef(false);
  const initialLoadRef = useRef<InitialLoadEntry | null>(null);
  stateRef.current = state;
  identityRef.current = { vaultRoot, repository };

  useEffect(() => {
    mountedRef.current = true;
    operationSequence.current += 1;
    dispatch({ type: "startWorkspaceLoad" });

    let entry = initialLoadRef.current;
    if (
      !entry ||
      entry.vaultRoot !== vaultRoot ||
      entry.repository !== repository
    ) {
      entry = {
        vaultRoot,
        repository,
        subscribers: 0,
        confirmedMutationVersion: confirmedMutationVersion.current,
        promise: Promise.resolve(null)
      };
      initialLoadRef.current = entry;

      let initialization: Promise<void>;
      try {
        initialization = repository.initialize(vaultRoot);
      } catch (cause) {
        initialization = Promise.reject(cause);
      }

      const loadEntry = entry;
      entry.promise = initialization.then(() => {
        if (
          loadEntry.subscribers === 0 ||
          initialLoadRef.current !== loadEntry
        ) {
          return null;
        }
        return repository.loadWorkspace(vaultRoot, { kind: "active" });
      });
    }
    entry.subscribers += 1;
    let subscribed = true;

    const canPublish = () => {
      const current = identityRef.current;
      return (
        subscribed &&
        mountedRef.current &&
        initialLoadRef.current === entry &&
        confirmedMutationVersion.current === entry.confirmedMutationVersion &&
        current.vaultRoot === vaultRoot &&
        current.repository === repository
      );
    };

    void entry.promise
      .then((workspace) => {
        if (workspace && canPublish()) {
          dispatch({ type: "replaceWorkspace", workspace });
        }
      })
      .catch((cause: unknown) => {
        if (canPublish()) {
          dispatch({ type: "setError", error: errorMessage(cause) });
        }
      });

    return () => {
      subscribed = false;
      entry.subscribers -= 1;
      mountedRef.current = false;
      operationSequence.current += 1;
    };
  }, [repository, vaultRoot]);

  const runCommand = useCallback(
    async (
      command: (store: NotesStore, vaultPath: string) => Promise<NotesWorkspace>,
      uiUpdate: UiUpdate | ((workspace: NotesWorkspace) => UiUpdate) = {}
    ) => {
      const commandVaultRoot = vaultRoot;
      const commandRepository = repository;
      const operation = ++operationSequence.current;
      dispatch({ type: "setLoading" });

      const isCurrent = () => {
        const current = identityRef.current;
        return (
          mountedRef.current &&
          operationSequence.current === operation &&
          current.vaultRoot === commandVaultRoot &&
          current.repository === commandRepository
        );
      };

      try {
        const workspace = await command(commandRepository, commandVaultRoot);
        if (!isCurrent()) {
          return;
        }
        confirmedMutationVersion.current += 1;
        dispatch({ type: "replaceWorkspace", workspace });
        const nextUi =
          typeof uiUpdate === "function" ? uiUpdate(workspace) : uiUpdate;
        if (Object.keys(nextUi).length > 0) {
          dispatch({ type: "setUiState", ...nextUi });
        }
      } catch (cause) {
        if (isCurrent()) {
          dispatch({ type: "setError", error: errorMessage(cause) });
        }
      }
    },
    [repository, vaultRoot]
  );

  const createRoot = useCallback(async () => {
    const id = createNoteId();
    const afterId = stateRef.current.rootIds.at(-1) ?? null;
    await runCommand(
      (store, vaultPath) =>
        store.createNode(vaultPath, { id, parentId: null, afterId, title: "", note: "" }),
      { selectedId: id, editingNoteId: id, pendingFocusId: id }
    );
  }, [runCommand]);

  const createChild = useCallback(
    async (nodeId: NoteId) => {
      if (!stateRef.current.nodesById[nodeId]) {
        return;
      }
      const id = createNoteId();
      const afterId = stateRef.current.childIdsByParent[nodeId]?.at(-1) ?? null;
      await runCommand(
        (store, vaultPath) =>
          store.createNode(vaultPath, {
            id,
            parentId: nodeId,
            afterId,
            title: "",
            note: ""
          }),
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
      const before = stateRef.current;
      await runCommand(
        (store, vaultPath) => store.duplicateNode(vaultPath, nodeId),
        (workspace) => {
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

  const zoomTo = useCallback((nodeId: NoteId | null) => {
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
