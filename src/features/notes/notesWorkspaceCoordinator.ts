import type {
  NoteId,
  NotesHistoryStatus,
  NotesStore,
  NotesWorkspace,
  NotesWorkspaceScope
} from "../../domain/notes";
import {
  createNotesHistorySession,
  type NotesHistoryFocusField,
  type NotesHistorySession
} from "./notesHistory";

export type NotesWorkspaceUiUpdate = Partial<{
  selectedId: NoteId | null;
  zoomRootId: NoteId | null;
  editingNoteId: NoteId | null;
  pendingFocusId: NoteId | null;
  pendingFocusField: NotesHistoryFocusField | null;
}>;

export type NotesWorkspaceQueueResult =
  | {
      kind: "authoritative";
      workspace: NotesWorkspace;
      uiUpdate?: NotesWorkspaceUiUpdate;
      historyStatus?: NotesHistoryStatus;
      historyVersion?: number;
      suppressSynchronization?: boolean;
      scopeAgnostic?: boolean;
      committedHistoryEntryIds?: readonly string[];
    }
  | { kind: "skipped" }
  | {
      kind: "failure";
      error: string;
      workspace?: NotesWorkspace;
      historyStatus?: NotesHistoryStatus;
      historyVersion?: number;
      committedHistoryEntryIds?: readonly string[];
    };

export type NotesWorkspaceQueueSettlement = NotesWorkspaceQueueResult;

export interface NotesWorkspaceQueueContext {
  repository: NotesStore;
  vaultRoot: string;
  confirmedWorkspace: NotesWorkspace;
}

export type NotesWorkspaceQueueWork = (
  context: NotesWorkspaceQueueContext
) => Promise<NotesWorkspaceQueueResult> | NotesWorkspaceQueueResult;

export type NotesWorkspaceCoordinatorEvent =
  | { type: "pending" }
  | {
      type: "synchronized";
      result: NotesWorkspaceQueueSettlement;
      hasPendingWork: boolean;
      sourceScope: NotesWorkspaceScope | null;
    }
  | {
      type: "settled";
      result: NotesWorkspaceQueueSettlement;
      hasPendingWork: boolean;
    };

export interface OpenNotesWorkspaceSessionOptions {
  repository: NotesStore;
  vaultRoot: string;
  onEvent(event: NotesWorkspaceCoordinatorEvent): void;
  beforeStructural?: (cutoff: number) => Promise<boolean>;
  captureDraftCutoff?: () => number;
  afterStructural?: (cutoff: number) => void;
  isCurrent?: () => boolean;
  getScope?: () => NotesWorkspaceScope;
}

export interface NotesWorkspaceCoordinatorSession {
  readonly activation: Promise<void>;
  readonly history: NotesHistorySession;
  enqueue(work: NotesWorkspaceQueueWork): Promise<void>;
  enqueueStructural(work: NotesWorkspaceQueueWork): Promise<void>;
  close(): void;
}

export interface NotesWorkspaceCoordinatorRegistry {
  openSession(
    options: OpenNotesWorkspaceSessionOptions
  ): NotesWorkspaceCoordinatorSession;
  hasCoordinator(repository: NotesStore, vaultRoot: string): boolean;
}

interface CoordinatorEntry {
  repository: NotesStore;
  vaultRoot: string;
  confirmedWorkspace: NotesWorkspace;
  history: NotesHistorySession;
  initialized: boolean;
  sessions: Set<SessionState>;
  queue: QueueItem[];
  running: QueueItem | null;
  pendingActivation: ActivationItem | null;
  structuralTail: Promise<void>;
  pendingStructuralBarriers: number;
  historyStatus: NotesHistoryStatus;
  historyVersion: number;
}

interface SessionState {
  entry: CoordinatorEntry;
  active: boolean;
  pendingWork: number;
  activationItem: ActivationItem | null;
  onEvent: ((event: NotesWorkspaceCoordinatorEvent) => void) | null;
  beforeStructural: ((cutoff: number) => Promise<boolean>) | null;
  captureDraftCutoff: (() => number) | null;
  afterStructural: ((cutoff: number) => void) | null;
  isCurrent: (() => boolean) | null;
  getScope: (() => NotesWorkspaceScope) | null;
  closeCompletion: Promise<void>;
  resolveClose: () => void;
  confirmedWorkspace: NotesWorkspace;
}

interface QueueItemBase {
  entry: CoordinatorEntry;
  completion: Promise<void>;
  resolveCompletion: (() => void) | null;
  canceled: boolean;
}

const LEGACY_HISTORY_SESSION_ID = "00000000-0000-4000-8000-000000000000";

