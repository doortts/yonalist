import { describe, expect, it, vi } from "vitest";
import type { NotesStore } from "../../../domain/notes";
import { journalNotesRepository } from "./notesWorkspaceTestHarness";

describe("journalNotesRepository", () => {
  it("records repository calls using product-level fields", async () => {
    const updateNode = vi.fn<NotesStore["updateNode"]>().mockResolvedValue({
      workspace: { nodes: [] },
      historyEntryId: "entry-a",
      historyEpoch: "epoch-a",
      canUndo: true,
      canRedo: false,
      nextUndoEntryId: "entry-a",
      nextRedoEntryId: null,
      prunedEntryIds: []
    });
    const base = { updateNode } as unknown as NotesStore;
    const { repository, events } = journalNotesRepository(base);

    await repository.updateNode(
      "/vault",
      { id: "root", title: "A", note: "", imageOffsetUtf16: 0 },
      {
        sessionId: "session-a",
        historyEpoch: "epoch-a",
        entryId: "entry-a",
        commandKind: "update-node"
      }
    );

    expect(events.for("updateNode")).toEqual([
      expect.objectContaining({
        sequence: 0,
        operation: "updateNode",
        vaultRoot: "/vault",
        nodeId: "root",
        historyEntryId: "entry-a",
        historySessionId: "session-a",
        commandKind: "update-node",
        input: { id: "root", title: "A", note: "", imageOffsetUtf16: 0 }
      })
    ]);
    expect(repository.updateNode).toBe(repository.updateNode);
    expect(updateNode).toHaveBeenCalledOnce();
  });

  it("clears the journal without replacing the wrapped repository", async () => {
    const loadWorkspace = vi
      .fn<NotesStore["loadWorkspace"]>()
      .mockResolvedValue({ nodes: [] });
    const base = { loadWorkspace } as unknown as NotesStore;
    const { repository, events } = journalNotesRepository(base);

    await repository.loadWorkspace("/vault", { kind: "active" });
    events.clear();

    expect(events.all).toEqual([]);
    expect(repository.loadWorkspace).toBe(repository.loadWorkspace);
  });
});
