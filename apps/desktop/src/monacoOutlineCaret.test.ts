import {
  buildMonacoOutlineDecorations,
  isMonacoCaretOnTextSide,
  scheduleMonacoOutlineCaretNormalization
} from "./monacoOutlineCaret";
import type { MonacoOutlineProjection } from "./monacoOutlineProjection";

describe("Monaco outline caret normalization", () => {
  it("places the caret on the text side of an injected bullet on an empty line", () => {
    const projection: MonacoOutlineProjection = {
      lines: [{
        nodeId: "empty",
        text: "",
        depth: 0,
        editable: true
      }],
      value: "",
      lineByNodeId: new Map([["empty", 1]]),
      nodeIdByLine: ["empty"]
    };

    const [decoration] = buildMonacoOutlineDecorations(projection);

    expect(decoration.options.before).toMatchObject({
      content: "\u2022\u00a0\u00a0",
      cursorStops: 1
    });
  });

  it("recognizes only a caret rendered at the matching bullet's text edge", () => {
    const host = document.createElement("div");
    const prefix = document.createElement("span");
    const cursor = document.createElement("span");
    prefix.className = "notes-monaco-bullet-prefix";
    cursor.className = "cursor";
    host.append(prefix, cursor);
    vi.spyOn(prefix, "getBoundingClientRect").mockReturnValue(
      rect({ height: 21, left: 10, right: 30, top: 43 })
    );
    const cursorRect = vi.spyOn(cursor, "getBoundingClientRect");

    cursorRect.mockReturnValue(
      rect({ height: 28, left: 10, right: 12, top: 40 })
    );
    expect(isMonacoCaretOnTextSide(host)).toBe(false);

    cursorRect.mockReturnValue(
      rect({ height: 28, left: 28, right: 30, top: 40 })
    );
    expect(isMonacoCaretOnTextSide(host)).toBe(true);
  });

  it("hides a restored caret until it reaches the injected bullet's right side", () => {
    let runFrame: FrameRequestCallback | undefined;
    const hideCaret = vi.fn();
    const showCaret = vi.fn();
    let onTextSide = false;
    const trigger = vi.fn(() => {
      onTextSide = true;
    });
    const editor = {
      getPosition: () => ({ lineNumber: 4, column: 1 }),
      trigger
    };
    const normalization = {
      editor,
      position: { lineNumber: 4, column: 1 },
      isCurrent: () => true,
      isCaretOnTextSide: () => onTextSide,
      hideCaret,
      showCaret,
      requestFrame: (callback: FrameRequestCallback) => {
        runFrame = callback;
        return 1;
      }
    };

    scheduleMonacoOutlineCaretNormalization(normalization);

    expect(hideCaret).toHaveBeenCalledOnce();
    expect(trigger).not.toHaveBeenCalled();
    expect(showCaret).not.toHaveBeenCalled();

    runFrame?.(16);

    expect(trigger).toHaveBeenCalledWith(
      "yonalist-outline",
      "cursorRight",
      undefined
    );
    expect(showCaret).toHaveBeenCalledOnce();
  });

  it("shows but does not move a caret that changed before normalization", () => {
    let runFrame: FrameRequestCallback | undefined;
    const hideCaret = vi.fn();
    const showCaret = vi.fn();
    const trigger = vi.fn();
    const editor = {
      getPosition: () => ({ lineNumber: 5, column: 1 }),
      trigger
    };
    const normalization = {
      editor,
      position: { lineNumber: 4, column: 1 },
      isCurrent: () => true,
      isCaretOnTextSide: () => false,
      hideCaret,
      showCaret,
      requestFrame: (callback: FrameRequestCallback) => {
        runFrame = callback;
        return 1;
      }
    };

    scheduleMonacoOutlineCaretNormalization(normalization);
    runFrame?.(16);

    expect(trigger).not.toHaveBeenCalled();
    expect(hideCaret).toHaveBeenCalledOnce();
    expect(showCaret).toHaveBeenCalledOnce();
  });

  it("does not reveal a stale normalization over a newer caret", () => {
    let runFrame: FrameRequestCallback | undefined;
    const hideCaret = vi.fn();
    const showCaret = vi.fn();
    const normalization = {
      editor: {
        getPosition: () => ({ lineNumber: 4, column: 1 }),
        trigger: vi.fn()
      },
      position: { lineNumber: 4, column: 1 },
      isCurrent: () => false,
      isCaretOnTextSide: () => false,
      hideCaret,
      showCaret,
      requestFrame: (callback: FrameRequestCallback) => {
        runFrame = callback;
        return 1;
      }
    };

    scheduleMonacoOutlineCaretNormalization(normalization);
    runFrame?.(16);

    expect(hideCaret).toHaveBeenCalledOnce();
    expect(showCaret).not.toHaveBeenCalled();
  });

  it("reveals the caret when Monaco rejects the movement command", () => {
    let runFrame: FrameRequestCallback | undefined;
    const showCaret = vi.fn();
    const normalization = {
      editor: {
        getPosition: () => ({ lineNumber: 4, column: 1 }),
        trigger: () => {
          throw new Error("movement failed");
        }
      },
      position: { lineNumber: 4, column: 1 },
      isCurrent: () => true,
      isCaretOnTextSide: () => false,
      hideCaret: vi.fn(),
      showCaret,
      requestFrame: (callback: FrameRequestCallback) => {
        runFrame = callback;
        return 1;
      }
    };

    scheduleMonacoOutlineCaretNormalization(normalization);

    expect(() => runFrame?.(16)).not.toThrow();
    expect(showCaret).toHaveBeenCalledOnce();
  });

  it("retries while Monaco still paints the caret left of the bullet", () => {
    const frames: FrameRequestCallback[] = [];
    const showCaret = vi.fn();
    let attempts = 0;
    const normalization = {
      editor: {
        getPosition: () => ({ lineNumber: 4, column: 1 }),
        trigger: () => {
          attempts += 1;
        }
      },
      position: { lineNumber: 4, column: 1 },
      isCurrent: () => true,
      isCaretOnTextSide: () => attempts === 2,
      hideCaret: vi.fn(),
      showCaret,
      requestFrame: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }
    };

    scheduleMonacoOutlineCaretNormalization(normalization);
    frames[0]?.(16);

    expect(attempts).toBe(1);
    expect(showCaret).not.toHaveBeenCalled();

    frames[1]?.(32);

    expect(attempts).toBe(2);
    expect(showCaret).toHaveBeenCalledOnce();
  });

  it("uses the supplied strategy to preserve column one while changing affinity", () => {
    let runFrame: FrameRequestCallback | undefined;
    let onTextSide = false;
    const trigger = vi.fn();
    const moveCaretToTextSide = vi.fn(() => {
      onTextSide = true;
    });
    const normalization = {
      editor: {
        getPosition: () => ({ lineNumber: 1, column: 1 }),
        trigger
      },
      position: { lineNumber: 1, column: 1 },
      isCurrent: () => true,
      isCaretOnTextSide: () => onTextSide,
      hideCaret: vi.fn(),
      showCaret: vi.fn(),
      moveCaretToTextSide,
      requestFrame: (callback: FrameRequestCallback) => {
        runFrame = callback;
        return 1;
      }
    };

    scheduleMonacoOutlineCaretNormalization(normalization);
    runFrame?.(16);

    expect(moveCaretToTextSide).toHaveBeenCalledOnce();
    expect(trigger).not.toHaveBeenCalled();
  });
});

function rect({
  height = 28,
  left,
  right,
  top
}: {
  readonly height?: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right,
    top,
    width: right - left,
    x: left,
    y: top,
    toJSON: () => ({})
  };
}
