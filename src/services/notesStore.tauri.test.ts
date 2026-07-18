import { Blob as NodeBlob } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_NOTE_ATTACHMENT_BATCH_BYTES,
  MAX_NOTE_ATTACHMENT_BYTES
} from "../domain/notes";
import type {
  ApplyImageAtomEditInput,
  ApplyImageAtomPasteInput,
  ApplyNotesBatchInput,
  CreateNoteNodeInput,
  ImportImageNodeBytesInput,
  ImportImageNodePathsInput,
  ImportNoteAttachmentBytesBatchInput,
  ImportNoteAttachmentInput,
  ImportNoteAttachmentPathBatchInput,
  ImportSubtreeInput,
  MoveNoteNodeInput,
  NoteAttachment,
  NoteSearchResult,
  NotesHistoryContext,
  NotesHistoryReplayOutcome,
  NotesHistoryState,
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
  notesApplyBatch,
  notesCollapseAll,
  notesDeleteDatabase,
  notesDuplicateNode,
  notesExpandAll,
  notesEmptyTrash,
  notesClearHistory,
  notesHistoryStatus,
  notesLookupImageAtomOperation,
  notesImportAttachment,
  notesImportAttachmentBytes,
  notesImportAttachmentPaths,
  notesImportImageNodeBytes,
  notesImportImageNodePaths,
  notesImportSubtree,
  notesInitialize,
  notesListTags,
  notesListTagsWithCounts,
  notesLoadWorkspace,
  notesMoveNode,
  notesCloseHistorySession,
  notesAckImageAtomOperation,
  notesApplyImageAtomEdit,
  notesApplyImageAtomPaste,
  notesDownloadAttachment,
  notesOpenAttachmentOriginal,
  notesReadAttachmentBytes,
  notesRemoveAttachment,
  notesRemoveEmptyNode,
  notesPrepareNavigation,
  notesPruneHistoryEntries,
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

function indexedNodeId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}
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
      nodeKind: "text",
      parentId: null,
      sortKey: 1024,
      title: "Page",
      note: "Supporting note",
      imageOffsetUtf16: 0,
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
  historyEpoch: "epoch-a",
  entryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  commandKind: "updateText"
};
const imageAtomHistoryContext: NotesHistoryContext = {
  ...historyContext,
  commandKind: "imageAtomEdit"
};
const imageAtomPasteHistoryContext: NotesHistoryContext = {
  ...historyContext,
  commandKind: "imageAtomPaste"
};
function imageAtomPasteInput(): ApplyImageAtomPasteInput {
  return {
    target: {
      nodeId,
      expectedUpdatedAt: workspace.nodes[0]!.updatedAt,
      expectedNodeKind: "text",
      expectedTitle: "Page",
      expectedImageOffsetUtf16: 0,
      expectedPrimaryAttachmentId: null
    },
    selection: { anchorUtf16: 2, focusUtf16: 2 },
    version: 1,
    fragment: [
      { kind: "text", text: "before" },
      {
        kind: "image",
        nodeId,
        attachmentId,
        originalName: "paste.png",
        mimeType: "image/png",
        blob: new NodeBlob([Uint8Array.of(1, 2)], {
          type: "image/png"
        }) as Blob
      },
      { kind: "text", text: "after" }
    ],
    initialMaxDisplayWidth: 480
  };
}
function historyState(historyEpoch = "epoch-a"): NotesHistoryState {
  return {
    canUndo: true,
    canRedo: false,
    historyEpoch,
    nextUndoEntryId: historyContext.entryId,
    nextRedoEntryId: null,
    prunedEntryIds: []
  };
}
const mutationResult: NotesMutationResult = {
  workspace,
  historyEntryId: historyContext.entryId,
  ...historyState()
};
const unjournaledMutationResult: NotesMutationResult = {
  workspace,
  historyEntryId: null,
  ...historyState()
};
const normalizedMutationResult: NotesMutationResult = {
  ...mutationResult,
  workspace: normalizedWorkspace
};
const normalizedUnjournaledMutationResult: NotesMutationResult = {
  ...unjournaledMutationResult,
  workspace: normalizedWorkspace
};
const secondImageAttachment: NoteAttachment = {
  ...attachment,
  id: secondAttachmentId,
  nodeId: secondNodeId,
  contentHash: "b".repeat(64),
  relativePath: `notes-assets/${"b".repeat(64)}.webp`,
  originalName: "second.webp",
  mimeType: "image/webp"
};
const imageImportWorkspace: NotesWorkspace = {
  nodes: [
    {
      ...workspace.nodes[0]!,
      id: nodeId,
      nodeKind: "image",
      title: "first.png",
      sortKey: 1024
    },
    {
      ...workspace.nodes[0]!,
      id: secondNodeId,
      nodeKind: "image",
      title: "second.webp",
      sortKey: 2048
    }
  ],
  attachmentsByNodeId: {
    [nodeId]: [attachment],
    [secondNodeId]: [secondImageAttachment]
  }
};
const imageImportMutationResult: NotesMutationResult = {
  ...mutationResult,
  workspace: imageImportWorkspace,
  changedNodes: imageImportWorkspace.nodes,
  removedNodeIds: [],
  changedAttachments: [attachment, secondImageAttachment],
  importedRootIds: [nodeId, secondNodeId]
};

function decodeRawEnvelopeMetadata<T>(body: Uint8Array): T {
  const metadataLength = new DataView(
    body.buffer,
    body.byteOffset,
    body.byteLength
  ).getUint32(5, true);
  return JSON.parse(
    new TextDecoder().decode(body.subarray(9, 9 + metadataLength))
  ) as T;
}

