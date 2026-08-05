import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { IpcEditorCommand } from "../../../../packages/contracts/generated/IpcEditorCommand";
import {
  OutlineMetadataTimeline,
  type OutlineLineMetadata,
  type OutlineMetadataSnapshot
} from "./metadata";
import { planStructuralReplacement } from "./structuralReplacement";

const MAX_EDITOR_BATCH_COMMANDS = 256;

export interface OutlineLineTextPatch {
  readonly startIndex: number;
  readonly deleteCount: number;
  readonly insertedTexts: readonly string[];
}

export interface OutlineStructuralTransition {
  readonly before: OutlineMetadataSnapshot;
  readonly after: OutlineMetadataSnapshot;
  readonly textPatch: OutlineLineTextPatch;
  readonly inverseTextPatch: OutlineLineTextPatch;
  readonly forward: readonly IpcEditorCommand[];
  readonly inverse: readonly IpcEditorCommand[];
  readonly affectedLineNumbers: readonly number[];
  readonly structural: boolean;
}

interface PreparedChange {
  readonly change: monaco.editor.IModelContentChange;
  readonly allocatedIds: readonly string[];
}

export function interpretModelChanges(input: {
  readonly before: OutlineMetadataSnapshot;
  readonly beforeTexts: readonly string[];
  readonly event: monaco.editor.IModelContentChangedEvent;
  readonly model: monaco.editor.ITextModel;
  readonly allocateId: () => string;
}): OutlineStructuralTransition {
  if (input.beforeTexts.length !== input.before.lines.length) {
    throw new Error("Outline text and metadata line counts must match.");
  }
  if (input.event.changes.length === 0) {
    throw new Error("A Monaco content event must contain at least one change.");
  }

  const changes = prepareChanges(input.event.changes, input.allocateId);
  const windowStart = Math.min(
    ...changes.map(({ change }) => change.range.startLineNumber - 1)
  );
  const windowEnd = Math.max(
    ...changes.map(({ change }) => change.range.endLineNumber)
  );
  const originalTexts = input.beforeTexts.slice(windowStart, windowEnd);
  const nextTexts = [...originalTexts];
  const structural = changes.some(
    ({ change }) =>
      change.range.startLineNumber !== change.range.endLineNumber ||
      containsLineBreak(change.text)
  );

  if (!structural) {
    return interpretTextOnly({
      before: input.before,
      model: input.model,
      changes,
      windowStart,
      originalTexts,
      nextTexts
    });
  }

  const workingLines = [...input.before.lines];
  const forward: IpcEditorCommand[] = [];
  let inverse: IpcEditorCommand[] = [];
  for (const { change, allocatedIds } of descendingChanges(changes)) {
    const textChange = applyTextChange(nextTexts, windowStart, change);
    const startIndex = change.range.startLineNumber - 1;
    const oldLines = workingLines.slice(
      startIndex,
      startIndex + textChange.removedTexts.length
    );
    if (oldLines.length !== textChange.removedTexts.length) {
      throw new Error("A structural edit escaped its source metadata.");
    }
    const replacement = planStructuralReplacement({
      allLines: workingLines,
      startIndex,
      oldLines,
      oldTexts: textChange.removedTexts,
      newTexts: textChange.insertedTexts,
      allocatedIds
    });
    workingLines.splice(startIndex, oldLines.length, ...replacement.lines);
    forward.push(...replacement.forward);
    inverse = [...replacement.inverse, ...inverse];
  }

  assertModelWindow(
    input.model,
    windowStart,
    nextTexts,
    input.before.lines.length - originalTexts.length + nextTexts.length
  );
  assertBatchBounds(forward, inverse);
  return {
    before: input.before,
    after: OutlineMetadataTimeline.hydrate(
      input.model.getAlternativeVersionId(),
      workingLines
    ).current(),
    textPatch: textPatch(windowStart, originalTexts.length, nextTexts),
    inverseTextPatch: textPatch(windowStart, nextTexts.length, originalTexts),
    forward,
    inverse,
    affectedLineNumbers: Array.from(
      { length: nextTexts.length },
      (_, index) => windowStart + index + 1
    ),
    structural: true
  };
}

