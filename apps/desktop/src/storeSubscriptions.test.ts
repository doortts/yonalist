import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  initialNotesState,
  type NotesState
} from "./notesState";
import { StoreSubscriptions } from "./storeSubscriptions";

function notesStateWithNodes(count: number): NotesState {
  const nodes: NoteView[] = Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`,
    parentId: "page-1",
    sortKey: (index + 1) * 1_024,
    kind: "bullet",
    text: `Node ${index}`,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  }));
  return {
    ...initialNotesState,
    status: "ready",
    sessionId: "session-1",
    revision: 1,
    activePageId: "page-1",
    pages: [{ id: "page-1", title: "Page" }],
    nodes
  };
}

describe("StoreSubscriptions", () => {
  it("publishes an 800-node draft only to its owning row", () => {
    let state = notesStateWithNodes(800);
    const subscriptions = new StoreSubscriptions(() => state);
    const shellBefore = subscriptions.getShellSnapshot();
    const outlineBefore = subscriptions.getOutlineSnapshot();
    const changed = vi.fn();
    const adjacent = vi.fn();
    const shell = vi.fn();
    const outline = vi.fn();
    subscriptions.subscribeNode("node-400", changed);
    subscriptions.subscribeNode("node-399", adjacent);
    subscriptions.subscribeShell(shell);
    subscriptions.subscribeOutline(outline);

    state = {
      ...state,
      drafts: { ...state.drafts, "node-400": "edited" }
    };
    subscriptions.publish({ nodeIds: ["node-400"] });

    expect(subscriptions.getShellSnapshot()).toBe(shellBefore);
    expect(subscriptions.getOutlineSnapshot()).toBe(outlineBefore);
    expect(subscriptions.getNodeSnapshot("node-400")?.title).toBe("edited");
    expect(changed).toHaveBeenCalledOnce();
    expect(adjacent).not.toHaveBeenCalled();
    expect(shell).not.toHaveBeenCalled();
    expect(outline).not.toHaveBeenCalled();
  });

  it("replaces only explicitly invalidated cached projections", () => {
    let state = notesStateWithNodes(2);
    const subscriptions = new StoreSubscriptions(() => state);
    const shellBefore = subscriptions.getShellSnapshot();
    const outlineBefore = subscriptions.getOutlineSnapshot();

    state = {
      ...state,
      revision: 2,
      pendingWrites: 1
    };
    subscriptions.publish({ shell: true });

    expect(subscriptions.getShellSnapshot()).not.toBe(shellBefore);
    expect(subscriptions.getShellSnapshot().revision).toBe(2);
    expect(subscriptions.getOutlineSnapshot()).toBe(outlineBefore);

    subscriptions.publish({ outline: true });

    expect(subscriptions.getOutlineSnapshot()).not.toBe(outlineBefore);
    expect(subscriptions.getOutlineSnapshot().revision).toBe(2);
  });

  it("projects page titles when a bounded viewport omits the page node", () => {
    const state: NotesState = {
      ...notesStateWithNodes(0),
      drafts: { "page-1": "Renamed page" }
    };
    const subscriptions = new StoreSubscriptions(() => state);

    expect(subscriptions.getNodeSnapshot("page-1")).toMatchObject({
      node: null,
      title: "Renamed page",
      titleDraft: "Renamed page"
    });
  });

  it("deduplicates ids for multi-node subscriptions and epochs", () => {
    let state = notesStateWithNodes(2);
    const subscriptions = new StoreSubscriptions(() => state);
    const listener = vi.fn();
    subscriptions.subscribeNodes(["node-0", "node-0", "node-1"], listener);

    state = {
      ...state,
      drafts: { "node-0": "First", "node-1": "Second" }
    };
    subscriptions.publish({ nodeIds: ["node-0", "node-0", "node-1"] });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(
      subscriptions.getNodeEpoch(["node-0", "node-0", "node-1"])
    ).toBe("node-0:1|node-1:1");
  });
});
