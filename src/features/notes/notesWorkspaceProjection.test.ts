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

describe("applyDeltaToNotesWorkspace (Track T2)", () => {
  const base: NotesWorkspace = {
    nodes: [node({ id: "a", sortKey: 1024 }), node({ id: "b", sortKey: 2048 })],
    attachmentsByNodeId: { a: [attachment({ id: "att-a", nodeId: "a" })] }
  };

  it("upserts changed nodes and removes deleted/archived and explicit removals", () => {
    const raw: RawNotesMutationDelta = {
      changedNodes: [
        node({ id: "b", sortKey: 2048, title: "renamed" }),
        node({ id: "c", sortKey: 3072 }),
        node({ id: "a", sortKey: 1024, deletedAt: "2026-07-13T00:00:00Z" })
      ],
      removedNodeIds: [],
      changedAttachments: []
    };
    const result = applyDeltaToNotesWorkspace(base, raw);
    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    expect([...byId.keys()].sort()).toEqual(["b", "c"]);
    expect(byId.get("b")?.title).toBe("renamed");
    // A node that left the active scope drops its attachments too.
    expect(result.attachmentsByNodeId?.a).toBeUndefined();
  });

  it("patches attachments in sorted order for surviving nodes", () => {
    const raw: RawNotesMutationDelta = {
      changedNodes: [],
      removedNodeIds: [],
      changedAttachments: [
        attachment({ id: "att-a2", nodeId: "a", sortKey: 512 }),
        attachment({ id: "att-a", nodeId: "a", sortKey: 4096 })
      ]
    };
    const result = applyDeltaToNotesWorkspace(base, raw);
    expect(result.attachmentsByNodeId?.a.map((att) => att.id)).toEqual([
      "att-a2",
      "att-a"
    ]);
  });

  it("stays consistent with the normalized applyWorkspaceDelta", () => {
    const raw: RawNotesMutationDelta = {
      changedNodes: [
        node({ id: "b", sortKey: 2048, title: "renamed" }),
        node({ id: "c", sortKey: 3072 }),
        node({ id: "a", sortKey: 1024, archivedAt: "2026-07-13T00:00:00Z" })
      ],
      removedNodeIds: [],
      changedAttachments: [attachment({ id: "att-c", nodeId: "c" })]
    };
    const scoped = scopedActiveDelta(raw)!;
    const viaHelper = normalizeWorkspace(applyDeltaToNotesWorkspace(base, raw));
    const viaReducer = applyWorkspaceDelta(normalizeWorkspace(base), scoped);
    expect(viaHelper.nodesById).toEqual(viaReducer.nodesById);
    expect(viaHelper.childIdsByParent).toEqual(viaReducer.childIdsByParent);
    expect(viaHelper.rootIds).toEqual(viaReducer.rootIds);
    expect(viaHelper.attachmentsByNodeId).toEqual(
      viaReducer.attachmentsByNodeId
    );
  });
});

describe("unwrapNotesMutation reconstruction (Track T2)", () => {
  const base: NotesWorkspace = {
    nodes: [node({ id: "a", sortKey: 1024 })],
    attachmentsByNodeId: {}
  };

  it("reconstructs a delta-only mutation from the confirmed base", () => {
    const response = {
      historyEntryId: "entry",
      ...historyState(),
      changedNodes: [node({ id: "b", sortKey: 2048 })],
      removedNodeIds: [],
      changedAttachments: []
    } as unknown as NotesMutationResult;
    const unwrapped = unwrapNotesMutation(response, base);
    expect(unwrapped.atomic).toBe(true);
    expect([...unwrapped.workspace.nodes].map((n) => n.id).sort()).toEqual([
      "a",
      "b"
    ]);
  });

  it("prefers a present workspace over reconstruction", () => {
    const carried: NotesWorkspace = { nodes: [node({ id: "z" })] };
    const response = {
      workspace: carried,
      historyEntryId: "entry",
      ...historyState(),
      changedNodes: [node({ id: "b" })],
      removedNodeIds: [],
      changedAttachments: []
    } as unknown as NotesMutationResult;
    expect(unwrapNotesMutation(response, base).workspace).toBe(carried);
  });

  it("throws when a delta-only mutation has no confirmed base", () => {
    const response = {
      historyEntryId: "entry",
      ...historyState(),
      changedNodes: [node({ id: "b" })],
      removedNodeIds: [],
      changedAttachments: []
    } as unknown as NotesMutationResult;
    expect(() => unwrapNotesMutation(response, null)).toThrow(
      /confirmed base/
    );
  });
});
