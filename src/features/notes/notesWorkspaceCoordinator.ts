import type {
  NoteId,
  NotesStore,
  NotesWorkspace
} from "../../domain/notes";

export type NotesWorkspaceUiUpdate = Partial<{
  selectedId: NoteId | null;
  zoomRootId: NoteId | null;
  editingNoteId: NoteId | null;
  pendingFocusId: NoteId | null;
}>;

export type NotesWorkspaceQueueResult =
  | {
      kind: "authoritative";
      workspace: NotesWorkspace;
      uiUpdate?: NotesWorkspaceUiUpdate;
    }
  | { kind: "skipped" };

export type NotesWorkspaceQueueSettlement =
  | NotesWorkspaceQueueResult
  | { kind: "failure"; error: string };

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
      type: "settled";
      result: NotesWorkspaceQueueSettlement;
      hasPendingWork: boolean;
    };

export interface OpenNotesWorkspaceSessionOptions {
  repository: NotesStore;
  vaultRoot: string;
  onEvent(event: NotesWorkspaceCoordinatorEvent): void;
}

export interface NotesWorkspaceCoordinatorSession {
  readonly activation: Promise<void>;
  enqueue(work: NotesWorkspaceQueueWork): Promise<void>;
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
  sessions: Set<SessionState>;
  queue: QueueItem[];
  running: QueueItem | null;
  pendingActivation: ActivationItem | null;
}

interface SessionState {
  entry: CoordinatorEntry;
  active: boolean;
  pendingWork: number;
  activationItem: ActivationItem | null;
  onEvent: ((event: NotesWorkspaceCoordinatorEvent) => void) | null;
}

interface QueueItemBase {
  entry: CoordinatorEntry;
  completion: Promise<void>;
  resolveCompletion: (() => void) | null;
  canceled: boolean;
}

interface ActivationItem extends QueueItemBase {
  kind: "activation";
  sessions: Set<SessionState>;
}

interface CommandItem extends QueueItemBase {
  kind: "command";
  owner: SessionState | null;
  work: NotesWorkspaceQueueWork | null;
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
      entry.queue.length > 0
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

    if (result.kind === "authoritative") {
      entry.confirmedWorkspace = result.workspace;
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
      item.owner = null;
      item.work = null;
      if (owner?.active) {
        owner.pendingWork = Math.max(0, owner.pendingWork - 1);
        notify(owner, {
          type: "settled",
          result,
          hasPendingWork: owner.pendingWork > 0
        });
      }
    }

    finishCompletion(item);
    pump(entry);
  };

  const executeItem = async (item: QueueItem): Promise<void> => {
    let result: NotesWorkspaceQueueSettlement;
    try {
      if (item.kind === "activation") {
        let initialization: Promise<void>;
        try {
          initialization = item.entry.repository.initialize(item.entry.vaultRoot);
        } catch (cause) {
          await Promise.resolve();
          throw cause;
        }
        await initialization;
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
            confirmedWorkspace: item.entry.confirmedWorkspace
          });
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
        sessions: new Set(),
        queue: [],
        running: null,
        pendingActivation: null
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

    const running = session.entry.running;
    if (running?.kind === "command" && running.owner === session) {
      running.owner = null;
    }
    session.pendingWork = 0;
    maybeDeleteEntry(session.entry);
  };

  return {
    openSession({
      repository,
      vaultRoot,
      onEvent
    }: OpenNotesWorkspaceSessionOptions): NotesWorkspaceCoordinatorSession {
      const entry = getOrCreateEntry(repository, vaultRoot);
      const session: SessionState = {
        entry,
        active: true,
        pendingWork: 1,
        activationItem: null,
        onEvent
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
      return {
        activation: activationCompletion,
        enqueue(work: NotesWorkspaceQueueWork): Promise<void> {
          if (!session.active) {
            return Promise.resolve();
          }
          const completion = completionParts();
          const item: CommandItem = {
            kind: "command",
            entry,
            owner: session,
            work,
            canceled: false,
            ...completion
          };
          session.pendingWork += 1;
          entry.queue.push(item);
          notify(session, { type: "pending" });
          pump(entry);
          return item.completion;
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
