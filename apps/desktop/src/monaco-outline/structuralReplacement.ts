import type { IpcEditorCommand } from "../../../../packages/contracts/generated/IpcEditorCommand";
import type { OutlineLineMetadata } from "./metadata";

export interface StructuralReplacementPlan {
  readonly lines: readonly OutlineLineMetadata[];
  readonly forward: readonly IpcEditorCommand[];
  readonly inverse: readonly IpcEditorCommand[];
  /**
   * Set when the plan rewrote a note run. The caller reassembles the whole run
   * into one updateNote, because only it can read the lines outside this range.
   */
  readonly noteNodeId?: string;
}

interface StructuralReplacementInput {
  readonly allLines: readonly OutlineLineMetadata[];
  readonly startIndex: number;
  readonly oldLines: readonly OutlineLineMetadata[];
  readonly oldTexts: readonly string[];
  readonly newTexts: readonly string[];
  readonly allocatedIds: readonly string[];
}

export function planStructuralReplacement(
  input: StructuralReplacementInput
): StructuralReplacementPlan {
  // An image row is an indivisible node, and a split or merge that spans two
  // kinds has no meaning to plan (design §2b-5, §2b-6). The native gestures
  // are refused upstream; these guard the paths that bypass them.
  if (input.oldLines.some((line) => line.kind === "image")) {
    throw new Error(
      "An outline image line cannot take part in a split or merge."
    );
  }
  const first = requiredLine(input.oldLines, 0);
  if (input.oldLines.some((line) => line.kind !== first.kind)) {
    throw new Error("A structural outline edit cannot cross line kinds.");
  }
  if (first.kind === "note") {
    return planNoteRunReplacement(input, first);
  }
  if (input.oldLines.length === 1 && input.newTexts.length === 1) {
    const source = requiredLine(input.oldLines, 0);
    const previous = requiredText(input.oldTexts, 0);
    const next = requiredText(input.newTexts, 0);
    return {
      lines: [source],
      forward:
        previous === next
          ? []
          : [{ kind: "updateText", id: source.nodeId, text: next }],
      inverse:
        previous === next
          ? []
          : [{ kind: "updateText", id: source.nodeId, text: previous }]
    };
  }
  if (input.oldLines.length === 1) {
    return planSplit(input);
  }
  if (input.oldLines.length === 2 && input.newTexts.length === 1) {
    if (!isRemovableEmptyTail(input)) {
      assertReplaceableSiblings(input);
    }
    return planBackwardMerge(input);
  }
  assertReplaceableSiblings(input);
  return planGeneralReplacement(input);
}

/**
 * Splitting or merging inside a note run only reshapes the run's newlines: no
 * node is born and none dies, so the plan is metadata plus a caller-side
 * updateNote (design §2b-1, §2b-2).
 */
function planNoteRunReplacement(
  input: StructuralReplacementInput,
  source: OutlineLineMetadata
): StructuralReplacementPlan {
  if (input.oldLines.some((line) => line.nodeId !== source.nodeId)) {
    throw new Error("A note run edit cannot cross two note owners.");
  }
  if (input.newTexts.length === 0) {
    throw new Error("A note run edit must leave at least one note line.");
  }
  return {
    lines: input.newTexts.map(() => source),
    forward: [],
    inverse: [],
    noteNodeId: source.nodeId
  };
}

function isRemovableEmptyTail(
  input: StructuralReplacementInput
): boolean {
  const current = requiredLine(input.oldLines, 1);
  return (
    requiredText(input.oldTexts, 1).trim().length === 0 &&
    !input.allLines.some((line) => line.parentId === current.nodeId)
  );
}

