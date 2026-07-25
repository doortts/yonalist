import { useCallback, useRef, useSyncExternalStore } from "react";
import type {
  NoteId,
  NotesStore,
  NotesStoreError,
  NotesWorkspaceScope
} from "../../domain/notes";
import type { NotesHistoryPrimarySelection } from "./notesHistory";
import type { NotesPaneId } from "./notesPaneSession";
import type {
  NotesBackspaceGestureQueueWork,
  NotesWorkspaceCommandOutcome,
  NotesWorkspaceCoordinatorSession
} from "./notesWorkspaceCoordinator";
import type { NotesDraftEngine } from "./notesDraftEngine";
import type { NotesWorkspaceSessionRecord } from "./notesDraftEngine";
import type {
  LiveNotesNavigation,
  NotesBackspaceDraftLease,
  NotesImageAtomCutAuthority,
  NotesImageAtomPasteAuthority,
  NotesNodeDraft
} from "./notesWorkspaceTypes";
import {
  isNotesDataDeletionInProgress,
  subscribeToNotesDataDeletion
} from "./notesDataDeletionRegistry";
import type { BufferedWorkspaceCommand } from "./useNotesHistoryController";
import {
  createNotesImageAtomEditorRegistry,
  type ActiveImageAtomEditor,
  type ImageAtomEditorSelectionAuthority,
  type NotesImageAtomEditorAuthority
} from "./notesImageAtomEditorRegistry";
import type { NotesHistoryFocus } from "./notesHistory";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";
import {
  capturedImageAtomAuthority,
  imageAtomAuthorityMatches,
  type CapturedImageAtomAuthority
} from "./notesImageAtomAuthority";
import { cloneWorkspaceScope } from "./notesWorkspaceNavigationSupport";

export interface NotesBackspaceGestureRuntimeBinding {
  readonly key: object;
  readonly session: NotesWorkspaceCoordinatorSession;
  readonly beginDraftLease: (
    token: number,
    nodeId: NoteId
  ) => NotesBackspaceDraftLease | null;
}

interface NotesBackspaceGestureOrigin {
  readonly bindingKey: object;
  readonly session: NotesWorkspaceCoordinatorSession;
  readonly coordinatorToken: number;
  finishing: Promise<NotesWorkspaceCommandOutcome> | null;
}

export function createNotesBackspaceGestureRuntimeLifecycle() {
  let nextHandle = 0;
  const origins = new Map<number, NotesBackspaceGestureOrigin>();
  const activeHandleByBinding = new WeakMap<object, number>();

  const origin = (handle: number): NotesBackspaceGestureOrigin | null =>
    origins.get(handle) ?? null;
  const forget = (handle: number, current: NotesBackspaceGestureOrigin): void => {
    if (origins.get(handle) !== current) return;
    origins.delete(handle);
    if (activeHandleByBinding.get(current.bindingKey) === handle) {
      activeHandleByBinding.delete(current.bindingKey);
    }
  };

  return {
    begin(
      binding: NotesBackspaceGestureRuntimeBinding,
      input: {
        readonly ownerPaneId: NotesPaneId;
        readonly nodeId: NoteId;
        readonly selection: NotesHistoryPrimarySelection;
      },
      work: NotesBackspaceGestureQueueWork
    ): number | null {
      const activeHandle = activeHandleByBinding.get(binding.key);
      if (activeHandle !== undefined && origins.has(activeHandle)) {
        return activeHandle;
      }
      const coordinatorToken = binding.session.beginBackspaceGesture(
        input,
        (token) => binding.beginDraftLease(token, input.nodeId),
        work
      );
      if (coordinatorToken === null) return null;
      const handle = ++nextHandle;
      origins.set(handle, {
        bindingKey: binding.key,
        session: binding.session,
        coordinatorToken,
        finishing: null
      });
      activeHandleByBinding.set(binding.key, handle);
      return handle;
    },
    touch(handle: number, nodeId: NoteId): void {
      const current = origin(handle);
      current?.session.touchBackspaceGesture(current.coordinatorToken, nodeId);
    },
    remove(
      handle: number,
      nodeId: NoteId,
      focusNodeId: NoteId | null
    ): boolean {
      const current = origin(handle);
      return current?.session.removeEmptyNodeInBackspaceGesture(
        current.coordinatorToken,
        nodeId,
        focusNodeId
      ) ?? false;
    },
    finish(
      bindingKey: object,
      reason: "keyup" | "blur" | "hidden" | "drain"
    ): Promise<NotesWorkspaceCommandOutcome> {
      const handle = activeHandleByBinding.get(bindingKey);
      if (handle === undefined) return Promise.resolve("skipped");
      const current = origin(handle);
      if (!current) return Promise.resolve("skipped");
      if (current.finishing) return current.finishing;
      const completion = current.session
        .finishBackspaceGesture(reason)
        .finally(() => forget(handle, current));
      current.finishing = completion;
      return completion;
    },
    cancel(bindingKey: object): void {
      const handle = activeHandleByBinding.get(bindingKey);
      if (handle === undefined) return;
      const current = origin(handle);
      if (!current || current.finishing) return;
      current.session.cancelBackspaceGesture();
      forget(handle, current);
    }
  };
}

