import { describe, expect, it, vi } from "vitest";
import type { NotesStore } from "../../domain/notes";
import type { NotesDraftEngine } from "./notesDraftEngine";
import {
  isNotesDataDeletionInProgress,
  notesDataDeletionParticipants,
  registerNotesDataDeletionParticipant,
  releaseNotesDataDeletion,
  reserveNotesDataDeletion,
  resetNotesDataDeletionRegistryForTests,
  subscribeToNotesDataDeletion
} from "./notesDataDeletionRegistry";

describe("notesDataDeletionRegistry", () => {
  it("coordinates one deletion owner and the vault draft participants", () => {
    const repository = {} as NotesStore;
    const engine = {} as NotesDraftEngine;
    const owner = {};
    const subscriber = vi.fn();
    const unsubscribe = subscribeToNotesDataDeletion(
      repository,
      "/vault",
      subscriber
    );
    const unregister = registerNotesDataDeletionParticipant(
      repository,
      "/vault",
      engine
    );

    expect(reserveNotesDataDeletion(repository, "/vault", owner)).toBe(true);
    expect(reserveNotesDataDeletion(repository, "/vault", {})).toBe(false);
    expect(isNotesDataDeletionInProgress(repository, "/vault")).toBe(true);
    expect(notesDataDeletionParticipants(repository, "/vault")).toEqual([engine]);

    releaseNotesDataDeletion(repository, "/vault", owner);
    expect(isNotesDataDeletionInProgress(repository, "/vault")).toBe(false);
    expect(subscriber).toHaveBeenCalledTimes(2);

    unregister();
    unsubscribe();
    resetNotesDataDeletionRegistryForTests();
  });
});
