import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import * as notesDomain from "./notes";
import {
  createNoteId,
  isNoteAttachment,
  isNoteNode,
  isNotesHistoryReplayOutcome,
  isNotesHistoryState,
  isNotesHistoryResetResult,
  isNotesWorkspaceResetResult,
  isNotesMutationResult,
  isNoteSearchResult,
  isNoteStructuredSearchQuery,
  isRetryableNotesErrorCode,
  MAX_NOTE_ATTACHMENTS_PER_NODE,
  MAX_NOTE_ATTACHMENTS_PER_WORKSPACE,
  MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS,
  normalizeNotesWorkspace,
  notesErrorHasCode,
  parseNotesError
} from "./notes";
import type { NotesErrorCode } from "./notes";
import type {
  ApplyNotesBatchInput,
  NoteAttachment,
  ImportImageNodeByteItem,
  ImportImageNodeBytesInput,
  ImportImageNodePathItem,
  ImportImageNodePathsInput,
  ImportNoteAttachmentByteItem,
  ImportNoteAttachmentBytesBatchInput,
  ImportNoteAttachmentInput,
  ImportNoteAttachmentPathBatchInput,
  NoteNode,
  NoteSearchResult,
  NoteSearchScope,
  NoteStructuredSearchQuery,
  NoteTagSummary,
  NotesMutationResult,
  NotesMutationResponse,
  NotesStore,
  NotesWorkspaceScope,
  PendingImageNodeByteItem,
  PendingNoteAttachmentByteItem,
  ResizeNoteAttachmentInput
} from "./notes";

const UUID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_UUID = "22222222-2222-4222-8222-222222222222";
const CONTENT_HASH = "a".repeat(64);

function makeNoteNode(overrides: Partial<NoteNode> = {}): NoteNode {
  return {
    id: UUID,
    nodeKind: "text",
    parentId: null,
    sortKey: 1024,
    title: "Page",
    note: "Supporting note",
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
    ...overrides
  };
}

function makeNoteAttachment(
  overrides: Partial<NoteAttachment> = {}
): NoteAttachment {
  return {
    id: ATTACHMENT_UUID,
    nodeId: UUID,
    sortKey: 1024,
    relativePath: `notes-assets/${CONTENT_HASH}.png`,
    contentHash: CONTENT_HASH,
    originalName: "image.png",
    mimeType: "image/png",
    byteSize: 123,
    intrinsicWidth: 320,
    intrinsicHeight: 200,
    displayWidth: 240,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:01.000Z",
    ...overrides
  };
}

function indexedUuid(prefix: string, index: number): string {
  return `${prefix}0000000-0000-4000-8000-${index
    .toString(16)
    .padStart(12, "0")}`;
}

