import { useCallback, useReducer, useRef } from "react";
import type {
  NoteId,
  NoteNode,
  NotesStore,
  NotesWorkspaceScope
} from "../../domain/notes";
import type { NotesWorkspaceCoordinatorSession } from "./notesWorkspaceCoordinator";
import type { NotesWorkspaceSessionRecord } from "./notesDraftEngine";
import { isActiveMoveNode } from "./notesMoveTargets";
import {
  applyPreparedSelectionBatchCommand,
  commitPreparedMoveCommand,
  type NotesBatchCommandSettlement,
  type NotesBatchOp,
  type NotesCommandContext
} from "./notesCommands";
import {
  notesSelectionReducer,
  type NotesSelection,
  type NotesSelectionAction
} from "./notesWorkspaceReducer";
import { sameScope } from "./notesWorkspaceScope";
import { focusedUiUpdate } from "./notesWorkspaceCommandSupport";
import {
  cloneWorkspaceScope,
  freezeActiveAuthorityWorkspace
} from "./notesWorkspaceNavigationSupport";
import type {
  NotesPreparedMove,
  NotesPreparedMoveCommitResult,
  NotesPreparedSelectionAuthority,
  NotesPreparedSelectionBatchOptions
} from "./notesWorkspaceTypes";

interface LiveRef<T> {
  current: T;
}

export interface NotesSelectionStateController {
  readonly selection: NotesSelection | null;
  readonly selectionRef: LiveRef<NotesSelection | null>;
  readonly selectionRevisionRef: LiveRef<number>;
  readonly selectionPreparationTokenRef: LiveRef<number>;
  updateSelection(
    action: NotesSelectionAction,
    expectedRevision?: number
  ): boolean;
  setSelectionAnchor(anchorId: NoteId): void;
  extendSelectionTo(headId: NoteId): void;
  toggleSelectionNode(nodeId: NoteId, visibleNodeIds: readonly NoteId[]): void;
  clearSelection(): void;
  replaceSelection(
    selection: NotesSelection | null,
    expectedRevision?: number
  ): boolean;
  getSelectionSnapshot(): {
    selection: NotesSelection | null;
    revision: number;
  };
}

