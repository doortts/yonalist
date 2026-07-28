import type {
  NoteId,
  NoteNode,
  NotesHistoryContext,
} from "../../domain/notes";
import type { NotesHistoryPrimarySelection } from "./notesHistory";
import type { NotesPaneId } from "./notesPaneSession";
import { finalizeOptimisticOutlineRows } from "./notesBackspaceGesture";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";
import type { FlattenedOutlineRow } from "./outlineTree";

export interface LocalStructureEntry {
  readonly token: number;
  readonly sourceId: NoteId;
  readonly insertedId: NoteId;
  readonly ownerPaneId: NotesPaneId;
  readonly historyContext: NotesHistoryContext;
  readonly postcondition:
    | {
        readonly kind: "split";
        readonly expectedSourceTitle: string;
        readonly expectedInsertedTitle: string;
      }
    | {
        readonly kind: "first-child";
        readonly expectedParentId: NoteId;
        readonly expectedIndex: 0;
        readonly expectedInsertedTitle: "";
      };
  readonly sourceSelection: NotesHistoryPrimarySelection;
  readonly sourceTitle: string;
  readonly insertedTitle: string;
  readonly dependencyId: NoteId | null;
  readonly status: "prepared" | "queued" | "running" | "checking";
}

export interface LocalStructureProjection {
  readonly rows: readonly FlattenedOutlineRow[];
  readonly nodeOverrides: ReadonlyMap<NoteId, NoteNode>;
}

export type LocalStructureFailureResolution =
  | {
      readonly kind: "rollback";
      readonly historyContext: NotesHistoryContext;
      readonly sourceId: NoteId;
      readonly sourceSelection: NotesHistoryPrimarySelection;
    }
  | { readonly kind: "recover-authority" };

type LocalSplitInput = Omit<
  LocalStructureEntry,
  "postcondition" | "status"
>;

export function localSplit(input: LocalSplitInput): LocalStructureEntry {
  return {
    ...input,
    postcondition: {
      kind: "split",
      expectedSourceTitle: input.sourceTitle,
      expectedInsertedTitle: input.insertedTitle,
    },
    status: "prepared",
  };
}

export function localFirstChild(input: LocalSplitInput): LocalStructureEntry {
  return {
    ...input,
    postcondition: {
      kind: "first-child",
      expectedParentId: input.sourceId,
      expectedIndex: 0,
      expectedInsertedTitle: "",
    },
    status: "prepared",
  };
}

export function projectLocalStructures(
  rows: readonly FlattenedOutlineRow[],
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  entries: readonly LocalStructureEntry[],
): LocalStructureProjection {
  if (entries.length === 0) return { rows, nodeOverrides: new Map() };

  const projectedRows = [...rows];
  const nodeOverrides = new Map<NoteId, NoteNode>();
  for (const entry of entries) {
    if (
      nodesById[entry.insertedId] ||
      projectedRows.some((candidate) => candidate.id === entry.insertedId)
    ) {
      continue;
    }
    const sourceIndex = projectedRows.findIndex(
      (candidate) => candidate.id === entry.sourceId,
    );
    if (sourceIndex < 0) continue;
    const sourceRow = projectedRows[sourceIndex]!;
    const sourceNode =
      nodeOverrides.get(entry.sourceId) ?? nodesById[entry.sourceId];
    if (!sourceNode) continue;
    const firstChild = entry.postcondition.kind === "first-child";

    if (firstChild && sourceRow.isCollapsed) {
      projectedRows[sourceIndex] = { ...sourceRow, isCollapsed: false };
    }
    nodeOverrides.set(entry.sourceId, {
      ...sourceNode,
      title: entry.sourceTitle,
      ...(firstChild ? { isCollapsed: false } : {}),
    });
    const descendantEndIndex =
      sourceRow.visibleDescendantEndId === null
        ? sourceIndex
        : projectedRows.findIndex(
            (candidate) =>
              candidate.id === sourceRow.visibleDescendantEndId,
          );
    projectedRows.splice(firstChild ? sourceIndex + 1 : Math.max(sourceIndex, descendantEndIndex) + 1, 0, {
      id: entry.insertedId,
      parentId: firstChild ? entry.sourceId : sourceRow.parentId,
      depth: sourceRow.depth + (firstChild ? 1 : 0),
      isCollapsed: false,
      ancestorIds: firstChild
        ? [...sourceRow.ancestorIds, entry.sourceId]
        : sourceRow.ancestorIds,
      ancestorGuideDepths: [],
      visibleDescendantEndId: null,
    });
    nodeOverrides.set(entry.insertedId, {
      ...sourceNode,
      id: entry.insertedId,
      nodeKind: "text",
      markerKind: "bullet",
      parentId: firstChild ? entry.sourceId : sourceRow.parentId,
      title: entry.insertedTitle,
      note: "",
      imageOffsetUtf16: 0,
      markdownImageWidth: null,
      isCollapsed: false,
      isStarred: false,
      completedAt: null,
      deletedAt: null,
      archivedAt: null,
      archiveRootId: null,
    });
  }

  return nodeOverrides.size === 0
    ? { rows, nodeOverrides }
    : {
        rows: finalizeOptimisticOutlineRows(projectedRows),
        nodeOverrides,
      };
}

