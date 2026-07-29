import { describe, expect, it } from "vitest";
import type { NoteId, NoteNode, NotesHistoryContext } from "../../domain/notes";
import {
  classifyLocalStructureFailure,
  localFirstChild,
  localSplit,
  projectLocalStructures,
  settleLocalStructure,
  type LocalStructureEntry,
  updateLocalStructureTitle,
} from "./notesLocalStructure";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import type { FlattenedOutlineRow } from "./outlineTree";

function row(id: NoteId): FlattenedOutlineRow {
  return {
    id,
    parentId: null,
    depth: 0,
    isCollapsed: false,
    ancestorIds: [],
    ancestorGuideDepths: [],
    visibleDescendantEndId: null,
  };
}

function note(
  id: NoteId,
  title: string,
  overrides: Partial<NoteNode> = {},
): NoteNode {
  return {
    id,
    nodeKind: "text",
    markerKind: "bullet",
    parentId: null,
    sortKey: 1024,
    title,
    note: "",
    imageOffsetUtf16: 0,
    markdownImageWidth: null,
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    ...overrides,
  };
}

function history(entryId: string): NotesHistoryContext {
  return {
    sessionId: "history-session",
    historyEpoch: "history-epoch",
    entryId,
    commandKind: "split",
  };
}

function split(
  token: number,
  sourceId: NoteId,
  insertedId: NoteId,
  sourceTitle: string,
  insertedTitle: string,
  dependencyId: NoteId | null = null,
): LocalStructureEntry {
  return localSplit({
    token,
    sourceId,
    insertedId,
    ownerPaneId: "primary",
    historyContext: history(`history-${token}`),
    sourceSelection: { anchorUtf16: 1, focusUtf16: 1 },
    sourceTitle,
    insertedTitle,
    dependencyId,
  });
}