export function canApplyNativeBoundaryEdit(input: {
  readonly snapshot: OutlineMetadataSnapshot;
  readonly texts: readonly string[];
  readonly selection: monaco.Selection;
  readonly command: "backspace" | "delete";
}): boolean {
  if (input.snapshot.lines.length !== input.texts.length) return false;
  const { selection } = input;
  if (!selection.isEmpty()) {
    if (selection.startLineNumber === selection.endLineNumber) return true;
    return canReplaceLineRange(
      input.snapshot,
      selection.startLineNumber - 1,
      selection.endLineNumber - 1
    );
  }

  if (input.command === "backspace") {
    if (selection.positionColumn !== 1 || selection.positionLineNumber === 1) {
      return true;
    }
    return canMergeBoundary(
      input.snapshot,
      input.texts,
      selection.positionLineNumber - 2,
      selection.positionLineNumber - 1
    );
  }

  const currentIndex = selection.positionLineNumber - 1;
  const currentText = input.texts[currentIndex];
  if (
    currentText === undefined ||
    selection.positionColumn !== currentText.length + 1 ||
    currentIndex + 1 >= input.texts.length
  ) {
    return true;
  }
  return canMergeBoundary(
    input.snapshot,
    input.texts,
    currentIndex,
    currentIndex + 1
  );
}

function interpretTextOnly(input: {
  readonly before: OutlineMetadataSnapshot;
  readonly model: monaco.editor.ITextModel;
  readonly changes: readonly PreparedChange[];
  readonly windowStart: number;
  readonly originalTexts: readonly string[];
  readonly nextTexts: string[];
}): OutlineStructuralTransition {
  for (const { change } of descendingChanges(input.changes)) {
    applyTextChange(input.nextTexts, input.windowStart, change);
  }
  assertModelWindow(
    input.model,
    input.windowStart,
    input.nextTexts,
    input.before.lines.length
  );
  const forward: IpcEditorCommand[] = [];
  const inverse: IpcEditorCommand[] = [];
  const affectedLineNumbers: number[] = [];
  for (const [index, next] of input.nextTexts.entries()) {
    const previous = input.originalTexts[index];
    if (previous === next) continue;
    const line = input.before.lines[input.windowStart + index];
    if (!line || previous === undefined) {
      throw new Error("A text-only edit escaped its source line.");
    }
    forward.push({ kind: "updateText", id: line.nodeId, text: next });
    inverse.push({ kind: "updateText", id: line.nodeId, text: previous });
    affectedLineNumbers.push(input.windowStart + index + 1);
  }
  assertBatchBounds(forward, inverse);
  return {
    before: input.before,
    after: Object.freeze({
      alternativeVersionId: input.model.getAlternativeVersionId(),
      lines: input.before.lines,
      lineByNodeId: input.before.lineByNodeId
    }),
    textPatch: textPatch(
      input.windowStart,
      input.originalTexts.length,
      input.nextTexts
    ),
    inverseTextPatch: textPatch(
      input.windowStart,
      input.nextTexts.length,
      input.originalTexts
    ),
    forward,
    inverse,
    affectedLineNumbers,
    structural: false
  };
}

function prepareChanges(
  changes: readonly monaco.editor.IModelContentChange[],
  allocateId: () => string
): readonly PreparedChange[] {
  return [...changes].sort(compareChangesAscending).map((change) => {
    const oldLineCount =
      change.range.endLineNumber - change.range.startLineNumber + 1;
    const newLineCount = splitLines(change.text).length;
    const allocationCount =
      oldLineCount === 1 && newLineCount > 1
        ? newLineCount - 1
        : oldLineCount > 1 && newLineCount > 2
          ? newLineCount - 2
          : 0;
    return {
      change,
      allocatedIds: Array.from({ length: allocationCount }, allocateId)
    };
  });
}

function descendingChanges(
  changes: readonly PreparedChange[]
): readonly PreparedChange[] {
  return [...changes].sort((left, right) =>
    compareChangesAscending(right.change, left.change)
  );
}

