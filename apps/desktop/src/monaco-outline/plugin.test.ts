import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import {
  OutlineMetadataTimeline,
  type OutlineLineMetadata,
  type OutlineMetadataSnapshot
} from "./metadata";
import {
  applyOutlineNoteGesture,
  resolveOutlineNoteGesture,
  runOutlineCommand,
  type OutlineNoteGesture,
  type YonalistOutlineEditorBinding
} from "./plugin";
import { MonacoOutlineSession } from "./session";

function binding(): YonalistOutlineEditorBinding {
  return {
    session: {
      canAcceptStructuralEdit: vi.fn().mockReturnValue(true),
      indent: vi.fn(),
      outdent: vi.fn(),
      toggleCompleted: vi.fn()
    } as unknown as YonalistOutlineEditorBinding["session"],
    pane: {
      activeNodeId: () => "child",
      handleBullet: vi.fn(),
      handleChevron: vi.fn()
    }
  };
}

function line(
  nodeId: string,
  kind: OutlineLineMetadata["kind"] = "text"
): OutlineLineMetadata {
  return {
    nodeId,
    parentId: "page",
    depth: 0,
    kind,
    collapsed: false,
    completed: false
  };
}

/** title "alpha", its two note lines, then a plain sibling and an image. */
function notedSnapshot(): OutlineMetadataSnapshot {
  return OutlineMetadataTimeline.hydrate(1, [
    line("first"),
    line("first", "note"),
    line("first", "note"),
    line("second"),
    line("picture", "image")
  ]).current();
}

function gesture(
  key: string,
  selection: monaco.Selection,
  overrides: Partial<{
    readonly shiftKey: boolean;
    readonly metaKey: boolean;
    readonly isComposing: boolean;
    readonly lineText: string;
    readonly snapshot: OutlineMetadataSnapshot;
  }> = {}
): OutlineNoteGesture | null {
  return resolveOutlineNoteGesture({
    event: {
      key,
      shiftKey: overrides.shiftKey ?? false,
      altKey: false,
      ctrlKey: false,
      metaKey: overrides.metaKey ?? false,
      isComposing: overrides.isComposing ?? false
    },
    snapshot: overrides.snapshot ?? notedSnapshot(),
    selection,
    lineText: overrides.lineText ?? ""
  });
}

