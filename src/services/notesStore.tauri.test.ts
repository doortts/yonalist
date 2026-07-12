import { Blob as NodeBlob } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateNoteNodeInput,
  ImportNoteAttachmentBytesBatchInput,
  ImportNoteAttachmentInput,
  ImportNoteAttachmentPathBatchInput,
  MoveNoteNodeInput,
  NoteAttachment,
  NotesHistoryContext,
  NotesHistoryReplayResult,
  NotesHistoryStatus,
  NotesMutationResult,
  NoteStructuredSearchQuery,
  NotesWorkspace,
  ResizeNoteAttachmentInput,
  SplitNoteNodeInput,
  UpdateNoteNodeInput
} from "../domain/notes";
import {
  notesCreateNode,
  notesArchiveNode,
  notesCollapseAll,
  notesDeleteDatabase,
  notesDuplicateNode,
  notesExpandAll,
  notesEmptyTrash,
  notesClearHistory,
  notesHistoryStatus,
  notesImportAttachment,
  notesImportAttachmentBytes,
  notesImportAttachmentPaths,
  notesInitialize,
  notesListTags,
  notesListTagsWithCounts,
  notesLoadWorkspace,
  notesMoveNode,
  notesReadAttachmentBytes,
  notesRemoveAttachment,
  notesRemoveEmptyNode,
  notesRestoreNode,
  notesRestoreAttachment,
  notesResizeAttachment,
  notesSearch,
  notesSearchStructured,
  notesSoftDeleteNode,
  notesSortSubtreeAscending,
  notesSortSubtreeDescending,
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
const attachmentId = "33333333-3333-4333-8333-333333333333";
const secondAttachmentId = "44444444-4444-4444-8444-444444444444";
const contentHash = "a".repeat(64);
const attachment: NoteAttachment = {
  id: attachmentId,
  nodeId,
  sortKey: 1024,
  relativePath: `notes-assets/${contentHash}.png`,
  contentHash,
  originalName: "diagram.png",
  mimeType: "image/png",
  byteSize: 5,
  intrinsicWidth: 320,
  intrinsicHeight: 200,
  displayWidth: 240,
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:01.000Z"
};
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
const workspaceWithAttachments: NotesWorkspace = {
  ...workspace,
  attachmentsByNodeId: { [nodeId]: [attachment] }
};
const normalizedWorkspace: NotesWorkspace = {
  ...workspace,
  attachmentsByNodeId: {}
};
const historyContext: NotesHistoryContext = {
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  entryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  commandKind: "updateText"
};
const mutationResult: NotesMutationResult = {
  workspace,
  historyEntryId: historyContext.entryId,
  canUndo: true,
  canRedo: false
};
const unjournaledMutationResult: NotesMutationResult = {
  workspace,
  historyEntryId: null,
  canUndo: false,
  canRedo: false
};
const normalizedMutationResult: NotesMutationResult = {
  ...mutationResult,
  workspace: normalizedWorkspace
};
const normalizedUnjournaledMutationResult: NotesMutationResult = {
  ...unjournaledMutationResult,
  workspace: normalizedWorkspace
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
    ).resolves.toEqual({ ...workspace, attachmentsByNodeId: {} });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "notes_initialize", {
      vaultPath
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "notes_load_workspace", {
      vaultPath,
      scope: { kind: "trash" }
    });
  });

  it("parses ordered attachment metadata from loaded workspaces", async () => {
    invokeMock.mockResolvedValue(workspaceWithAttachments);

    await expect(
      notesLoadWorkspace(vaultPath, { kind: "active" })
    ).resolves.toEqual(workspaceWithAttachments);
  });

  it("maps malformed loaded attachment metadata to a non-retryable load error", async () => {
    invokeMock.mockResolvedValue({
      ...workspaceWithAttachments,
      attachmentsByNodeId: {
        [nodeId]: [{ ...attachment, byteSize: -1 }]
      }
    });

    const error = await notesLoadWorkspace(vaultPath, { kind: "active" }).catch(
      (rejection: unknown) => rejection
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: "Notes load returned an invalid workspace.",
      operation: "load",
      retryable: false
    });
  });

  it("rejects an excessive native attachment payload as a non-retryable load error", async () => {
    invokeMock.mockResolvedValue({
      ...workspaceWithAttachments,
      attachmentsByNodeId: {
        [nodeId]: Array.from({ length: 129 }, (_, index) => ({
          ...attachment,
          id: `30000000-0000-4000-8000-${(index + 1)
            .toString(16)
            .padStart(12, "0")}`,
          sortKey: index + 1
        }))
      }
    });

    await expect(
      notesLoadWorkspace(vaultPath, { kind: "active" })
    ).rejects.toMatchObject({
      message: "Notes load returned an invalid workspace.",
      operation: "load",
      retryable: false
    });
  });

  it("maps native workspace load failures to retryable load errors", async () => {
    invokeMock.mockRejectedValue(new Error("Database is busy"));

    await expect(
      notesLoadWorkspace(vaultPath, { kind: "active" })
    ).rejects.toMatchObject({
      message: "Database is busy",
      operation: "load",
      retryable: true
    });
  });

  it("maps attachment commands to exact native payloads and history context", async () => {
    const importInput: ImportNoteAttachmentInput = {
      id: attachmentId,
      nodeId,
      sourcePath: "/tmp/diagram.png",
      initialMaxDisplayWidth: 480
    };
    const resizeInput: ResizeNoteAttachmentInput = {
      id: attachmentId,
      displayWidth: 180
    };
    const attachmentMutation = {
      ...mutationResult,
      workspace: workspaceWithAttachments
    };
    invokeMock
      .mockResolvedValueOnce(attachmentMutation)
      .mockResolvedValueOnce([0, 1, 127, 128, 255])
      .mockResolvedValueOnce(attachmentMutation)
      .mockResolvedValueOnce(attachmentMutation)
      .mockResolvedValueOnce(attachmentMutation);

    await expect(
      notesImportAttachment(vaultPath, importInput, historyContext)
    ).resolves.toEqual(attachmentMutation);
    await expect(notesReadAttachmentBytes(vaultPath, attachmentId)).resolves.toEqual(
      new Uint8Array([0, 1, 127, 128, 255])
    );
    await expect(
      notesResizeAttachment(vaultPath, resizeInput, historyContext)
    ).resolves.toEqual(attachmentMutation);
    await expect(
      notesRemoveAttachment(vaultPath, attachmentId, historyContext)
    ).resolves.toEqual(attachmentMutation);
    await expect(
      notesRestoreAttachment(vaultPath, attachmentId, historyContext)
    ).resolves.toEqual(attachmentMutation);

    expect(invokeMock.mock.calls).toEqual([
      [
        "notes_import_attachment_paths_batch",
        {
          vaultPath,
          input: {
            nodeId,
            attachments: [
              { id: attachmentId, sourcePath: importInput.sourcePath }
            ],
            initialMaxDisplayWidth: importInput.initialMaxDisplayWidth
          },
          historyContext
        }
      ],
      ["notes_read_attachment_bytes", { vaultPath, attachmentId }],
      [
        "notes_resize_attachment",
        { vaultPath, input: resizeInput, historyContext }
      ],
      [
        "notes_remove_attachment",
        { vaultPath, attachmentId, historyContext }
      ],
      [
        "notes_restore_attachment",
        { vaultPath, attachmentId, historyContext }
      ]
    ]);
  });

  it("invokes one JSON batch command for ordered attachment paths", async () => {
    const input: ImportNoteAttachmentPathBatchInput = {
      nodeId,
      attachments: [
        { id: attachmentId, sourcePath: "/tmp/first.png" },
        { id: secondAttachmentId, sourcePath: "/tmp/second.webp" }
      ],
      initialMaxDisplayWidth: 480
    };
    invokeMock.mockResolvedValue(mutationResult);

    await expect(
      notesImportAttachmentPaths(vaultPath, input, historyContext)
    ).resolves.toEqual(normalizedMutationResult);

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith(
      "notes_import_attachment_paths_batch",
      { vaultPath, input, historyContext }
    );
  });

  it("invokes one raw batch command for ordered attachment bytes", async () => {
    const input: ImportNoteAttachmentBytesBatchInput = {
      nodeId,
      attachments: [
        {
          id: attachmentId,
          originalName: "first.png",
          mimeType: "image/png",
          blob: new NodeBlob([Uint8Array.of(1, 2)], {
            type: "image/png"
          }) as Blob
        },
        {
          id: secondAttachmentId,
          originalName: "second.webp",
          mimeType: "image/webp",
          blob: new NodeBlob([Uint8Array.of(3, 4, 5)], {
            type: "image/webp"
          }) as Blob
        }
      ],
      initialMaxDisplayWidth: 480
    };
    invokeMock.mockResolvedValue(mutationResult);

    await expect(
      notesImportAttachmentBytes(vaultPath, input, historyContext)
    ).resolves.toEqual(normalizedMutationResult);

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith(
      "notes_import_attachment_bytes",
      expect.any(Uint8Array)
    );
  });

  it("rejects malformed path and byte batches before invoking native code", async () => {
    await expect(
      notesImportAttachmentPaths(vaultPath, {
        nodeId,
        attachments: [
          { id: attachmentId, sourcePath: "/tmp/first.png" },
          { id: attachmentId, sourcePath: "/tmp/second.png" }
        ],
        initialMaxDisplayWidth: 480
      })
    ).rejects.toMatchObject({ operation: "write", retryable: false });

    await expect(
      notesImportAttachmentBytes(vaultPath, {
        nodeId,
        attachments: [
          {
            id: attachmentId,
            originalName: "image.png",
            mimeType: "image/png",
            blob: { size: 0 } as Blob
          }
        ],
        initialMaxDisplayWidth: 480
      })
    ).rejects.toMatchObject({ operation: "write", retryable: false });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects an inexact path batch history context before invoking native code", async () => {
    const inexactHistory = {
      ...historyContext,
      extra: "must-not-cross-the-boundary"
    } as NotesHistoryContext;

    await expect(
      notesImportAttachmentPaths(
        vaultPath,
        {
          nodeId,
          attachments: [
            { id: attachmentId, sourcePath: "/tmp/first.png" }
          ],
          initialMaxDisplayWidth: 480
        },
        inexactHistory
      )
    ).rejects.toMatchObject({ operation: "write", retryable: false });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each([
    ["ASCII", "a".repeat(128)],
    ["Korean", `${"한".repeat(42)}ab`]
  ])(
    "accepts and trims a %s 128-byte history command kind for path and raw batches",
    async (_label, commandKind) => {
      const paddedCommandKind = `  ${commandKind}  `;
      const context = { ...historyContext, commandKind: paddedCommandKind };
      const readBlob = vi.fn().mockResolvedValue(Uint8Array.of(1).buffer);
      invokeMock.mockResolvedValue(mutationResult);

      await expect(
        notesImportAttachmentPaths(
          vaultPath,
          {
            nodeId,
            attachments: [
              { id: attachmentId, sourcePath: "/tmp/first.png" }
            ],
            initialMaxDisplayWidth: 480
          },
          context
        )
      ).resolves.toEqual(normalizedMutationResult);
      await expect(
        notesImportAttachmentBytes(
          vaultPath,
          {
            nodeId,
            attachments: [
              {
                id: attachmentId,
                originalName: "first.png",
                mimeType: "image/png",
                blob: { size: 1, arrayBuffer: readBlob } as unknown as Blob
              }
            ],
            initialMaxDisplayWidth: 480
          },
          context
        )
      ).resolves.toEqual(normalizedMutationResult);

      expect(invokeMock.mock.calls[0][1]).toMatchObject({
        historyContext: { commandKind }
      });
      const rawBody = invokeMock.mock.calls[1][1] as Uint8Array;
      const metadataLength = new DataView(
        rawBody.buffer,
        rawBody.byteOffset,
        rawBody.byteLength
      ).getUint32(5, true);
      const metadata = JSON.parse(
        new TextDecoder().decode(rawBody.subarray(9, 9 + metadataLength))
      ) as { historyContext: NotesHistoryContext };
      expect(metadata.historyContext.commandKind).toBe(commandKind);
      expect(readBlob).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ["ASCII", "a".repeat(129)],
    ["Korean", "한".repeat(43)]
  ])(
    "rejects a %s 129-byte history command kind before path or raw native work",
    async (_label, commandKind) => {
      const context = { ...historyContext, commandKind: `  ${commandKind}  ` };
      const readBlob = vi.fn().mockResolvedValue(Uint8Array.of(1).buffer);

      await expect(
        notesImportAttachmentPaths(
          vaultPath,
          {
            nodeId,
            attachments: [
              { id: attachmentId, sourcePath: "/tmp/first.png" }
            ],
            initialMaxDisplayWidth: 480
          },
          context
        )
      ).rejects.toMatchObject({ operation: "write", retryable: false });
      await expect(
        notesImportAttachmentBytes(
          vaultPath,
          {
            nodeId,
            attachments: [
              {
                id: attachmentId,
                originalName: "first.png",
                mimeType: "image/png",
                blob: { size: 1, arrayBuffer: readBlob } as unknown as Blob
              }
            ],
            initialMaxDisplayWidth: 480
          },
          context
        )
      ).rejects.toMatchObject({ operation: "write", retryable: false });

      expect(invokeMock).not.toHaveBeenCalled();
      expect(readBlob).not.toHaveBeenCalled();
    }
  );

  it("validates and sends the initial attachment max display width exactly", async () => {
    const input: ImportNoteAttachmentInput = {
      id: attachmentId,
      nodeId,
      sourcePath: "/tmp/diagram.png",
      initialMaxDisplayWidth: 480
    };
    invokeMock.mockResolvedValue({
      ...unjournaledMutationResult,
      workspace: workspaceWithAttachments
    });

    await expect(notesImportAttachment(vaultPath, input)).resolves.toEqual({
      ...unjournaledMutationResult,
      workspace: workspaceWithAttachments
    });
    expect(invokeMock).toHaveBeenCalledWith("notes_import_attachment_paths_batch", {
      vaultPath,
      input: {
        nodeId,
        attachments: [{ id: attachmentId, sourcePath: input.sourcePath }],
        initialMaxDisplayWidth: input.initialMaxDisplayWidth
      },
      historyContext: null
    });
  });

  it("rejects a missing initial attachment max display width", async () => {
    const input = {
      id: attachmentId,
      nodeId,
      sourcePath: "/tmp/diagram.png"
    } as ImportNoteAttachmentInput;

    await expect(notesImportAttachment(vaultPath, input)).rejects.toMatchObject({
      message: "Notes attachment import input is invalid."
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not forward an inherited initial attachment max display width", async () => {
    Object.defineProperty(Object.prototype, "initialMaxDisplayWidth", {
      configurable: true,
      value: 180
    });
    try {
      await expect(
        notesImportAttachment(vaultPath, {
          id: attachmentId,
          nodeId,
          sourcePath: "/tmp/diagram.png"
        } as ImportNoteAttachmentInput)
      ).rejects.toMatchObject({
        message: "Notes attachment import input is invalid."
      });
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(Object.prototype, "initialMaxDisplayWidth");
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid attachment import display width %s before invoking native code",
    async (initialMaxDisplayWidth) => {
      await expect(
        notesImportAttachment(vaultPath, {
          id: attachmentId,
          nodeId,
          sourcePath: "/tmp/diagram.png",
          initialMaxDisplayWidth
        })
      ).rejects.toMatchObject({
        message: "Notes attachment import input is invalid.",
        operation: "write",
        retryable: false
      });
      expect(invokeMock).not.toHaveBeenCalled();
    }
  );

  it("rejects a custom-prototype attachment import input", async () => {
    const input = Object.assign(Object.create({ inherited: true }), {
      id: attachmentId,
      nodeId,
      sourcePath: "/tmp/diagram.png",
      initialMaxDisplayWidth: 480
    }) as ImportNoteAttachmentInput;

    await expect(notesImportAttachment(vaultPath, input)).rejects.toMatchObject({
      message: "Notes attachment import input is invalid.",
      operation: "write",
      retryable: false
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("maps native attachment failures to retryable operation-specific errors", async () => {
    invokeMock
      .mockRejectedValueOnce("Could not import attachment")
      .mockRejectedValueOnce(new Error("Could not read attachment"));

    const importError = await notesImportAttachment(vaultPath, {
      id: attachmentId,
      nodeId,
      sourcePath: "/tmp/diagram.png",
      initialMaxDisplayWidth: 480
    }).catch((rejection: unknown) => rejection);
    const readError = await notesReadAttachmentBytes(
      vaultPath,
      attachmentId
    ).catch((rejection: unknown) => rejection);

    expect(importError).toMatchObject({
      message: "Could not import attachment",
      operation: "write",
      retryable: true
    });
    expect(readError).toMatchObject({
      message: "Could not read attachment",
      operation: "load",
      retryable: true
    });
  });

  it("copies Uint8Array attachment bytes without changing binary boundaries", async () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    invokeMock.mockResolvedValue(bytes);

    const result = await notesReadAttachmentBytes(vaultPath, attachmentId);

    expect(result).not.toBe(bytes);
    expect([...result]).toEqual([0, 1, 127, 128, 255]);
  });

  it("rejects a custom-prototype numeric byte array", async () => {
    const bytes = [0, 255];
    Object.setPrototypeOf(bytes, Object.create(Array.prototype));
    invokeMock.mockResolvedValue(bytes);

    await expect(
      notesReadAttachmentBytes(vaultPath, attachmentId)
    ).rejects.toMatchObject({
      message: "Notes attachment bytes returned an invalid result.",
      operation: "load",
      retryable: false
    });
  });

  it.each([
    [[-1], "out-of-range"],
    [[256], "out-of-range"],
    [[1.5], "non-integer"],
    [[Number.NaN], "non-finite"],
    [[0, , 255], "sparse"]
  ])("rejects %s attachment byte payloads (%s)", async (payload) => {
    invokeMock.mockResolvedValue(payload);

    const error = await notesReadAttachmentBytes(vaultPath, attachmentId).catch(
      (rejection: unknown) => rejection
    );

    expect(error).toMatchObject({
      message: "Notes attachment bytes returned an invalid result.",
      operation: "load",
      retryable: false
    });
  });

  it("rejects empty and oversized attachment byte payloads", async () => {
    const oversized: number[] = [];
    oversized.length = 20 * 1024 * 1024 + 1;
    invokeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(oversized);

    await expect(
      notesReadAttachmentBytes(vaultPath, attachmentId)
    ).rejects.toMatchObject({ operation: "load", retryable: false });
    await expect(
      notesReadAttachmentBytes(vaultPath, attachmentId)
    ).rejects.toMatchObject({ operation: "load", retryable: false });
  });

  it("rejects malformed attachment metadata returned by mutations", async () => {
    invokeMock.mockResolvedValue({
      ...mutationResult,
      workspace: {
        ...workspaceWithAttachments,
        attachmentsByNodeId: {
          [nodeId]: [{ ...attachment, relativePath: "../diagram.png" }]
        }
      }
    });

    await expect(
      notesResizeAttachment(vaultPath, { id: attachmentId, displayWidth: 180 })
    ).rejects.toMatchObject({
      message: "Notes mutation returned an invalid result.",
      operation: "write",
      retryable: false
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
      .mockResolvedValueOnce(unjournaledMutationResult)
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
    ).resolves.toEqual(normalizedWorkspace);
    await expect(
      notesLoadWorkspace(vaultPath, { kind: "recent" })
    ).resolves.toEqual(normalizedWorkspace);
    await expect(
      notesLoadWorkspace(vaultPath, { kind: "tag", tag: "roadmap" })
    ).resolves.toEqual(normalizedWorkspace);
    await expect(notesSearch(vaultPath, "target")).resolves.toBe(searchResults);
    await expect(notesToggleStar(vaultPath, nodeId)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );
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
      [
        "notes_search",
        { vaultPath, query: "target", scope: { kind: "active" } }
      ],
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

  it("passes the typed date-search lifecycle scope and accepts date matches", async () => {
    const results = [
      {
        nodeId,
        title: "Archived plan",
        parentTrail: [],
        matchedField: "date" as const
      }
    ];
    invokeMock.mockResolvedValue(results);

    await expect(
      notesSearch(vaultPath, "next week", { kind: "archive" })
    ).resolves.toEqual(results);
    expect(invokeMock).toHaveBeenCalledWith("notes_search", {
      vaultPath,
      query: "next week",
      scope: { kind: "archive" }
    });
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

  it("validates canonical tag bodies and exact 64-tag bounds before forwarding", async () => {
    const normalTags = Array.from({ length: 63 }, (_, index) => ({
      prefix: index % 2 === 0 ? ("#" as const) : ("@" as const),
      normalizedTag: `tag-${index}`,
      displayTag: `Tag-${index}`
    }));
    const boundaryQuery: NoteStructuredSearchQuery = {
      text: "",
      requiredTags: [
        ...normalTags,
        { prefix: "#", normalizedTag: "x", displayTag: "X" }
      ],
      excludedTags: [],
      orGroups: []
    };
    invokeMock.mockResolvedValue([]);

    await expect(notesSearchStructured(vaultPath, boundaryQuery)).resolves.toEqual(
      []
    );
    expect(invokeMock).toHaveBeenCalledWith("notes_search_structured", {
      vaultPath,
      query: boundaryQuery
    });

    invokeMock.mockClear();
    await expect(
      notesSearchStructured(vaultPath, {
        ...boundaryQuery,
        requiredTags: [
          ...boundaryQuery.requiredTags,
          { prefix: "#", normalizedTag: "##x", displayTag: "##x" }
        ]
      })
    ).rejects.toEqual(
      new Error(
        "Structured Notes search tag normalizedTag must be a canonical tag body."
      )
    );
    expect(invokeMock).not.toHaveBeenCalled();

    await expect(
      notesSearchStructured(vaultPath, {
        ...boundaryQuery,
        requiredTags: [
          ...boundaryQuery.requiredTags,
          { prefix: "@", normalizedTag: "overflow", displayTag: "Overflow" }
        ]
      })
    ).rejects.toEqual(
      new Error(
        "Structured Notes search has more than 64 unique tag alternatives."
      )
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects noncanonical typed tag workspace scopes before forwarding", async () => {
    await expect(
      notesLoadWorkspace(vaultPath, {
        kind: "tags",
        tags: [{ prefix: "#", normalizedTag: "#x" }]
      })
    ).rejects.toEqual(
      new Error(
        "Structured Notes search tag normalizedTag must be a canonical tag body."
      )
    );
    expect(invokeMock).not.toHaveBeenCalled();
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
    invokeMock.mockResolvedValue(unjournaledMutationResult);

    await expect(notesCreateNode(vaultPath, createInput)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );
    await expect(notesUpdateNode(vaultPath, updateInput)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );
    await expect(notesSplitNode(vaultPath, splitInput)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );
    await expect(notesMoveNode(vaultPath, moveInput)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );

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

  it("returns the atomic mutation result from the native adapter", async () => {
    invokeMock.mockResolvedValue(mutationResult);

    await expect(
      notesUpdateNode(
        vaultPath,
        { id: nodeId, title: "Journaled", note: "" },
        historyContext
      )
    ).resolves.toEqual(normalizedMutationResult);

    expect(invokeMock).toHaveBeenCalledWith("notes_update_node", {
      vaultPath,
      input: { id: nodeId, title: "Journaled", note: "" },
      historyContext
    });
  });

  it("rejects malformed mutation wrappers and unexpected history entry IDs", async () => {
    invokeMock
      .mockResolvedValueOnce(workspace)
      .mockResolvedValueOnce({
        ...mutationResult,
        historyEntryId: secondNodeId
      });

    await expect(
      notesUpdateNode(vaultPath, { id: nodeId, title: "Invalid", note: "" })
    ).rejects.toMatchObject({
      message: "Notes mutation returned an invalid result.",
      operation: "write",
      retryable: false
    });
    await expect(
      notesUpdateNode(
        vaultPath,
        { id: nodeId, title: "Mismatched", note: "" },
        historyContext
      )
    ).rejects.toMatchObject({
      message: "Notes mutation returned an unexpected history entry ID.",
      operation: "write",
      retryable: false
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
    invokeMock.mockResolvedValue(unjournaledMutationResult);

    await expect(notesMoveNode(vaultPath, beforeInput)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );
    await expect(notesMoveNode(vaultPath, legacyInput)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );

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
    invokeMock.mockResolvedValue(unjournaledMutationResult);

    await expect(adapter(vaultPath, nodeId)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );

    expect(invokeMock).toHaveBeenCalledWith(command, {
      vaultPath,
      nodeId,
      historyContext: null
    });
  });

  it.each([
    ["notes_expand_all", notesExpandAll],
    ["notes_collapse_all", notesCollapseAll],
    ["notes_sort_subtree_ascending", notesSortSubtreeAscending],
    ["notes_sort_subtree_descending", notesSortSubtreeDescending]
  ] as const)(
    "maps atomic subtree command %s to the exact nodeId payload",
    async (command, adapter) => {
      invokeMock.mockResolvedValue(mutationResult);

      await expect(adapter(vaultPath, nodeId, historyContext)).resolves.toEqual(
        normalizedMutationResult
      );

      expect(invokeMock).toHaveBeenCalledWith(command, {
        vaultPath,
        nodeId,
        historyContext
      });
    }
  );

  it.each([
    ["notes_archive_node", notesArchiveNode],
    ["notes_unarchive_node", notesUnarchiveNode]
  ] as const)("maps %s to the exact root node payload", async (command, adapter) => {
    invokeMock.mockResolvedValue(unjournaledMutationResult);

    await expect(adapter(vaultPath, nodeId)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );

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
      .mockResolvedValueOnce(mutationResult)
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
    ).resolves.toEqual(normalizedMutationResult);
    await expect(
      notesUndo(vaultPath, historyContext.sessionId, { kind: "active" })
    ).resolves.toEqual({ ...replay, workspace: normalizedWorkspace });
    await expect(
      notesRedo(vaultPath, historyContext.sessionId, { kind: "trash" })
    ).resolves.toEqual({ ...replay, workspace: normalizedWorkspace });
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

  it.each([
    ["undo", notesUndo],
    ["redo", notesRedo]
  ] as const)(
    "rejects malformed attachment metadata returned by %s",
    async (_name, replayAdapter) => {
      invokeMock.mockResolvedValue({
        workspace: {
          ...workspaceWithAttachments,
          attachmentsByNodeId: {
            [nodeId]: [{ ...attachment, mimeType: "constructor" }]
          }
        },
        replayedEntryId: historyContext.entryId,
        canUndo: false,
        canRedo: true
      });

      await expect(
        replayAdapter(vaultPath, historyContext.sessionId, { kind: "active" })
      ).rejects.toMatchObject({
        message: "Notes history replay returned an invalid result.",
        operation: "write",
        retryable: false
      });
    }
  );

  it("maps native history replay failures to retryable write errors", async () => {
    invokeMock.mockRejectedValue(new Error("Replay database is busy"));

    await expect(
      notesUndo(vaultPath, historyContext.sessionId, { kind: "active" })
    ).rejects.toMatchObject({
      message: "Replay database is busy",
      operation: "write",
      retryable: true
    });
  });

  it("empties trash with only the vault path", async () => {
    invokeMock.mockResolvedValue(workspace);

    await expect(notesEmptyTrash(vaultPath)).resolves.toEqual(normalizedWorkspace);

    expect(invokeMock).toHaveBeenCalledWith("notes_empty_trash", { vaultPath });
  });

  it("rejects malformed empty-trash workspaces with a non-retryable write error", async () => {
    invokeMock.mockResolvedValue({
      ...workspaceWithAttachments,
      attachmentsByNodeId: {
        [secondNodeId]: [{ ...attachment, nodeId: secondNodeId }]
      }
    });

    await expect(notesEmptyTrash(vaultPath)).rejects.toMatchObject({
      message: "Notes empty trash returned an invalid workspace.",
      operation: "write",
      retryable: false
    });
  });

  it("maps native empty-trash failures to retryable write errors", async () => {
    invokeMock.mockRejectedValue(new Error("Trash database is busy"));

    await expect(notesEmptyTrash(vaultPath)).rejects.toMatchObject({
      message: "Trash database is busy",
      operation: "write",
      retryable: true
    });
  });
});