function historyState(historyEpoch = "epoch-a") {
  return {
    canUndo: true,
    canRedo: false,
    historyEpoch,
    nextUndoEntryId: UUID,
    nextRedoEntryId: null,
    prunedEntryIds: []
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Notes domain contract", () => {
  it("exposes the image-atom operation receipt validators", () => {
    const receipt = {
      operationId: ATTACHMENT_UUID,
      historyEpoch: "epoch-a",
      postconditionDigest: "b".repeat(64),
      affectedRootIds: [UUID],
      focus: { nodeId: UUID, anchorUtf16: 0, focusUtf16: 1 }
    };

    expect(notesDomain.isImageAtomOperationReceiptResult(receipt)).toBe(true);
    expect(notesDomain.isImageAtomOperationLookup({ kind: "found", receipt })).toBe(
      true
    );
    expect(
      notesDomain.isImageAtomOperationLookup({
        kind: "epochMismatch",
        historyEpoch: "epoch-b"
      })
    ).toBe(true);
    expect(
      notesDomain.isImageAtomOperationLookup({ kind: "unknown", historyEpoch: "epoch-a" })
    ).toBe(false);
    expect(
      notesDomain.isImageAtomOperationReceiptResult({
        ...receipt,
        workspace: { nodes: [] }
      })
    ).toBe(false);
    expect(
      notesDomain.isImageAtomOperationReceiptResult({
        ...receipt,
        focus: { ...receipt.focus, anchorUtf16: -1 }
      })
    ).toBe(false);
  });

  it("recognizes the exact native attachment metadata contract", () => {
    expect(isNoteAttachment(makeNoteAttachment())).toBe(true);
    expect(
      isNoteAttachment({ ...makeNoteAttachment(), mimeType: "image/svg+xml" })
    ).toBe(false);
    expect(
      isNoteAttachment({ ...makeNoteAttachment(), byteSize: 20 * 1024 * 1024 + 1 })
    ).toBe(false);
    expect(
      isNoteAttachment({ ...makeNoteAttachment(), intrinsicWidth: 0 })
    ).toBe(false);
    expect(
      isNoteAttachment({ ...makeNoteAttachment(), displayWidth: 321 })
    ).toBe(false);
    expect(
      isNoteAttachment({ ...makeNoteAttachment(), displayWidth: 100 })
    ).toBe(true);
    expect(
      isNoteAttachment({ ...makeNoteAttachment(), displayWidth: 0 })
    ).toBe(false);
    expect(
      isNoteAttachment({ ...makeNoteAttachment(), originalName: "   " })
    ).toBe(false);
    expect(
      isNoteAttachment({ ...makeNoteAttachment(), relativePath: "../image.png" })
    ).toBe(false);
    expect(
      isNoteAttachment({ ...makeNoteAttachment(), contentHash: "A".repeat(64) })
    ).toBe(false);
    expect(isNoteAttachment({ ...makeNoteAttachment(), extra: true })).toBe(false);
  });

  it.each(["__proto__", "constructor", "toString"])(
    "rejects prototype MIME key %s even when its inherited value matches the path",
    (mimeType) => {
      const inheritedExtension = String(
        ({} as Record<string, unknown>)[mimeType]
      );

      expect(
        isNoteAttachment({
          ...makeNoteAttachment(),
          mimeType,
          relativePath: `notes-assets/${CONTENT_HASH}.${inheritedExtension}`
        })
      ).toBe(false);
    }
  );

  it("requires native records to have plain prototypes and own fields", () => {
    const customAttachment = Object.assign(
      Object.create({ inherited: true }),
      makeNoteAttachment()
    );
    const inheritedNode = Object.create(makeNoteNode());
    const customMutation = Object.assign(Object.create({ inherited: true }), {
      workspace: { nodes: [makeNoteNode()] },
      historyEntryId: null,
      canUndo: false,
      canRedo: false
    });

    expect(isNoteAttachment(customAttachment)).toBe(false);
    expect(isNoteNode(inheritedNode)).toBe(false);
    expect(isNotesMutationResult(customMutation)).toBe(false);
  });

  it("normalizes ordered workspace attachment arrays without reordering them", () => {
    const secondAttachment = makeNoteAttachment({
      id: "33333333-3333-4333-8333-333333333333",
      sortKey: 2048,
      originalName: "second.png"
    });
    const attachments = [makeNoteAttachment(), secondAttachment];

    const normalized = normalizeNotesWorkspace({
      nodes: [makeNoteNode()],
      attachmentsByNodeId: { [UUID]: attachments }
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.attachmentsByNodeId[UUID]).toEqual(attachments);
    expect(normalized?.attachmentsByNodeId[UUID]).not.toBe(attachments);
  });

  it("defaults a missing attachment map to empty for legacy workspace fixtures", () => {
    expect(normalizeNotesWorkspace({ nodes: [makeNoteNode()] })).toEqual({
      nodes: [makeNoteNode()],
      attachmentsByNodeId: {}
    });
  });

  it("bounds attachment metadata per node and across one workspace", () => {
    const nodeAttachments = Array.from(
      { length: MAX_NOTE_ATTACHMENTS_PER_NODE + 1 },
      (_, index) =>
        makeNoteAttachment({
          id: indexedUuid("2", index + 1),
          sortKey: index + 1
        })
    );
    expect(
      normalizeNotesWorkspace({
        nodes: [makeNoteNode()],
        attachmentsByNodeId: { [UUID]: nodeAttachments }
      })
    ).toBeNull();

    const nodes = Array.from({ length: 5 }, (_, index) =>
      makeNoteNode({ id: indexedUuid("1", index + 1), sortKey: index + 1 })
    );
    let remaining = MAX_NOTE_ATTACHMENTS_PER_WORKSPACE + 1;
    let attachmentIndex = 0;
    const attachmentsByNodeId = Object.fromEntries(
      nodes.map((currentNode) => {
        const count = Math.min(MAX_NOTE_ATTACHMENTS_PER_NODE, remaining);
        remaining -= count;
        return [
          currentNode.id,
          Array.from({ length: count }, (_, index) =>
            makeNoteAttachment({
              id: indexedUuid("3", ++attachmentIndex),
              nodeId: currentNode.id,
              sortKey: index + 1
            })
          )
        ];
      })
    );

    expect(
      normalizeNotesWorkspace({ nodes, attachmentsByNodeId })
    ).toBeNull();
  });

  it("rejects corrupt workspace attachment maps", () => {
    expect(
      normalizeNotesWorkspace({
        nodes: [makeNoteNode()],
        attachmentsByNodeId: {
          [UUID]: [makeNoteAttachment({ nodeId: ATTACHMENT_UUID })]
        }
      })
    ).toBeNull();
    expect(
      normalizeNotesWorkspace({
        nodes: [makeNoteNode()],
        attachmentsByNodeId: {
          [UUID]: [
            makeNoteAttachment({ sortKey: 2048 }),
            makeNoteAttachment({
              id: "33333333-3333-4333-8333-333333333333",
              sortKey: 1024
            })
          ]
        }
      })
    ).toBeNull();
    expect(
      normalizeNotesWorkspace({
        nodes: [makeNoteNode()],
        attachmentsByNodeId: { [UUID]: [{}] }
      })
    ).toBeNull();
  });

  it("rejects inherited, sparse, and non-record workspace payloads", () => {
    const inheritedWorkspace = Object.create({ nodes: [makeNoteNode()] });
    const customMap = Object.assign(Object.create({ inherited: [] }), {
      [UUID]: [makeNoteAttachment()]
    });
    const sparseNodes: NoteNode[] = [];
    sparseNodes.length = 100_000;
    sparseNodes[99_999] = makeNoteNode();
    const arrayWorkspace = Object.assign([], { nodes: [makeNoteNode()] });

    expect(normalizeNotesWorkspace(inheritedWorkspace)).toBeNull();
    expect(
      normalizeNotesWorkspace({
        nodes: [makeNoteNode()],
        attachmentsByNodeId: customMap
      })
    ).toBeNull();
    expect(normalizeNotesWorkspace({ nodes: sparseNodes })).toBeNull();
    expect(normalizeNotesWorkspace(arrayWorkspace)).toBeNull();
  });

  it("requires attachment map keys to name workspace nodes", () => {
    expect(
      normalizeNotesWorkspace({
        nodes: [makeNoteNode({ id: ATTACHMENT_UUID })],
        attachmentsByNodeId: { [UUID]: [makeNoteAttachment()] }
      })
    ).toBeNull();
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects prototype-pollution attachment map key %s",
    (key) => {
      const attachmentsByNodeId = Object.create(null) as Record<
        string,
        NoteAttachment[]
      >;
      attachmentsByNodeId[key] = [];

      expect(
        normalizeNotesWorkspace({
          nodes: [makeNoteNode()],
          attachmentsByNodeId
        })
      ).toBeNull();
    }
  );

  it("recognizes a complete Notes node payload", () => {
    expect(isNoteNode(makeNoteNode())).toBe(true);
    expect(isNoteNode({ ...makeNoteNode(), parentId: 42 })).toBe(false);
    expect(isNoteNode({ ...makeNoteNode(), layoutMode: "board" })).toBe(false);
    expect(isNoteNode({ ...makeNoteNode(), updatedAt: null })).toBe(false);
    expect(isNoteNode({ ...makeNoteNode(), imageOffsetUtf16: 1.5 })).toBe(false);
    expect(isNoteNode({ ...makeNoteNode(), imageOffsetUtf16: -1 })).toBe(false);
    expect(isNoteNode({ ...makeNoteNode(), imageOffsetUtf16: 1 })).toBe(false);
    expect(
      isNoteNode({ ...makeNoteNode(), imageOffsetUtf16: Number.MAX_SAFE_INTEGER + 1 })
    ).toBe(false);
    const image = makeNoteNode({
      nodeKind: "image",
      title: "A😀B",
      imageOffsetUtf16: 3
    });
    expect(isNoteNode(image)).toBe(true);
    expect(isNoteNode({ ...image, imageOffsetUtf16: 5 })).toBe(false);
    expect(isNoteNode({ ...image, imageOffsetUtf16: 2 })).toBe(false);
  });

  it("requires an own text or image node kind", () => {
    const textNode = makeNoteNode();
    const imageNode = { ...makeNoteNode(), nodeKind: "image" };
    const { nodeKind: _missingKind, ...missingKind } = makeNoteNode();
    const inheritedKind = Object.assign(
      Object.create({ nodeKind: "text" }),
      missingKind
    );

    expect(isNoteNode(textNode)).toBe(true);
    expect(isNoteNode(imageNode)).toBe(true);
    expect(isNoteNode(missingKind)).toBe(false);
    expect(isNoteNode(inheritedKind)).toBe(false);
    expect(isNoteNode({ ...makeNoteNode(), nodeKind: "video" })).toBe(false);
  });

  it("recognizes only the exact atomic Notes mutation result shape", () => {
    const result: NotesMutationResult = {
      workspace: { nodes: [makeNoteNode()] },
      historyEntryId: UUID,
      ...historyState()
    };

    expect(isNotesMutationResult(result)).toBe(true);
    expect(isNotesMutationResult({ ...result, historyEntryId: null })).toBe(true);
    expect(isNotesMutationResult({ ...result, historyEntryId: undefined })).toBe(false);
    expect(isNotesMutationResult({ ...result, canUndo: 1 })).toBe(false);
    expect(isNotesMutationResult({ ...result, workspace: { nodes: [{}] } })).toBe(
      false
    );
    expect(
      isNotesMutationResult({
        ...result,
        workspace: {
          nodes: [makeNoteNode()],
          attachmentsByNodeId: { [UUID]: [makeNoteAttachment()] }
        }
      })
    ).toBe(true);
    expect(
      isNotesMutationResult({
        ...result,
        workspace: {
          nodes: [makeNoteNode()],
          attachmentsByNodeId: { [UUID]: [{ ...makeNoteAttachment(), byteSize: -1 }] }
        }
      })
    ).toBe(false);
  });

  it("requires every history state key on mutation results", () => {
    const result = {
      workspace: { nodes: [makeNoteNode()] },
      historyEntryId: UUID,
      canUndo: true,
      canRedo: false,
      historyEpoch: "epoch-a",
      nextUndoEntryId: UUID,
      nextRedoEntryId: null,
      prunedEntryIds: [ATTACHMENT_UUID]
    };

    expect(isNotesMutationResult(result)).toBe(true);
    for (const key of [
      "historyEpoch",
      "nextUndoEntryId",
      "nextRedoEntryId",
      "prunedEntryIds"
    ] as const) {
      const missing = { ...result };
      delete missing[key];
      expect(isNotesMutationResult(missing), key).toBe(false);
    }
  });

  it("accepts and passes through the optional mutation delta fields", () => {
    const result: NotesMutationResult = {
      workspace: { nodes: [makeNoteNode()] },
      historyEntryId: UUID,
      ...historyState()
    };

    expect(
      isNotesMutationResult({
        ...result,
        changedNodes: [makeNoteNode()],
        removedNodeIds: [ATTACHMENT_UUID],
        changedAttachments: [makeNoteAttachment()]
      })
    ).toBe(true);
    // A subset of the delta fields is still valid; they are individually optional.
    expect(isNotesMutationResult({ ...result, changedNodes: [] })).toBe(true);
    expect(
      isNotesMutationResult({ ...result, removedNodeIds: [ATTACHMENT_UUID] })
    ).toBe(true);
    // Present-but-malformed delta fields are rejected.
    expect(isNotesMutationResult({ ...result, changedNodes: [{}] })).toBe(false);
    expect(isNotesMutationResult({ ...result, removedNodeIds: [42] })).toBe(false);
    expect(
      isNotesMutationResult({
        ...result,
        changedAttachments: [{ ...makeNoteAttachment(), byteSize: -1 }]
      })
    ).toBe(false);
    // Unknown keys outside the additive delta contract remain rejected.
    expect(isNotesMutationResult({ ...result, bogus: 1 })).toBe(false);
  });

  it("accepts only well-formed optional duplicated root ids", () => {
    const result: NotesMutationResult = {
      workspace: { nodes: [makeNoteNode()] },
      historyEntryId: UUID,
      ...historyState()
    };

    expect(
      isNotesMutationResult({
        ...result,
        duplicatedRootIds: [UUID, ATTACHMENT_UUID]
      })
    ).toBe(true);
    expect(isNotesMutationResult(result)).toBe(true);
    expect(
      isNotesMutationResult({ ...result, duplicatedRootIds: [42] })
    ).toBe(false);
  });

  it("exposes the exact typed batch action wire variants", () => {
    expectTypeOf<
      Extract<ApplyNotesBatchInput, { op: "duplicate" }>
    >().toEqualTypeOf<{
      op: "duplicate";
      nodeIds: readonly string[];
    }>();
    expectTypeOf<
      Extract<ApplyNotesBatchInput, { op: "addTag" }>
    >().toEqualTypeOf<{
      op: "addTag";
      nodeIds: readonly string[];
      tag: {
        prefix: "#" | "@";
        normalizedTag: string;
        displayTag: string;
      };
    }>();
    expectTypeOf<
      Extract<ApplyNotesBatchInput, { op: "removeTag" }>
    >().toEqualTypeOf<{
      op: "removeTag";
      nodeIds: readonly string[];
      tag: { prefix: "#" | "@"; normalizedTag: string };
    }>();
  });

  it("requires every exact key on history state payloads", () => {
    const state = {
      canUndo: true,
      canRedo: false,
      historyEpoch: "epoch-a",
      nextUndoEntryId: UUID,
      nextRedoEntryId: null,
      prunedEntryIds: [ATTACHMENT_UUID]
    };

    expect(isNotesHistoryState(state)).toBe(true);
    for (const key of Object.keys(state) as Array<keyof typeof state>) {
      const missing = { ...state };
      delete missing[key];
      expect(isNotesHistoryState(missing), key).toBe(false);
    }
    expect(isNotesHistoryState({ ...state, extra: true })).toBe(false);
  });

  it("recognizes only strict history replay outcome payloads", () => {
    const state = {
      canUndo: false,
      canRedo: true,
      historyEpoch: "epoch-a",
      nextUndoEntryId: null,
      nextRedoEntryId: ATTACHMENT_UUID,
      prunedEntryIds: []
    };
    const replay = {
      kind: "applied",
      workspace: { nodes: [makeNoteNode()] },
      replayedEntryId: ATTACHMENT_UUID,
      ...state
    };
    const customReplay = Object.assign(
      Object.create({ inherited: true }),
      replay
    );

    expect(isNotesHistoryReplayOutcome(replay)).toBe(true);
    expect(
      isNotesHistoryReplayOutcome({ kind: "epochMismatch", ...state })
    ).toBe(true);
    expect(
      isNotesHistoryReplayOutcome({ ...replay, replayedEntryId: null })
    ).toBe(false);
    expect(isNotesHistoryReplayOutcome(customReplay)).toBe(false);
    expect(
      isNotesHistoryReplayOutcome({
        ...replay,
        workspace: {
          nodes: [makeNoteNode()],
          attachmentsByNodeId: {
            [UUID]: [{ ...makeNoteAttachment(), mimeType: "constructor" }]
          }
        }
      })
    ).toBe(false);
    for (const key of Object.keys(state) as Array<keyof typeof state>) {
      const missing = { ...replay };
      delete missing[key];
      expect(isNotesHistoryReplayOutcome(missing), key).toBe(false);
    }
  });

  it("requires exact history reset result payloads", () => {
    const reset = {
      historyReset: true,
      canUndo: false,
      canRedo: false,
      historyEpoch: "epoch-b",
      nextUndoEntryId: null,
      nextRedoEntryId: null,
      prunedEntryIds: [UUID]
    } as const;

    expect(isNotesHistoryResetResult(reset)).toBe(true);
    expect(
      isNotesWorkspaceResetResult({ ...reset, workspace: { nodes: [] } })
    ).toBe(true);
    expect(isNotesHistoryResetResult({ ...reset, historyReset: false })).toBe(
      false
    );
    for (const key of Object.keys(reset) as Array<keyof typeof reset>) {
      const missing = { ...reset };
      delete missing[key];
      expect(isNotesHistoryResetResult(missing), key).toBe(false);
    }
  });

  it("rejects incomplete Notes node payloads", () => {
    const { note: _note, ...missingNote } = makeNoteNode();
    const { archivedAt: _archivedAt, ...missingArchivedAt } = makeNoteNode();
    const { archiveRootId: _archiveRootId, ...missingArchiveRootId } = makeNoteNode();
    const { imageOffsetUtf16: _imageOffsetUtf16, ...missingImageOffsetUtf16 } = makeNoteNode();

    expect(isNoteNode(missingNote)).toBe(false);
    expect(isNoteNode(missingArchivedAt)).toBe(false);
    expect(isNoteNode(missingArchiveRootId)).toBe(false);
    expect(isNoteNode(missingImageOffsetUtf16)).toBe(false);
    expect(isNoteNode(null)).toBe(false);
  });

  it("recognizes typed search results and rejects malformed offsets", () => {
    const result = {
      nodeId: UUID,
      nodeKind: "image",
      title: "A😀B",
      imageOffsetUtf16: 3,
      attachmentName: "target.png",
      displayLabel: "Target",
      parentTrail: ["Page", "Section"],
      parentTrailKinds: ["image", "text"],
      matchedField: "attachment"
    } satisfies NoteSearchResult;

    expect(isNoteSearchResult(result)).toBe(true);
    expect(isNoteSearchResult({ ...result, parentTrail: ["Page", 42] })).toBe(false);
    expect(
      isNoteSearchResult({ ...result, parentTrailKinds: ["text"] })
    ).toBe(false);
    expect(
      isNoteSearchResult({ ...result, parentTrailKinds: ["text", "canvas"] })
    ).toBe(false);
    expect(isNoteSearchResult({ ...result, nodeKind: "canvas" })).toBe(false);
    expect(isNoteSearchResult({ ...result, matchedField: "tags" })).toBe(false);
    expect(isNoteSearchResult({ ...result, matchedField: "date" })).toBe(true);
    expect(isNoteSearchResult({ ...result, attachmentName: 42 })).toBe(false);
    expect(isNoteSearchResult({ ...result, displayLabel: null })).toBe(false);
    expect(isNoteSearchResult({ ...result, imageOffsetUtf16: 1.5 })).toBe(false);
    expect(isNoteSearchResult({ ...result, imageOffsetUtf16: -1 })).toBe(false);
    expect(
      isNoteSearchResult({ ...result, imageOffsetUtf16: Number.MAX_SAFE_INTEGER + 1 })
    ).toBe(false);
    expect(isNoteSearchResult({ ...result, imageOffsetUtf16: 5 })).toBe(false);
    expect(isNoteSearchResult({ ...result, imageOffsetUtf16: 2 })).toBe(false);
    expect(
      isNoteSearchResult({
        ...result,
        attachmentName: null,
        matchedField: "title"
      })
    ).toBe(true);
    const textResult = {
      ...result,
      nodeKind: "text" as const,
      title: "Text",
      imageOffsetUtf16: 0,
      attachmentName: null,
      matchedField: "title" as const
    };
    expect(isNoteSearchResult(textResult)).toBe(true);
    expect(isNoteSearchResult({ ...textResult, imageOffsetUtf16: 1 })).toBe(false);
    expect(isNoteSearchResult({ ...textResult, attachmentName: "text.png" })).toBe(false);
    const { nodeKind: _nodeKind, ...missingNodeKind } = result;
    const { imageOffsetUtf16: _imageOffsetUtf16, ...missingImageOffsetUtf16 } = result;
    const { attachmentName: _attachmentName, ...missingAttachmentName } = result;
    const { parentTrailKinds: _parentTrailKinds, ...missingTrailKinds } = result;
    expect(isNoteSearchResult(missingNodeKind)).toBe(false);
    expect(isNoteSearchResult(missingImageOffsetUtf16)).toBe(false);
    expect(isNoteSearchResult(missingAttachmentName)).toBe(false);
    expect(isNoteSearchResult(missingTrailKinds)).toBe(false);
    expect(isNoteSearchResult({ ...result, extra: true })).toBe(false);
    const inherited = Object.assign(Object.create({ inherited: true }), result);
    const sparseTrail: string[] = [];
    sparseTrail.length = 2;
    sparseTrail[1] = "Section";
    const sparseTrailKinds: string[] = [];
    sparseTrailKinds.length = 2;
    sparseTrailKinds[1] = "text";
    expect(isNoteSearchResult(inherited)).toBe(false);
    expect(isNoteSearchResult({ ...result, parentTrail: sparseTrail })).toBe(false);
    expect(
      isNoteSearchResult({ ...result, parentTrailKinds: sparseTrailKinds })
    ).toBe(false);
  });

  it("requires image attachment metadata for attachment search matches", () => {
    const attachmentMatch = {
      nodeId: UUID,
      nodeKind: "image",
      title: "",
      imageOffsetUtf16: 0,
      attachmentName: "diagram.png",
      displayLabel: "diagram.png",
      parentTrail: [],
      parentTrailKinds: [],
      matchedField: "attachment"
    } satisfies NoteSearchResult;

    expect(isNoteSearchResult(attachmentMatch)).toBe(true);
    expect(
      isNoteSearchResult({
        ...attachmentMatch,
        nodeKind: "text",
        attachmentName: null
      })
    ).toBe(false);
    expect(
      isNoteSearchResult({ ...attachmentMatch, attachmentName: null })
    ).toBe(false);
  });

  it("supports typed active, archive, and trash search scopes", () => {
    const scopes: NoteSearchScope[] = [
      { kind: "active" },
      { kind: "archive" },
      { kind: "trash" }
    ];

    expect(scopes.map((scope) => scope.kind)).toEqual([
      "active",
      "archive",
      "trash"
    ]);
    expectTypeOf<NotesStore["search"]>().toEqualTypeOf<
      (
        vaultPath: string,
        query: string,
        scope?: NoteSearchScope
      ) => Promise<import("./notes").NoteSearchResult[]>
    >();
  });

  it("recognizes structured search queries and rejects malformed tag groups", () => {
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

    expect(isNoteStructuredSearchQuery(query)).toBe(true);
    expect(
      isNoteStructuredSearchQuery({
        ...query,
        orGroups: [[{ prefix: "hash", normalizedTag: "desktop" }]]
      })
    ).toBe(false);
    expect(
      isNoteStructuredSearchQuery({ ...query, excludedTags: ["#blocked"] })
    ).toBe(false);
    const customQuery = Object.assign(Object.create({ inherited: true }), query);
    const sparseRequiredTags = [...query.requiredTags];
    sparseRequiredTags.length = 2;
    expect(isNoteStructuredSearchQuery(customQuery)).toBe(false);
    expect(
      isNoteStructuredSearchQuery({
        ...query,
        requiredTags: sparseRequiredTags
      })
    ).toBe(false);
  });

  it("supports active, discovery, structured tag, archive, and trash scopes", () => {
    const scopes: NotesWorkspaceScope[] = [
      { kind: "active" },
      { kind: "starred" },
      { kind: "recent" },
      { kind: "tag", tag: "roadmap" },
      {
        kind: "tags",
        tags: [
          { prefix: "#", normalizedTag: "roadmap" },
          { prefix: "@", normalizedTag: "minji" }
        ]
      },
      { kind: "archive" },
      { kind: "trash" }
    ];

    expect(scopes.map((scope) => scope.kind)).toEqual([
      "active",
      "starred",
      "recent",
      "tag",
      "tags",
      "archive",
      "trash"
    ]);
  });

  it("describes counted hashtag and mention summaries", () => {
    const summaries: NoteTagSummary[] = [
      { prefix: "#", normalizedTag: "roadmap", displayTag: "Roadmap", count: 2 },
      { prefix: "@", normalizedTag: "minji", displayTag: "Minji", count: 1 }
    ];

    expect(summaries.map(({ prefix, count }) => [prefix, count])).toEqual([
      ["#", 2],
      ["@", 1]
    ]);
  });

  it("requires every NotesStore to provide discovery capabilities", () => {
    expectTypeOf<NotesStore>().toMatchTypeOf<{
      toggleStar: NonNullable<NotesStore["toggleStar"]>;
      archiveNode: NonNullable<NotesStore["archiveNode"]>;
      unarchiveNode: NonNullable<NotesStore["unarchiveNode"]>;
      search: NonNullable<NotesStore["search"]>;
      listTags: NonNullable<NotesStore["listTags"]>;
      listTagsWithCounts: NonNullable<NotesStore["listTagsWithCounts"]>;
      deleteDatabase: NonNullable<NotesStore["deleteDatabase"]>;
    }>();
    expectTypeOf<NonNullable<NotesStore["searchStructured"]>>().toEqualTypeOf<
      (
        vaultPath: string,
        query: NoteStructuredSearchQuery
      ) => Promise<import("./notes").NoteSearchResult[]>
    >();
  });

  it("defines typed attachment inputs and store APIs with history context", () => {
    expectTypeOf<NotesStore>().toMatchTypeOf<{
      importAttachmentPaths: NonNullable<NotesStore["importAttachmentPaths"]>;
      importAttachmentBytes: NonNullable<NotesStore["importAttachmentBytes"]>;
    }>();
    expectTypeOf<keyof ImportNoteAttachmentInput>().toEqualTypeOf<
      "id" | "nodeId" | "sourcePath" | "initialMaxDisplayWidth"
    >();
    expectTypeOf<keyof ResizeNoteAttachmentInput>().toEqualTypeOf<
      "id" | "displayWidth"
    >();
    expectTypeOf<NonNullable<NotesStore["importAttachment"]>>().toEqualTypeOf<
      (
        vaultPath: string,
        input: ImportNoteAttachmentInput,
        historyContext: import("./notes").NotesHistoryContext
      ) => Promise<NotesMutationResponse>
    >();
    expectTypeOf<NonNullable<NotesStore["readAttachmentBytes"]>>().toEqualTypeOf<
      (vaultPath: string, attachmentId: string) => Promise<Uint8Array>
    >();
    expectTypeOf<NonNullable<NotesStore["resizeAttachment"]>>().toEqualTypeOf<
      (
        vaultPath: string,
        input: ResizeNoteAttachmentInput,
        historyContext: import("./notes").NotesHistoryContext
      ) => Promise<NotesMutationResponse>
    >();
    expectTypeOf<NonNullable<NotesStore["removeAttachment"]>>().toEqualTypeOf<
      (
        vaultPath: string,
        attachmentId: string,
        historyContext: import("./notes").NotesHistoryContext
      ) => Promise<NotesMutationResponse>
    >();
    expectTypeOf<NonNullable<NotesStore["restoreAttachment"]>>().toEqualTypeOf<
      (
        vaultPath: string,
        attachmentId: string,
        historyContext: import("./notes").NotesHistoryContext
      ) => Promise<NotesMutationResponse>
    >();
    expectTypeOf<keyof ImportNoteAttachmentPathBatchInput>().toEqualTypeOf<
      "nodeId" | "attachments" | "initialMaxDisplayWidth"
    >();
    expectTypeOf<keyof ImportNoteAttachmentByteItem>().toEqualTypeOf<
      "id" | "originalName" | "mimeType" | "blob"
    >();
    expectTypeOf<keyof PendingNoteAttachmentByteItem>().toEqualTypeOf<
      "originalName" | "mimeType" | "blob"
    >();
    expectTypeOf<keyof ImportNoteAttachmentBytesBatchInput>().toEqualTypeOf<
      "nodeId" | "attachments" | "initialMaxDisplayWidth"
    >();
    expectTypeOf<NonNullable<NotesStore["importAttachmentPaths"]>>().toEqualTypeOf<
      (
        vaultPath: string,
        input: ImportNoteAttachmentPathBatchInput,
        historyContext: import("./notes").NotesHistoryContext
      ) => Promise<NotesMutationResponse>
    >();
    expectTypeOf<NonNullable<NotesStore["importAttachmentBytes"]>>().toEqualTypeOf<
      (
        vaultPath: string,
        input: ImportNoteAttachmentBytesBatchInput,
        historyContext: import("./notes").NotesHistoryContext
      ) => Promise<NotesMutationResponse>
    >();
  });

  it("defines typed image-node import inputs and store APIs with history context", () => {
    expect(MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS).toBe(128);
    expectTypeOf<keyof ImportImageNodePathItem>().toEqualTypeOf<
      "nodeId" | "attachmentId" | "sourcePath"
    >();
    expectTypeOf<keyof ImportImageNodePathsInput>().toEqualTypeOf<
      "parentId" | "afterId" | "items" | "initialMaxDisplayWidth"
    >();
    expectTypeOf<keyof ImportImageNodeByteItem>().toEqualTypeOf<
      "nodeId" | "attachmentId" | "originalName" | "mimeType" | "blob"
    >();
    expectTypeOf<keyof PendingImageNodeByteItem>().toEqualTypeOf<
      "originalName" | "mimeType" | "blob"
    >();
    expectTypeOf<keyof ImportImageNodeBytesInput>().toEqualTypeOf<
      "parentId" | "afterId" | "items" | "initialMaxDisplayWidth"
    >();
    expectTypeOf<NonNullable<NotesStore["importImageNodePaths"]>>().toEqualTypeOf<
      (
        vaultPath: string,
        input: ImportImageNodePathsInput,
        historyContext: import("./notes").NotesHistoryContext
      ) => Promise<NotesMutationResponse>
    >();
    expectTypeOf<NonNullable<NotesStore["importImageNodeBytes"]>>().toEqualTypeOf<
      (
        vaultPath: string,
        input: ImportImageNodeBytesInput,
        historyContext: import("./notes").NotesHistoryContext
      ) => Promise<NotesMutationResponse>
    >();
  });

  it("requires typed atomic subtree menu mutation methods", () => {
    type SubtreeMutation = (
      vaultPath: string,
      nodeId: import("./notes").NoteId,
      historyContext: import("./notes").NotesHistoryContext
    ) => Promise<NotesMutationResult>;

    expectTypeOf<NonNullable<NotesStore["expandAll"]>>().toEqualTypeOf<SubtreeMutation>();
    expectTypeOf<NonNullable<NotesStore["collapseAll"]>>().toEqualTypeOf<SubtreeMutation>();
    expectTypeOf<NonNullable<NotesStore["sortSubtreeAscending"]>>().toEqualTypeOf<SubtreeMutation>();
    expectTypeOf<NonNullable<NotesStore["sortSubtreeDescending"]>>().toEqualTypeOf<SubtreeMutation>();
  });

  it("creates a canonical UUID for a new node", () => {
    const randomUUID = vi.fn(() => UUID);
    vi.stubGlobal("crypto", { randomUUID });

    expect(createNoteId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("reports when secure UUID generation is unavailable", () => {
    vi.stubGlobal("crypto", {});

    expect(() => createNoteId()).toThrow(/crypto\.randomUUID/);
  });
});

describe("notes error taxonomy", () => {
  it("keeps a recognized backend code and message", () => {
    expect(
      parseNotesError({
        code: "destinationExists",
        message: "Destination already exists."
      })
    ).toEqual({
      code: "destinationExists",
      message: "Destination already exists."
    });
    expect(
      parseNotesError({ code: "vaultBusy", message: "Vault is open elsewhere." })
    ).toEqual({ code: "vaultBusy", message: "Vault is open elsewhere." });
  });

  it("classifies unstructured causes as internal while preserving their text", () => {
    expect(parseNotesError("Notes requires Tauri desktop storage.")).toEqual({
      code: "internal",
      message: "Notes requires Tauri desktop storage."
    });
    expect(parseNotesError(new Error("disk full"))).toEqual({
      code: "internal",
      message: "disk full"
    });
    // An unknown code is not trusted; it falls back to internal.
    expect(
      parseNotesError({ code: "notAKnownCode", message: "boom" })
    ).toEqual({ code: "internal", message: "boom" });
  });

  it("uses a stable fallback for malformed object causes", () => {
    expect(parseNotesError({ detail: "opaque transport payload" })).toEqual({
      code: "internal",
      message: "Notes request failed."
    });
    expect(parseNotesError(null)).toEqual({
      code: "internal",
      message: "Notes request failed."
    });
  });

  it("derives retryability from the code", () => {
    const retryable: NotesErrorCode[] = ["vaultBusy", "internal"];
    const notRetryable: NotesErrorCode[] = [
      "destinationExists",
      "foreignExportAssetDir",
      "unsupportedSchemaVersion"
    ];
    for (const code of retryable) {
      expect(isRetryableNotesErrorCode(code)).toBe(true);
    }
    for (const code of notRetryable) {
      expect(isRetryableNotesErrorCode(code)).toBe(false);
    }
  });

  it("matches a code only on a structured cause", () => {
    expect(
      notesErrorHasCode(
        { code: "destinationExists", message: "x" },
        "destinationExists"
      )
    ).toBe(true);
    expect(
      notesErrorHasCode(
        { code: "foreignExportAssetDir", message: "x" },
        "destinationExists"
      )
    ).toBe(false);
    expect(notesErrorHasCode("destinationExists", "destinationExists")).toBe(
      false
    );
    expect(notesErrorHasCode(null, "internal")).toBe(false);
  });
});
