import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import type { NotesState } from "../notesState";
import { initialNotesState } from "../notesState";
import { receiptState, viewportState } from "./storeState";
import { JOURNALS_ID, ROOT_ID } from "./storeSupport";

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

describe("receipt state", () => {
  it("attaches changed descendants even when lexical receipt order puts children first", () => {
    const result = receiptState({
      ...initialNotesState,
      status: "ready",
      sessionId: "session",
      activePageId: "page"
    }, {
      revision: 2,
      changedNodes: [
        bullet("a-child", "z-parent"),
        bullet("z-parent", "page")
      ],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });

    expect(result.patch.nodes?.map((node) => node.id))
      .toEqual(["z-parent", "a-child"]);
  });

  it("lets go of a row a receipt moved onto another page", () => {
    const result = receiptState({
      ...initialNotesState,
      status: "ready",
      sessionId: "session",
      activePageId: "page",
      pages: [
        { id: "page", title: "Page", sortKey: 1_024 },
        { id: "other-page", title: "Other", sortKey: 2_048 }
      ],
      nodes: [
        bullet("kept", "page"),
        bullet("leaving", "page"),
        bullet("under-leaving", "leaving")
      ]
    }, {
      revision: 2,
      // What an undone carry-over sends back, and what Move To... sends: the
      // row is alive, on a page this one is not showing.
      changedNodes: [bullet("leaving", "other-page")],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });

    // The row under it went where it went, whether or not the receipt named it.
    expect(result.patch.nodes?.map((node) => node.id)).toEqual(["kept"]);
  });

  it("keeps the page's rows when the receipt carries the page's own node", () => {
    const result = receiptState({
      ...initialNotesState,
      status: "ready",
      sessionId: "session",
      activePageId: "page",
      pages: [{ id: "page", title: "Page", sortKey: 1_024 }],
      nodes: [bullet("row", "page")]
    }, {
      revision: 2,
      // A page node lives under the root, which is not the page it is: it is
      // not a row that left, and its rows did not leave with it.
      changedNodes: [bullet("page", ROOT_ID)],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });

    expect(result.patch.nodes?.map((node) => node.id)).toEqual(["row"]);
  });

  it("classifies text receipts as node-only invalidations", () => {
    const original = bullet("one", "page");
    const result = receiptState({
      ...initialNotesState,
      status: "ready",
      sessionId: "session",
      activePageId: "page",
      nodes: [original]
    }, {
      revision: 2,
      changedNodes: [{ ...original, text: "Renamed" }],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });

    expect(result.changedNodeIds).toEqual(["one"]);
    expect(result.outlineChanged).toBe(false);
  });

  it("classifies hierarchy receipts as outline invalidations", () => {
    const original = bullet("one", "page");
    const result = receiptState({
      ...initialNotesState,
      status: "ready",
      sessionId: "session",
      activePageId: "page",
      nodes: [original]
    }, {
      revision: 2,
      changedNodes: [{ ...original, parentId: "two", sortKey: 2_048 }],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });

    expect(result.changedNodeIds).toEqual(["one"]);
    expect(result.outlineChanged).toBe(true);
  });

  it("drops drafts the receipt made stale and keeps unflushed typing", () => {
    const one = { ...bullet("one", "page"), text: "one", note: "note one" };
    const two = { ...bullet("two", "page"), text: "two", note: "note two" };
    const three = { ...bullet("three", "page"), text: "three", note: "" };
    const result = receiptState({
      ...initialNotesState,
      status: "ready",
      sessionId: "session",
      activePageId: "page",
      nodes: [one, two, three],
      drafts: { one: "one", two: "renamed", three: "still typing" },
      noteDrafts: { one: "note one", two: "renote", three: "still typing" }
    }, {
      revision: 2,
      changedNodes: [
        // Undo puts a text back that neither draft knows about.
        { ...one, text: "older", note: "older note" },
        // The commit that matches the draft the user already stopped touching.
        { ...two, text: "renamed", note: "renote" }
      ],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });

    expect(result.patch.drafts).toEqual({ three: "still typing" });
    expect(result.patch.noteDrafts).toEqual({ three: "still typing" });
  });

  it("keeps a draft the user typed past the text the receipt carries", () => {
    const one = { ...bullet("one", "page"), text: "one" };
    const result = receiptState({
      ...initialNotesState,
      status: "ready",
      sessionId: "session",
      activePageId: "page",
      nodes: [one],
      drafts: { one: "one and more" }
    }, {
      revision: 2,
      changedNodes: [{ ...one, text: "older" }],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });

    expect(result.patch.drafts).toEqual({ one: "one and more" });
  });
});