function planSplit(
  input: StructuralReplacementInput
): StructuralReplacementPlan {
  const source = requiredLine(input.oldLines, 0);
  const previousText = requiredText(input.oldTexts, 0);
  // Monaco puts the split line between the title and its note run, which no
  // plan can repair. session.splitTitleWithNote owns this gesture instead.
  if (ownsNoteRun(input.allLines, input.startIndex, source)) {
    throw new Error(
      "A split of a title that owns a note run must go through the session."
    );
  }
  if (input.allocatedIds.length !== input.newTexts.length - 1) {
    throw new Error("A split did not receive one stable ID per suffix line.");
  }
  const firstChild = input.allLines[input.startIndex + 1];
  if (firstChild && firstChild.parentId === source.nodeId) {
    const lastText = requiredText(
      input.newTexts,
      input.newTexts.length - 1
    );
    return lastText === previousText
      ? planSplitAboveParent(input, source)
      : planSplitIntoChildren(input, source, previousText, firstChild.nodeId);
  }
  const beforeId = nextSiblingId(
    input.allLines,
    input.startIndex + 1,
    source
  );
  const insertedLines = input.allocatedIds.map((nodeId) => ({
    nodeId,
    parentId: source.parentId,
    depth: source.depth,
    kind: "text" as const,
    marker: "bullet" as const,
    collapsed: false,
    completed: false
  }));
  const forward = input.allocatedIds.map((newId, index) => ({
    kind: "splitNode" as const,
    id: index === 0 ? source.nodeId : requiredText(input.allocatedIds, index - 1),
    new_id: newId,
    parent_id: source.parentId,
    before_id: beforeId,
    prefix: requiredText(input.newTexts, index),
    suffix: requiredText(input.newTexts, index + 1)
  }));
  const inverse: IpcEditorCommand[] = [];
  for (const nodeId of [...input.allocatedIds].reverse()) {
    inverse.push({ kind: "updateText", id: nodeId, text: "" });
    inverse.push({ kind: "removeEmptyNode", id: nodeId });
  }
  inverse.push({
    kind: "updateText",
    id: source.nodeId,
    text: previousText
  });
  return {
    lines: [source, ...insertedLines],
    forward,
    inverse
  };
}

function planSplitAboveParent(
  input: StructuralReplacementInput,
  source: OutlineLineMetadata
): StructuralReplacementPlan {
  const insertedLines = input.allocatedIds.map((nodeId) => ({
    nodeId,
    parentId: source.parentId,
    depth: source.depth,
    kind: "text" as const,
    marker: "bullet" as const,
    collapsed: false,
    completed: false
  }));
  const forward: IpcEditorCommand[] = insertedLines.map((line, index) => ({
    kind: "createNode",
    id: line.nodeId,
    parent_id: source.parentId,
    before_id: source.nodeId,
    text: requiredText(input.newTexts, index)
  }));
  const inverse: IpcEditorCommand[] = [];
  for (const nodeId of [...input.allocatedIds].reverse()) {
    inverse.push({ kind: "updateText", id: nodeId, text: "" });
    inverse.push({ kind: "removeEmptyNode", id: nodeId });
  }
  return {
    lines: [...insertedLines, source],
    forward,
    inverse
  };
}

function planSplitIntoChildren(
  input: StructuralReplacementInput,
  source: OutlineLineMetadata,
  previousText: string,
  firstChildId: string
): StructuralReplacementPlan {
  const insertedLines = input.allocatedIds.map((nodeId) => ({
    nodeId,
    parentId: source.nodeId,
    depth: source.depth + 1,
    kind: "text" as const,
    marker: "bullet" as const,
    collapsed: false,
    completed: false
  }));
  const forward: IpcEditorCommand[] = [];
  const inverse: IpcEditorCommand[] = [];
  pushTextUpdate(
    forward,
    source.nodeId,
    previousText,
    requiredText(input.newTexts, 0)
  );
  if (source.collapsed) {
    forward.push({
      kind: "setCollapsed",
      id: source.nodeId,
      collapsed: false
    });
  }
  for (const [index, line] of insertedLines.entries()) {
    forward.push({
      kind: "createNode",
      id: line.nodeId,
      parent_id: source.nodeId,
      before_id: firstChildId,
      text: requiredText(input.newTexts, index + 1)
    });
  }
  for (const nodeId of [...input.allocatedIds].reverse()) {
    inverse.push({ kind: "updateText", id: nodeId, text: "" });
    inverse.push({ kind: "removeEmptyNode", id: nodeId });
  }
  if (source.collapsed) {
    inverse.push({
      kind: "setCollapsed",
      id: source.nodeId,
      collapsed: true
    });
  }
  pushTextUpdate(
    inverse,
    source.nodeId,
    requiredText(input.newTexts, 0),
    previousText
  );
  return {
    lines: [
      source.collapsed ? { ...source, collapsed: false } : source,
      ...insertedLines
    ],
    forward,
    inverse
  };
}

