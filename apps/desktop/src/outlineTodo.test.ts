import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { buildTodoProgressMap } from "./outlineTodo";

function node(
  id: string,
  parentId: string,
  marker: "bullet" | "todo",
  completed = false
): NoteView {
  return {
    id,
    parentId,
    sortKey: 1_024,
    kind: "bullet", image: null,
    text: id,
    note: "",
    marker,
    collapsed: false,
    completed,
    starred: false,
    deleted: false
  };
}

describe("v2 Todo branch progress", () => {
  it("counts the whole Todo chain under a bullet", () => {
    const progress = buildTodoProgressMap([
      node("parent", "page", "bullet"),
      node("done", "parent", "todo", true),
      node("open", "parent", "todo"),
      node("ordinary", "parent", "bullet", true),
      node("grandchild", "open", "todo", true)
    ]);

    expect(progress.get("parent")).toEqual({ completed: 2, total: 3 });
    expect(progress.has("ordinary")).toBe(false);
  });

  it("draws no bar on a Todo nested under another Todo", () => {
    const progress = buildTodoProgressMap([
      node("top", "page", "todo"),
      node("middle", "top", "todo"),
      node("leaf", "middle", "todo", true)
    ]);

    expect(progress.get("top")).toEqual({ completed: 1, total: 2 });
    expect(progress.has("middle")).toBe(false);
  });

  it("stops counting at an ordinary bullet in the chain", () => {
    const progress = buildTodoProgressMap([
      node("parent", "page", "bullet"),
      node("open", "parent", "todo"),
      node("divider", "open", "bullet"),
      node("beyond", "divider", "todo", true)
    ]);

    expect(progress.get("parent")).toEqual({ completed: 0, total: 1 });
    expect(progress.get("divider")).toEqual({ completed: 1, total: 1 });
  });

  it("skips deleted Todos", () => {
    const progress = buildTodoProgressMap([
      node("parent", "page", "bullet"),
      { ...node("gone", "parent", "todo"), deleted: true },
      node("open", "parent", "todo")
    ]);

    expect(progress.get("parent")).toEqual({ completed: 0, total: 1 });
  });
});