export function settleLocalStructure(
  entries: readonly LocalStructureEntry[],
  token: number,
  workspace: NormalizedNotesWorkspace,
): readonly LocalStructureEntry[] {
  const entry = entries.find((candidate) => candidate.token === token);
  if (!entry) return entries;
  return localStructurePostconditionMatches(entry, workspace)
    ? entries.filter((candidate) => candidate.token !== token)
    : entries;
}

export function localStructurePostconditionMatches(
  entry: LocalStructureEntry,
  workspace: NormalizedNotesWorkspace,
): boolean {
  const source = workspace.nodesById[entry.sourceId];
  const inserted = workspace.nodesById[entry.insertedId];
  if (!source || !inserted) return false;
  if (entry.postcondition.kind === "first-child") {
    return (
      inserted.parentId === entry.postcondition.expectedParentId &&
      workspace.childIdsByParent[entry.postcondition.expectedParentId]?.[
        entry.postcondition.expectedIndex
      ] === inserted.id &&
      inserted.title === entry.postcondition.expectedInsertedTitle
    );
  }
  if (source.parentId !== inserted.parentId) return false;
  const siblings =
    source.parentId === null
      ? workspace.rootIds
      : (workspace.childIdsByParent[source.parentId] ?? []);
  const sourceIndex = siblings.indexOf(source.id);
  return (
    sourceIndex >= 0 &&
    siblings[sourceIndex + 1] === inserted.id &&
    source.title === entry.postcondition.expectedSourceTitle &&
    inserted.title === entry.postcondition.expectedInsertedTitle
  );
}

export function updateLocalStructureTitle(
  entries: readonly LocalStructureEntry[],
  token: number,
  title: string,
): readonly LocalStructureEntry[] {
  const index = entries.findIndex((entry) => entry.token === token);
  if (index < 0 || entries[index]!.insertedTitle === title) return entries;
  const updated = [...entries];
  updated[index] = { ...updated[index]!, insertedTitle: title };
  return updated;
}

export function classifyLocalStructureFailure(
  entries: readonly LocalStructureEntry[],
  failedToken: number,
  outcome: "known" | "unknown",
): LocalStructureFailureResolution {
  const failed = entries.find((entry) => entry.token === failedToken);
  if (!failed || outcome === "unknown") {
    return { kind: "recover-authority" };
  }
  const affectedIds = new Set<NoteId>([failed.insertedId]);
  for (let previousSize = -1; previousSize !== affectedIds.size; ) {
    previousSize = affectedIds.size;
    for (const entry of entries) {
      if (entry.dependencyId && affectedIds.has(entry.dependencyId)) {
        affectedIds.add(entry.insertedId);
      }
    }
  }
  if (affectedIds.size > 1) return { kind: "recover-authority" };
  return {
    kind: "rollback",
    historyContext: failed.historyContext,
    sourceId: failed.sourceId,
    sourceSelection: failed.sourceSelection,
  };
}
