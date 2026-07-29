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

describe("v2 direct-child Todo progress", () => {
  it("counts only direct Todo children in one query-model pass", () => {
    const progress = buildTodoProgressMap([
      node("done", "parent", "todo", true),
      node("open", "parent", "todo"),
      node("ordinary", "parent", "bullet", true),
      node("grandchild", "open", "todo", true)
    ]);

    expect(progress.get("parent")).toEqual({ completed: 1, total: 2 });
    expect(progress.get("open")).toEqual({ completed: 1, total: 1 });
    expect(progress.has("ordinary")).toBe(false);
  });
});
