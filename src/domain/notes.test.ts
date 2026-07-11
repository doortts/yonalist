import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createNoteId,
  isNoteAttachment,
  isNoteNode,
  isNotesHistoryReplayResult,
  isNotesMutationResult,
  isNoteSearchResult,
  isNoteStructuredSearchQuery,
  MAX_NOTE_ATTACHMENTS_PER_NODE,
  MAX_NOTE_ATTACHMENTS_PER_WORKSPACE,
  normalizeNotesWorkspace
} from "./notes";
import type {
  NoteAttachment,
  ImportNoteAttachmentInput,
  NoteNode,
  NoteSearchScope,
  NoteStructuredSearchQuery,
  NoteTagSummary,
  NotesMutationResult,
  NotesMutationResponse,
  NotesStore,
  NotesWorkspaceScope,
  ResizeNoteAttachmentInput
} from "./notes";

const UUID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_UUID = "22222222-2222-4222-8222-222222222222";
const CONTENT_HASH = "a".repeat(64);

function makeNoteNode(overrides: Partial<NoteNode> = {}): NoteNode {
  return {
    id: UUID,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Notes domain contract", () => {
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
  });

  it("recognizes only the exact atomic Notes mutation result shape", () => {
    const result: NotesMutationResult = {
      workspace: { nodes: [makeNoteNode()] },
      historyEntryId: UUID,
      canUndo: true,
      canRedo: false
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

  it("recognizes only strict history replay result payloads", () => {
    const replay = {
      workspace: { nodes: [makeNoteNode()] },
      replayedEntryId: ATTACHMENT_UUID,
      canUndo: false,
      canRedo: true
    };
    const customReplay = Object.assign(
      Object.create({ inherited: true }),
      replay
    );

    expect(isNotesHistoryReplayResult(replay)).toBe(true);
    expect(isNotesHistoryReplayResult({ ...replay, replayedEntryId: null })).toBe(
      true
    );
    expect(isNotesHistoryReplayResult(customReplay)).toBe(false);
    expect(
      isNotesHistoryReplayResult({
        ...replay,
        workspace: {
          nodes: [makeNoteNode()],
          attachmentsByNodeId: {
            [UUID]: [{ ...makeNoteAttachment(), mimeType: "constructor" }]
          }
        }
      })
    ).toBe(false);
  });

  it("rejects incomplete Notes node payloads", () => {
    const { note: _note, ...missingNote } = makeNoteNode();
    const { archivedAt: _archivedAt, ...missingArchivedAt } = makeNoteNode();
    const { archiveRootId: _archiveRootId, ...missingArchiveRootId } = makeNoteNode();

    expect(isNoteNode(missingNote)).toBe(false);
    expect(isNoteNode(missingArchivedAt)).toBe(false);
    expect(isNoteNode(missingArchiveRootId)).toBe(false);
    expect(isNoteNode(null)).toBe(false);
  });

  it("recognizes typed search results and rejects malformed parent trails", () => {
    const result = {
      nodeId: UUID,
      title: "Target",
      parentTrail: ["Page", "Section"],
      matchedField: "note"
    };

    expect(isNoteSearchResult(result)).toBe(true);
    expect(isNoteSearchResult({ ...result, parentTrail: ["Page", 42] })).toBe(false);
    expect(isNoteSearchResult({ ...result, matchedField: "tags" })).toBe(false);
    expect(isNoteSearchResult({ ...result, matchedField: "date" })).toBe(true);
    const inherited = Object.assign(Object.create({ inherited: true }), result);
    const sparseTrail: string[] = [];
    sparseTrail.length = 2;
    sparseTrail[1] = "Section";
    expect(isNoteSearchResult(inherited)).toBe(false);
    expect(isNoteSearchResult({ ...result, parentTrail: sparseTrail })).toBe(false);
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
    expectTypeOf<keyof ImportNoteAttachmentInput>().toEqualTypeOf<
      "id" | "nodeId" | "sourcePath" | "displayWidth"
    >();
    expectTypeOf<keyof ResizeNoteAttachmentInput>().toEqualTypeOf<
      "id" | "displayWidth"
    >();
    expectTypeOf<NonNullable<NotesStore["importAttachment"]>>().toEqualTypeOf<
      (
        vaultPath: string,
        input: ImportNoteAttachmentInput,
        historyContext?: import("./notes").NotesHistoryContext | null
      ) => Promise<NotesMutationResponse>
    >();
    expectTypeOf<NonNullable<NotesStore["readAttachmentBytes"]>>().toEqualTypeOf<
      (vaultPath: string, attachmentId: string) => Promise<Uint8Array>
    >();
    expectTypeOf<NonNullable<NotesStore["resizeAttachment"]>>().toEqualTypeOf<
      (
        vaultPath: string,
        input: ResizeNoteAttachmentInput,
        historyContext?: import("./notes").NotesHistoryContext | null
      ) => Promise<NotesMutationResponse>
    >();
    expectTypeOf<NonNullable<NotesStore["removeAttachment"]>>().toEqualTypeOf<
      (
        vaultPath: string,
        attachmentId: string,
        historyContext?: import("./notes").NotesHistoryContext | null
      ) => Promise<NotesMutationResponse>
    >();
    expectTypeOf<NonNullable<NotesStore["restoreAttachment"]>>().toEqualTypeOf<
      (
        vaultPath: string,
        attachmentId: string,
        historyContext?: import("./notes").NotesHistoryContext | null
      ) => Promise<NotesMutationResponse>
    >();
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
