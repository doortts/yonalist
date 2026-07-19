import { describe, expect, it } from "vitest";
import type { NotesWorkspace } from "../../domain/notes";
import {
  authoritative,
  scopedActiveDelta,
  unwrapNotesMutation
} from "./notesWorkspaceProjection";

const workspace: NotesWorkspace = { nodes: [] };

describe("notes workspace projection", () => {
  it("preserves the authoritative queue result shape", () => {
    expect(authoritative(workspace, { selectedId: "root" })).toEqual({
      kind: "authoritative",
      workspace,
      uiUpdate: { selectedId: "root" },
      historyStatus: undefined
    });
  });

  it("unwraps a legacy workspace without inventing history metadata", () => {
    expect(unwrapNotesMutation(workspace)).toEqual({
      workspace,
      historyEntryId: undefined,
      historyStatus: undefined,
      atomic: false,
      delta: null,
      importedRootIds: undefined,
      duplicatedRootIds: undefined
    });
  });

  it("does not manufacture an active delta", () => {
    expect(scopedActiveDelta(null)).toBeUndefined();
  });
});
