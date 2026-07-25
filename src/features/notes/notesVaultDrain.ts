export interface NotesVaultDrainParticipant {
  drain(): Promise<boolean>;
}

interface NotesVaultDrainState {
  readonly participants: Set<NotesVaultDrainParticipant>;
  inFlight: Promise<boolean> | null;
}

let states = new Map<string, NotesVaultDrainState>();

function stateFor(vaultRoot: string, create: boolean): NotesVaultDrainState | null {
  let state = states.get(vaultRoot);
  if (!state && create) {
    state = { participants: new Set(), inFlight: null };
    states.set(vaultRoot, state);
  }
  return state ?? null;
}

function deleteIfIdle(vaultRoot: string, state: NotesVaultDrainState): void {
  if (state.participants.size > 0 || state.inFlight !== null) return;
  if (states.get(vaultRoot) === state) {
    states.delete(vaultRoot);
  }
}

export function registerNotesVaultDrain(
  vaultRoot: string,
  participant: NotesVaultDrainParticipant,
): () => void {
  const state = stateFor(vaultRoot, true)!;
  state.participants.add(participant);
  return () => {
    state.participants.delete(participant);
    deleteIfIdle(vaultRoot, state);
  };
}

export function drainNotesVault(vaultRoot: string): Promise<boolean> {
  const state = stateFor(vaultRoot, false);
  if (!state || state.participants.size === 0) {
    return Promise.resolve(true);
  }
  if (state.inFlight) return state.inFlight;

  const participants = [...state.participants];
  const drain = Promise.all(participants.map((participant) => participant.drain()))
    .then((results) => results.every(Boolean))
    .finally(() => {
      if (state.inFlight === drain) {
        state.inFlight = null;
      }
      deleteIfIdle(vaultRoot, state);
    });
  state.inFlight = drain;
  return drain;
}

export function resetNotesVaultDrainRegistryForTests(): void {
  states = new Map();
}
