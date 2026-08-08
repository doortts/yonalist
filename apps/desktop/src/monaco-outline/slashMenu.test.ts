import { localDateIso } from "../outlineSlash";
import {
  OutlineMetadataTimeline, type OutlineLineMetadata
} from "./metadata";
import { OutlineSlashMenuTracker } from "./slashMenu";

function line(
  nodeId: string,
  kind: "text" | "note" | "image"
): OutlineLineMetadata {
  return {
    nodeId,
    parentId: "page",
    depth: 0,
    kind,
    marker: "bullet",
    collapsed: false,
    completed: false
  };
}

/** title, its note line, a picture caption. */
const metadata = OutlineMetadataTimeline.hydrate(1, [
  line("bullet-1", "text"),
  line("bullet-1", "note"),
  line("image-1", "image")
]);

function harness(texts: readonly string[] = ["", "", ""]) {
  const handlers: {
    cursor?: () => void;
    scroll?: () => void;
    blur?: () => void;
  } = {};
  const disposed: string[] = [];
  const lines = [...texts];
  const state = { lineNumber: 1, column: 1, scrollTop: 0 };
  const positions: { lineNumber: number; column: number }[] = [];
  const applySlashEdit = vi.fn().mockReturnValue(1);
  const focus = vi.fn();
  const editor = {
    onDidChangeCursorPosition: (listener: () => void) => {
      handlers.cursor = listener;
      return { dispose: () => disposed.push("cursor") };
    },
    onDidScrollChange: (listener: () => void) => {
      handlers.scroll = listener;
      return { dispose: () => disposed.push("scroll") };
    },
    onDidBlurEditorText: (listener: () => void) => {
      handlers.blur = listener;
      return { dispose: () => disposed.push("blur") };
    },
    getSelection: () => ({
      positionLineNumber: state.lineNumber,
      positionColumn: state.column,
      isEmpty: () => true
    }),
    getModel: () => ({
      getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? ""
    }),
    getDomNode: () => ({
      getBoundingClientRect: () => ({ top: 100, left: 10 })
    }),
    getScrolledVisiblePosition: (position: { lineNumber: number }) => ({
      top: (position.lineNumber - 1) * 25 - state.scrollTop,
      left: 40,
      height: 25
    }),
    setPosition: (position: { lineNumber: number; column: number }) =>
      positions.push(position),
    focus
  };
  const tracker = new OutlineSlashMenuTracker({
    editor: editor as unknown as ConstructorParameters<
      typeof OutlineSlashMenuTracker
    >[0]["editor"],
    metadata: () => metadata.current(),
    session: { applySlashEdit } as unknown as ConstructorParameters<
      typeof OutlineSlashMenuTracker
    >[0]["session"]
  });
  const notifications: (ReturnType<typeof tracker.current>)[] = [];
  tracker.subscribe(() => notifications.push(tracker.current()));
  /** Types `text` onto `lineNumber` and puts the caret at its end. */
  const type = (text: string, lineNumber = 1) => {
    lines[lineNumber - 1] = text;
    state.lineNumber = lineNumber;
    state.column = text.length + 1;
    handlers.cursor?.();
  };
  return {
    applySlashEdit, disposed, focus, handlers, notifications, positions, state,
    tracker, type
  };
}