function node(id: string, text: string, note: string, pageId: string): NoteView {
  return {
    id,
    parentId: pageId,
    sortKey: 1_024,
    kind: "bullet",
    image: null,
    text,
    note,
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

function createSession(
  pageId: string,
  nodes: readonly NoteView[]
): MonacoOutlineSession {
  const receipt: MutationReceipt = {
    revision: 2,
    changedNodes: [],
    deletedIds: [],
    history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
  };
  return MonacoOutlineSession.create({
    pageId,
    nodes,
    persistence: { executeEditorBatch: vi.fn().mockResolvedValue(receipt) },
    allocateId: () => "inserted"
  });
}

describe("Yonalist Monaco outline plugin", () => {
  it("routes Tab only through the active outline binding", () => {
    const active = binding();

    expect(runOutlineCommand("yonalist.outline.indent", active)).toBe(true);
    expect(active.session.indent).toHaveBeenCalledWith("child");
  });

  it("routes the completion shortcut to the active node", () => {
    const active = binding();

    expect(
      runOutlineCommand("yonalist.outline.toggleCompleted", active)
    ).toBe(true);
    expect(active.session.toggleCompleted).toHaveBeenCalledWith("child");
  });

  it("leaves commands native when no outline node is active", () => {
    const inactive = binding();
    inactive.pane.activeNodeId = () => null;

    expect(runOutlineCommand("yonalist.outline.outdent", inactive)).toBe(false);
    expect(inactive.session.outdent).not.toHaveBeenCalled();
  });
});

describe("outline note key routing", () => {
  it("opens or focuses the note run on Shift+Enter in a title", () => {
    expect(
      gesture("Enter", new monaco.Selection(1, 3, 1, 3), { shiftKey: true })
    ).toEqual({ kind: "openNote", nodeId: "first" });
  });

  it("leaves a note run on Shift+Enter and blocks it on an image row", () => {
    expect(
      gesture("Enter", new monaco.Selection(2, 1, 2, 1), { shiftKey: true })
    ).toEqual({ kind: "nextTitle", nodeId: "first", create: true });
    expect(
      gesture("Enter", new monaco.Selection(5, 1, 5, 1), { shiftKey: true })
    ).toEqual({ kind: "block" });
  });

  it("sends Enter on a note-owning title to the session split", () => {
    expect(gesture("Enter", new monaco.Selection(1, 4, 1, 4))).toEqual({
      kind: "splitTitle",
      nodeId: "first",
      column: 4
    });
    // A note line splits natively, and a title without a run keeps its plan.
    expect(gesture("Enter", new monaco.Selection(2, 2, 2, 2))).toBeNull();
    expect(gesture("Enter", new monaco.Selection(4, 1, 4, 1))).toBeNull();
    // A selection has no single split column.
    expect(gesture("Enter", new monaco.Selection(1, 2, 1, 4))).toEqual({
      kind: "block"
    });
  });

  it("returns to the title on Escape and on ArrowUp at the run start", () => {
    expect(gesture("Escape", new monaco.Selection(3, 2, 3, 2))).toEqual({
      kind: "titleEnd",
      nodeId: "first"
    });
    expect(gesture("ArrowUp", new monaco.Selection(2, 1, 2, 1))).toEqual({
      kind: "titleEnd",
      nodeId: "first"
    });
    // Inner movement stays native: second run line, or past column one.
    expect(gesture("ArrowUp", new monaco.Selection(3, 1, 3, 1))).toBeNull();
    expect(gesture("ArrowUp", new monaco.Selection(2, 2, 2, 2))).toBeNull();
    expect(gesture("Escape", new monaco.Selection(1, 1, 1, 1))).toBeNull();
  });

  it("leaves the run downward only from the end of its last line", () => {
    expect(
      gesture("ArrowDown", new monaco.Selection(3, 5, 3, 5), {
        lineText: "note"
      })
    ).toEqual({ kind: "nextTitle", nodeId: "first", create: false });
    expect(
      gesture("ArrowDown", new monaco.Selection(3, 3, 3, 3), {
        lineText: "note"
      })
    ).toBeNull();
    expect(
      gesture("ArrowDown", new monaco.Selection(2, 1, 2, 1), { lineText: "" })
    ).toBeNull();
  });

  it("removes an empty run on Backspace and blocks a filled one", () => {
    const single = OutlineMetadataTimeline.hydrate(1, [
      line("first"),
      line("first", "note")
    ]).current();

    expect(
      gesture("Backspace", new monaco.Selection(2, 1, 2, 1), {
        snapshot: single,
        lineText: ""
      })
    ).toEqual({ kind: "removeNote", nodeId: "first" });
    expect(
      gesture("Backspace", new monaco.Selection(2, 1, 2, 1), {
        snapshot: single,
        lineText: "note"
      })
    ).toEqual({ kind: "titleEnd", nodeId: "first" });
    expect(gesture("Backspace", new monaco.Selection(2, 1, 2, 1))).toEqual({
      kind: "titleEnd",
      nodeId: "first"
    });
  });

  it("blocks indentation inside a note and ignores IME and modifiers", () => {
    expect(gesture("Tab", new monaco.Selection(2, 1, 2, 1))).toEqual({
      kind: "block"
    });
    expect(
      gesture("Tab", new monaco.Selection(2, 1, 2, 1), { shiftKey: true })
    ).toEqual({ kind: "block" });
    expect(gesture("Tab", new monaco.Selection(1, 1, 1, 1))).toBeNull();
    expect(
      gesture("Enter", new monaco.Selection(1, 3, 1, 3), {
        shiftKey: true,
        isComposing: true
      })
    ).toBeNull();
    expect(
      gesture("Enter", new monaco.Selection(1, 3, 1, 3), { metaKey: true })
    ).toBeNull();
  });
});

describe("outline note gesture application", () => {
  function caret() {
    return { setPosition: vi.fn<(position: monaco.IPosition) => void>() };
  }

  it("creates the run once and then only moves the caret", async () => {
    const session = createSession("apply-open", [
      node("first", "alpha", "", "apply-open")
    ]);
    const target = caret();

    applyOutlineNoteGesture({ kind: "openNote", nodeId: "first" }, session, target);
    expect(session.model.getValue()).toBe("alpha\n");
    expect(target.setPosition).toHaveBeenLastCalledWith({
      lineNumber: 2,
      column: 1
    });

    applyOutlineNoteGesture({ kind: "openNote", nodeId: "first" }, session, target);
    expect(session.model.getLineCount()).toBe(2);
    expect(target.setPosition).toHaveBeenLastCalledWith({
      lineNumber: 2,
      column: 1
    });
    await session.dispose();
  });

  it("moves to the following title and creates one at the end of the page", async () => {
    const session = createSession("apply-next", [
      node("first", "alpha", "note", "apply-next"),
      node("second", "beta", "", "apply-next")
    ]);
    const target = caret();

    applyOutlineNoteGesture(
      { kind: "nextTitle", nodeId: "first", create: true },
      session,
      target
    );
    expect(target.setPosition).toHaveBeenLastCalledWith({
      lineNumber: 3,
      column: 1
    });

    const last = createSession("apply-create", [
      node("only", "alpha", "note", "apply-create")
    ]);
    applyOutlineNoteGesture(
      { kind: "nextTitle", nodeId: "only", create: true },
      last,
      target
    );
    expect(last.model.getValue()).toBe("alpha\nnote\n");
    expect(target.setPosition).toHaveBeenLastCalledWith({
      lineNumber: 3,
      column: 1
    });
    await session.dispose();
    await last.dispose();
  });

  it("puts the caret at the title end after removing an empty run", async () => {
    const session = createSession("apply-remove", [
      node("first", "alpha", "", "apply-remove")
    ]);
    const target = caret();
    session.createNote("first");

    applyOutlineNoteGesture(
      { kind: "removeNote", nodeId: "first" },
      session,
      target
    );
    expect(session.model.getValue()).toBe("alpha");
    expect(target.setPosition).toHaveBeenLastCalledWith({
      lineNumber: 1,
      column: 6
    });
    await session.dispose();
  });

  it("splits a note-owning title through the session", async () => {
    const session = createSession("apply-split", [
      node("first", "alphabeta", "note", "apply-split")
    ]);
    const target = caret();

    applyOutlineNoteGesture(
      { kind: "splitTitle", nodeId: "first", column: 6 },
      session,
      target
    );
    expect(session.model.getValue()).toBe("alpha\nnote\nbeta");
    expect(target.setPosition).toHaveBeenLastCalledWith({
      lineNumber: 3,
      column: 1
    });
    await session.dispose();
  });
});