describe("notesStore in Tauri", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
  });

  it("initializes and loads the requested workspace scope", async () => {
    invokeMock
      .mockResolvedValueOnce(historyState())
      .mockResolvedValueOnce(workspace);

    await expect(
      notesInitialize(vaultPath, { sessionId: historyContext.sessionId })
    ).resolves.toEqual(historyState());
    await expect(
      notesLoadWorkspace(vaultPath, { kind: "trash" })
    ).resolves.toEqual({ ...workspace, attachmentsByNodeId: {} });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "notes_initialize", {
      vaultPath,
      input: { sessionId: historyContext.sessionId }
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "notes_load_workspace", {
      vaultPath,
      scope: { kind: "trash" }
    });
  });

  it("uses strict image-atom receipt lookup and acknowledgement adapters", async () => {
    const receipt = {
      operationId: historyContext.entryId,
      historyEpoch: historyContext.historyEpoch,
      postconditionDigest: "b".repeat(64),
      affectedRootIds: [nodeId],
      focus: { nodeId, anchorUtf16: 0, focusUtf16: 1 }
    };
    invokeMock.mockResolvedValueOnce({ kind: "found", receipt }).mockResolvedValueOnce(null);

    await expect(
      notesLookupImageAtomOperation(
        vaultPath,
        historyContext.sessionId,
        historyContext.historyEpoch,
        historyContext.entryId
      )
    ).resolves.toEqual({ kind: "found", receipt });
    await expect(
      notesAckImageAtomOperation(
        vaultPath,
        historyContext.sessionId,
        historyContext.historyEpoch,
        historyContext.entryId
      )
    ).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenNthCalledWith(1, "notes_lookup_image_atom_operation", {
      vaultPath,
      sessionId: historyContext.sessionId,
      historyEpoch: historyContext.historyEpoch,
      operationId: historyContext.entryId
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "notes_ack_image_atom_operation", {
      vaultPath,
      sessionId: historyContext.sessionId,
      historyEpoch: historyContext.historyEpoch,
      operationId: historyContext.entryId
    });

    invokeMock.mockResolvedValueOnce({ kind: "found", receipt: { ...receipt, workspace: {} } });
    await expect(
      notesLookupImageAtomOperation(
        vaultPath,
        historyContext.sessionId,
        historyContext.historyEpoch,
        historyContext.entryId
      )
    ).rejects.toMatchObject({ retryable: false });
  });

  it("applies image-atom edits through the exact camelCase command contract", async () => {
    const input: ApplyImageAtomEditInput = {
      target: {
        nodeId,
        expectedUpdatedAt: workspace.nodes[0]!.updatedAt,
        expectedTitle: "Page",
        expectedImageOffsetUtf16: 0,
        expectedPrimaryAttachmentId: attachmentId
      },
      selection: { anchorUtf16: 0, focusUtf16: 1 },
      edit: { kind: "remove", replacementText: "replacement" }
    };
    const operation = {
      operationId: historyContext.entryId,
      historyEpoch: historyContext.historyEpoch,
      postconditionDigest: "b".repeat(64),
      affectedRootIds: [nodeId],
      focus: { nodeId, anchorUtf16: 0, focusUtf16: 0 }
    };
    invokeMock.mockResolvedValueOnce({ ...mutationResult, operation });

    await expect(
      notesApplyImageAtomEdit(vaultPath, input, imageAtomHistoryContext)
    ).resolves.toEqual({ ...mutationResult, operation });
    expect(invokeMock).toHaveBeenCalledWith("notes_apply_image_atom_edit", {
      vaultPath,
      input,
      historyContext: imageAtomHistoryContext
    });
  });

  it("applies image-atom byte pastes through the raw YNAP command contract", async () => {
    const input: ApplyImageAtomPasteInput = {
      target: {
        nodeId,
        expectedUpdatedAt: workspace.nodes[0]!.updatedAt,
        expectedNodeKind: "text",
        expectedTitle: "Page",
        expectedImageOffsetUtf16: 0,
        expectedPrimaryAttachmentId: null
      },
      selection: { anchorUtf16: 2, focusUtf16: 2 },
      version: 1,
      fragment: [
        { kind: "text", text: "before" },
        {
          kind: "image",
          nodeId,
          attachmentId,
          originalName: "paste.png",
          mimeType: "image/png",
          blob: new NodeBlob([Uint8Array.of(1, 2)], {
            type: "image/png"
          }) as Blob
        },
        { kind: "text", text: "after" }
      ],
      initialMaxDisplayWidth: 480
    };
    const operation = {
      operationId: historyContext.entryId,
      historyEpoch: historyContext.historyEpoch,
      postconditionDigest: "b".repeat(64),
      affectedRootIds: [nodeId],
      focus: { nodeId, anchorUtf16: 2, focusUtf16: 3 }
    };
    invokeMock.mockResolvedValueOnce({ ...mutationResult, operation });

    await expect(
      notesApplyImageAtomPaste(vaultPath, input, imageAtomPasteHistoryContext)
    ).resolves.toEqual({ ...mutationResult, operation });
    expect(invokeMock).toHaveBeenCalledWith(
      "notes_apply_image_atom_paste",
      expect.any(Uint8Array)
    );
    const body = invokeMock.mock.calls[0]![1] as Uint8Array;
    expect([...body.slice(0, 5)]).toEqual([89, 78, 65, 80, 1]);
    expect(decodeRawEnvelopeMetadata<Record<string, unknown>>(body)).toMatchObject({
      vaultPath,
      historyContext: imageAtomPasteHistoryContext,
      initialMaxDisplayWidth: 480
    });
  });

  it("rejects malformed image-atom paste input and history before raw IPC", async () => {
    const input = imageAtomPasteInput();
    const malformedInputs: unknown[] = [
      { ...input, version: 2 },
      {
        ...input,
        target: { ...input.target, expectedPrimaryAttachmentId: undefined }
      },
      { ...input, selection: { anchorUtf16: 0.5, focusUtf16: 1 } },
      { ...input, fragment: [] },
      { ...input, extra: true }
    ];
    for (const malformed of malformedInputs) {
      await expect(
        notesApplyImageAtomPaste(
          vaultPath,
          malformed as ApplyImageAtomPasteInput,
          imageAtomPasteHistoryContext
        )
      ).rejects.toMatchObject({ operation: "write", retryable: false });
    }
    for (const malformedHistory of [
      { ...imageAtomPasteHistoryContext, commandKind: "imageAtomEdit" },
      { ...imageAtomPasteHistoryContext, historyEpoch: "" },
      { ...imageAtomPasteHistoryContext, historyEpoch: "epoch\0a" },
      { ...imageAtomPasteHistoryContext, historyEpoch: "a".repeat(129) }
    ]) {
      await expect(
        notesApplyImageAtomPaste(
          vaultPath,
          input,
          malformedHistory as NotesHistoryContext
        )
      ).rejects.toMatchObject({ operation: "write", retryable: false });
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects image-atom paste results that do not correlate to the history authority", async () => {
    const input = imageAtomPasteInput();
    const operation = {
      operationId: historyContext.entryId,
      historyEpoch: historyContext.historyEpoch,
      postconditionDigest: "b".repeat(64),
      affectedRootIds: [nodeId],
      focus: { nodeId, anchorUtf16: 2, focusUtf16: 3 }
    };
    for (const response of [
      {
        ...mutationResult,
        operation: { ...operation, operationId: secondNodeId }
      },
      {
        ...mutationResult,
        operation: { ...operation, historyEpoch: "epoch-b" }
      },
      { ...mutationResult, historyEntryId: secondNodeId, operation }
    ]) {
      invokeMock.mockResolvedValueOnce(response);
      await expect(
        notesApplyImageAtomPaste(vaultPath, input, imageAtomPasteHistoryContext)
      ).rejects.toMatchObject({ operation: "write", retryable: false });
    }
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed image-atom edit requests before IPC", async () => {
    const input: ApplyImageAtomEditInput = {
      target: {
        nodeId,
        expectedUpdatedAt: workspace.nodes[0]!.updatedAt,
        expectedTitle: "Page",
        expectedImageOffsetUtf16: 0,
        expectedPrimaryAttachmentId: attachmentId
      },
      selection: { anchorUtf16: 0, focusUtf16: 1 },
      edit: { kind: "remove", replacementText: "replacement" }
    };
    const malformedInputs: unknown[] = [
      {
        ...input,
        selection: { ...input.selection, anchorUtf16: 0.5 }
      },
      {
        ...input,
        target: { ...input.target, expectedImageOffsetUtf16: Number.MAX_SAFE_INTEGER + 1 }
      },
      {
        ...input,
        target: { ...input.target, expectedPrimaryAttachmentId: "not-a-uuid" }
      },
      {
        ...input,
        edit: { ...input.edit, extra: true }
      },
      {
        ...input,
        edit: { kind: "remove", siblingId: secondNodeId }
      },
      { ...input, extra: true }
    ];

    for (const malformedInput of malformedInputs) {
      await expect(
        notesApplyImageAtomEdit(
          vaultPath,
          malformedInput as ApplyImageAtomEditInput,
          imageAtomHistoryContext
        )
      ).rejects.toMatchObject({ operation: "write", retryable: false });
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("requires image-atom-specific history authority before IPC", async () => {
    const input: ApplyImageAtomEditInput = {
      target: {
        nodeId,
        expectedUpdatedAt: workspace.nodes[0]!.updatedAt,
        expectedTitle: "Page",
        expectedImageOffsetUtf16: 0,
        expectedPrimaryAttachmentId: attachmentId
      },
      selection: { anchorUtf16: 0, focusUtf16: 1 },
      edit: { kind: "remove", replacementText: "replacement" }
    };
    const invalidContexts: unknown[] = [
      { ...imageAtomHistoryContext, historyEpoch: "" },
      { ...imageAtomHistoryContext, historyEpoch: "epoch\0a" },
      { ...imageAtomHistoryContext, historyEpoch: "a".repeat(129) },
      { ...imageAtomHistoryContext, commandKind: "updateText" },
      { ...imageAtomHistoryContext, commandKind: " imageAtomEdit\0" }
    ];

    for (const invalidContext of invalidContexts) {
      await expect(
        notesApplyImageAtomEdit(
          vaultPath,
          input,
          invalidContext as NotesHistoryContext
        )
      ).rejects.toMatchObject({ operation: "write", retryable: false });
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects image-atom results that do not correlate to the history authority", async () => {
    const input: ApplyImageAtomEditInput = {
      target: {
        nodeId,
        expectedUpdatedAt: workspace.nodes[0]!.updatedAt,
        expectedTitle: "Page",
        expectedImageOffsetUtf16: 0,
        expectedPrimaryAttachmentId: attachmentId
      },
      selection: { anchorUtf16: 0, focusUtf16: 1 },
      edit: { kind: "remove", replacementText: "replacement" }
    };
    const operation = {
      operationId: historyContext.entryId,
      historyEpoch: historyContext.historyEpoch,
      postconditionDigest: "b".repeat(64),
      affectedRootIds: [nodeId],
      focus: { nodeId, anchorUtf16: 0, focusUtf16: 0 }
    };
    const mismatchedResults = [
      {
        ...mutationResult,
        operation: { ...operation, operationId: secondNodeId }
      },
      {
        ...mutationResult,
        operation: { ...operation, historyEpoch: "epoch-b" }
      },
      {
        ...mutationResult,
        historyEntryId: secondNodeId,
        operation
      }
    ];

    for (const mismatchedResult of mismatchedResults) {
      invokeMock.mockResolvedValueOnce(mismatchedResult);
      await expect(
        notesApplyImageAtomEdit(vaultPath, input, imageAtomHistoryContext)
      ).rejects.toMatchObject({ operation: "write", retryable: false });
    }
  });

  it("correlates every image-atom lookup response with the requested authority", async () => {
    const receipt = {
      operationId: historyContext.entryId,
      historyEpoch: historyContext.historyEpoch,
      postconditionDigest: "b".repeat(64),
      affectedRootIds: [nodeId],
      focus: { nodeId, anchorUtf16: 0, focusUtf16: 1 }
    };
    const lookup = () =>
      notesLookupImageAtomOperation(
        vaultPath,
        historyContext.sessionId,
        historyContext.historyEpoch,
        historyContext.entryId
      );

    for (const response of [
      { kind: "found", receipt },
      { kind: "missing", historyEpoch: historyContext.historyEpoch },
      { kind: "epochMismatch", historyEpoch: "epoch-b" }
    ]) {
      invokeMock.mockResolvedValueOnce(response);
      await expect(lookup()).resolves.toEqual(response);
    }
    for (const response of [
      { kind: "found", receipt: { ...receipt, operationId: secondNodeId } },
      { kind: "found", receipt: { ...receipt, historyEpoch: "epoch-b" } },
      { kind: "missing", historyEpoch: "epoch-b" },
      { kind: "epochMismatch", historyEpoch: historyContext.historyEpoch }
    ]) {
      invokeMock.mockResolvedValueOnce(response);
      await expect(lookup()).rejects.toMatchObject({
        operation: "write",
        retryable: false
      });
    }
  });

  it.each([
    "canUndo",
    "canRedo",
    "historyEpoch",
    "nextUndoEntryId",
    "nextRedoEntryId",
    "prunedEntryIds"
  ] as const)("rejects initialize results missing %s", async (key) => {
    const invalid = { ...historyState() };
    delete invalid[key];
    invokeMock.mockResolvedValue(invalid);

    await expect(
      notesInitialize(vaultPath, { sessionId: historyContext.sessionId })
    ).rejects.toMatchObject({
      message: "Notes initialize returned an invalid history state.",
      operation: "load",
      retryable: false
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
      .mockResolvedValueOnce(new Uint8Array([0, 1, 127, 128, 255]))
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

  it("invokes one JSON batch command for ordered image-node paths", async () => {
    const input: ImportImageNodePathsInput = {
      parentId: null,
      afterId: null,
      items: [
        { nodeId, attachmentId, sourcePath: "/tmp/first.png" },
        {
          nodeId: secondNodeId,
          attachmentId: secondAttachmentId,
          sourcePath: "/tmp/second.webp"
        }
      ],
      initialMaxDisplayWidth: 480
    };
    invokeMock.mockResolvedValue(imageImportMutationResult);

    await expect(
      notesImportImageNodePaths(vaultPath, input, historyContext)
    ).resolves.toEqual({
      ...imageImportMutationResult,
      workspace: imageImportWorkspace
    });

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith(
      "notes_import_image_node_paths_batch",
      { vaultPath, input, historyContext }
    );
    expect(invokeMock.mock.calls.map(([command]) => command)).not.toContain(
      "notes_import_attachment_paths_batch"
    );
  });

  it("invokes one raw v2 batch command for ordered image-node bytes", async () => {
    const input: ImportImageNodeBytesInput = {
      parentId: null,
      afterId: null,
      items: [
        {
          nodeId,
          attachmentId,
          originalName: "first.png",
          mimeType: "image/png",
          blob: new NodeBlob([Uint8Array.of(1, 2)], {
            type: "image/png"
          }) as Blob
        },
        {
          nodeId: secondNodeId,
          attachmentId: secondAttachmentId,
          originalName: "second.webp",
          mimeType: "image/webp",
          blob: new NodeBlob([Uint8Array.of(3, 4, 5)], {
            type: "image/webp"
          }) as Blob
        }
      ],
      initialMaxDisplayWidth: 480
    };
    invokeMock.mockResolvedValue(imageImportMutationResult);

    await expect(
      notesImportImageNodeBytes(vaultPath, input, historyContext)
    ).resolves.toEqual({
      ...imageImportMutationResult,
      workspace: imageImportWorkspace
    });

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith(
      "notes_import_image_node_bytes",
      expect.any(Uint8Array)
    );
    const rawBody = invokeMock.mock.calls[0][1] as Uint8Array;
    expect([...rawBody.slice(0, 5)]).toEqual([89, 78, 73, 66, 2]);
    expect(decodeRawEnvelopeMetadata(rawBody)).toMatchObject({
      vaultPath,
      parentId: null,
      afterId: null,
      items: [
        {
          nodeId,
          attachmentId,
          ordinal: 0,
          originalName: "first.png",
          mimeType: "image/png",
          byteLength: 2
        },
        {
          nodeId: secondNodeId,
          attachmentId: secondAttachmentId,
          ordinal: 1,
          originalName: "second.webp",
          mimeType: "image/webp",
          byteLength: 3
        }
      ],
      initialMaxDisplayWidth: 480,
      historyContext
    });
    expect(invokeMock.mock.calls.map(([command]) => command)).not.toContain(
      "notes_import_attachment_bytes"
    );
  });

  it("rejects malformed image-node imports before invoking native code", async () => {
    const readBlob = vi.fn();

    await expect(
      notesImportImageNodePaths(vaultPath, {
        parentId: null,
        afterId: null,
        items: [
          { nodeId, attachmentId, sourcePath: "/tmp/first.png" },
          {
            nodeId,
            attachmentId: secondAttachmentId,
            sourcePath: "/tmp/second.png"
          }
        ],
        initialMaxDisplayWidth: 480
      }, historyContext)
    ).rejects.toMatchObject({
      message: "Notes image-node path import input is invalid.",
      operation: "write",
      retryable: false
    });

    await expect(
      notesImportImageNodePaths(vaultPath, {
        parentId: "not-a-uuid",
        afterId: null,
        items: [{ nodeId, attachmentId, sourcePath: "/tmp/first.png" }],
        initialMaxDisplayWidth: 480
      }, historyContext)
    ).rejects.toMatchObject({ operation: "write", retryable: false });

    const sparseItems = [
      {
        nodeId,
        attachmentId,
        originalName: "first.png",
        mimeType: "image/png",
        blob: { size: 1, arrayBuffer: readBlob } as unknown as Blob
      }
    ];
    sparseItems.length = 2;
    await expect(
      notesImportImageNodeBytes(vaultPath, {
        parentId: null,
        afterId: null,
        items: sparseItems,
        initialMaxDisplayWidth: 480
      }, historyContext)
    ).rejects.toMatchObject({
      message: "Notes image-node byte import input is invalid.",
      operation: "write",
      retryable: false
    });

    await expect(
      notesImportImageNodeBytes(vaultPath, {
        parentId: null,
        afterId: null,
        items: [
          {
            nodeId,
            attachmentId,
            originalName: "vector.svg",
            mimeType: "image/svg+xml",
            blob: { size: 1, arrayBuffer: readBlob } as unknown as Blob
          }
        ],
        initialMaxDisplayWidth: 480
      }, historyContext)
    ).rejects.toMatchObject({ operation: "write", retryable: false });

    expect(readBlob).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing importedRootIds", undefined],
    ["too few importedRootIds", [nodeId]],
    ["importedRootIds out of order", [secondNodeId, nodeId]],
    ["importedRootIds with a foreign ID", [nodeId, attachmentId]]
  ])(
    "rejects image-node import responses with %s",
    async (_label, importedRootIds) => {
      const input: ImportImageNodePathsInput = {
        parentId: null,
        afterId: null,
        items: [
          { nodeId, attachmentId, sourcePath: "/tmp/first.png" },
          {
            nodeId: secondNodeId,
            attachmentId: secondAttachmentId,
            sourcePath: "/tmp/second.webp"
          }
        ],
        initialMaxDisplayWidth: 480
      };
      invokeMock.mockResolvedValue(
        importedRootIds === undefined
          ? mutationResult
          : { ...mutationResult, importedRootIds }
      );

      await expect(
        notesImportImageNodePaths(vaultPath, input, historyContext)
      ).rejects.toMatchObject({
        message:
          "Notes image-node import returned unexpected imported root IDs.",
        operation: "write",
        retryable: false
      });
    }
  );

  it.each([
    [
      "unchanged workspace without imported image nodes",
      {
        ...mutationResult,
        importedRootIds: [nodeId, secondNodeId]
      }
    ],
    [
      "fabricated image node without its requested attachment",
      {
        ...mutationResult,
        workspace: {
          nodes: [
            {
              ...workspace.nodes[0]!,
              id: nodeId,
              nodeKind: "image",
              title: "first.png",
              sortKey: 1024
            },
            {
              ...workspace.nodes[0]!,
              id: secondNodeId,
              nodeKind: "image",
              title: "second.webp",
              sortKey: 2048
            }
          ],
          attachmentsByNodeId: {
            [nodeId]: [attachment]
          }
        },
        importedRootIds: [nodeId, secondNodeId]
      }
    ],
    [
      "requested attachment duplicated on one image node",
      {
        ...mutationResult,
        workspace: {
          nodes: [
            {
              ...workspace.nodes[0]!,
              id: nodeId,
              nodeKind: "image",
              title: "first.png",
              sortKey: 1024
            },
            {
              ...workspace.nodes[0]!,
              id: secondNodeId,
              nodeKind: "image",
              title: "second.webp",
              sortKey: 2048
            }
          ],
          attachmentsByNodeId: {
            [nodeId]: [
              attachment,
              {
                ...attachment,
                id: "55555555-5555-4555-8555-555555555555",
                sortKey: 2048,
                contentHash: "c".repeat(64),
                relativePath: `notes-assets/${"c".repeat(64)}.png`
              }
            ],
            [secondNodeId]: [secondImageAttachment]
          }
        },
        importedRootIds: [nodeId, secondNodeId]
      }
    ],
    [
      "null history entry after a requested history context",
      {
        ...mutationResult,
        historyEntryId: null,
        workspace: {
          nodes: [
            {
              ...workspace.nodes[0]!,
              id: nodeId,
              nodeKind: "image",
              title: "first.png",
              sortKey: 1024
            },
            {
              ...workspace.nodes[0]!,
              id: secondNodeId,
              nodeKind: "image",
              title: "second.webp",
              sortKey: 2048
            }
          ],
          attachmentsByNodeId: {
            [nodeId]: [attachment],
            [secondNodeId]: [secondImageAttachment]
          }
        },
        importedRootIds: [nodeId, secondNodeId]
      }
    ]
  ])("rejects image-node import success with %s", async (_label, payload) => {
    const input: ImportImageNodePathsInput = {
      parentId: null,
      afterId: null,
      items: [
        { nodeId, attachmentId, sourcePath: "/tmp/first.png" },
        {
          nodeId: secondNodeId,
          attachmentId: secondAttachmentId,
          sourcePath: "/tmp/second.webp"
        }
      ],
      initialMaxDisplayWidth: 480
    };
    invokeMock.mockResolvedValue(payload);

    await expect(
      notesImportImageNodePaths(vaultPath, input, historyContext)
    ).rejects.toMatchObject({
      message: "Notes image-node import returned an invalid workspace.",
      operation: "write",
      retryable: false
    });
  });

  it("rejects image-node import workspaces with duplicate node IDs", async () => {
    const input: ImportImageNodePathsInput = {
      parentId: null,
      afterId: null,
      items: [
        { nodeId, attachmentId, sourcePath: "/tmp/first.png" },
        {
          nodeId: secondNodeId,
          attachmentId: secondAttachmentId,
          sourcePath: "/tmp/second.webp"
        }
      ],
      initialMaxDisplayWidth: 480
    };
    invokeMock.mockResolvedValue({
      ...imageImportMutationResult,
      workspace: {
        ...imageImportWorkspace,
        nodes: [
          ...imageImportWorkspace.nodes,
          { ...imageImportWorkspace.nodes[1]! }
        ]
      }
    });

    await expect(
      notesImportImageNodePaths(vaultPath, input, historyContext)
    ).rejects.toMatchObject({
      operation: "write",
      retryable: false
    });
  });

  it.each([
    [
      "a partial delta field group",
      {
        changedNodes: imageImportWorkspace.nodes,
        removedNodeIds: undefined,
        changedAttachments: undefined
      }
    ],
    [
      "a changed node that differs from its canonical workspace entry",
      {
        changedNodes: [
          { ...imageImportWorkspace.nodes[0]!, title: "forged.png" },
          imageImportWorkspace.nodes[1]!
        ],
        removedNodeIds: [],
        changedAttachments: [attachment, secondImageAttachment]
      }
    ],
    [
      "duplicate changed node IDs",
      {
        changedNodes: [
          imageImportWorkspace.nodes[0]!,
          imageImportWorkspace.nodes[0]!,
          imageImportWorkspace.nodes[1]!
        ],
        removedNodeIds: [],
        changedAttachments: [attachment, secondImageAttachment]
      }
    ],
    [
      "an imported node missing from changedNodes",
      {
        changedNodes: [imageImportWorkspace.nodes[0]!],
        removedNodeIds: [],
        changedAttachments: [attachment, secondImageAttachment]
      }
    ],
    [
      "a changed and removed node ID overlap",
      {
        changedNodes: imageImportWorkspace.nodes,
        removedNodeIds: [nodeId],
        changedAttachments: [attachment, secondImageAttachment]
      }
    ],
    [
      "duplicate removed node IDs",
      {
        changedNodes: imageImportWorkspace.nodes,
        removedNodeIds: [
          "77777777-7777-4777-8777-777777777777",
          "77777777-7777-4777-8777-777777777777"
        ],
        changedAttachments: [attachment, secondImageAttachment]
      }
    ],
    [
      "a removed node ID that an image import cannot produce",
      {
        changedNodes: imageImportWorkspace.nodes,
        removedNodeIds: ["77777777-7777-4777-8777-777777777777"],
        changedAttachments: [attachment, secondImageAttachment]
      }
    ],
    [
      "a canonical changed node outside the insertion sibling set",
      {
        workspace: {
          ...imageImportWorkspace,
          nodes: [
            ...imageImportWorkspace.nodes,
            {
              ...workspace.nodes[0]!,
              id: "88888888-8888-4888-8888-888888888888",
              parentId: nodeId,
              title: "Unrelated child"
            }
          ]
        },
        changedNodes: [
          ...imageImportWorkspace.nodes,
          {
            ...workspace.nodes[0]!,
            id: "88888888-8888-4888-8888-888888888888",
            parentId: nodeId,
            title: "Unrelated child"
          }
        ],
        removedNodeIds: [],
        changedAttachments: [attachment, secondImageAttachment]
      }
    ],
    [
      "an unrelated canonical same-parent node without a rebalance sort key",
      {
        workspace: {
          ...imageImportWorkspace,
          nodes: [
            ...imageImportWorkspace.nodes,
            {
              ...workspace.nodes[0]!,
              id: "55555555-5555-4555-8555-555555555555",
              title: "Unrelated sibling",
              sortKey: 4097
            }
          ]
        },
        changedNodes: [
          ...imageImportWorkspace.nodes,
          {
            ...workspace.nodes[0]!,
            id: "55555555-5555-4555-8555-555555555555",
            title: "Unrelated sibling",
            sortKey: 4097
          }
        ],
        removedNodeIds: [],
        changedAttachments: [attachment, secondImageAttachment]
      }
    ],
    [
      "an omitted required rebalanced sibling",
      {
        workspace: {
          ...imageImportWorkspace,
          nodes: [
            ...imageImportWorkspace.nodes,
            {
              ...workspace.nodes[0]!,
              id: "66666666-6666-4666-8666-666666666666",
              title: "First rebalanced sibling",
              sortKey: 3072
            },
            {
              ...workspace.nodes[0]!,
              id: "77777777-7777-4777-8777-777777777777",
              title: "Omitted rebalanced sibling",
              sortKey: 4096
            }
          ]
        },
        changedNodes: [
          ...imageImportWorkspace.nodes,
          {
            ...workspace.nodes[0]!,
            id: "66666666-6666-4666-8666-666666666666",
            title: "First rebalanced sibling",
            sortKey: 3072
          }
        ],
        removedNodeIds: [],
        changedAttachments: [attachment, secondImageAttachment]
      }
    ],
    [
      "a changed attachment that differs from its canonical workspace entry",
      {
        changedNodes: imageImportWorkspace.nodes,
        removedNodeIds: [],
        changedAttachments: [
          { ...attachment, originalName: "forged.png" },
          secondImageAttachment
        ]
      }
    ],
    [
      "duplicate changed attachment IDs",
      {
        changedNodes: imageImportWorkspace.nodes,
        removedNodeIds: [],
        changedAttachments: [
          attachment,
          attachment,
          secondImageAttachment
        ]
      }
    ],
    [
      "an imported attachment missing from changedAttachments",
      {
        changedNodes: imageImportWorkspace.nodes,
        removedNodeIds: [],
        changedAttachments: [attachment]
      }
    ],
    [
      "an unrelated canonical changed attachment",
      {
        workspace: {
          ...imageImportWorkspace,
          nodes: [
            ...imageImportWorkspace.nodes,
            {
              ...workspace.nodes[0]!,
              id: "99999999-9999-4999-8999-999999999991",
              title: "Attachment owner",
              sortKey: 3072
            }
          ],
          attachmentsByNodeId: {
            ...imageImportWorkspace.attachmentsByNodeId,
            "99999999-9999-4999-8999-999999999991": [
              {
                ...attachment,
                id: "99999999-9999-4999-8999-999999999992",
                nodeId: "99999999-9999-4999-8999-999999999991",
                contentHash: "c".repeat(64),
                relativePath: `notes-assets/${"c".repeat(64)}.png`,
                originalName: "unrelated.png"
              }
            ]
          }
        },
        changedNodes: imageImportWorkspace.nodes,
        removedNodeIds: [],
        changedAttachments: [
          attachment,
          secondImageAttachment,
          {
            ...attachment,
            id: "99999999-9999-4999-8999-999999999992",
            nodeId: "99999999-9999-4999-8999-999999999991",
            contentHash: "c".repeat(64),
            relativePath: `notes-assets/${"c".repeat(64)}.png`,
            originalName: "unrelated.png"
          }
        ]
      }
    ]
  ])(
    "rejects image-node import responses with %s",
    async (_label, delta) => {
      const input: ImportImageNodePathsInput = {
        parentId: null,
        afterId: null,
        items: [
          { nodeId, attachmentId, sourcePath: "/tmp/first.png" },
          {
            nodeId: secondNodeId,
            attachmentId: secondAttachmentId,
            sourcePath: "/tmp/second.webp"
          }
        ],
        initialMaxDisplayWidth: 480
      };
      invokeMock.mockResolvedValue({
        ...imageImportMutationResult,
        ...delta
      });

      await expect(
        notesImportImageNodePaths(vaultPath, input, historyContext)
      ).rejects.toMatchObject({
        operation: "write",
        retryable: false
      });
    }
  );

  it("accepts canonical sibling rebalance nodes in an image import delta", async () => {
    const sibling = {
      ...workspace.nodes[0]!,
      id: "66666666-6666-4666-8666-666666666666",
      title: "Sibling",
      sortKey: 3072
    };
    const rebalanceWorkspace: NotesWorkspace = {
      ...imageImportWorkspace,
      nodes: [...imageImportWorkspace.nodes, sibling]
    };
    const input: ImportImageNodePathsInput = {
      parentId: null,
      afterId: null,
      items: [
        { nodeId, attachmentId, sourcePath: "/tmp/first.png" },
        {
          nodeId: secondNodeId,
          attachmentId: secondAttachmentId,
          sourcePath: "/tmp/second.webp"
        }
      ],
      initialMaxDisplayWidth: 480
    };
    const response: NotesMutationResult = {
      ...imageImportMutationResult,
      workspace: rebalanceWorkspace,
      changedNodes: [...rebalanceWorkspace.nodes],
      removedNodeIds: [],
      changedAttachments: [attachment, secondImageAttachment]
    };
    invokeMock.mockResolvedValue(response);

    await expect(
      notesImportImageNodePaths(vaultPath, input, historyContext)
    ).resolves.toEqual(response);
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
      }, historyContext)
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
      }, historyContext)
    ).rejects.toMatchObject({ operation: "write", retryable: false });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("names the attachment that exceeds the per-file byte limit", async () => {
    const readBlob = vi.fn();

    await expect(
      notesImportAttachmentBytes(vaultPath, {
        nodeId,
        attachments: [
          {
            id: attachmentId,
            originalName: "oversized-photo.png",
            mimeType: "image/png",
            blob: {
              size: MAX_NOTE_ATTACHMENT_BYTES + 1,
              arrayBuffer: readBlob
            } as unknown as Blob
          }
        ],
        initialMaxDisplayWidth: 480
      }, historyContext)
    ).rejects.toMatchObject({
      message:
        'Attachment "oversized-photo.png" exceeds the 20 MiB per-file limit.',
      operation: "write",
      retryable: false
    });

    expect(readBlob).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("names the attachment that crosses the aggregate byte limit", async () => {
    const readBlob = vi.fn();
    const chunkBytes = MAX_NOTE_ATTACHMENT_BATCH_BYTES / 4;

    await expect(
      notesImportAttachmentBytes(vaultPath, {
        nodeId,
        attachments: [
          {
            id: attachmentId,
            originalName: "first.png",
            mimeType: "image/png",
            blob: { size: chunkBytes, arrayBuffer: readBlob } as unknown as Blob
          },
          {
            id: secondAttachmentId,
            originalName: "second.png",
            mimeType: "image/png",
            blob: { size: chunkBytes, arrayBuffer: readBlob } as unknown as Blob
          },
          {
            id: "55555555-5555-4555-8555-555555555555",
            originalName: "third.png",
            mimeType: "image/png",
            blob: { size: chunkBytes, arrayBuffer: readBlob } as unknown as Blob
          },
          {
            id: "66666666-6666-4666-8666-666666666666",
            originalName: "crossing-file.png",
            mimeType: "image/png",
            blob: {
              size: chunkBytes + 1,
              arrayBuffer: readBlob
            } as unknown as Blob
          }
        ],
        initialMaxDisplayWidth: 480
      }, historyContext)
    ).rejects.toMatchObject({
      message:
        'Attachment "crossing-file.png" causes the batch to exceed the 64 MiB total limit.',
      operation: "write",
      retryable: false
    });

    expect(readBlob).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("keeps the generic message when a malformed item follows an oversized attachment", async () => {
    const readBlob = vi.fn();

    await expect(
      notesImportAttachmentBytes(vaultPath, {
        nodeId,
        attachments: [
          {
            id: attachmentId,
            originalName: "oversized-photo.png",
            mimeType: "image/png",
            blob: {
              size: MAX_NOTE_ATTACHMENT_BYTES + 1,
              arrayBuffer: readBlob
            }
          },
          {
            id: secondAttachmentId,
            originalName: 42,
            mimeType: "image/png",
            blob: { size: 1, arrayBuffer: readBlob }
          }
        ],
        initialMaxDisplayWidth: 480
      } as unknown as ImportNoteAttachmentBytesBatchInput, historyContext)
    ).rejects.toMatchObject({
      message: "Notes attachment byte batch input is invalid.",
      operation: "write",
      retryable: false
    });

    expect(readBlob).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("keeps the generic message when a malformed item follows the aggregate crossing", async () => {
    const readBlob = vi.fn();
    const chunkBytes = MAX_NOTE_ATTACHMENT_BATCH_BYTES / 4;

    await expect(
      notesImportAttachmentBytes(vaultPath, {
        nodeId,
        attachments: [
          {
            id: attachmentId,
            originalName: "first.png",
            mimeType: "image/png",
            blob: { size: chunkBytes, arrayBuffer: readBlob }
          },
          {
            id: secondAttachmentId,
            originalName: "second.png",
            mimeType: "image/png",
            blob: { size: chunkBytes, arrayBuffer: readBlob }
          },
          {
            id: "55555555-5555-4555-8555-555555555555",
            originalName: "third.png",
            mimeType: "image/png",
            blob: { size: chunkBytes, arrayBuffer: readBlob }
          },
          {
            id: "66666666-6666-4666-8666-666666666666",
            originalName: "crossing-file.png",
            mimeType: "image/png",
            blob: { size: chunkBytes + 1, arrayBuffer: readBlob }
          },
          {
            id: "77777777-7777-4777-8777-777777777777",
            originalName: 42,
            mimeType: "image/png",
            blob: { size: 1, arrayBuffer: readBlob }
          }
        ],
        initialMaxDisplayWidth: 480
      } as unknown as ImportNoteAttachmentBytesBatchInput, historyContext)
    ).rejects.toMatchObject({
      message: "Notes attachment byte batch input is invalid.",
      operation: "write",
      retryable: false
    });

    expect(readBlob).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each([
    ["whitespace-only", " \t\n"],
    ["over-1024-byte UTF-8", "한".repeat(342)]
  ])("rejects a %s attachment name as generic input", async (_label, name) => {
    const readBlob = vi.fn();

    await expect(
      notesImportAttachmentBytes(vaultPath, {
        nodeId,
        attachments: [
          {
            id: attachmentId,
            originalName: name,
            mimeType: "image/png",
            blob: { size: 1, arrayBuffer: readBlob } as unknown as Blob
          }
        ],
        initialMaxDisplayWidth: 480
      }, historyContext)
    ).rejects.toMatchObject({
      message: "Notes attachment byte batch input is invalid.",
      operation: "write",
      retryable: false
    });

    expect(readBlob).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("keeps the generic byte batch message without a trustworthy filename", async () => {
    await expect(
      notesImportAttachmentBytes(vaultPath, {
        nodeId,
        attachments: [
          {
            id: attachmentId,
            originalName: 42,
            mimeType: "image/png",
            blob: {
              size: MAX_NOTE_ATTACHMENT_BYTES + 1,
              arrayBuffer: vi.fn()
            }
          }
        ],
        initialMaxDisplayWidth: 480
      } as unknown as ImportNoteAttachmentBytesBatchInput, historyContext)
    ).rejects.toMatchObject({
      message: "Notes attachment byte batch input is invalid.",
      operation: "write",
      retryable: false
    });

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

    await expect(
      notesImportAttachment(vaultPath, input, historyContext)
    ).resolves.toEqual({
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
      historyContext
    });
  });

  it("rejects a missing initial attachment max display width", async () => {
    const input = {
      id: attachmentId,
      nodeId,
      sourcePath: "/tmp/diagram.png"
    } as ImportNoteAttachmentInput;

    await expect(notesImportAttachment(vaultPath, input, historyContext)).rejects.toMatchObject({
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
        } as ImportNoteAttachmentInput, historyContext)
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
        }, historyContext)
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

    await expect(
      notesImportAttachment(vaultPath, input, historyContext)
    ).rejects.toMatchObject({
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

    const importError = await notesImportAttachment(
      vaultPath,
      {
        id: attachmentId,
        nodeId,
        sourcePath: "/tmp/diagram.png",
        initialMaxDisplayWidth: 480
      },
      historyContext
    ).catch((rejection: unknown) => rejection);
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

  it("opens originals and delegates the trusted download dialog to native code", async () => {
    invokeMock.mockResolvedValue(null);

    await expect(
      notesOpenAttachmentOriginal(vaultPath, attachmentId)
    ).resolves.toBeUndefined();
    await expect(
      notesDownloadAttachment(vaultPath, attachmentId)
    ).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "notes_open_attachment_original",
      { vaultPath, attachmentId }
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "notes_download_attachment",
      { vaultPath, attachmentId }
    );
  });

  it.each([undefined, true, "ok", { ok: true }, []])(
    "rejects malformed attachment action response %j",
    async (payload) => {
      invokeMock.mockResolvedValue(payload);

      await expect(
        notesOpenAttachmentOriginal(vaultPath, attachmentId)
      ).rejects.toMatchObject({
        message: "Notes attachment action returned an invalid result.",
        operation: "write",
        retryable: false
      });
    }
  );

  it("rejects malformed attachment action input before invoking native code", async () => {
    await expect(
      notesDownloadAttachment(vaultPath, "")
    ).rejects.toMatchObject({
      message: "Notes attachment action input is invalid.",
      operation: "write",
      retryable: false
    });

    await expect(
      notesDownloadAttachment(vaultPath, "\0bad")
    ).rejects.toMatchObject({
      message: "Notes attachment action input is invalid.",
      operation: "write",
      retryable: false
    });

    expect(invokeMock).not.toHaveBeenCalled();
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

  it("copies ArrayBuffer attachment bytes from the raw IPC body", async () => {
    // The raw-bytes command hands the desktop transport an ArrayBuffer.
    const backing = new Uint8Array([9, 8, 7, 6]);
    invokeMock.mockResolvedValue(backing.buffer);

    const result = await notesReadAttachmentBytes(vaultPath, attachmentId);

    expect(result).toBeInstanceOf(Uint8Array);
    expect([...result]).toEqual([9, 8, 7, 6]);
    // The returned view must be an owned copy, not a window onto the transport
    // buffer, so mutating the source cannot bleed into it.
    backing[0] = 0;
    expect(result[0]).toBe(9);
  });

  // The two tests below allocate multi-megabyte byte buffers. The work itself
  // is a native bulk copy (sub-millisecond), but vitest's per-test timeout is
  // wall-clock, so a cold-start GC/transform stall in the shared worker can
  // otherwise trip the default 5s budget for an otherwise-trivial test.
  it(
    "round-trips a multi-megabyte payload without an element-wise scan",
    async () => {
      // A 20MB image used to arrive as an ~80MB JSON number array that was
      // validated byte by byte. It now streams as raw bytes and is copied in
      // bulk. Structural proof that the numeric-array branch is gone: a
      // standard numeric array of the same shape is rejected below.
      const size = 2 * 1024 * 1024;
      const payload = new Uint8Array(size);
      payload[0] = 1;
      payload[size - 1] = 254;
      invokeMock.mockResolvedValue(payload);

      const result = await notesReadAttachmentBytes(vaultPath, attachmentId);

      // Keep the matcher away from two 6 MiB typed arrays: Vitest's object
      // diagnostics can traverse both values even though this is an identity
      // assertion, obscuring the bulk-copy performance this test protects.
      expect(Object.is(result, payload)).toBe(false);
      expect(result.length).toBe(size);
      expect(result[0]).toBe(1);
      expect(result[size - 1]).toBe(254);
    },
    30_000
  );

  it("no longer accepts a standard JSON numeric array of valid bytes", async () => {
    // Every element is a valid byte, so the deleted element-wise loop would have
    // accepted it. The raw-bytes path only accepts Uint8Array/ArrayBuffer.
    invokeMock.mockResolvedValue([0, 1, 127, 128, 255]);

    await expect(
      notesReadAttachmentBytes(vaultPath, attachmentId)
    ).rejects.toMatchObject({
      message: "Notes attachment bytes returned an invalid result.",
      operation: "load",
      retryable: false
    });
  });

  it(
    "rejects empty and oversized raw byte payloads",
    async () => {
      invokeMock
        .mockResolvedValueOnce(new Uint8Array(0))
        .mockResolvedValueOnce(new Uint8Array(20 * 1024 * 1024 + 1));

      await expect(
        notesReadAttachmentBytes(vaultPath, attachmentId)
      ).rejects.toMatchObject({
        message: "Notes attachment bytes returned an invalid result.",
        operation: "load",
        retryable: false
      });
      await expect(
        notesReadAttachmentBytes(vaultPath, attachmentId)
      ).rejects.toMatchObject({
        message: "Notes attachment bytes returned an invalid result.",
        operation: "load",
        retryable: false
      });
    },
    30_000
  );

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
      notesResizeAttachment(
        vaultPath,
        { id: attachmentId, displayWidth: 180 },
        historyContext
      )
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
        nodeKind: "text" as const,
        title: "Page",
        imageOffsetUtf16: 0,
        attachmentName: null,
        displayLabel: "Page",
        parentTrail: ["Home"],
        parentTrailKinds: ["image" as const],
        matchedField: "title" as const
      }
    ] satisfies NoteSearchResult[];
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
      .mockResolvedValueOnce({ attachmentCleanupFailed: false });

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
    await expect(notesToggleStar(vaultPath, nodeId, historyContext)).resolves.toEqual(
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
    await expect(notesDeleteDatabase(vaultPath)).resolves.toEqual({
      attachmentCleanupFailed: false
    });

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
      ["notes_toggle_star", { vaultPath, nodeId, historyContext }],
      ["notes_list_tags", { vaultPath }],
      ["notes_list_tags_with_counts", { vaultPath }],
      ["notes_delete_database", { vaultPath }]
    ]);
  });

  it("parses the attachment cleanup flag from a database deletion", async () => {
    invokeMock.mockResolvedValue({ attachmentCleanupFailed: true });

    await expect(notesDeleteDatabase(vaultPath)).resolves.toEqual({
      attachmentCleanupFailed: true
    });
    expect(invokeMock).toHaveBeenCalledWith("notes_delete_database", {
      vaultPath
    });
  });

  it("rejects a malformed database deletion payload", async () => {
    invokeMock.mockResolvedValue(undefined);

    await expect(notesDeleteDatabase(vaultPath)).rejects.toEqual(
      new Error("Notes data deletion returned an invalid result.")
    );
  });

  it("rejects a malformed native search payload", async () => {
    invokeMock.mockResolvedValue([
      {
        nodeId,
        nodeKind: "text",
        title: "Page",
        imageOffsetUtf16: 0,
        attachmentName: null,
        displayLabel: "Page",
        parentTrail: ["Home", 42],
        parentTrailKinds: ["text", "text"],
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
        nodeKind: "text" as const,
        title: "Archived plan",
        imageOffsetUtf16: 0,
        attachmentName: null,
        displayLabel: "Archived plan",
        parentTrail: [],
        parentTrailKinds: [],
        matchedField: "date" as const
      }
    ] satisfies NoteSearchResult[];
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
        nodeKind: "image" as const,
        title: "",
        imageOffsetUtf16: 0,
        attachmentName: "diagram.png",
        displayLabel: "diagram.png",
        parentTrail: ["Home"],
        parentTrailKinds: ["image" as const],
        matchedField: "attachment" as const
      }
    ] satisfies NoteSearchResult[];
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
      note: "Context",
      imageOffsetUtf16: 3
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

    await expect(notesCreateNode(vaultPath, createInput, historyContext)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );
    await expect(notesUpdateNode(vaultPath, updateInput, historyContext)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );
    await expect(notesSplitNode(vaultPath, splitInput, historyContext)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );
    await expect(notesMoveNode(vaultPath, moveInput, historyContext)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, "notes_create_node", {
      vaultPath,
      input: createInput,
      historyContext
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "notes_update_node", {
      vaultPath,
      input: updateInput,
      historyContext
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "notes_split_node", {
      vaultPath,
      input: splitInput,
      historyContext
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "notes_move_node", {
      vaultPath,
      input: moveInput,
      historyContext
    });
  });

  it("maps the new batch variants to their exact camelCase native payloads", async () => {
    const inputs = [
      { op: "duplicate", nodeIds: [nodeId, secondNodeId] },
      {
        op: "move",
        nodeIds: [secondNodeId],
        parentId: null,
        afterId: null,
        beforeId: nodeId
      },
      {
        op: "addTag",
        nodeIds: [nodeId],
        tag: {
          prefix: "#",
          normalizedTag: "roadmap",
          displayTag: "Roadmap"
        }
      },
      {
        op: "removeTag",
        nodeIds: [secondNodeId],
        tag: { prefix: "@", normalizedTag: "minji" }
      }
    ] as const satisfies readonly ApplyNotesBatchInput[];
    invokeMock.mockResolvedValue(unjournaledMutationResult);

    for (const input of inputs) {
      await expect(notesApplyBatch(vaultPath, input, historyContext)).resolves.toEqual(
        normalizedUnjournaledMutationResult
      );
    }

    inputs.forEach((input, index) => {
      expect(invokeMock).toHaveBeenNthCalledWith(index + 1, "notes_apply_batch", {
        vaultPath,
        input,
        historyContext
      });
    });
  });

  it("preserves duplicated root ids without fabricating them when omitted", async () => {
    const duplicatedRootIds = [secondNodeId, attachmentId];
    invokeMock
      .mockResolvedValueOnce({ ...mutationResult, duplicatedRootIds })
      .mockResolvedValueOnce(mutationResult);

    await expect(
      notesApplyBatch(
        vaultPath,
        { op: "duplicate", nodeIds: [nodeId] },
        historyContext
      )
    ).resolves.toEqual({ ...normalizedMutationResult, duplicatedRootIds });
    const omitted = await notesApplyBatch(
      vaultPath,
      { op: "duplicate", nodeIds: [nodeId] },
      historyContext
    );
    expect(omitted).toEqual(normalizedMutationResult);
    expect(omitted).not.toHaveProperty("duplicatedRootIds");
  });

  it("rejects more than 10,000 submitted batch ids before invoking native code", async () => {
    const nodeIds = Array.from({ length: 10_000 }, (_, index) =>
      indexedNodeId(index)
    );
    nodeIds.push(nodeIds[0]);
    invokeMock.mockResolvedValue(unjournaledMutationResult);

    await expect(
      notesApplyBatch(vaultPath, { op: "delete", nodeIds }, historyContext)
    ).rejects.toThrow("10,000");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("accepts exactly 10,000 submitted batch ids", async () => {
    const nodeIds = Array.from({ length: 10_000 }, (_, index) =>
      indexedNodeId(index)
    );
    invokeMock.mockResolvedValue(unjournaledMutationResult);

    await expect(
      notesApplyBatch(vaultPath, { op: "delete", nodeIds }, historyContext)
    ).resolves.toEqual(normalizedUnjournaledMutationResult);
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock.mock.calls[0]?.[1]).toMatchObject({
      input: { nodeIds }
    });
  });

  it("rejects an empty batch selection before invoking native code", async () => {
    invokeMock.mockResolvedValue(unjournaledMutationResult);

    await expect(
      notesApplyBatch(vaultPath, { op: "delete", nodeIds: [] }, historyContext)
    ).rejects.toThrow("at least one node");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("deduplicates batch ids without changing first-seen order", async () => {
    invokeMock.mockResolvedValue(unjournaledMutationResult);

    await expect(
      notesApplyBatch(vaultPath, {
        op: "delete",
        nodeIds: [secondNodeId, nodeId, secondNodeId]
      }, historyContext)
    ).resolves.toEqual(normalizedUnjournaledMutationResult);
    expect(invokeMock).toHaveBeenCalledWith("notes_apply_batch", {
      vaultPath,
      input: { op: "delete", nodeIds: [secondNodeId, nodeId] },
      historyContext
    });
  });

  it("returns the atomic mutation result from the native adapter", async () => {
    invokeMock.mockResolvedValue(mutationResult);

    await expect(
      notesUpdateNode(
        vaultPath,
        { id: nodeId, title: "Journaled", note: "", imageOffsetUtf16: 0 },
        historyContext
      )
    ).resolves.toEqual(normalizedMutationResult);

    expect(invokeMock).toHaveBeenCalledWith("notes_update_node", {
      vaultPath,
      input: { id: nodeId, title: "Journaled", note: "", imageOffsetUtf16: 0 },
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
      notesUpdateNode(
        vaultPath,
        { id: nodeId, title: "Invalid", note: "", imageOffsetUtf16: 0 },
        historyContext
      )
    ).rejects.toMatchObject({
      message: "Notes mutation returned an invalid result.",
      operation: "write",
      retryable: false
    });
    await expect(
      notesUpdateNode(
        vaultPath,
        { id: nodeId, title: "Mismatched", note: "", imageOffsetUtf16: 0 },
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

    await expect(notesMoveNode(vaultPath, beforeInput, historyContext)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );
    await expect(notesMoveNode(vaultPath, legacyInput, historyContext)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, "notes_move_node", {
      vaultPath,
      input: beforeInput,
      historyContext
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "notes_move_node", {
      vaultPath,
      input: legacyInput,
      historyContext
    });
  });

  it("maps notes_import_subtree to the exact input payload and surfaces importedRootIds", async () => {
    const importInput: ImportSubtreeInput = {
      parentId: nodeId,
      afterId: null,
      nodes: [
        { title: "Imported root", children: [{ title: "Imported child", children: [] }] }
      ]
    };
    const importedRootId = "55555555-5555-4555-8555-555555555555";
    invokeMock.mockResolvedValue({
      ...mutationResult,
      importedRootIds: [importedRootId]
    });

    await expect(
      notesImportSubtree(vaultPath, importInput, historyContext)
    ).resolves.toEqual({
      ...normalizedMutationResult,
      importedRootIds: [importedRootId]
    });

    expect(invokeMock).toHaveBeenCalledWith("notes_import_subtree", {
      vaultPath,
      input: importInput,
      historyContext
    });
  });

  it("rejects notes_import_subtree when the response returns a malformed importedRootIds", async () => {
    invokeMock.mockResolvedValue({
      ...mutationResult,
      importedRootIds: [42]
    });

    await expect(
      notesImportSubtree(vaultPath, {
        parentId: null,
        afterId: null,
        nodes: [{ title: "x", children: [] }]
      }, historyContext)
    ).rejects.toMatchObject({
      message: "Notes mutation returned an invalid result.",
      operation: "write",
      retryable: false
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

    await expect(adapter(vaultPath, nodeId, historyContext)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );

    expect(invokeMock).toHaveBeenCalledWith(command, {
      vaultPath,
      nodeId,
      historyContext
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

    await expect(adapter(vaultPath, nodeId, historyContext)).resolves.toEqual(
      normalizedUnjournaledMutationResult
    );

    expect(invokeMock).toHaveBeenCalledWith(command, {
      vaultPath,
      nodeId,
      historyContext
    });
  });

  it("passes explicit history context and exposes replay and status commands", async () => {
    const replay: NotesHistoryReplayOutcome = {
      kind: "applied",
      workspace,
      replayedEntryId: historyContext.entryId,
      ...historyState()
    };
    const status = historyState();
    const replayRequest = {
      sessionId: historyContext.sessionId,
      historyEpoch: historyContext.historyEpoch,
      expectedEntryId: historyContext.entryId,
      scope: { kind: "active" as const }
    };
    const resetInput = {
      sessionId: historyContext.sessionId,
      historyEpoch: historyContext.historyEpoch
    };
    invokeMock
      .mockResolvedValueOnce(mutationResult)
      .mockResolvedValueOnce(replay)
      .mockResolvedValueOnce({ kind: "entryNotNext", ...historyState() })
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({
        workspace,
        historyReset: true,
        ...historyState("epoch-b")
      });

    await expect(
      notesUpdateNode(
        vaultPath,
        { id: nodeId, title: "Journaled", note: "", imageOffsetUtf16: 0 },
        historyContext
      )
    ).resolves.toEqual(normalizedMutationResult);
    await expect(notesUndo(vaultPath, replayRequest)).resolves.toEqual({
      ...replay,
      workspace: normalizedWorkspace
    });
    await expect(
      notesRedo(vaultPath, { ...replayRequest, scope: { kind: "trash" } })
    ).resolves.toEqual({ kind: "entryNotNext", ...historyState() });
    await expect(
      notesHistoryStatus(vaultPath, historyContext.sessionId)
    ).resolves.toBe(status);
    await expect(notesClearHistory(vaultPath, resetInput)).resolves.toEqual({
      historyReset: true,
      ...historyState("epoch-b")
    });

    expect(invokeMock.mock.calls).toEqual([
      [
        "notes_update_node",
        {
          vaultPath,
          input: { id: nodeId, title: "Journaled", note: "", imageOffsetUtf16: 0 },
          historyContext
        }
      ],
      [
        "notes_undo",
        {
          vaultPath,
          request: replayRequest
        }
      ],
      [
        "notes_redo",
        {
          vaultPath,
          request: { ...replayRequest, scope: { kind: "trash" } }
        }
      ],
      [
        "notes_history_status",
        { vaultPath, sessionId: historyContext.sessionId }
      ],
      ["notes_clear_history", { vaultPath, input: resetInput }]
    ]);
  });

  it.each([
    ["undo", notesUndo],
    ["redo", notesRedo]
  ] as const)(
    "rejects malformed attachment metadata returned by %s",
    async (_name, replayAdapter) => {
      invokeMock.mockResolvedValue({
        kind: "applied",
        workspace: {
          ...workspaceWithAttachments,
          attachmentsByNodeId: {
            [nodeId]: [{ ...attachment, mimeType: "constructor" }]
          }
        },
        replayedEntryId: historyContext.entryId,
        ...historyState()
      });

      await expect(
        replayAdapter(vaultPath, {
          sessionId: historyContext.sessionId,
          historyEpoch: historyContext.historyEpoch,
          expectedEntryId: historyContext.entryId,
          scope: { kind: "active" }
        })
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
      notesUndo(vaultPath, {
        sessionId: historyContext.sessionId,
        historyEpoch: historyContext.historyEpoch,
        expectedEntryId: historyContext.entryId,
        scope: { kind: "active" }
      })
    ).rejects.toMatchObject({
      message: "Replay database is busy",
      operation: "write",
      retryable: true
    });
  });

  it("rejects an applied replay without an exact history state", async () => {
    invokeMock.mockResolvedValue({ kind: "applied", workspace });

    await expect(
      notesUndo(vaultPath, {
        sessionId: historyContext.sessionId,
        historyEpoch: historyContext.historyEpoch,
        expectedEntryId: historyContext.entryId,
        scope: { kind: "active" }
      })
    ).rejects.toMatchObject({
      message: "Notes history replay returned an invalid result.",
      operation: "write",
      retryable: false
    });
  });

  it("sends navigation preparation and pruning as camelCase request inputs", async () => {
    const navigationInput = {
      sessionId: historyContext.sessionId,
      historyEpoch: historyContext.historyEpoch,
      unreachableRedoEntryIds: [historyContext.entryId]
    };
    const pruneInput = {
      sessionId: historyContext.sessionId,
      historyEpoch: historyContext.historyEpoch,
      entryIds: [historyContext.entryId]
    };
    invokeMock.mockResolvedValue(historyState());

    await expect(
      notesPrepareNavigation(vaultPath, navigationInput)
    ).resolves.toEqual(historyState());
    await expect(
      notesPruneHistoryEntries(vaultPath, pruneInput)
    ).resolves.toEqual(historyState());

    expect(invokeMock.mock.calls).toEqual([
      ["notes_prepare_navigation", { vaultPath, input: navigationInput }],
      ["notes_prune_history_entries", { vaultPath, input: pruneInput }]
    ]);
  });

  it("validates pruned history state and closes the exact epoch session", async () => {
    const pruneInput = {
      sessionId: historyContext.sessionId,
      historyEpoch: historyContext.historyEpoch,
      entryIds: [historyContext.entryId]
    };
    const { nextRedoEntryId: _missingNextRedoEntryId, ...invalid } =
      historyState();
    invokeMock.mockResolvedValueOnce(invalid).mockResolvedValueOnce(undefined);

    await expect(
      notesPruneHistoryEntries(vaultPath, pruneInput)
    ).rejects.toMatchObject({
      message: "Notes history operation returned an invalid state.",
      operation: "write",
      retryable: false
    });
    await expect(
      notesCloseHistorySession(vaultPath, {
        sessionId: historyContext.sessionId,
        historyEpoch: historyContext.historyEpoch
      })
    ).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenLastCalledWith("notes_close_history_session", {
      vaultPath,
      input: {
        sessionId: historyContext.sessionId,
        historyEpoch: historyContext.historyEpoch
      }
    });
  });

  it("empties trash with an epoch reset request", async () => {
    const input = {
      sessionId: historyContext.sessionId,
      historyEpoch: historyContext.historyEpoch
    };
    invokeMock.mockResolvedValue({
      workspace,
      historyReset: true,
      ...historyState("epoch-b")
    });

    await expect(notesEmptyTrash(vaultPath, input)).resolves.toEqual({
      workspace: normalizedWorkspace,
      historyReset: true,
      ...historyState("epoch-b")
    });

    expect(invokeMock).toHaveBeenCalledWith("notes_empty_trash", {
      vaultPath,
      input
    });
  });

  it("rejects malformed empty-trash workspaces with a non-retryable write error", async () => {
    invokeMock.mockResolvedValue({
      workspace: {
        ...workspaceWithAttachments,
        attachmentsByNodeId: {
          [secondNodeId]: [{ ...attachment, nodeId: secondNodeId }]
        }
      },
      historyReset: true,
      ...historyState("epoch-b")
    });

    await expect(
      notesEmptyTrash(vaultPath, {
        sessionId: historyContext.sessionId,
        historyEpoch: historyContext.historyEpoch
      })
    ).rejects.toMatchObject({
      message: "Notes empty trash returned an invalid reset result.",
      operation: "write",
      retryable: false
    });
  });

  it("maps native empty-trash failures to retryable write errors", async () => {
    invokeMock.mockRejectedValue(new Error("Trash database is busy"));

    await expect(
      notesEmptyTrash(vaultPath, {
        sessionId: historyContext.sessionId,
        historyEpoch: historyContext.historyEpoch
      })
    ).rejects.toMatchObject({
      message: "Trash database is busy",
      operation: "write",
      retryable: true
    });
  });
});
