import { describe, expect, it } from "vitest";
import {
  notesSelectionMutationDisabledReason,
  notesSelectionOperationDisabledReason,
  type NotesSelectionOperation
} from "./notesSelectionMutationAvailability";

describe("notesSelectionMutationDisabledReason", () => {
  it("disables selection mutations while notes are loading", () => {
    expect(
      notesSelectionMutationDisabledReason({
        deletingNotesData: false,
        lifecycleReadOnly: false,
        loading: true,
        writeError: false
      })
    ).toBe("Notes are updating.");
  });

  it("keeps lifecycle safety reasons in deterministic priority order", () => {
    expect(
      notesSelectionMutationDisabledReason({
        deletingNotesData: true,
        lifecycleReadOnly: true,
        loading: true,
        writeError: true
      })
    ).toBe("Notes data is being deleted.");
    expect(
      notesSelectionMutationDisabledReason({
        deletingNotesData: false,
        lifecycleReadOnly: true,
        loading: true,
        writeError: true
      })
    ).toBe("Selection actions are unavailable in Archive or Trash.");
    expect(
      notesSelectionMutationDisabledReason({
        deletingNotesData: false,
        lifecycleReadOnly: false,
        loading: false,
        writeError: true
      })
    ).toBe("Retry the failed save before changing notes.");
  });

  it("allows selection mutations when no lifecycle guard is active", () => {
    expect(
      notesSelectionMutationDisabledReason({
        deletingNotesData: false,
        lifecycleReadOnly: false,
        loading: false,
        writeError: false
      })
    ).toBeNull();
  });

  it.each([
    "toggleComplete",
    "complete",
    "moveTo",
    "moveUp",
    "moveDown",
    "indent",
    "outdent",
    "duplicate",
    "tags",
    "addTag",
    "removeTag",
    "cut",
    "delete",
    "reorder"
  ] satisfies readonly NotesSelectionOperation[])(
    "blocks mutating selection operation %s at the semantic boundary",
    (operation) => {
      expect(
        notesSelectionOperationDisabledReason(
          operation,
          "Notes are updating."
        )
      ).toBe("Notes are updating.");
    }
  );

  it.each(["copy", "clear"] satisfies readonly NotesSelectionOperation[])(
    "keeps non-mutating selection operation %s available",
    (operation) => {
      expect(
        notesSelectionOperationDisabledReason(
          operation,
          "Notes are updating."
        )
      ).toBeNull();
    }
  );
});
