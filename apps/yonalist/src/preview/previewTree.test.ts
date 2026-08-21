import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import {
  completionCycle,
  completionWrite,
  reopenOverPlacedRows,
  settleOverDepartedRows
} from "./previewTree";
import { ROOT_ID } from "../store/storeSupport";

function bullet(id: string, parentId: string): NoteView {
  return {
    id,
    parentId,
    sortKey: 1_024,
    kind: "bullet", image: null,
    text: id,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

function todo(id: string, parentId: string, completed = false): NoteView {
  return { ...bullet(id, parentId), marker: "todo", completed };
}

function home(): NoteView {
  return { ...bullet(ROOT_ID, ""), kind: "page", parentId: null };
}

describe("one completion write", () => {
  // `page` is a page row -- Home's own child, drawn as a page rather than as a
  // row of one -- so the rows a press settles start below it.
  const branch = [
    home(),
    bullet("page", ROOT_ID),
    todo("top", "page"),
    todo("first", "top"),
    todo("second", "top"),
    bullet("divider", "top"),
    todo("beyond", "divider")
  ];

  it("writes the row it names and nothing under it", () => {
    expect(completionWrite(branch, "top", true)).toEqual(["top"]);
  });

  it("leaves the parent open while a sibling is still open", () => {
    expect(completionWrite(branch, "first", true)).toEqual(["first"]);
  });

  it("ticks the parent once its own children are done", () => {
    const nearlyDone = branch.map((node) =>
      ["second", "divider"].includes(node.id)
        ? { ...node, completed: true }
        : node);

    // `beyond` is open, but `divider` says it is done and stands for its own
    // branch, so `top` follows its children.
    expect(new Set(completionWrite(nearlyDone, "first", true)))
      .toEqual(new Set(["first", "top"]));
  });

  it("stops the climb below the page row", () => {
    const nothingLeft = branch.map((node) =>
      node.id === "top" || node.kind === "page"
        ? node
        : { ...node, completed: true });

    expect(completionWrite(nothingLeft, "top", true)).toEqual(["top"]);
  });

  it("clears every finished row above the one reopened", () => {
    const allDone = branch.map((node) => ({ ...node, completed: true }));

    expect(new Set(completionWrite(allDone, "first", false)))
      .toEqual(new Set(["first", "top"]));
  });

  it("clears an ancestor bullet when a row under it is reopened", () => {
    const allDone = branch.map((node) =>
      node.kind === "page" ? node : { ...node, completed: true });

    expect(new Set(completionWrite(allDone, "beyond", false)))
      .toEqual(new Set(["beyond", "divider", "top"]));
  });

  it("drops rows already holding the state they would be given", () => {
    const done = branch.map((node) =>
      node.id === "first" ? { ...node, completed: true } : node);

    expect(completionWrite(done, "first", true)).toEqual([]);
  });
});

describe("the completion cycle", () => {
  const branch = () => [
    home(),
    bullet("page", ROOT_ID),
    bullet("parent", "page"),
    todo("done", "parent", true),
    todo("open", "parent"),
    bullet("bare", "parent")
  ];

  it("finishes only the row on the first press", () => {
    const cycle = completionCycle(branch(), "parent", []);

    expect(cycle.stage).toBe("row");
    expect(cycle.writes).toEqual([["parent", true]]);
  });

  it("finishes the children that are open on the second press", () => {
    const finished = branch().map((node) =>
      node.id === "parent" ? { ...node, completed: true } : node);

    const cycle = completionCycle(finished, "parent", []);

    expect(cycle.stage).toBe("children");
    // `done` is already done, so the press has nothing to say about it.
    expect(new Set(cycle.writes.map(([id]) => id))).toEqual(new Set(["open", "bare"]));
  });

  it("hands the children back what they held on the third press", () => {
    const allDone = branch().map((node) =>
      node.kind === "page" || node.id === ROOT_ID ? node : { ...node, completed: true });

    const cycle = completionCycle(allDone, "parent", [["open", false], ["bare", false], ["done", true]]);

    expect(cycle.stage).toBe("back");
    expect(new Set(cycle.writes)).toEqual(new Set([
      ["open", false], ["bare", false], ["parent", false]
    ]));
  });

  it("opens the row alone when nothing is remembered", () => {
    const allDone = branch().map((node) =>
      node.kind === "page" || node.id === ROOT_ID ? node : { ...node, completed: true });

    const cycle = completionCycle(allDone, "parent", []);

    expect(cycle.stage).toBe("back");
    expect(cycle.writes).toEqual([["parent", false]]);
  });

  it("turns a childless row over in two presses", () => {
    const rows = branch();
    const first = completionCycle(rows, "bare", []);
    expect(first.writes).toEqual([["bare", true]]);

    const finished = rows.map((node) =>
      node.id === "bare" ? { ...node, completed: true } : node);
    const second = completionCycle(finished, "bare", []);
    expect(second.stage).toBe("back");
    expect(second.writes).toEqual([["bare", false]]);
  });
});

describe("reopening over a placed row", () => {
  const finished = [
    home(),
    bullet("page", ROOT_ID),
    { ...bullet("parent", "page"), completed: true },
    { ...todo("child", "parent", true) }
  ];

  it("opens the rows above a row that was not there before", () => {
    const withFresh = [...finished, bullet("fresh", "parent")];

    expect(reopenOverPlacedRows(finished, withFresh)).toEqual(["parent"]);
  });

  it("waits for a blank row until something is written in it", () => {
    const blank = { ...bullet("blank", "parent"), text: "" };
    const withBlank = [...finished, blank];

    expect(reopenOverPlacedRows(finished, withBlank)).toEqual([]);

    const written = withBlank.map((node) =>
      node.id === "blank" ? { ...node, text: "something" } : node);

    expect(reopenOverPlacedRows(withBlank, written)).toEqual(["parent"]);
  });

  it("opens the rows above a row that moved in", () => {
    const elsewhere = bullet("elsewhere", "page");
    const before = [...finished, elsewhere];
    const after = before.map((node) =>
      node.id === "elsewhere" ? { ...node, parentId: "parent" } : node);

    expect(reopenOverPlacedRows(before, after)).toEqual(["parent"]);
  });

  it("leaves the rows above a finished row alone", () => {
    const withFinished = [
      ...finished,
      { ...bullet("done-too", "parent"), completed: true }
    ];

    expect(reopenOverPlacedRows(finished, withFinished)).toEqual([]);
  });

  it("leaves a row the same command brought along with its own state", () => {
    // A pasted subtree: the finished row and its open child arrive together, so
    // the arrival is not news to the row it arrived under.
    const pasted = [
      ...finished,
      { ...bullet("pasted", "parent"), completed: true },
      bullet("pasted-child", "pasted")
    ];

    // `parent` was already there and now carries an open row, so it opens.
    // `pasted` arrived in the same command and keeps the tick it was cut with.
    expect(reopenOverPlacedRows(finished, pasted)).toEqual(["parent"]);
  });

  it("reports nothing when rows only change order", () => {
    const reordered = finished.map((node) =>
      node.id === "child" ? { ...node, sortKey: 4_096 } : node);

    expect(reopenOverPlacedRows(finished, reordered)).toEqual([]);
  });
});

describe("settling over a row that left", () => {
  const branch = [
    home(),
    bullet("page", ROOT_ID),
    bullet("parent", "page"),
    { ...todo("done", "parent", true) },
    bullet("open", "parent")
  ];

  it("finishes the row above the last open row to leave", () => {
    const trashed = branch.map((node) =>
      node.id === "open" ? { ...node, deleted: true } : node);

    expect(settleOverDepartedRows(branch, trashed)).toEqual(["parent"]);
  });

  it("leaves the row above open while another open row stays", () => {
    const withTwo = [...branch, bullet("also-open", "parent")];
    const trashed = withTwo.map((node) =>
      node.id === "open" ? { ...node, deleted: true } : node);

    expect(settleOverDepartedRows(withTwo, trashed)).toEqual([]);
  });

  it("leaves a branch with no rows left alone", () => {
    const emptied = branch.map((node) =>
      node.id === "open" || node.id === "done"
        ? { ...node, deleted: true }
        : node);

    expect(settleOverDepartedRows(branch, emptied)).toEqual([]);
  });

  it("finishes the row a moved-away row left behind", () => {
    const moved = branch.map((node) =>
      node.id === "open" ? { ...node, parentId: "page" } : node);

    expect(settleOverDepartedRows(branch, moved)).toEqual(["parent"]);
  });

  it("finishes the row above a blank row that left", () => {
    const blanked = branch.map((node) =>
      node.id === "open" ? { ...node, text: "" } : node);
    const trashed = blanked.map((node) =>
      node.id === "open" ? { ...node, deleted: true } : node);

    // Blank counts for nothing arriving and everything leaving: while it sat
    // there the branch was not finished.
    expect(settleOverDepartedRows(blanked, trashed)).toEqual(["parent"]);
  });

  it("settles nothing for a row blanked where it stands", () => {
    const blanked = branch.map((node) =>
      node.id === "open" ? { ...node, text: "" } : node);

    expect(settleOverDepartedRows(branch, blanked)).toEqual([]);
  });
});
