import type { MonacoOutlineProjection } from "./monacoOutlineProjection";
import { resolveMonacoOutlineGesture } from "./monacoOutlineKeyboard";

describe("Monaco outline keyboard gestures", () => {
  it("splits an editable line at the literal Monaco selection", () => {
    const current = projection([
      ["first", "abcd", true],
      ["second", "next", true]
    ]);

    expect(resolveMonacoOutlineGesture(input(current, {
      key: "Enter",
      lineNumber: 1,
      startColumn: 1,
      endColumn: 1
    }))).toEqual({
      kind: "split",
      nodeId: "first",
      startOffset: 0,
      endOffset: 0
    });
    expect(resolveMonacoOutlineGesture(input(current, {
      key: "Enter",
      repeat: true,
      lineNumber: 1,
      startColumn: 2,
      endColumn: 4
    }))).toEqual({
      kind: "split",
      nodeId: "first",
      startOffset: 1,
      endOffset: 3
    });
  });

  it("routes plain collapsed vertical movement through caret normalization", () => {
    const current = projection([
      ["first", "first", true],
      ["empty", "", true]
    ]);

    expect(resolveMonacoOutlineGesture(input(current, {
      key: "ArrowUp",
      lineNumber: 2
    }))).toEqual({ kind: "moveVertical", direction: "up" });
    expect(resolveMonacoOutlineGesture(input(current, {
      key: "ArrowDown"
    }))).toEqual({ kind: "moveVertical", direction: "down" });
    expect(resolveMonacoOutlineGesture(input(current, {
      key: "ArrowUp",
      shiftKey: true
    }))).toEqual({ kind: "native" });
    expect(resolveMonacoOutlineGesture(input(current, {
      key: "ArrowDown",
      endColumn: 2
    }))).toEqual({ kind: "native" });
  });

  it("leaves composition and horizontal caret movement native", () => {
    const current = projection([["first", "한글", true]]);

    expect(resolveMonacoOutlineGesture(input(current, {
      key: "Enter",
      isComposing: true
    }))).toEqual({ kind: "native" });
    expect(resolveMonacoOutlineGesture(input(current, {
      key: "ArrowLeft"
    }))).toEqual({ kind: "native" });
    expect(resolveMonacoOutlineGesture(input(current, {
      key: "Backspace",
      startColumn: 2,
      endColumn: 2
    }))).toEqual({ kind: "native" });
  });

  it("merges nonempty line starts and removes empty lines", () => {
    const current = projection([
      ["first", "first", true],
      ["second", "second", true],
      ["empty", "", true]
    ]);

    expect(resolveMonacoOutlineGesture(input(current, {
      key: "Backspace",
      lineNumber: 2
    }))).toEqual({
      kind: "mergeBackward",
      nodeId: "second",
      previousId: "first"
    });
    expect(resolveMonacoOutlineGesture(input(current, {
      key: "Backspace",
      lineNumber: 3
    }))).toEqual({
      kind: "removeEmpty",
      nodeId: "empty",
      focusId: "second"
    });
    expect(resolveMonacoOutlineGesture(input(current, {
      key: "Backspace",
      lineNumber: 1
    }))).toEqual({ kind: "consume" });
    expect(resolveMonacoOutlineGesture(input(
      projection([["only", "", true]]),
      { key: "Backspace" }
    ))).toEqual({ kind: "consume" });
  });

  it("routes indentation without allowing Monaco to insert tabs", () => {
    const current = projection([
      ["first", "first", true],
      ["second", "second", true]
    ]);

    expect(resolveMonacoOutlineGesture(input(current, {
      key: "Tab",
      lineNumber: 2
    }))).toEqual({ kind: "indent", nodeId: "second" });
    expect(resolveMonacoOutlineGesture(input(current, {
      key: "Tab",
      shiftKey: true,
      lineNumber: 2
    }))).toEqual({ kind: "outdent", nodeId: "second" });
    expect(resolveMonacoOutlineGesture(input(current, {
      key: "Tab",
      repeat: true,
      lineNumber: 2
    }))).toEqual({ kind: "consume" });
  });

  it("routes product history and protects read-only image lines", () => {
    const current = projection([
      ["text", "text", true],
      ["image", "diagram.png", false]
    ]);

    expect(resolveMonacoOutlineGesture(input(current, {
      key: "z",
      ctrlKey: true,
      platform: "other"
    }))).toEqual({ kind: "undo" });
    expect(resolveMonacoOutlineGesture(input(current, {
      key: "z",
      metaKey: true,
      shiftKey: true,
      platform: "mac"
    }))).toEqual({ kind: "redo" });
    expect(resolveMonacoOutlineGesture(input(current, {
      key: "Enter",
      lineNumber: 2
    }))).toEqual({ kind: "consume" });
    expect(resolveMonacoOutlineGesture(input(current, {
      key: "x",
      lineNumber: 2
    }))).toEqual({ kind: "native" });
  });
});

interface InputOverrides {
  readonly key?: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
  readonly repeat?: boolean;
  readonly platform?: "mac" | "other";
  readonly lineNumber?: number;
  readonly endLineNumber?: number;
  readonly startColumn?: number;
  readonly endColumn?: number;
}

function input(
  projectionValue: MonacoOutlineProjection,
  overrides: InputOverrides
) {
  return {
    key: overrides.key ?? "Enter",
    altKey: overrides.altKey ?? false,
    ctrlKey: overrides.ctrlKey ?? false,
    metaKey: overrides.metaKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
    isComposing: overrides.isComposing ?? false,
    repeat: overrides.repeat ?? false,
    platform: overrides.platform ?? "other",
    lineNumber: overrides.lineNumber ?? 1,
    endLineNumber: overrides.endLineNumber ??
      overrides.lineNumber ??
      1,
    startColumn: overrides.startColumn ?? 1,
    endColumn: overrides.endColumn ??
      overrides.startColumn ??
      1,
    projection: projectionValue
  } as const;
}

function projection(
  lines: ReadonlyArray<readonly [
    nodeId: string,
    text: string,
    editable: boolean
  ]>
): MonacoOutlineProjection {
  return {
    lines: lines.map(([nodeId, text, editable]) => ({
      nodeId,
      text,
      depth: 0,
      editable
    })),
    value: lines.map(([, text]) => text).join("\n"),
    lineByNodeId: new Map(
      lines.map(([nodeId], index) => [nodeId, index + 1])
    ),
    nodeIdByLine: lines.map(([nodeId]) => nodeId)
  };
}