describe("local outline structure", () => {
  it("projects a split immediately without changing the authoritative nodes", () => {
    const rows = [row("a"), row("b"), row("c")];
    const nodesById = {
      a: note("a", "before"),
      b: note("b", "b"),
      c: note("c", "c"),
    };

    const projected = projectLocalStructures(rows, nodesById, [
      split(1, "a", "new", "pre", "post"),
    ]);

    expect(projected.rows.map(({ id }) => id)).toEqual(["a", "new", "b", "c"]);
    expect(projected.nodeOverrides.get("a")?.title).toBe("pre");
    expect(projected.nodeOverrides.get("new")?.title).toBe("post");
    expect(nodesById.a.title).toBe("before");
  });

  it("projects and settles a first child at index zero", () => {
    const entry = localFirstChild({
      token: 1,
      sourceId: "a",
      insertedId: "new",
      ownerPaneId: "primary",
      historyContext: { ...history("history-1"), commandKind: "create" },
      sourceSelection: { anchorUtf16: 1, focusUtf16: 1 },
      sourceTitle: "parent",
      insertedTitle: "",
      dependencyId: null,
    });
    const projected = projectLocalStructures(
      [row("a"), row("b")],
      { a: note("a", "parent"), b: note("b", "b") },
      [entry],
    );

    expect(projected.rows.map(({ id, depth }) => [id, depth])).toEqual([
      ["a", 0],
      ["new", 1],
      ["b", 0],
    ]);
    expect(projected.nodeOverrides.get("new")?.parentId).toBe("a");

    const authoritative = normalizeWorkspace({
      nodes: [
        note("a", "parent", { sortKey: 1024 }),
        note("new", "", { parentId: "a", sortKey: 1024 }),
        note("b", "b", { sortKey: 2048 }),
      ],
      attachmentsByNodeId: {},
    });
    expect(settleLocalStructure([entry], entry.token, authoritative)).toEqual(
      [],
    );
  });

  it("chains a held split through the row inserted by the previous keydown", () => {
    const projected = projectLocalStructures(
      [row("a"), row("b"), row("c")],
      {
        a: note("a", "alpha"),
        b: note("b", "b"),
        c: note("c", "c"),
      },
      [
        split(1, "a", "new-1", "al", "pha"),
        split(2, "new-1", "new-2", "p", "ha", "new-1"),
      ],
    );

    expect(projected.rows.map(({ id }) => id)).toEqual([
      "a",
      "new-1",
      "new-2",
      "b",
      "c",
    ]);
    expect(projected.nodeOverrides.get("a")?.title).toBe("al");
    expect(projected.nodeOverrides.get("new-1")?.title).toBe("p");
    expect(projected.nodeOverrides.get("new-2")?.title).toBe("ha");
  });

  it("projects a held split chain without rescanning the whole outline for every entry", () => {
    let idReads = 0;
    const rows = Array.from({ length: 5_000 }, (_, index) => {
      const item = row(`row-${index}`);
      Object.defineProperty(item, "id", {
        enumerable: true,
        get() {
          idReads += 1;
          return `row-${index}`;
        },
      });
      return item;
    });
    const nodesById = Object.fromEntries(
      rows.map((item) => [item.id, note(item.id, item.id)]),
    );
    idReads = 0;
    const entries = Array.from({ length: 25 }, (_, index) =>
      split(
        index + 1,
        index === 0 ? "row-0" : `new-${index}`,
        `new-${index + 1}`,
        "",
        "",
        index === 0 ? null : `new-${index}`,
      ),
    );

    const projected = projectLocalStructures(rows, nodesById, entries);

    expect(projected.rows.slice(0, 27).map(({ id }) => id)).toEqual([
      "row-0",
      ...entries.map(({ insertedId }) => insertedId),
      "row-1",
    ]);
    expect(idReads).toBeLessThan(20_000);
  });

  it("keeps optimistic node metadata stable while authority catches up", () => {
    const entry = {
      ...split(7, "a", "new", "a", ""),
      createdAt: "2026-07-29T01:02:03.000Z",
    };
    const project = (sortKey: number, updatedAt: string) =>
      projectLocalStructures(
        [row("a"), row("b")],
        {
          a: note("a", "a", {
            sortKey,
            createdAt: updatedAt,
            updatedAt,
          }),
          b: note("b", "b"),
        },
        [entry],
      ).nodeOverrides.get("new");

    expect(project(1024, "2026-07-29T00:00:00.000Z")).toMatchObject({
      sortKey: 7,
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
    });
    expect(project(2048, "2026-07-29T02:00:00.000Z")).toMatchObject({
      sortKey: 7,
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
    });
  });

  it("removes only the exactly settled entry", () => {
    const first = split(1, "a", "new-1", "pre", "post");
    const second = split(2, "new-1", "new-2", "po", "st", "new-1");
    const authoritative = normalizeWorkspace({
      nodes: [
        note("a", "pre", { sortKey: 1024 }),
        note("new-1", "post", { sortKey: 2048 }),
        note("b", "b", { sortKey: 3072 }),
        note("c", "c", { sortKey: 4096 }),
      ],
      attachmentsByNodeId: {},
    });

    expect(
      settleLocalStructure([first, second], first.token, authoritative),
    ).toEqual([second]);
  });

  it("keeps a mismatched entry until authoritative reconciliation", () => {
    const entry = split(1, "a", "new", "pre", "post");
    const mismatched = normalizeWorkspace({
      nodes: [
        note("a", "normalized", { sortKey: 1024 }),
        note("new", "post", { sortKey: 2048 }),
        note("b", "b", { sortKey: 3072 }),
        note("c", "c", { sortKey: 4096 }),
      ],
      attachmentsByNodeId: {},
    });

    expect(settleLocalStructure([entry], entry.token, mismatched)).toEqual([
      entry,
    ]);
  });

  it("updates only the live inserted title while retaining the settlement postcondition", () => {
    const first = split(1, "a", "new-1", "pre", "post");
    const second = split(2, "new-1", "new-2", "po", "st", "new-1");

    const updated = updateLocalStructureTitle(
      [first, second],
      first.token,
      "typed before save",
    );

    expect(updated[0]).toEqual({
      ...first,
      insertedTitle: "typed before save",
    });
    expect(updated[0]?.postcondition).toEqual(first.postcondition);
    expect(updated[1]).toBe(second);
    expect(first.insertedTitle).toBe("post");
  });

  it("rolls back a known independent failure from its reserved history entry", () => {
    const entry = split(1, "a", "new", "pre", "post");

    expect(
      classifyLocalStructureFailure([entry], entry.token, "known"),
    ).toEqual({
      kind: "rollback",
      historyContext: entry.historyContext,
      sourceId: "a",
      sourceSelection: entry.sourceSelection,
    });
  });

  it.each([["dependent", "known"] as const, ["unknown", "unknown"] as const])(
    "requires authority recovery for a %s failure",
    (_label, outcome) => {
      const first = split(1, "a", "new-1", "pre", "post");
      const dependent = split(2, "new-1", "new-2", "po", "st", "new-1");

      expect(
        classifyLocalStructureFailure(
          outcome === "known" ? [first, dependent] : [first],
          first.token,
          outcome,
        ),
      ).toEqual({ kind: "recover-authority" });
    },
  );
});