const coordinatorSessionByDraftEngine = new WeakMap<
  NotesDraftEngine,
  NotesWorkspaceCoordinatorSession
>();

export function registerCoordinatorSessionForDraftEngine(
  engine: NotesDraftEngine,
  session: NotesWorkspaceCoordinatorSession
): void {
  coordinatorSessionByDraftEngine.set(engine, session);
}

export async function shutdownAfterBackspaceDrain(
  engine: NotesDraftEngine
): Promise<void> {
  const session = coordinatorSessionByDraftEngine.get(engine);
  if (
    engine.record.backspaceDraftLease?.active === true &&
    session !== undefined
  ) {
    try {
      await session.finishBackspaceGesture("drain");
    } catch {
      // Shutdown still owns disposal after a terminal drain failure.
    }
  }
  try {
    await engine.beginShutdown();
  } finally {
    engine.dispose();
  }
}

export function observeBackspaceGestureTerminalOutcome(
  completion: Promise<NotesWorkspaceCommandOutcome>,
  observer: (outcome: NotesWorkspaceCommandOutcome) => void
): void {
  void completion.then(observer, () => observer("failed"));
}

const EMPTY_DRAFTS: Readonly<Record<NoteId, NotesNodeDraft>> = {};

export function useNotesDraftExternalStore(
  draftEngineRef: { readonly current: NotesDraftEngine | null }
) {
  const draftsListeners = useRef(new Set<() => void>());
  const writeErrorListeners = useRef(new Set<() => void>());
  const subscribeDrafts = useCallback((listener: () => void) => {
    draftsListeners.current.add(listener);
    return () => draftsListeners.current.delete(listener);
  }, []);
  const subscribeWriteError = useCallback((listener: () => void) => {
    writeErrorListeners.current.add(listener);
    return () => writeErrorListeners.current.delete(listener);
  }, []);
  const draftsByNodeId = useSyncExternalStore(
    subscribeDrafts,
    () => draftEngineRef.current?.getDraftsSnapshot() ?? EMPTY_DRAFTS
  );
  const currentWriteError = useSyncExternalStore(
    subscribeWriteError,
    (): NotesStoreError | null =>
      draftEngineRef.current?.getWriteErrorSnapshot() ?? null
  );
  const notifyDraftsListeners = useCallback(() => {
    for (const listener of draftsListeners.current) listener();
  }, []);
  const notifyWriteErrorListeners = useCallback(() => {
    for (const listener of writeErrorListeners.current) listener();
  }, []);
  return {
    draftsByNodeId,
    currentWriteError,
    notifyDraftsListeners,
    notifyWriteErrorListeners
  };
}