function planBackwardMerge(
  input: StructuralReplacementInput
): StructuralReplacementPlan {
  const previous = requiredLine(input.oldLines, 0);
  const current = requiredLine(input.oldLines, 1);
  const previousText = requiredText(input.oldTexts, 0);
  const currentText = requiredText(input.oldTexts, 1);
  const mergedText = requiredText(input.newTexts, 0);
  const nextId = nextSiblingId(
    input.allLines,
    input.startIndex + input.oldLines.length,
    current
  );

  if (currentText.trim().length === 0) {
    const forward: IpcEditorCommand[] = [];
    if (mergedText !== previousText) {
      forward.push({
        kind: "updateText",
        id: previous.nodeId,
        text: mergedText
      });
    }
    forward.push({ kind: "removeEmptyNode", id: current.nodeId });
    const inverse: IpcEditorCommand[] = [
      {
        kind: "createNode",
        id: current.nodeId,
        parent_id: current.parentId,
        before_id: nextId,
        text: currentText
      }
    ];
    if (mergedText !== previousText) {
      inverse.push({
        kind: "updateText",
        id: previous.nodeId,
        text: previousText
      });
    }
    return { lines: [previous], forward, inverse };
  }

  const forward: IpcEditorCommand[] = [
    {
      kind: "mergeNodeBackward",
      id: current.nodeId,
      previous_id: previous.nodeId,
      previous_text: previousText,
      current_text: currentText
    }
  ];
  if (mergedText !== previousText + currentText) {
    forward.push({
      kind: "updateText",
      id: current.nodeId,
      text: mergedText
    });
  }
  return {
    lines: [current],
    forward,
    inverse: [
      {
        kind: "createNode",
        id: previous.nodeId,
        parent_id: previous.parentId,
        before_id: current.nodeId,
        text: previousText
      },
      {
        kind: "updateText",
        id: current.nodeId,
        text: currentText
      }
    ]
  };
}

function planGeneralReplacement(
  input: StructuralReplacementInput
): StructuralReplacementPlan {
  if (input.newTexts.length === 1) {
    return planManyToOne(input);
  }

  const first = requiredLine(input.oldLines, 0);
  const last = requiredLine(input.oldLines, input.oldLines.length - 1);
  const removedLines = input.oldLines.slice(1, -1);
  const removedTexts = input.oldTexts.slice(1, -1);
  if (input.allocatedIds.length !== input.newTexts.length - 2) {
    throw new Error(
      "A multi-line replacement did not receive one ID per inserted interior line."
    );
  }
  const insertedLines = input.allocatedIds.map((nodeId) => ({
    nodeId,
    parentId: first.parentId,
    depth: first.depth,
    kind: "text" as const,
    marker: "bullet" as const,
    collapsed: false,
    completed: false
  }));
  const forward: IpcEditorCommand[] = [];
  pushTextUpdate(
    forward,
    first.nodeId,
    requiredText(input.oldTexts, 0),
    requiredText(input.newTexts, 0)
  );
  for (const [index, line] of removedLines.entries()) {
    const text = requiredText(removedTexts, index);
    if (text !== "") {
      forward.push({ kind: "updateText", id: line.nodeId, text: "" });
    }
    forward.push({ kind: "removeEmptyNode", id: line.nodeId });
  }
  pushTextUpdate(
    forward,
    last.nodeId,
    requiredText(input.oldTexts, input.oldTexts.length - 1),
    requiredText(input.newTexts, input.newTexts.length - 1)
  );
  for (const [index, line] of insertedLines.entries()) {
    forward.push({
      kind: "createNode",
      id: line.nodeId,
      parent_id: line.parentId,
      before_id: last.nodeId,
      text: requiredText(input.newTexts, index + 1)
    });
  }

  const inverse: IpcEditorCommand[] = [];
  for (const line of [...insertedLines].reverse()) {
    inverse.push({ kind: "updateText", id: line.nodeId, text: "" });
    inverse.push({ kind: "removeEmptyNode", id: line.nodeId });
  }
  pushTextUpdate(
    inverse,
    first.nodeId,
    requiredText(input.newTexts, 0),
    requiredText(input.oldTexts, 0)
  );
  pushTextUpdate(
    inverse,
    last.nodeId,
    requiredText(input.newTexts, input.newTexts.length - 1),
    requiredText(input.oldTexts, input.oldTexts.length - 1)
  );
  for (const [index, line] of removedLines.entries()) {
    inverse.push({
      kind: "createNode",
      id: line.nodeId,
      parent_id: line.parentId,
      before_id: last.nodeId,
      text: requiredText(removedTexts, index)
    });
  }
  return {
    lines: [first, ...insertedLines, last],
    forward,
    inverse
  };
}

