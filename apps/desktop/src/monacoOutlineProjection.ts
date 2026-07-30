import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { OutlineIndex } from "./outlineIndex";

export interface MonacoOutlineLine {
  readonly nodeId: string;
  readonly text: string;
  readonly depth: number;
  readonly editable: boolean;
}

export interface MonacoOutlineProjection {
  readonly lines: readonly MonacoOutlineLine[];
  readonly value: string;
  readonly lineByNodeId: ReadonlyMap<string, number>;
  readonly nodeIdByLine: readonly string[];
}

export interface MonacoProjectionEdit {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
  readonly text: string;
}

export function buildMonacoOutlineProjection(
  nodes: readonly NoteView[],
  index: OutlineIndex,
  rootId: string,
  titleForId: (nodeId: string) => string
): MonacoOutlineProjection {
  const lineByNodeId = new Map<string, number>();
  const lines = nodes.map((node, position): MonacoOutlineLine => {
    lineByNodeId.set(node.id, position + 1);
    return {
      nodeId: node.id,
      text: node.kind === "image"
        ? node.image?.originalName ?? node.text
        : titleForId(node.id),
      depth: index.depthOf(node.id, rootId),
      editable: node.kind !== "image"
    };
  });
  return {
    lines,
    value: lines.map((line) => line.text).join("\n"),
    lineByNodeId,
    nodeIdByLine: lines.map((line) => line.nodeId)
  };
}

export function planMonacoProjectionEdit(
  previous: MonacoOutlineProjection,
  next: MonacoOutlineProjection
): MonacoProjectionEdit | null {
  if (previous.value === next.value) return null;
  const prefixLength = commonPrefixLength(previous.value, next.value);
  const suffixLength = commonSuffixLength(
    previous.value,
    next.value,
    prefixLength
  );
  const start = positionAt(previous.value, prefixLength);
  const end = positionAt(previous.value, previous.value.length - suffixLength);
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
    text: next.value.slice(prefixLength, next.value.length - suffixLength)
  };
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) length += 1;
  return length;
}

function commonSuffixLength(
  left: string,
  right: string,
  prefixLength: number
): number {
  const limit = Math.min(left.length, right.length) - prefixLength;
  let length = 0;
  while (
    length < limit &&
    left[left.length - length - 1] === right[right.length - length - 1]
  ) {
    length += 1;
  }
  return length;
}

function positionAt(
  value: string,
  offset: number
): { readonly lineNumber: number; readonly column: number } {
  const before = value.slice(0, offset);
  const lastLineBreak = before.lastIndexOf("\n");
  return {
    lineNumber: countLineBreaks(before) + 1,
    column: offset - lastLineBreak
  };
}

function countLineBreaks(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") count += 1;
  }
  return count;
}