describe("the page list follows the root's live children", () => {
  function ready(pages: NotesState["pages"]): NotesState {
    return {
      ...initialNotesState,
      status: "ready",
      sessionId: "session",
      activePageId: "page",
      pages
    };
  }

  function receipt(changedNodes: NoteView[]): MutationReceipt {
    return {
      revision: 2,
      changedNodes,
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    };
  }

  it("adds a bullet outdented onto the root", () => {
    const result = receiptState(
      ready([{ id: "page-1", title: "Today", sortKey: 1_024 }]),
      receipt([{ ...bullet("promoted", ROOT_ID), text: "Promoted", sortKey: 2_048 }])
    );

    expect(result.patch.pages).toEqual([
      { id: "page-1", title: "Today", sortKey: 1_024 },
      { id: "promoted", title: "Promoted", sortKey: 2_048 }
    ]);
  });

  it("drops a page indented under another node", () => {
    const result = receiptState(
      ready([
        { id: "page-1", title: "Today", sortKey: 1_024 },
        { id: "page-2", title: "Later", sortKey: 2_048 }
      ]),
      receipt([bullet("page-2", "page-1")])
    );

    expect(result.patch.pages?.map((page) => page.id)).toEqual(["page-1"]);
  });

  it("reorders the list when a receipt moves a page's sort key", () => {
    const result = receiptState(
      ready([
        { id: "page-1", title: "Today", sortKey: 1_024 },
        { id: "page-2", title: "Later", sortKey: 2_048 }
      ]),
      receipt([{ ...bullet("page-2", ROOT_ID), text: "Later", sortKey: 512 }])
    );

    expect(result.patch.pages?.map((page) => page.id)).toEqual([
      "page-2",
      "page-1"
    ]);
  });

  it("brings a trashed page back when undo restores it", () => {
    const state = ready([{ id: "page-1", title: "Today", sortKey: 1_024 }]);
    const trashed = receiptState(state, receipt([
      { ...bullet("page-1", ROOT_ID), text: "Today", deleted: true }
    ]));
    expect(trashed.patch.pages).toEqual([]);

    const restored = receiptState(
      { ...state, ...trashed.patch },
      receipt([{ ...bullet("page-1", ROOT_ID), text: "Today" }])
    );

    expect(restored.patch.pages).toEqual([
      { id: "page-1", title: "Today", sortKey: 1_024 }
    ]);
  });

  it("adds a journal day, which is a page under the Journals node", () => {
    const result = receiptState(
      ready([{ id: "page-1", title: "Today", sortKey: 1_024 }]),
      receipt([
        { ...bullet("day", JOURNALS_ID), text: "2026-08-21", sortKey: 2_048 }
      ])
    );

    // The storage layer answers the same, which is what `findJournalPage`, the
    // calendar and the feed all read: `queries.rs::pages`.
    expect(result.patch.pages).toEqual([
      { id: "page-1", title: "Today", sortKey: 1_024 },
      { id: "day", title: "2026-08-21", sortKey: 2_048 }
    ]);
  });

  it("keeps a day in the list when a later receipt touches it", () => {
    const result = receiptState(
      ready([{ id: "day", title: "2026-08-21", sortKey: 2_048 }]),
      receipt([{ ...bullet("day", JOURNALS_ID), text: "2026-08-21", starred: true }])
    );

    expect(result.patch.pages?.map((page) => page.id)).toEqual(["day"]);
  });

  it("keeps the root row out of both the outline and the page list", () => {
    const root: NoteView = {
      ...bullet(ROOT_ID, "unused"),
      parentId: null,
      kind: "page",
      text: "Home",
      sortKey: 0
    };
    const result = receiptState(
      ready([]),
      receipt([root, bullet("child", ROOT_ID)])
    );

    expect(result.patch.pages?.map((page) => page.id)).toEqual(["child"]);
    expect(result.patch.nodes?.map((node) => node.id)).not.toContain(ROOT_ID);
  });
});

describe("the page's own node rides beside the body rows", () => {
  const pageNode: NoteView = {
    ...bullet("page", ROOT_ID),
    text: "Today",
    note: "Page context"
  };

  function viewport(page: NoteView | undefined) {
    return {
      pageId: "page",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      pageNode: page,
      nodes: [bullet("one", "page")]
    };
  }

  it("takes the page node on a fresh load and drops it when one is absent", () => {
    const loaded = viewportState(initialNotesState, viewport(pageNode), false);
    expect(loaded.pageNode).toEqual(pageNode);

    const reloaded = viewportState(
      { ...initialNotesState, pageNode },
      viewport(undefined),
      false
    );
    expect(reloaded.pageNode).toBeNull();
  });

  it("keeps the page node across an appended viewport", () => {
    const appended = viewportState(
      { ...initialNotesState, pageNode },
      viewport(undefined),
      true
    );

    expect(appended.pageNode).toEqual(pageNode);
  });

  it("follows the active page's node through a receipt", () => {
    const state: NotesState = {
      ...initialNotesState,
      status: "ready",
      activePageId: "page",
      pageNode
    };
    const changed = { ...pageNode, note: "Rewritten" };

    expect(receiptState(state, {
      revision: 2,
      changedNodes: [changed],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    }).patch.pageNode).toEqual(changed);
    // The page node never joins the body rows: the outline guards read that
    // absence.
    expect(receiptState(state, {
      revision: 2,
      changedNodes: [changed],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    }).patch.nodes?.map((node) => node.id)).not.toContain("page");

    expect(receiptState(state, {
      revision: 2,
      changedNodes: [],
      deletedIds: ["page"],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    }).patch.pageNode).toBeNull();
  });
});