export function useNotesSelectionState(): NotesSelectionStateController {
  const [selection, dispatchSelection] = useReducer(notesSelectionReducer, null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const selectionRevisionRef = useRef(0);
  const selectionPreparationTokenRef = useRef(0);

  const updateSelection = useCallback(
    (action: NotesSelectionAction, expectedRevision?: number): boolean => {
      if (
        expectedRevision !== undefined &&
        selectionRevisionRef.current !== expectedRevision
      ) {
        return false;
      }
      const previous = selectionRef.current;
      const next = notesSelectionReducer(previous, action);
      if (next === previous) return false;
      selectionRef.current = next;
      selectionRevisionRef.current += 1;
      dispatchSelection(action);
      return true;
    },
    []
  );
  const setSelectionAnchor = useCallback(
    (anchorId: NoteId): void => {
      updateSelection({ type: "setSelectionAnchor", anchorId });
    },
    [updateSelection]
  );
  const extendSelectionTo = useCallback(
    (headId: NoteId): void => {
      updateSelection({ type: "extendSelectionTo", headId });
    },
    [updateSelection]
  );
  const toggleSelectionNode = useCallback(
    (nodeId: NoteId, visibleNodeIds: readonly NoteId[]): void => {
      updateSelection({ type: "toggleSelectionNode", nodeId, visibleNodeIds });
    },
    [updateSelection]
  );
  const clearSelection = useCallback((): void => {
    if (selectionRef.current !== null) {
      updateSelection({ type: "clearSelection" });
    }
  }, [updateSelection]);
  const replaceSelection = useCallback(
    (
      nextSelection: NotesSelection | null,
      expectedRevision?: number
    ): boolean =>
      updateSelection(
        {
          type: "replaceSelection",
          selection: nextSelection ? { ...nextSelection } : null
        },
        expectedRevision
      ),
    [updateSelection]
  );
  const getSelectionSnapshot = useCallback(
    () => ({
      selection: selectionRef.current,
      revision: selectionRevisionRef.current
    }),
    []
  );

  return {
    selection,
    selectionRef,
    selectionRevisionRef,
    selectionPreparationTokenRef,
    updateSelection,
    setSelectionAnchor,
    extendSelectionTo,
    toggleSelectionNode,
    clearSelection,
    replaceSelection,
    getSelectionSnapshot
  };
}

interface NotesSelectionAuthorityDependencies {
  readonly repository: NotesStore;
  readonly vaultRoot: string;
  readonly commandCtx: NotesCommandContext;
  readonly activeScopeRef: LiveRef<NotesWorkspaceScope>;
  readonly activeWorkspaceGenerationRef: LiveRef<number>;
  readonly movePreparationTokenRef: LiveRef<number>;
  readonly navigationVersionRef: LiveRef<number>;
  readonly selectionPreparationTokenRef: LiveRef<number>;
  readonly selectionRevisionRef: LiveRef<number>;
  readonly sessionRef: LiveRef<NotesWorkspaceCoordinatorSession | null>;
  readonly sessionRecordRef: LiveRef<NotesWorkspaceSessionRecord | null>;
  readonly vaultRootRef: LiveRef<string>;
}

export interface NotesSelectionAuthorityController {
  isPreparedSelectionAuthorityCurrent(
    prepared: NotesPreparedSelectionAuthority
  ): boolean;
  prepareSelectionAuthority(
    selectedNodeIds: readonly NoteId[]
  ): Promise<NotesPreparedSelectionAuthority>;
  applyPreparedSelectionBatch(
    prepared: NotesPreparedSelectionAuthority,
    op: NotesBatchOp,
    options?: NotesPreparedSelectionBatchOptions
  ): Promise<NotesBatchCommandSettlement>;
  loadActiveNodesForMove(): Promise<readonly NoteNode[]>;
  prepareMoveNode(nodeId: NoteId): Promise<NotesPreparedMove>;
  commitPreparedMove(
    prepared: NotesPreparedMove,
    destinationId: NoteId | null
  ): Promise<NotesPreparedMoveCommitResult>;
}

export function useNotesSelectionAuthority({
  repository,
  vaultRoot,
  commandCtx,
  activeScopeRef,
  activeWorkspaceGenerationRef,
  movePreparationTokenRef,
  navigationVersionRef,
  selectionPreparationTokenRef,
  selectionRevisionRef,
  sessionRef,
  sessionRecordRef,
  vaultRootRef
}: NotesSelectionAuthorityDependencies): NotesSelectionAuthorityController {
  const isPreparedSelectionAuthorityCurrent = useCallback(
    (prepared: NotesPreparedSelectionAuthority): boolean => {
      const record = sessionRecordRef.current;
      return (
        prepared.token === selectionPreparationTokenRef.current &&
        prepared.vaultRoot === vaultRootRef.current &&
        sameScope(prepared.scope, activeScopeRef.current) &&
        prepared.generation === activeWorkspaceGenerationRef.current &&
        prepared.selectionRevision === selectionRevisionRef.current &&
        prepared.session === sessionRef.current &&
        record !== null &&
        !record.closing &&
        record.session === prepared.session &&
        prepared.selectedNodeIds.length > 0 &&
        prepared.selectedNodeIds.every(
          (nodeId) => prepared.workspace.nodesById[nodeId] !== undefined
        )
      );
    },
    [
      activeScopeRef,
      activeWorkspaceGenerationRef,
      selectionPreparationTokenRef,
      selectionRevisionRef,
      sessionRecordRef,
      sessionRef,
      vaultRootRef
    ]
  );
  const prepareSelectionAuthority = useCallback(
    async (
      selectedNodeIds: readonly NoteId[]
    ): Promise<NotesPreparedSelectionAuthority> => {
      const ids = [...selectedNodeIds];
      if (ids.length === 0 || new Set(ids).size !== ids.length) {
        throw new Error("A valid selected range is required.");
      }
      const record = sessionRecordRef.current;
      const session = sessionRef.current;
      if (!record || record.closing || !session || record.session !== session) {
        throw new Error("Notes are not ready.");
      }
      const token = selectionPreparationTokenRef.current;
      const preparedVaultRoot = vaultRoot;
      const scope = cloneWorkspaceScope(activeScopeRef.current);
      if (scope.kind === "tags") {
        for (const filter of scope.tags) Object.freeze(filter);
        Object.freeze(scope.tags);
      }
      Object.freeze(scope);
      const generation = activeWorkspaceGenerationRef.current;
      const selectionRevision = selectionRevisionRef.current;
      const activeWorkspace = freezeActiveAuthorityWorkspace(
        await repository.loadWorkspace(preparedVaultRoot, { kind: "active" })
      );
      if (
        token !== selectionPreparationTokenRef.current ||
        vaultRootRef.current !== preparedVaultRoot ||
        !sameScope(activeScopeRef.current, scope) ||
        activeWorkspaceGenerationRef.current !== generation ||
        selectionRevisionRef.current !== selectionRevision ||
        sessionRef.current !== session ||
        sessionRecordRef.current !== record ||
        record.closing
      ) {
        throw new Error("Notes changed while preparing the selection.");
      }
      if (ids.some((nodeId) => activeWorkspace.nodesById[nodeId] === undefined)) {
        throw new Error("A selected note is no longer active.");
      }
      return Object.freeze({
        token,
        vaultRoot: preparedVaultRoot,
        scope,
        generation,
        session,
        selectionRevision,
        selectedNodeIds: Object.freeze(ids),
        workspace: activeWorkspace
      });
    },
    [
      activeScopeRef,
      activeWorkspaceGenerationRef,
      repository,
      selectionPreparationTokenRef,
      selectionRevisionRef,
      sessionRecordRef,
      sessionRef,
      vaultRoot,
      vaultRootRef
    ]
  );
  const applyPreparedSelectionBatch = useCallback(
    (
      prepared: NotesPreparedSelectionAuthority,
      op: NotesBatchOp,
      options?: NotesPreparedSelectionBatchOptions
    ): Promise<NotesBatchCommandSettlement> =>
      applyPreparedSelectionBatchCommand(
        commandCtx,
        prepared,
        op,
        focusedUiUpdate(options?.focusNodeId),
        options?.expandNodeId,
        options?.expectedNavigationVersion ?? navigationVersionRef.current
      ),
    [commandCtx, navigationVersionRef]
  );
  const loadActiveNodesForMove = useCallback(
    async (): Promise<readonly NoteNode[]> =>
      (await repository.loadWorkspace(vaultRoot, { kind: "active" })).nodes,
    [repository, vaultRoot]
  );
  const prepareMoveNode = useCallback(
    async (nodeId: NoteId): Promise<NotesPreparedMove> => {
      const token = movePreparationTokenRef.current + 1;
      movePreparationTokenRef.current = token;
      const preparedVaultRoot = vaultRoot;
      const preparedScope = cloneWorkspaceScope(activeScopeRef.current);
      const generation = activeWorkspaceGenerationRef.current;
      const nodes = (await loadActiveNodesForMove()).map((node) => ({ ...node }));
      if (
        token !== movePreparationTokenRef.current ||
        vaultRootRef.current !== preparedVaultRoot ||
        !sameScope(activeScopeRef.current, preparedScope) ||
        activeWorkspaceGenerationRef.current !== generation
      ) {
        throw new Error("Notes changed while Move To was opening.");
      }
      const nodesById = Object.fromEntries(
        nodes.map((node) => [node.id, node])
      ) as Record<NoteId, NoteNode>;
      if (!isActiveMoveNode(nodesById[nodeId])) {
        throw new Error("This note is no longer active.");
      }
      return {
        token,
        vaultRoot: preparedVaultRoot,
        scope: preparedScope,
        generation,
        sourceId: nodeId,
        nodes
      };
    },
    [
      activeScopeRef,
      activeWorkspaceGenerationRef,
      loadActiveNodesForMove,
      movePreparationTokenRef,
      vaultRoot,
      vaultRootRef
    ]
  );
  const commitPreparedMove = useCallback(
    (
      prepared: NotesPreparedMove,
      destinationId: NoteId | null
    ): Promise<NotesPreparedMoveCommitResult> =>
      commitPreparedMoveCommand(commandCtx, prepared, destinationId),
    [commandCtx]
  );

  return {
    isPreparedSelectionAuthorityCurrent,
    prepareSelectionAuthority,
    applyPreparedSelectionBatch,
    loadActiveNodesForMove,
    prepareMoveNode,
    commitPreparedMove
  };
}