function planManyToOne(
  input: StructuralReplacementInput
): StructuralReplacementPlan {
  const lastIndex = input.oldLines.length - 1;
  const keepLast = requiredText(input.oldTexts, lastIndex).trim().length > 0;
  const survivorIndex = keepLast ? lastIndex : 0;
  const survivor = requiredLine(input.oldLines, survivorIndex);
  const survivorText = requiredText(input.oldTexts, survivorIndex);
  const replacementText = requiredText(input.newTexts, 0);
  const removed = input.oldLines
    .map((line, index) => ({
      line,
      text: requiredText(input.oldTexts, index),
      index
    }))
    .filter(({ index }) => index !== survivorIndex);
  const nextId = nextSiblingId(
    input.allLines,
    input.startIndex + input.oldLines.length,
    requiredLine(input.oldLines, lastIndex)
  );

  const forward: IpcEditorCommand[] = [];
  for (const { line, text } of removed) {
    if (text !== "") {
      forward.push({ kind: "updateText", id: line.nodeId, text: "" });
    }
    forward.push({ kind: "removeEmptyNode", id: line.nodeId });
  }
  pushTextUpdate(
    forward,
    survivor.nodeId,
    survivorText,
    replacementText
  );

  const inverse: IpcEditorCommand[] = [];
  pushTextUpdate(
    inverse,
    survivor.nodeId,
    replacementText,
    survivorText
  );
  const beforeId = keepLast ? survivor.nodeId : nextId;
  for (const { line, text } of removed) {
    inverse.push({
      kind: "createNode",
      id: line.nodeId,
      parent_id: line.parentId,
      before_id: beforeId,
      text
    });
  }
  return { lines: [survivor], forward, inverse };
}

function pushTextUpdate(
  commands: IpcEditorCommand[],
  id: string,
  previous: string,
  next: string
): void {
  if (previous !== next) {
    commands.push({ kind: "updateText", id, text: next });
  }
}

function assertReplaceableSiblings(
  input: StructuralReplacementInput
): void {
  const { allLines, oldLines } = input;
  const first = requiredLine(oldLines, 0);
  const last = requiredLine(oldLines, oldLines.length - 1);
  if (
    // Only the last line's run can sit outside the replaced range: an interior
    // run would be inside it and the kind check has already refused that.
    ownsNoteRun(allLines, input.startIndex + oldLines.length - 1, last) ||
    oldLines.some(
      (line) =>
        line.parentId !== first.parentId ||
        line.depth !== first.depth ||
        allLines.some((candidate) => candidate.parentId === line.nodeId)
    )
  ) {
    throw new Error(
      "A native multi-line replacement may only cross same-parent leaf bullets."
    );
  }
}

/** A note run always follows its title line (V2), so one lookahead decides. */
function ownsNoteRun(
  allLines: readonly OutlineLineMetadata[],
  lineIndex: number,
  line: OutlineLineMetadata
): boolean {
  const next = allLines[lineIndex + 1];
  return next?.kind === "note" && next.nodeId === line.nodeId;
}

function nextSiblingId(
  lines: readonly OutlineLineMetadata[],
  startIndex: number,
  source: OutlineLineMetadata
): string | null {
  for (let index = startIndex; index < lines.length; index += 1) {
    const candidate = lines[index];
    if (!candidate || candidate.depth < source.depth) return null;
    if (candidate.depth === source.depth) {
      return candidate.parentId === source.parentId ? candidate.nodeId : null;
    }
  }
  return null;
}

function requiredLine(
  lines: readonly OutlineLineMetadata[],
  index: number
): OutlineLineMetadata {
  const line = lines[index];
  if (!line) throw new Error(`Missing outline metadata at index ${index}.`);
  return line;
}

function requiredText(texts: readonly string[], index: number): string {
  const text = texts[index];
  if (text === undefined) throw new Error(`Missing outline text at index ${index}.`);
  return text;
}
