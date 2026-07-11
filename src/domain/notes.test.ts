import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createNoteId,
  isNoteNode,
  isNotesMutationResult,
  isNoteSearchResult,
  isNoteStructuredSearchQuery
} from "./notes";
import type {
  NoteNode,
  NoteStructuredSearchQuery,
  NoteTagSummary,
  NotesMutationResult,
  NotesStore,
  NotesWorkspaceScope
} from "./notes";

const UUID = "11111111-1111-4111-8111-111111111111";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Notes domain contract", () => {
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
