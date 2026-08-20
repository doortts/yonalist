import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { carryOverDays, carryOverRows } from "./journalCarryOver";

function row(
  id: string,
  parentId: string,
  options: {
    readonly todo?: boolean;
    readonly completed?: boolean;
    readonly deleted?: boolean;
    readonly sortKey?: number;
  } = {}
): NoteView {
  return {
    id,
    parentId,
    sortKey: options.sortKey ?? 1_024,
    kind: "bullet", image: null,
    text: id,
    note: "",
    marker: options.todo === false ? "bullet" : "todo",
    collapsed: false,
    completed: options.completed ?? false,
    starred: false,
    deleted: options.deleted ?? false
  };
}

describe("carryOverDays", () => {
  const days = Array.from({ length: 12 }, (_, index) => ({
    id: `day-${index}`,
    date: `2026-08-${String(index + 1).padStart(2, "0")}`
  }));

  it("reads the seven days before this one, oldest first", () => {
    const read = carryOverDays(days, "2026-08-12");
    expect(read.map((day) => day.date)).toEqual([
      "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08",
      "2026-08-09", "2026-08-10", "2026-08-11"
    ]);
  });

  it("leaves out the day itself and the days after it", () => {
    expect(carryOverDays(days, "2026-08-01")).toEqual([]);
  });
});

describe("carryOverRows", () => {
  it("takes the unfinished To-dos and nothing else", () => {
    const nodes = [
      row("open", "day-1"),
      row("done", "day-1", { completed: true, sortKey: 2_048 }),
      row("plain", "day-1", { todo: false, sortKey: 3_072 }),
      row("gone", "day-1", { deleted: true, sortKey: 4_096 })
    ];

    expect(carryOverRows(nodes, ["day-1"]).map((node) => node.id))
      .toEqual(["open"]);
  });

  it("names only the top of what it moves", () => {
    const nodes = [
      row("parent", "day-1"),
      row("child", "parent"),
      // Under a finished To-do, so nothing above it is moving.
      row("under-done", "done"),
      row("done", "day-1", { completed: true, sortKey: 2_048 })
    ];

    expect(carryOverRows(nodes, ["day-1"]).map((node) => node.id))
      .toEqual(["parent", "under-done"]);
  });

  it("lands the older day's rows first, in the order they were written", () => {
    const nodes = [
      row("newer-b", "day-2", { sortKey: 2_048 }),
      row("newer-a", "day-2", { sortKey: 1_024 }),
      row("older", "day-1")
    ];

    expect(carryOverRows(nodes, ["day-1", "day-2"]).map((node) => node.id))
      .toEqual(["older", "newer-a", "newer-b"]);
  });

  it("leaves a row whose day is not being read", () => {
    const nodes = [row("elsewhere", "page-9")];

    expect(carryOverRows(nodes, ["day-1"])).toEqual([]);
  });
});
