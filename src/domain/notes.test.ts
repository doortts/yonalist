import { afterEach, describe, expect, it, vi } from "vitest";
import { createNoteId, isNoteNode, isNoteSearchResult } from "./notes";
import type { NoteNode, NotesWorkspaceScope } from "./notes";

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

  it("rejects incomplete Notes node payloads", () => {
    const { note: _note, ...missingNote } = makeNoteNode();

    expect(isNoteNode(missingNote)).toBe(false);
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

  it("supports active, starred, recent, tag, and trash workspace scopes", () => {
    const scopes: NotesWorkspaceScope[] = [
      { kind: "active" },
      { kind: "starred" },
      { kind: "recent" },
      { kind: "tag", tag: "roadmap" },
      { kind: "trash" }
    ];

    expect(scopes.map((scope) => scope.kind)).toEqual([
      "active",
      "starred",
      "recent",
      "tag",
      "trash"
    ]);
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
