import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateNoteNodeInput,
  MoveNoteNodeInput,
  NotesHistoryContext,
  NotesHistoryReplayResult,
  NotesHistoryStatus,
  NoteStructuredSearchQuery,
  NotesWorkspace,
  SplitNoteNodeInput,
  UpdateNoteNodeInput
} from "../domain/notes";
import {
  notesCreateNode,
  notesArchiveNode,
  notesDeleteDatabase,
  notesDuplicateNode,
  notesEmptyTrash,
  notesClearHistory,
  notesHistoryStatus,
  notesInitialize,
  notesListTags,
  notesListTagsWithCounts,
  notesLoadWorkspace,
  notesMoveNode,
  notesRemoveEmptyNode,
  notesRestoreNode,
  notesSearch,
  notesSearchStructured,
  notesSoftDeleteNode,
  notesSplitNode,
  notesToggleCollapsed,
  notesToggleComplete,
  notesToggleStar,
  notesRedo,
  notesUndo,
  notesUnarchiveNode,
  notesUpdateNode
} from "./notesStore";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock
}));

const vaultPath = "/vault";
const nodeId = "11111111-1111-4111-8111-111111111111";
const secondNodeId = "22222222-2222-4222-8222-222222222222";
const workspace: NotesWorkspace = {
  nodes: [
    {
      id: nodeId,
      parentId: null,
      sortKey: 1024,
      title: "Page",
      note: "Supporting note",
      layoutMode: "bullets",
      isCollapsed: false,
      isStarred: false,
      completedAt: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
      deletedAt: null,
      archivedAt: null,
      archiveRootId: null
    }
  ]
};
const historyContext: NotesHistoryContext = {
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  entryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  commandKind: "updateText"
};

