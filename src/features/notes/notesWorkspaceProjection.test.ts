import { describe, expect, it } from "vitest";
import type {
  NoteAttachment,
  NoteNode,
  NotesMutationResult,
  NotesWorkspace
} from "../../domain/notes";
import {
  applyDeltaToNotesWorkspace,
  authoritative,
  scopedActiveDelta,
  unwrapNotesMutation,
  type RawNotesMutationDelta
} from "./notesWorkspaceProjection";
import {
  applyWorkspaceDelta,
  normalizeWorkspace
} from "./notesWorkspaceReducer";

const workspace: NotesWorkspace = { nodes: [] };

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
    nodeKind: "text",
    parentId: null,
    sortKey: 1024,
    title: overrides.id,
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    imageOffsetUtf16: 0,
    ...overrides,
    markerKind: overrides.markerKind ?? "bullet",
    markdownImageWidth: overrides.markdownImageWidth ?? null
  };
}

function attachment(
  overrides: Partial<NoteAttachment> & Pick<NoteAttachment, "id" | "nodeId">
): NoteAttachment {
  return {
    sortKey: 1024,
    relativePath: `assets/${overrides.id}.png`,
    contentHash: overrides.id,
    originalName: `${overrides.id}.png`,
    mimeType: "image/png",
    byteSize: 4,
    intrinsicWidth: 640,
    intrinsicHeight: 320,
    displayWidth: 320,
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z",
    ...overrides
  };
}

const historyState = () => ({
  canUndo: true,
  canRedo: false,
  historyEpoch: "epoch",
  nextUndoEntryId: "entry",
  nextRedoEntryId: null,
  prunedEntryIds: [] as string[]
});

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
    expect(unwrapNotesMutation(workspace, null)).toEqual({
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

describe("delta-only Notes workspace projection", () => {
  const base: NotesWorkspace = {
    nodes: [
      node({ id: "a", sortKey: 1024 }),
      node({ id: "b", sortKey: 2048 })
    ],
    attachmentsByNodeId: {
      a: [attachment({ id: "att-a", nodeId: "a" })]
    }
  };

  it("reconstructs a complete delta from the confirmed base", () => {
    const response = {
      historyEntryId: "entry",
      ...historyState(),
      changedNodes: [
        node({ id: "b", sortKey: 2048, title: "renamed" }),
        node({ id: "c", sortKey: 3072 }),
        node({ id: "a", deletedAt: "2026-07-13T00:00:00Z" })
      ],
      removedNodeIds: [],
      changedAttachments: []
    } as NotesMutationResult;

    const mutation = unwrapNotesMutation(response, base);

    expect(mutation.atomic).toBe(true);
    expect(mutation.workspace.nodes.map(({ id }) => id).sort()).toEqual([
      "b",
      "c"
    ]);
    expect(mutation.workspace.attachmentsByNodeId).toEqual({});
  });

  it("does not guess without the coordinator's confirmed base", () => {
    const response = {
      historyEntryId: "entry",
      ...historyState(),
      changedNodes: [node({ id: "c" })],
      removedNodeIds: [],
      changedAttachments: []
    } as NotesMutationResult;

    expect(() => unwrapNotesMutation(response, null)).toThrow(/confirmed base/i);
  });

  it("keeps full-workspace mutation results authoritative", () => {
    const carried = { nodes: [node({ id: "carried" })] };
    const response: NotesMutationResult = {
      workspace: carried,
      historyEntryId: "entry",
      ...historyState(),
      changedNodes: [node({ id: "ignored-delta" })],
      removedNodeIds: [],
      changedAttachments: []
    };

    expect(unwrapNotesMutation(response, base).workspace).toBe(carried);
  });

  it("matches the reducer's normalized delta semantics", () => {
    const delta: RawNotesMutationDelta = {
      changedNodes: [
        node({ id: "b", sortKey: 2048, title: "renamed" }),
        node({ id: "c", sortKey: 3072 }),
        node({ id: "a", archivedAt: "2026-07-13T00:00:00Z" })
      ],
      removedNodeIds: [],
      changedAttachments: [attachment({ id: "att-c", nodeId: "c" })]
    };

    const reconstructed = normalizeWorkspace(
      applyDeltaToNotesWorkspace(base, delta)
    );
    const reduced = applyWorkspaceDelta(
      normalizeWorkspace(base),
      scopedActiveDelta(delta)!
    );

    expect(reconstructed.nodesById).toEqual(reduced.nodesById);
    expect(reconstructed.childIdsByParent).toEqual(reduced.childIdsByParent);
    expect(reconstructed.rootIds).toEqual(reduced.rootIds);
    expect(reconstructed.attachmentsByNodeId).toEqual(
      reduced.attachmentsByNodeId
    );
  });
});