describe("OutlineSlashMenuTracker", () => {
  it("opens on a slash at the start of a bullet title", () => {
    const { tracker, type } = harness();

    type("/");

    expect(tracker.current()?.nodeId).toBe("bullet-1");
    expect(tracker.current()?.commands.map((command) => command.id)).toEqual([
      "today",
      "todo"
    ]);
    expect(tracker.current()?.activeIndex).toBe(0);
  });

  it("filters the commands down and closes when none are left", () => {
    const { tracker, type } = harness();

    type("/toda");
    expect(tracker.current()?.commands.map((command) => command.id)).toEqual([
      "today"
    ]);

    type("/zz");
    expect(tracker.current()).toBeNull();
  });

  it("stays shut on a note line and on an image caption", () => {
    const { tracker, type } = harness();

    type("/", 2);
    expect(tracker.current()).toBeNull();

    type("/", 3);
    expect(tracker.current()).toBeNull();
  });

  it("stays shut when the slash is not at the start of the line", () => {
    const { tracker, type } = harness();

    type("say /");

    expect(tracker.current()).toBeNull();
  });

  it("cycles the active index with the arrows and wraps around", () => {
    const { tracker, type } = harness();
    type("/");

    expect(tracker.handleKeyDown(arrow("ArrowDown"))).toBe(true);
    expect(tracker.current()?.activeIndex).toBe(1);

    tracker.handleKeyDown(arrow("ArrowDown"));
    expect(tracker.current()?.activeIndex).toBe(0);

    tracker.handleKeyDown(arrow("ArrowUp"));
    expect(tracker.current()?.activeIndex).toBe(1);
  });

  it("keeps the highlight through a refresh that leaves the query alone", () => {
    const { handlers, state, tracker, type } = harness();
    type("/");
    tracker.handleKeyDown(arrow("ArrowDown"));

    // The caret and the viewport move under an open menu all the time; only
    // new typing may send the highlight back to the first command.
    tracker.refresh();
    state.scrollTop = 25;
    handlers.scroll?.();
    expect(tracker.current()?.activeIndex).toBe(1);

    // New typing is a new query, and that does start over at the first.
    type("/tod");
    expect(tracker.current()?.activeIndex).toBe(0);
  });

  it("leaves every key alone while the menu is shut", () => {
    const { tracker } = harness();

    expect(tracker.handleKeyDown(arrow("ArrowDown"))).toBe(false);
    expect(tracker.handleKeyDown(arrow("Enter"))).toBe(false);
    expect(tracker.handleKeyDown(arrow("Escape"))).toBe(false);
  });

  it("applies the active command on Enter and keeps the caret in the editor", () => {
    const {
      applySlashEdit, focus, positions, tracker, type
    } = harness();
    type("/toda");

    expect(tracker.handleKeyDown(arrow("Enter"))).toBe(true);

    expect(applySlashEdit).toHaveBeenCalledWith(
      "bullet-1",
      localDateIso(),
      null
    );
    expect(positions).toEqual([
      { lineNumber: 1, column: localDateIso().length + 1 }
    ]);
    expect(focus).toHaveBeenCalledOnce();
    expect(tracker.current()).toBeNull();
  });

  it("clears the slash text and sets the marker for To-do", () => {
    const { applySlashEdit, positions, tracker, type } = harness();
    type("/todo");
    tracker.handleKeyDown(arrow("ArrowDown"));

    tracker.handleKeyDown(arrow("Enter"));

    expect(applySlashEdit).toHaveBeenCalledWith("bullet-1", "", "todo");
    expect(positions).toEqual([{ lineNumber: 1, column: 1 }]);
  });

  it("lets an Enter that ends a composition through to Monaco", () => {
    const { applySlashEdit, tracker, type } = harness();
    type("/");

    expect(
      tracker.handleKeyDown({ key: "Enter", isComposing: true })
    ).toBe(false);
    expect(applySlashEdit).not.toHaveBeenCalled();
    expect(tracker.current()).not.toBeNull();
  });

  it("dismisses on Escape until the query itself changes", () => {
    const { tracker, type } = harness();
    type("/to");

    expect(tracker.handleKeyDown(arrow("Escape"))).toBe(true);
    expect(tracker.current()).toBeNull();

    // The same query must stay dismissed; only new typing brings it back.
    tracker.refresh();
    expect(tracker.current()).toBeNull();

    type("/tod");
    expect(tracker.current()).not.toBeNull();
  });

  it("closes when the editor loses its text focus", () => {
    const { handlers, tracker, type } = harness();
    type("/");

    handlers.blur?.();

    expect(tracker.current()).toBeNull();
  });

  it("anchors on the caret line and follows the editor's scroll", () => {
    const { handlers, notifications, state, tracker, type } = harness();
    type("/");

    expect(tracker.current()?.getBoundingClientRect()).toMatchObject({
      top: 100,
      left: 50,
      bottom: 125
    });

    state.scrollTop = 25;
    handlers.scroll?.();

    expect(tracker.current()?.getBoundingClientRect().top).toBe(75);
    // One notification per real move, not one per cursor event.
    expect(notifications).toHaveLength(2);
    handlers.scroll?.();
    expect(notifications).toHaveLength(2);
  });

  it("lets go of every editor subscription on dispose", () => {
    const { disposed, tracker } = harness();

    tracker.dispose();

    expect(disposed).toEqual(["cursor", "scroll", "blur"]);
  });
});

function arrow(key: string): { key: string; isComposing: boolean } {
  return { key, isComposing: false };
}
