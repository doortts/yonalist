import { describe, expect, it } from "vitest";
import type { NoteNode } from "../../domain/notes";
import { buildTodoProgressMap, directTodoProgress } from "./notesTodoProgress";

const node = (
  id: string,
  parentId: string | null,
  markerKind: NoteNode["markerKind"],
  completed = false
): NoteNode => ({
  id,
  parentId,
  markerKind,
  nodeKind: "text",
  sortKey: 1,
  title: id,
  note: "",
  imageOffsetUtf16: 0,
  markdownImageWidth: null,
  layoutMode: "bullets",
  isCollapsed: false,
  isStarred: false,
  completedAt: completed ? "2026-07-23T00:00:00Z" : null,
  createdAt: "2026-07-23T00:00:00Z",
  updatedAt: "2026-07-23T00:00:00Z",
  deletedAt: null,
  archivedAt: null,
  archiveRootId: null
});

describe("directTodoProgress", () => {
  it("counts only direct To-do children", () => {
    const nodes = [
      node("todo-done", "parent", "todo", true),
      node("todo-open", "parent", "todo"),
      node("ordinary-done", "parent", "bullet", true),
      node("grandchild", "todo-open", "todo", true)
    ];
    expect(
      directTodoProgress(
        "parent",
        Object.fromEntries(nodes.map((item) => [item.id, item])),
        {
          parent: ["todo-done", "todo-open", "ordinary-done"],
          "todo-open": ["grandchild"]
        }
      )
    ).toEqual({ completed: 1, total: 2 });
  });

  it("returns null when the parent has no direct To-dos", () => {
    const ordinary = node("ordinary", "parent", "bullet", true);
    expect(
      directTodoProgress("parent", { ordinary }, { parent: ["ordinary"] })
    ).toBeNull();
  });
});

describe("buildTodoProgressMap", () => {
  it("holds progress only for parents with direct To-do children", () => {
    const nodes = [
      node("a-done", "a", "todo", true),
      node("a-open", "a", "todo"),
      node("b-plain", "b", "bullet", true),
      node("c-open", "c", "todo")
    ];
    const map = buildTodoProgressMap(
      Object.fromEntries(nodes.map((item) => [item.id, item])),
      { a: ["a-done", "a-open"], b: ["b-plain"], c: ["c-open"] }
    );
    expect(map.get("a")).toEqual({ completed: 1, total: 2 });
    expect(map.get("c")).toEqual({ completed: 0, total: 1 });
    // A parent with no To-do children is omitted, so a missing key reads null.
    expect(map.has("b")).toBe(false);
  });

  it("matches directTodoProgress for every parent", () => {
    const nodes = [
      node("a-done", "a", "todo", true),
      node("a-open", "a", "todo"),
      node("b-plain", "b", "bullet")
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));
    const childIdsByParent = { a: ["a-done", "a-open"], b: ["b-plain"] };
    const map = buildTodoProgressMap(nodesById, childIdsByParent);
    for (const parentId of Object.keys(childIdsByParent)) {
      expect(map.get(parentId) ?? null).toEqual(
        directTodoProgress(parentId, nodesById, childIdsByParent)
      );
    }
  });

  it("reflects a completion toggle when rebuilt (cache invalidation)", () => {
    const open = node("child", "parent", "todo");
    const childIdsByParent = { parent: ["child"] };
    const before = buildTodoProgressMap({ child: open }, childIdsByParent);
    expect(before.get("parent")).toEqual({ completed: 0, total: 1 });

    // A new nodesById reference (immutable toggle) is what invalidates the
    // render-loop useMemo; rebuilding must surface the updated completed count.
    const done = { ...open, completedAt: "2026-07-23T00:00:00Z" };
    const after = buildTodoProgressMap({ child: done }, childIdsByParent);
    expect(after.get("parent")).toEqual({ completed: 1, total: 1 });
  });
});
