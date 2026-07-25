export interface NotesVaultDrainParticipant {
  drain(): Promise<boolean>;
  releaseDrain(): void;
}

export interface NotesVaultDrainLease {
  readonly vaultRoot: string;
  readonly generation: number;
  commit(): void;
  release(): void;
}

interface NotesVaultDrainGeneration {
  readonly id: number;
  readonly participants: readonly NotesVaultDrainParticipant[];
  readonly completion: Promise<boolean>;
  heldLeases: number;
  committedLeases: number;
  physicallyReleased: boolean;
}

interface NotesVaultDrainState {
  readonly participants: Set<NotesVaultDrainParticipant>;
  nextGeneration: number;
  active: NotesVaultDrainGeneration | null;
}

let states = new Map<string, NotesVaultDrainState>();

function stateFor(vaultRoot: string, create: boolean): NotesVaultDrainState | null {
  let state = states.get(vaultRoot);
  if (!state && create) {
    state = {
      participants: new Set(),
      nextGeneration: 0,
      active: null,
    };
    states.set(vaultRoot, state);
  }
  return state ?? null;
}

function deleteIfIdle(vaultRoot: string, state: NotesVaultDrainState): void {
  if (state.participants.size > 0 || state.active !== null) return;
  if (states.get(vaultRoot) === state) {
    states.delete(vaultRoot);
  }
}

function releasePhysicalGeneration(
  vaultRoot: string,
  state: NotesVaultDrainState,
  generation: NotesVaultDrainGeneration,
): void {
  if (generation.physicallyReleased) return;
  generation.physicallyReleased = true;
  if (state.active === generation) {
    state.active = null;
  }
  for (const participant of generation.participants) {
    try {
      participant.releaseDrain();
    } catch {
      // One participant cannot prevent the others from being released.
    }
  }
  deleteIfIdle(vaultRoot, state);
}

function createGeneration(
  vaultRoot: string,
  state: NotesVaultDrainState,
): NotesVaultDrainGeneration {
  const participants = [...state.participants];
  let resolveCompletion!: (complete: boolean) => void;
  let rejectCompletion!: (cause: unknown) => void;
  const completion = new Promise<boolean>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const generation: NotesVaultDrainGeneration = {
    id: ++state.nextGeneration,
    participants,
    completion,
    heldLeases: 0,
    committedLeases: 0,
    physicallyReleased: false,
  };
  state.active = generation;
  void Promise.allSettled(
    participants.map((participant) => {
      try {
        return participant.drain();
      } catch (cause) {
        return Promise.reject(cause);
      }
    }),
  ).then(
    (results) => {
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
        releasePhysicalGeneration(vaultRoot, state, generation);
      }
      if (rejection) {
        rejectCompletion(rejection.reason);
      } else {
        resolveCompletion(complete);
      }
    },
    rejectCompletion,
  );
  return generation;
}

function createNoopLease(vaultRoot: string): NotesVaultDrainLease {
  return Object.freeze({
    vaultRoot,
    generation: 0,
    commit(): void {},
    release(): void {},
  });
}

function createLease(
  vaultRoot: string,
  state: NotesVaultDrainState,
  generation: NotesVaultDrainGeneration,
): NotesVaultDrainLease {
  let status: "held" | "committed" | "released" = "held";
  return Object.freeze({
    vaultRoot,
    generation: generation.id,
    commit(): void {
      if (status !== "held") return;
      status = "committed";
      generation.heldLeases = Math.max(0, generation.heldLeases - 1);
      generation.committedLeases += 1;
    },
    release(): void {
      if (status !== "held") return;
      status = "released";
      generation.heldLeases = Math.max(0, generation.heldLeases - 1);
      if (
        state.active === generation &&
        generation.heldLeases === 0 &&
        generation.committedLeases === 0
      ) {
        releasePhysicalGeneration(vaultRoot, state, generation);
      }
    },
  });
}

export function registerNotesVaultDrain(
  vaultRoot: string,
  participant: NotesVaultDrainParticipant,
): () => void {
  const state = stateFor(vaultRoot, true)!;
  state.participants.add(participant);
  return () => {
    state.participants.delete(participant);
    const generation = state.active;
    if (
      generation &&
      generation.committedLeases > 0 &&
      generation.participants.every(
        (snapshotParticipant) => !state.participants.has(snapshotParticipant),
      )
    ) {
      state.active = null;
    }
    deleteIfIdle(vaultRoot, state);
  };
}

export async function acquireNotesVaultDrain(
  vaultRoot: string,
): Promise<NotesVaultDrainLease | null> {
  const state = stateFor(vaultRoot, false);
  if (!state || state.participants.size === 0) {
    return createNoopLease(vaultRoot);
  }
  const generation = state.active ?? createGeneration(vaultRoot, state);
  generation.heldLeases += 1;
  try {
    if (!(await generation.completion)) {
      return null;
    }
    return createLease(vaultRoot, state, generation);
  } catch (cause) {
    throw cause;
  } finally {
    if (generation.physicallyReleased) {
      generation.heldLeases = Math.max(0, generation.heldLeases - 1);
    }
  }
}

export function resetNotesVaultDrainRegistryForTests(): void {
  states = new Map();
}
