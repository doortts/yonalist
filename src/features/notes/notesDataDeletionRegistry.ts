import type { NotesStore } from "../../domain/notes";
import type { NotesDraftEngine } from "./notesDraftEngine";

interface NotesDataDeletionVaultState {
  owner: object | null;
  readonly subscribers: Set<() => void>;
  readonly participants: Set<NotesDraftEngine>;
}

let states = new WeakMap<NotesStore, Map<string, NotesDataDeletionVaultState>>();

function stateFor(
  repository: NotesStore,
  vaultRoot: string,
  create: boolean
): NotesDataDeletionVaultState | null {
  let vaults = states.get(repository);
  if (!vaults && create) {
    vaults = new Map();
    states.set(repository, vaults);
  }
  let state = vaults?.get(vaultRoot);
  if (!state && create) {
    state = {
      owner: null,
      subscribers: new Set(),
      participants: new Set()
    };
    vaults!.set(vaultRoot, state);
  }
  return state ?? null;
}

function deleteIfEmpty(
  repository: NotesStore,
  vaultRoot: string,
  state: NotesDataDeletionVaultState
): void {
  if (
    state.owner !== null ||
    state.subscribers.size > 0 ||
    state.participants.size > 0
  ) {
    return;
  }
  const vaults = states.get(repository);
  if (vaults?.get(vaultRoot) !== state) return;
  vaults.delete(vaultRoot);
  if (vaults.size === 0) states.delete(repository);
}

function notify(state: NotesDataDeletionVaultState): void {
  for (const subscriber of state.subscribers) subscriber();
}

export function reserveNotesDataDeletion(
  repository: NotesStore,
  vaultRoot: string,
  token: object
): boolean {
  const state = stateFor(repository, vaultRoot, true)!;
  if (state.owner !== null) return false;
  state.owner = token;
  notify(state);
  return true;
}

export function releaseNotesDataDeletion(
  repository: NotesStore,
  vaultRoot: string,
  token: object
): void {
  const state = stateFor(repository, vaultRoot, false);
  if (state?.owner !== token) return;
  state.owner = null;
  notify(state);
  deleteIfEmpty(repository, vaultRoot, state);
}

export function isNotesDataDeletionInProgress(
  repository: NotesStore,
  vaultRoot: string
): boolean {
  return stateFor(repository, vaultRoot, false)?.owner != null;
}

export function subscribeToNotesDataDeletion(
  repository: NotesStore,
  vaultRoot: string,
  subscriber: () => void
): () => void {
  const state = stateFor(repository, vaultRoot, true)!;
  state.subscribers.add(subscriber);
  return () => {
    state.subscribers.delete(subscriber);
    deleteIfEmpty(repository, vaultRoot, state);
  };
}

export function registerNotesDataDeletionParticipant(
  repository: NotesStore,
  vaultRoot: string,
  engine: NotesDraftEngine
): () => void {
  const state = stateFor(repository, vaultRoot, true)!;
  state.participants.add(engine);
  return () => {
    state.participants.delete(engine);
    deleteIfEmpty(repository, vaultRoot, state);
  };
}

export function notesDataDeletionParticipants(
  repository: NotesStore,
  vaultRoot: string
): readonly NotesDraftEngine[] {
  return [...(stateFor(repository, vaultRoot, false)?.participants ?? [])];
}

export function resetNotesDataDeletionRegistryForTests(): void {
  states = new WeakMap();
}
