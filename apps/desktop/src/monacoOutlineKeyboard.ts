import type { MonacoOutlineProjection } from "./monacoOutlineProjection";

export interface MonacoOutlineGestureInput {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  readonly repeat: boolean;
  readonly platform: "mac" | "other";
  readonly lineNumber: number;
  readonly endLineNumber: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly projection: MonacoOutlineProjection;
}

export type MonacoOutlineGesture =
  | { readonly kind: "native" }
  | {
      readonly kind: "split";
      readonly nodeId: string;
      readonly startOffset: number;
      readonly endOffset: number;
    }
  | {
      readonly kind: "mergeBackward";
      readonly nodeId: string;
      readonly previousId: string;
    }
  | {
      readonly kind: "removeEmpty";
      readonly nodeId: string;
      readonly focusId: string | null;
    }
  | { readonly kind: "indent"; readonly nodeId: string }
  | { readonly kind: "outdent"; readonly nodeId: string }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" }
  | { readonly kind: "consume" };

export function resolveMonacoOutlineGesture(
  input: MonacoOutlineGestureInput
): MonacoOutlineGesture {
  if (input.isComposing || input.key === "Process") {
    return { kind: "native" };
  }
  const primaryModifier = input.platform === "mac"
    ? input.metaKey && !input.ctrlKey
    : input.ctrlKey && !input.metaKey;
  if (
    primaryModifier &&
    !input.altKey &&
    input.key.toLowerCase() === "z"
  ) {
    return { kind: input.shiftKey ? "redo" : "undo" };
  }
  const line = input.projection.lines[input.lineNumber - 1];
  if (!line) return { kind: "consume" };
  if (input.key === "Enter") {
    if (
      input.altKey ||
      input.ctrlKey ||
      input.metaKey ||
      input.shiftKey ||
      !line.editable ||
      input.lineNumber !== input.endLineNumber
    ) {
      return { kind: "consume" };
    }
    return {
      kind: "split",
      nodeId: line.nodeId,
      startOffset: input.startColumn - 1,
      endOffset: input.endColumn - 1
    };
  }
  if (input.key === "Tab") {
    if (
      input.altKey ||
      input.ctrlKey ||
      input.metaKey ||
      input.repeat ||
      !line.editable
    ) {
      return { kind: "consume" };
    }
    return {
      kind: input.shiftKey ? "outdent" : "indent",
      nodeId: line.nodeId
    };
  }
  if (
    input.key === "Backspace" &&
    !input.altKey &&
    !input.ctrlKey &&
    !input.metaKey &&
    !input.shiftKey &&
    input.lineNumber === input.endLineNumber &&
    input.startColumn === 1 &&
    input.endColumn === 1 &&
    line.editable
  ) {
    const previousId = input.projection.nodeIdByLine[input.lineNumber - 2];
    if (line.text.length === 0) {
      if (input.projection.lines.length === 1) return { kind: "consume" };
      return {
        kind: "removeEmpty",
        nodeId: line.nodeId,
        focusId: previousId ?? null
      };
    }
    return previousId
      ? { kind: "mergeBackward", nodeId: line.nodeId, previousId }
      : { kind: "consume" };
  }
  return { kind: "native" };
}
