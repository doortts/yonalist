import { describe, expect, it } from "vitest";
import type { NoteNode } from "../../domain/notes";
import { directTodoProgress } from "./notesTodoProgress";

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