function compareChangesAscending(
  left: monaco.editor.IModelContentChange,
  right: monaco.editor.IModelContentChange
): number {
  return (
    left.range.startLineNumber - right.range.startLineNumber ||
    left.range.startColumn - right.range.startColumn ||
    left.range.endLineNumber - right.range.endLineNumber ||
    left.range.endColumn - right.range.endColumn
  );
}

function applyTextChange(
  texts: string[],
  windowStart: number,
  change: monaco.editor.IModelContentChange
): {
  readonly removedTexts: readonly string[];
  readonly insertedTexts: readonly string[];
} {
  const startIndex = change.range.startLineNumber - 1 - windowStart;
  const endIndex = change.range.endLineNumber - 1 - windowStart;
  const startText = texts[startIndex];
  const endText = texts[endIndex];
  if (startText === undefined || endText === undefined) {
    throw new Error("A Monaco change escaped the bounded text window.");
  }
  const removedTexts = texts.slice(startIndex, endIndex + 1);
  const inserted = splitLines(change.text);
  const prefix = startText.slice(0, change.range.startColumn - 1);
  const suffix = endText.slice(change.range.endColumn - 1);
  const insertedTexts =
    inserted.length === 1
      ? [`${prefix}${inserted[0]}${suffix}`]
      : [
          `${prefix}${inserted[0]}`,
          ...inserted.slice(1, -1),
          `${inserted.at(-1) ?? ""}${suffix}`
        ];
  texts.splice(startIndex, removedTexts.length, ...insertedTexts);
  return { removedTexts, insertedTexts };
}

function canMergeBoundary(
  snapshot: OutlineMetadataSnapshot,
  texts: readonly string[],
  previousIndex: number,
  currentIndex: number
): boolean {
  const previous = snapshot.lines[previousIndex];
  const current = snapshot.lines[currentIndex];
  const currentText = texts[currentIndex];
  if (!previous || !current || currentText === undefined) {
    return false;
  }
  if (currentText.trim().length === 0) {
    return !hasChildren(snapshot.lines, current.nodeId);
  }
  return (
    previous.parentId === current.parentId &&
    previous.depth === current.depth &&
    !hasChildren(snapshot.lines, previous.nodeId)
  );
}

function canReplaceLineRange(
  snapshot: OutlineMetadataSnapshot,
  startIndex: number,
  endIndex: number
): boolean {
  const lines = snapshot.lines.slice(startIndex, endIndex + 1);
  const first = lines[0];
  return (
    first !== undefined &&
    lines.every(
      (line) =>
        line.parentId === first.parentId &&
        line.depth === first.depth &&
        !hasChildren(snapshot.lines, line.nodeId)
    )
  );
}

function hasChildren(
  lines: readonly OutlineLineMetadata[],
  nodeId: string
): boolean {
  return lines.some((line) => line.parentId === nodeId);
}

function assertModelWindow(
  model: monaco.editor.ITextModel,
  windowStart: number,
  texts: readonly string[],
  expectedLineCount: number
): void {
  if (model.getLineCount() !== expectedLineCount) {
    throw new Error("The interpreted outline line count differs from Monaco.");
  }
  for (const [index, text] of texts.entries()) {
    if (model.getLineContent(windowStart + index + 1) !== text) {
      throw new Error("The interpreted outline text differs from Monaco.");
    }
  }
}

function assertBatchBounds(
  forward: readonly IpcEditorCommand[],
  inverse: readonly IpcEditorCommand[]
): void {
  if (
    forward.length === 0 ||
    forward.length > MAX_EDITOR_BATCH_COMMANDS ||
    inverse.length === 0 ||
    inverse.length > MAX_EDITOR_BATCH_COMMANDS
  ) {
    throw new Error(
      `A model change must produce 1 to ${MAX_EDITOR_BATCH_COMMANDS} forward and inverse commands.`
    );
  }
}

function textPatch(
  startIndex: number,
  deleteCount: number,
  insertedTexts: readonly string[]
): OutlineLineTextPatch {
  return { startIndex, deleteCount, insertedTexts };
}

function containsLineBreak(value: string): boolean {
  return /\r|\n/u.test(value);
}

function splitLines(value: string): readonly string[] {
  return value.split(/\r\n|\r|\n/u);
}