describe("notesStore in Tauri", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
  });

  it("initializes and loads the requested workspace scope", async () => {
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(workspace);

    await expect(notesInitialize(vaultPath)).resolves.toBeUndefined();
    await expect(
      notesLoadWorkspace(vaultPath, { kind: "trash" })
    ).resolves.toBe(workspace);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "notes_initialize", {
      vaultPath
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "notes_load_workspace", {
      vaultPath,
      scope: { kind: "trash" }
    });
  });

  it("maps discovery queries and lifecycle commands to exact native payloads", async () => {
    const searchResults = [
      {
        nodeId,
        title: "Page",
        parentTrail: ["Home"],
        matchedField: "title" as const
      }
    ];
    invokeMock
      .mockResolvedValueOnce(workspace)
      .mockResolvedValueOnce(workspace)
      .mockResolvedValueOnce(workspace)
      .mockResolvedValueOnce(searchResults)
      .mockResolvedValueOnce(workspace)
      .mockResolvedValueOnce(["offline", "roadmap"])
      .mockResolvedValueOnce([
        {
          prefix: "#",
          normalizedTag: "roadmap",
          displayTag: "Roadmap",
          count: 2
        },
        {
          prefix: "@",
          normalizedTag: "minji",
          displayTag: "Minji",
          count: 1
        }
      ])
      .mockResolvedValueOnce(undefined);

    await expect(
      notesLoadWorkspace(vaultPath, { kind: "starred" })
    ).resolves.toBe(workspace);
    await expect(
      notesLoadWorkspace(vaultPath, { kind: "recent" })
    ).resolves.toBe(workspace);
    await expect(
      notesLoadWorkspace(vaultPath, { kind: "tag", tag: "roadmap" })
    ).resolves.toBe(workspace);
    await expect(notesSearch(vaultPath, "target")).resolves.toBe(searchResults);
    await expect(notesToggleStar(vaultPath, nodeId)).resolves.toBe(workspace);
    await expect(notesListTags(vaultPath)).resolves.toEqual(["offline", "roadmap"]);
    await expect(notesListTagsWithCounts(vaultPath)).resolves.toEqual([
      {
        prefix: "#",
        normalizedTag: "roadmap",
        displayTag: "Roadmap",
        count: 2
      },
      {
        prefix: "@",
        normalizedTag: "minji",
        displayTag: "Minji",
        count: 1
      }
    ]);
    await expect(notesDeleteDatabase(vaultPath)).resolves.toBeUndefined();

    expect(invokeMock.mock.calls).toEqual([
      ["notes_load_workspace", { vaultPath, scope: { kind: "starred" } }],
      ["notes_load_workspace", { vaultPath, scope: { kind: "recent" } }],
      [
        "notes_load_workspace",
        { vaultPath, scope: { kind: "tag", tag: "roadmap" } }
      ],
      ["notes_search", { vaultPath, query: "target" }],
      ["notes_toggle_star", { vaultPath, nodeId, historyContext: null }],
      ["notes_list_tags", { vaultPath }],
      ["notes_list_tags_with_counts", { vaultPath }],
      ["notes_delete_database", { vaultPath }]
    ]);
  });

  it("rejects a malformed native search payload", async () => {
    invokeMock.mockResolvedValue([
      {
        nodeId,
        title: "Page",
        parentTrail: ["Home", 42],
        matchedField: "title"
      }
    ]);

    await expect(notesSearch(vaultPath, "target")).rejects.toEqual(
      new Error("Notes search returned an invalid result.")
    );
  });

  it("maps structured search to an additive typed native command", async () => {
    const query: NoteStructuredSearchQuery = {
      text: "release notes",
      requiredTags: [
        { prefix: "#", normalizedTag: "roadmap", displayTag: "Roadmap" }
      ],
      excludedTags: [
        { prefix: "@", normalizedTag: "bot", displayTag: "BOT" }
      ],
      orGroups: [
        [
          { prefix: "#", normalizedTag: "desktop", displayTag: "Desktop" },
          { prefix: "@", normalizedTag: "platform", displayTag: "Platform" }
        ]
      ]
    };
    const results = [
      {
        nodeId,
        title: "Page",
        parentTrail: ["Home"],
        matchedField: "title" as const
      }
    ];
    invokeMock.mockResolvedValue(results);

    await expect(notesSearchStructured(vaultPath, query)).resolves.toBe(results);

    expect(invokeMock).toHaveBeenCalledWith("notes_search_structured", {
      vaultPath,
      query
    });
  });

  it("maps typed input mutations to exact camelCase native payloads", async () => {
    const createInput: CreateNoteNodeInput = {
      id: nodeId,
      parentId: null,
      afterId: null,
      title: "Page",
      note: ""
    };
    const updateInput: UpdateNoteNodeInput = {
      id: nodeId,
      title: "Updated page",
      note: "Context"
    };
    const splitInput: SplitNoteNodeInput = {
      id: nodeId,
      newNodeId: secondNodeId,
      prefix: "First",
      suffix: "Second"
    };
    const moveInput: MoveNoteNodeInput = {
      id: nodeId,
      parentId: secondNodeId,
      afterId: null
    };
    invokeMock.mockResolvedValue(workspace);

    await expect(notesCreateNode(vaultPath, createInput)).resolves.toBe(workspace);
    await expect(notesUpdateNode(vaultPath, updateInput)).resolves.toBe(workspace);
    await expect(notesSplitNode(vaultPath, splitInput)).resolves.toBe(workspace);
    await expect(notesMoveNode(vaultPath, moveInput)).resolves.toBe(workspace);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "notes_create_node", {
      vaultPath,
      input: createInput,
      historyContext: null
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "notes_update_node", {
      vaultPath,
      input: updateInput,
      historyContext: null
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "notes_split_node", {
      vaultPath,
      input: splitInput,
      historyContext: null
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "notes_move_node", {
      vaultPath,
      input: moveInput,
      historyContext: null
    });
  });

  it("passes beforeId unchanged and keeps legacy afterId-only moves valid", async () => {
    const beforeInput: MoveNoteNodeInput = {
      id: nodeId,
      parentId: null,
      afterId: null,
      beforeId: secondNodeId
    };
    const legacyInput: MoveNoteNodeInput = {
      id: secondNodeId,
      parentId: null,
      afterId: nodeId
    };
    invokeMock.mockResolvedValue(workspace);

    await expect(notesMoveNode(vaultPath, beforeInput)).resolves.toBe(workspace);
    await expect(notesMoveNode(vaultPath, legacyInput)).resolves.toBe(workspace);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "notes_move_node", {
      vaultPath,
      input: beforeInput,
      historyContext: null
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "notes_move_node", {
      vaultPath,
      input: legacyInput,
      historyContext: null
    });
  });

  it.each([
    ["notes_toggle_complete", notesToggleComplete],
    ["notes_toggle_collapsed", notesToggleCollapsed],
    ["notes_duplicate_node", notesDuplicateNode],
    ["notes_remove_empty_node", notesRemoveEmptyNode],
    ["notes_soft_delete_node", notesSoftDeleteNode],
    ["notes_restore_node", notesRestoreNode]
  ] as const)("maps %s to the exact nodeId payload", async (command, adapter) => {
    invokeMock.mockResolvedValue(workspace);

    await expect(adapter(vaultPath, nodeId)).resolves.toBe(workspace);

    expect(invokeMock).toHaveBeenCalledWith(command, {
      vaultPath,
      nodeId,
      historyContext: null
    });
  });

  it.each([
    ["notes_archive_node", notesArchiveNode],
    ["notes_unarchive_node", notesUnarchiveNode]
  ] as const)("maps %s to the exact root node payload", async (command, adapter) => {
    invokeMock.mockResolvedValue(workspace);

    await expect(adapter(vaultPath, nodeId)).resolves.toBe(workspace);

    expect(invokeMock).toHaveBeenCalledWith(command, {
      vaultPath,
      nodeId,
      historyContext: null
    });
  });

  it("passes explicit history context and exposes replay and status commands", async () => {
    const replay: NotesHistoryReplayResult = {
      workspace,
      replayedEntryId: historyContext.entryId,
      canUndo: false,
      canRedo: true
    };
    const status: NotesHistoryStatus = { canUndo: true, canRedo: false };
    invokeMock
      .mockResolvedValueOnce(workspace)
      .mockResolvedValueOnce(replay)
      .mockResolvedValueOnce(replay)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ canUndo: false, canRedo: false });

    await expect(
      notesUpdateNode(
        vaultPath,
        { id: nodeId, title: "Journaled", note: "" },
        historyContext
      )
    ).resolves.toBe(workspace);
    await expect(
      notesUndo(vaultPath, historyContext.sessionId, { kind: "active" })
    ).resolves.toBe(replay);
    await expect(
      notesRedo(vaultPath, historyContext.sessionId, { kind: "trash" })
    ).resolves.toBe(replay);
    await expect(
      notesHistoryStatus(vaultPath, historyContext.sessionId)
    ).resolves.toBe(status);
    await expect(
      notesClearHistory(vaultPath, historyContext.sessionId)
    ).resolves.toEqual({ canUndo: false, canRedo: false });

    expect(invokeMock.mock.calls).toEqual([
      [
        "notes_update_node",
        {
          vaultPath,
          input: { id: nodeId, title: "Journaled", note: "" },
          historyContext
        }
      ],
      [
        "notes_undo",
        {
          vaultPath,
          sessionId: historyContext.sessionId,
          scope: { kind: "active" }
        }
      ],
      [
        "notes_redo",
        {
          vaultPath,
          sessionId: historyContext.sessionId,
          scope: { kind: "trash" }
        }
      ],
      ["notes_history_status", { vaultPath, sessionId: historyContext.sessionId }],
      ["notes_clear_history", { vaultPath, sessionId: historyContext.sessionId }]
    ]);
  });

  it("empties trash with only the vault path", async () => {
    invokeMock.mockResolvedValue(workspace);

    await expect(notesEmptyTrash(vaultPath)).resolves.toBe(workspace);

    expect(invokeMock).toHaveBeenCalledWith("notes_empty_trash", { vaultPath });
  });
});
