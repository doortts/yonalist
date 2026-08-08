import { OutlineMetadataTimeline } from "./metadata";
import { OutlineRowActionTracker } from "./rowActions";

function line(
  nodeId: string,
  kind: "text" | "note" | "image",
  depth = 0
): {
  readonly nodeId: string;
  readonly parentId: string;
  readonly depth: number;
  readonly kind: "text" | "note" | "image";
  readonly collapsed: boolean;
  readonly completed: boolean;
} {
  return {
    nodeId,
    parentId: "page",
    depth,
    kind,
    collapsed: false,
    completed: false
  };
}

/** title, its two note lines, a picture caption. */
const metadata = OutlineMetadataTimeline.hydrate(1, [
  line("bullet-1", "text"),
  line("bullet-1", "note"),
  line("bullet-1", "note"),
  line("image-1", "image")
]);

function harness() {
  const handlers: {
    mouseMove?: (event: unknown) => void;
    mouseLeave?: () => void;
    cursor?: () => void;
    scroll?: () => void;
    focus?: () => void;
    blur?: () => void;
  } = {};
  const disposed: string[] = [];
  const state = { focused: false, scrollTop: 0, lineNumber: 1 };
  const editor = {
    onMouseMove: (listener: (event: unknown) => void) => {
      handlers.mouseMove = listener;
      return { dispose: () => disposed.push("mouseMove") };
    },
    onMouseLeave: (listener: () => void) => {
      handlers.mouseLeave = listener;
      return { dispose: () => disposed.push("mouseLeave") };
    },
    onDidChangeCursorPosition: (listener: () => void) => {
      handlers.cursor = listener;
      return { dispose: () => disposed.push("cursor") };
    },
    onDidScrollChange: (listener: () => void) => {
      handlers.scroll = listener;
      return { dispose: () => disposed.push("scroll") };
    },
    onDidFocusEditorText: (listener: () => void) => {
      handlers.focus = listener;
      return { dispose: () => disposed.push("focus") };
    },
    onDidBlurEditorText: (listener: () => void) => {
      handlers.blur = listener;
      return { dispose: () => disposed.push("blur") };
    },
    hasTextFocus: () => state.focused,
    getPosition: () => ({ lineNumber: state.lineNumber, column: 1 }),
    getScrollTop: () => state.scrollTop,
    getTopForLineNumber: (lineNumber: number) => (lineNumber - 1) * 25,
    getModel: () => ({
      getLineContent: (lineNumber: number) =>
        ["First thought", "alpha", "beta", "cat.png"][lineNumber - 1] ?? ""
    })
  };
  const tracker = new OutlineRowActionTracker({
    editor: editor as unknown as ConstructorParameters<
      typeof OutlineRowActionTracker
    >[0]["editor"],
    metadata: () => metadata.current()
  });
  const changes: (ReturnType<typeof tracker.current>)[] = [];
  tracker.subscribe(() => changes.push(tracker.current()));
  return { handlers, disposed, state, tracker, changes };
}

function hover(
  handlers: { mouseMove?: (event: unknown) => void },
  lineNumber: number | null
): void {
  handlers.mouseMove?.({
    target: { position: lineNumber === null ? null : { lineNumber, column: 1 } }
  });
}

describe("OutlineRowActionTracker", () => {
  it("follows the hovered line and reads the row's own title", () => {
    const { handlers, tracker } = harness();

    hover(handlers, 1);

    expect(tracker.current()).toEqual({
      nodeId: "bullet-1",
      lineNumber: 1,
      title: "First thought",
      top: 0
    });
  });

  it("offers an image caption a trigger but never a note line", () => {
    const { handlers, tracker } = harness();

    hover(handlers, 4);
    expect(tracker.current()).toEqual(expect.objectContaining({
      nodeId: "image-1",
      lineNumber: 4
    }));

    // A note copies its title's node id, so it is no row of its own (§1).
    hover(handlers, 2);
    expect(tracker.current()).toBeNull();
  });

  it("drops the trigger when the pointer leaves the editor", () => {
    const { handlers, tracker, changes } = harness();

    hover(handlers, 1);
    handlers.mouseLeave?.();

    expect(tracker.current()).toBeNull();
    expect(changes).toHaveLength(2);
  });

  it("keeps the trigger on the caret line while the editor has focus", () => {
    const { handlers, state, tracker } = harness();
    state.focused = true;
    state.lineNumber = 4;

    handlers.focus?.();
    expect(tracker.current()).toEqual(expect.objectContaining({
      nodeId: "image-1",
      lineNumber: 4
    }));

    // The pointer wins over the caret, the way a hovered React row does.
    hover(handlers, 1);
    expect(tracker.current()?.nodeId).toBe("bullet-1");

    state.focused = false;
    hover(handlers, null);
    handlers.blur?.();
    expect(tracker.current()).toBeNull();
  });

  it("takes the scroll offset off the line's top", () => {
    const { handlers, state, tracker, changes } = harness();
    hover(handlers, 4);
    expect(tracker.current()?.top).toBe(75);

    state.scrollTop = 50;
    handlers.scroll?.();

    expect(tracker.current()?.top).toBe(25);
    // Nothing else moved, so the target is one notification per real change.
    expect(changes).toHaveLength(2);
  });

  it("lets go of every editor subscription on dispose", () => {
    const { tracker, disposed } = harness();

    tracker.dispose();

    expect(disposed).toEqual([
      "mouseMove",
      "mouseLeave",
      "cursor",
      "scroll",
      "focus",
      "blur"
    ]);
  });
});