interface ActivationItem extends QueueItemBase {
  kind: "activation";
  sessions: Set<SessionState>;
}

interface CommandItem extends QueueItemBase {
  kind: "command";
  owner: SessionState | null;
  work: NotesWorkspaceQueueWork | null;
  sourceScope: NotesWorkspaceScope;
}

type QueueItem = ActivationItem | CommandItem;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function completionParts(): {
  completion: Promise<void>;
  resolveCompletion: () => void;
} {
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  return { completion, resolveCompletion };
}

function notify(
  session: SessionState,
  event: NotesWorkspaceCoordinatorEvent
): void {
  if (!session.active || !session.onEvent) {
    return;
  }
  try {
    session.onEvent(event);
  } catch {
    // A consumer callback cannot be allowed to strand the serialization queue.
  }
}

function hasLiveActivationSession(item: ActivationItem): boolean {
  return [...item.sessions].some(
    (session) => session.active && item.entry.sessions.has(session)
  );
}

export function createNotesWorkspaceCoordinatorRegistry(): NotesWorkspaceCoordinatorRegistry {
  const entries = new WeakMap<NotesStore, Map<string, CoordinatorEntry>>();

  const maybeDeleteEntry = (entry: CoordinatorEntry): void => {
    if (
      entry.sessions.size > 0 ||
      entry.running !== null ||
      entry.queue.length > 0 ||
      entry.pendingStructuralBarriers > 0
    ) {
      return;
    }

    const repositoryEntries = entries.get(entry.repository);
    if (repositoryEntries?.get(entry.vaultRoot) !== entry) {
      return;
    }
    repositoryEntries.delete(entry.vaultRoot);
    if (repositoryEntries.size === 0) {
      entries.delete(entry.repository);
    }
  };

  const finishCompletion = (item: QueueItem): void => {
    const resolve = item.resolveCompletion;
    item.resolveCompletion = null;
    resolve?.();
  };

  const cancelItem = (item: QueueItem): void => {
    item.canceled = true;
    if (item.kind === "activation") {
      item.sessions.clear();
      if (item.entry.pendingActivation === item) {
        item.entry.pendingActivation = null;
      }
    } else {
      item.owner = null;
      item.work = null;
    }
    finishCompletion(item);
  };

  const removeQueuedItem = (item: QueueItem): void => {
    const index = item.entry.queue.indexOf(item);
    if (index >= 0) {
      item.entry.queue.splice(index, 1);
    }
    cancelItem(item);
  };

  const settleItem = (
    item: QueueItem,
    result: NotesWorkspaceQueueSettlement
  ): void => {
    const entry = item.entry;
    if (entry.running !== item) {
      return;
    }
    entry.running = null;

    const authoritativeWorkspace =
      result.kind === "authoritative"
        ? result.workspace
        : result.kind === "failure"
          ? result.workspace
          : undefined;
    if (authoritativeWorkspace) {
      entry.confirmedWorkspace = authoritativeWorkspace;
    }

    if (item.kind === "activation") {
      if (entry.pendingActivation === item) {
        entry.pendingActivation = null;
      }
      for (const session of item.sessions) {
        if (session.activationItem === item) {
          session.activationItem = null;
        }
        if (!session.active) {
          continue;
        }
        if (authoritativeWorkspace) {
          session.confirmedWorkspace = authoritativeWorkspace;
        }
        session.pendingWork = Math.max(0, session.pendingWork - 1);
        notify(session, {
          type: "settled",
          result,
          hasPendingWork: session.pendingWork > 0
        });
      }
      item.sessions.clear();
    } else {
      const owner = item.owner;
      item.work = null;
      if (owner && authoritativeWorkspace) {
        owner.confirmedWorkspace = authoritativeWorkspace;
      }
      if (owner?.active) {
        owner.pendingWork = Math.max(0, owner.pendingWork - 1);
        notify(owner, {
          type: "settled",
          result,
          hasPendingWork: owner.pendingWork > 0
        });
      }
      if (
        authoritativeWorkspace &&
        !(result.kind === "authoritative" && result.suppressSynchronization)
      ) {
        const sourceScope =
          result.kind === "authoritative" && result.scopeAgnostic
            ? null
            : owner?.active && owner.getScope
              ? owner.getScope()
              : item.sourceScope;
        const synchronizedResult: NotesWorkspaceQueueSettlement =
          result.kind === "authoritative"
            ? {
                kind: "authoritative",
                workspace: result.workspace,
                historyStatus: result.historyStatus,
                historyVersion: result.historyVersion,
                ...(result.committedHistoryEntryIds
                  ? {
                      committedHistoryEntryIds:
                        result.committedHistoryEntryIds
                    }
                  : {})
              }
            : result;
        for (const session of entry.sessions) {
          if (session !== owner) {
            if (
              sourceScope !== null &&
              session.getScope &&
              JSON.stringify(session.getScope()) === JSON.stringify(sourceScope)
            ) {
              session.confirmedWorkspace = authoritativeWorkspace;
            }
            notify(session, {
              type: "synchronized",
              result: synchronizedResult,
              hasPendingWork: session.pendingWork > 0,
              sourceScope
            });
          }
        }
      }
      item.owner = null;
    }

    finishCompletion(item);
    pump(entry);
  };

  const executeItem = async (item: QueueItem): Promise<void> => {
    let result: NotesWorkspaceQueueSettlement;
    try {
      if (item.kind === "activation") {
        if (!item.entry.initialized) {
          let initialization: Promise<void>;
          try {
            initialization = item.entry.repository.initialize(item.entry.vaultRoot);
          } catch (cause) {
            await Promise.resolve();
            throw cause;
          }
          await initialization;
          item.entry.initialized = true;
        }
        if (!hasLiveActivationSession(item)) {
          result = { kind: "skipped" };
        } else {
          const workspace = await item.entry.repository.loadWorkspace(
            item.entry.vaultRoot,
            { kind: "active" }
          );
          result = { kind: "authoritative", workspace };
        }
      } else {
        const work = item.work;
        if (!work) {
          result = { kind: "skipped" };
        } else {
          result = await work({
            repository: item.entry.repository,
            vaultRoot: item.entry.vaultRoot,
            confirmedWorkspace:
              item.owner?.confirmedWorkspace ?? item.entry.confirmedWorkspace
          });
        }
      }
      if (
        result.kind === "authoritative" ||
        (result.kind === "failure" && result.workspace)
      ) {
        let status = result.historyStatus;
        if (!status && item.entry.repository.historyStatus) {
          try {
            status = await item.entry.repository.historyStatus(
              item.entry.vaultRoot,
              item.entry.history.sessionId
            );
          } catch {
            // Workspace authority remains valid when status discovery fails.
          }
        }
        if (status) {
          item.entry.historyStatus = status;
          item.entry.historyVersion += 1;
          result = {
            ...result,
            historyStatus: status,
            historyVersion: item.entry.historyVersion
          };
        }
      }
    } catch (cause) {
      result = { kind: "failure", error: errorMessage(cause) };
    }
    settleItem(item, result);
  };

  function pump(entry: CoordinatorEntry): void {
    if (entry.running) {
      return;
    }

    while (entry.queue.length > 0) {
      const item = entry.queue.shift()!;
      if (item.canceled) {
        continue;
      }
      if (
        (item.kind === "activation" && !hasLiveActivationSession(item)) ||
        (item.kind === "command" && !item.owner?.active)
      ) {
        cancelItem(item);
        continue;
      }

      entry.running = item;
      void executeItem(item);
      return;
    }

    maybeDeleteEntry(entry);
  }

  const getOrCreateEntry = (
    repository: NotesStore,
    vaultRoot: string
  ): CoordinatorEntry => {
    let repositoryEntries = entries.get(repository);
    if (!repositoryEntries) {
      repositoryEntries = new Map();
      entries.set(repository, repositoryEntries);
    }

    let entry = repositoryEntries.get(vaultRoot);
    if (!entry) {
      entry = {
        repository,
        vaultRoot,
        confirmedWorkspace: { nodes: [] },
        history: createNotesHistorySession(
          repository.undo && repository.redo
            ? undefined
            : { createId: () => LEGACY_HISTORY_SESSION_ID }
        ),
        initialized: false,
        sessions: new Set(),
        queue: [],
        running: null,
        pendingActivation: null,
        structuralTail: Promise.resolve(),
        pendingStructuralBarriers: 0,
        historyStatus: { canUndo: false, canRedo: false },
        historyVersion: 0
      };
      repositoryEntries.set(vaultRoot, entry);
    }
    return entry;
  };

  const closeSession = (session: SessionState): void => {
    if (!session.active) {
      return;
    }

    session.active = false;
    session.entry.sessions.delete(session);
    session.onEvent = null;
    session.beforeStructural = null;
    session.captureDraftCutoff = null;
    session.afterStructural = null;
    session.isCurrent = null;
    session.getScope = null;
    session.resolveClose();

    const activation = session.activationItem;
    session.activationItem = null;
    if (activation) {
      activation.sessions.delete(session);
      if (
        activation.sessions.size === 0 &&
        session.entry.running !== activation
      ) {
        removeQueuedItem(activation);
      }
    }

    for (const item of [...session.entry.queue]) {
      if (item.kind === "command" && item.owner === session) {
        removeQueuedItem(item);
      }
    }

    session.pendingWork = 0;
    maybeDeleteEntry(session.entry);
  };

  return {
    openSession({
      repository,
      vaultRoot,
      onEvent,
      beforeStructural,
      captureDraftCutoff,
      afterStructural,
      isCurrent,
      getScope
    }: OpenNotesWorkspaceSessionOptions): NotesWorkspaceCoordinatorSession {
      const entry = getOrCreateEntry(repository, vaultRoot);
      const session: SessionState = {
        ...(() => {
          const close = completionParts();
          return {
            closeCompletion: close.completion,
            resolveClose: close.resolveCompletion
          };
        })(),
        entry,
        active: true,
        pendingWork: 1,
        activationItem: null,
        onEvent,
        beforeStructural: beforeStructural ?? null,
        captureDraftCutoff: captureDraftCutoff ?? null,
        afterStructural: afterStructural ?? null,
        isCurrent: isCurrent ?? null,
        getScope: getScope ?? null,
        confirmedWorkspace: entry.confirmedWorkspace
      };
      entry.sessions.add(session);

      let activation = entry.pendingActivation;
      if (!activation) {
        const completion = completionParts();
        activation = {
          kind: "activation",
          entry,
          sessions: new Set(),
          canceled: false,
          ...completion
        };
        entry.pendingActivation = activation;
        entry.queue.push(activation);
      }
      activation.sessions.add(session);
      session.activationItem = activation;
      pump(entry);

      const activationCompletion = activation.completion;
      const enqueueCommand = (work: NotesWorkspaceQueueWork): Promise<void> => {
        if (!session.active) {
          return Promise.resolve();
        }
        const completion = completionParts();
        const item: CommandItem = {
          kind: "command",
          entry,
          owner: session,
          work,
          sourceScope: session.getScope?.() ?? { kind: "active" },
          canceled: false,
          ...completion
        };
        session.pendingWork += 1;
        entry.queue.push(item);
        notify(session, { type: "pending" });
        pump(entry);
        return item.completion;
      };
      return {
        activation: activationCompletion,
        history: entry.history,
        enqueue(work: NotesWorkspaceQueueWork): Promise<void> {
          return enqueueCommand(work);
        },
        enqueueStructural(work: NotesWorkspaceQueueWork): Promise<void> {
          const participants = [...entry.sessions]
            .filter((participant) => participant.active)
            .map((participant) => {
              const cutoff = participant.captureDraftCutoff?.() ?? 0;
              const capturedFinalizer = participant.afterStructural;
              let finalized = false;
              return {
                participant,
                cutoff,
                finalize(): void {
                  if (finalized) {
                    return;
                  }
                  finalized = true;
                  try {
                    capturedFinalizer?.(cutoff);
                  } catch {
                    // Finalization cannot be allowed to strand the structural queue.
                  }
                }
              };
            });
          const finalizeParticipants = (): void => {
            for (const intent of participants) {
              intent.finalize();
            }
          };
          entry.pendingStructuralBarriers += 1;
          const runStructuralIntent = async (): Promise<void> => {
            try {
              if (!session.active) {
                return;
              }
              for (const intent of participants) {
                const participant = intent.participant;
                if (!participant.active) {
                  continue;
                }
                if (
                  participant.beforeStructural &&
                  !(await participant.beforeStructural(intent.cutoff))
                ) {
                  if (
                    participant.active &&
                    (participant.isCurrent?.() ?? true)
                  ) {
                    return;
                  }
                }
              }
              const structural = enqueueCommand(work);
              finalizeParticipants();
              await structural;
            } finally {
              finalizeParticipants();
            }
          };
          const completion =
            entry.pendingStructuralBarriers === 1
              ? runStructuralIntent()
              : entry.structuralTail.then(runStructuralIntent);
          entry.structuralTail = completion
            .catch(() => undefined)
            .finally(() => {
              entry.pendingStructuralBarriers = Math.max(
                0,
                entry.pendingStructuralBarriers - 1
              );
              maybeDeleteEntry(entry);
            });
          return Promise.race([completion, session.closeCompletion]);
        },
        close(): void {
          closeSession(session);
        }
      };
    },

    hasCoordinator(repository: NotesStore, vaultRoot: string): boolean {
      return entries.get(repository)?.has(vaultRoot) ?? false;
    }
  };
}

export const notesWorkspaceCoordinatorRegistry =
  createNotesWorkspaceCoordinatorRegistry();
