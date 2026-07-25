export interface NotesVaultDrainParticipant {
  drain(): Promise<boolean>;
  releaseDrain(): void;
}

interface NotesVaultDrainState {
  readonly participants: Set<NotesVaultDrainParticipant>;
  inFlight: Promise<boolean> | null;
  inFlightParticipants: readonly NotesVaultDrainParticipant[] | null;
}

let states = new Map<string, NotesVaultDrainState>();

function stateFor(vaultRoot: string, create: boolean): NotesVaultDrainState | null {
  let state = states.get(vaultRoot);
  if (!state && create) {
    state = {
      participants: new Set(),
      inFlight: null,
      inFlightParticipants: null,
    };
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
  const drain = Promise.allSettled(
    participants.map((participant) => {
      try {
        return participant.drain();
      } catch (cause) {
        return Promise.reject(cause);
      }
    }),
  )
    .then((results) => {
      const rejection = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      const complete =
        !rejection &&
        results.every(
          (result) => result.status === "fulfilled" && result.value,
        );
      if (!complete) {
        for (const participant of participants) {
          try {
            participant.releaseDrain();
          } catch {
            // One participant cannot prevent the others from being released.
          }
        }
      }
      if (rejection) throw rejection.reason;
      return complete;
    })
    .finally(() => {
      if (state.inFlight === drain) {
        state.inFlight = null;
        state.inFlightParticipants = null;
      }
      deleteIfIdle(vaultRoot, state);
    });
  state.inFlight = drain;
  state.inFlightParticipants = participants;
  return drain;
}

export function releaseNotesVaultDrain(vaultRoot: string): Promise<void> {
  const state = stateFor(vaultRoot, false);
  if (!state) return Promise.resolve();
  const participants =
    state.inFlightParticipants ?? [...state.participants];
  const inFlight = state.inFlight;
  return Promise.resolve(inFlight)
    .catch(() => false)
    .then(() => {
      for (const participant of participants) {
        try {
          participant.releaseDrain();
        } catch {
          // Release every participant even if one cleanup fails.
        }
      }
    });
}

export function resetNotesVaultDrainRegistryForTests(): void {
  states = new Map();
}
