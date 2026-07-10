import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateNoteNodeInput,
  MoveNoteNodeInput,
  NotesWorkspace,
  SplitNoteNodeInput,
  UpdateNoteNodeInput
} from "../domain/notes";
import {
  notesCreateNode,
  notesDuplicateNode,
  notesEmptyTrash,
  notesInitialize,
  notesLoadWorkspace,
  notesMoveNode,
  notesRemoveEmptyNode,
  notesRestoreNode,
  notesSoftDeleteNode,
  notesSplitNode,
  notesToggleCollapsed,
  notesToggleComplete,
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
      deletedAt: null
    }
  ]
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
      input: createInput
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "notes_update_node", {
      vaultPath,
      input: updateInput
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "notes_split_node", {
      vaultPath,
      input: splitInput
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "notes_move_node", {
      vaultPath,
      input: moveInput
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
      input: beforeInput
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "notes_move_node", {
      vaultPath,
      input: legacyInput
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

    expect(invokeMock).toHaveBeenCalledWith(command, { vaultPath, nodeId });
  });

  it("empties trash with only the vault path", async () => {
    invokeMock.mockResolvedValue(workspace);

    await expect(notesEmptyTrash(vaultPath)).resolves.toBe(workspace);

    expect(invokeMock).toHaveBeenCalledWith("notes_empty_trash", { vaultPath });
  });
});