export function useNotesDataDeletionExternalStore(
  repository: NotesStore,
  vaultRoot: string
): boolean {
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeToNotesDataDeletion(repository, vaultRoot, listener),
    [repository, vaultRoot]
  );
  const snapshot = useCallback(
    () => isNotesDataDeletionInProgress(repository, vaultRoot),
    [repository, vaultRoot]
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function resolveBufferedWorkspaceCommands(
  commands: BufferedWorkspaceCommand[]
): void {
  for (const command of commands) command.resolve("skipped");
}

export function enqueueBufferedWorkspaceCommands(
  session: NotesWorkspaceCoordinatorSession,
  commands: BufferedWorkspaceCommand[]
): void {
  for (const command of commands) {
    let completion: Promise<NotesWorkspaceCommandOutcome>;
    try {
      completion = command.structural
        ? session.enqueueStructural(command.work, {
            selectionPolicy: command.selectionPolicy
          })
        : session.enqueue(command.work);
    } catch {
      command.resolve("skipped");
      continue;
    }
    void completion.then(command.resolve, () => command.resolve("failed"));
  }
}

export function useNotesImageAtomEditorRuntime(
  repository: NotesStore,
  vaultRoot: string
) {
  const runtimeRef = useRef({
    repository,
    vaultRoot,
    registry: createNotesImageAtomEditorRegistry()
  });
  if (
    runtimeRef.current.repository !== repository ||
    runtimeRef.current.vaultRoot !== vaultRoot
  ) {
    runtimeRef.current = {
      repository,
      vaultRoot,
      registry: createNotesImageAtomEditorRegistry()
    };
  }
  const registry = runtimeRef.current.registry;
  return {
    registry,
    registerActiveEditor: useCallback(
      (editor: ActiveImageAtomEditor) => registry.register(editor),
      [registry]
    ),
    claimActivePaste: useCallback(
      (event: ClipboardEvent) => registry.claimPaste(event),
      [registry]
    )
  };
}

export function currentNotesNavigation(
  state: NormalizedNotesWorkspace,
  editing: NotesHistoryFocus | null
): LiveNotesNavigation {
  return {
    selectedId: editing ? editing.nodeId : state.selectedId,
    zoomRootId: state.zoomRootId,
    editingNoteId: editing ? editing.nodeId : state.editingNoteId,
    pendingFocusId: state.pendingFocusId,
    pendingFocusField: editing ? editing.field : state.pendingFocusField
  };
}

export function useNotesImageAtomAuthorityLifecycle(input: {
  readonly registry: ReturnType<typeof createNotesImageAtomEditorRegistry>;
  readonly vaultRootRef: { readonly current: string };
  readonly activeScopeRef: { readonly current: NotesWorkspaceScope };
  readonly generationRef: { readonly current: number };
  readonly sessionRef: {
    readonly current: NotesWorkspaceCoordinatorSession | null;
  };
  readonly sessionRecordRef: {
    readonly current: NotesWorkspaceSessionRecord | null;
  };
  readonly stateRef: { readonly current: NormalizedNotesWorkspace };
}) {
  const {
    registry,
    vaultRootRef,
    activeScopeRef,
    generationRef,
    sessionRef,
    sessionRecordRef,
    stateRef
  } = input;
  const captureActiveEditorAuthority = useCallback(
    (nodeId: NoteId, selection: ImageAtomEditorSelectionAuthority) =>
      registry.capturePasteAuthority(nodeId, selection),
    [registry]
  );
  const captureAuthority = useCallback(
    (
      nodeId: NoteId,
      editorAuthority: NotesImageAtomEditorAuthority
    ): CapturedImageAtomAuthority | null => {
      const record = sessionRecordRef.current;
      const session = sessionRef.current;
      const node = stateRef.current.nodesById[nodeId];
      const attachments =
        stateRef.current.attachmentsByNodeId?.[nodeId] ?? [];
      if (
        !record ||
        record.closing ||
        !session ||
        record.session !== session ||
        record.drafts.has(nodeId) ||
        !registry.isPasteAuthorityCurrent(editorAuthority) ||
        !node ||
        node.nodeKind !== "image" ||
        attachments.length !== 1
      ) {
        return null;
      }
      const attachment = attachments[0]!;
      const draft = record.drafts.get(nodeId);
      return {
        vaultRoot: vaultRootRef.current,
        scope: cloneWorkspaceScope(activeScopeRef.current),
        generation: generationRef.current,
        session,
        record,
        nodeId,
        nodeKind: node.nodeKind,
        nodeUpdatedAt: node.updatedAt,
        nodeTitle: node.title,
        nodeNote: node.note,
        nodeImageOffsetUtf16: node.imageOffsetUtf16,
        attachmentId: attachment.id,
        attachmentUpdatedAt: attachment.updatedAt,
        attachmentContentHash: attachment.contentHash,
        draftRevision: draft?.revision ?? null,
        draftTitle: draft?.title ?? node.title,
        draftNote: draft?.note ?? node.note,
        draftImageOffsetUtf16:
          draft?.imageOffsetUtf16 ?? node.imageOffsetUtf16,
        editorAuthority
      };
    },
    [
      activeScopeRef,
      generationRef,
      registry,
      sessionRecordRef,
      sessionRef,
      stateRef,
      vaultRootRef
    ]
  );
  return {
    captureActiveEditorAuthority,
    captureCutAuthority: useCallback(
      (nodeId: NoteId, authority: NotesImageAtomEditorAuthority) =>
        captureAuthority(
          nodeId,
          authority
        ) as unknown as NotesImageAtomCutAuthority | null,
      [captureAuthority]
    ),
    capturePasteAuthority: useCallback(
      (nodeId: NoteId, authority: NotesImageAtomEditorAuthority) =>
        captureAuthority(
          nodeId,
          authority
        ) as unknown as NotesImageAtomPasteAuthority | null,
      [captureAuthority]
    ),
    isPasteAuthorityCurrent: useCallback(
      (authority: NotesImageAtomPasteAuthority) =>
        registry.isPasteAuthorityCurrent(
          capturedImageAtomAuthority(authority).editorAuthority
        ) &&
        imageAtomAuthorityMatches(authority, {
          vaultRoot: vaultRootRef.current,
          scope: activeScopeRef.current,
          generation: generationRef.current,
          session: sessionRef.current,
          record: sessionRecordRef.current,
          workspace: stateRef.current
        }),
      [
        activeScopeRef,
        generationRef,
        registry,
        sessionRecordRef,
        sessionRef,
        stateRef,
        vaultRootRef
      ]
    )
  };
}
