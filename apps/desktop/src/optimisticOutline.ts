import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesState } from "./notesState";
import { orderOutline } from "./outlineModel";
import {
  allocateSiblingSortKey,
  applyRebalancedSortKeys
} from "./outlineSortKeys";
import { omitKeys } from "./storeState";

export interface OptimisticOutlineState {
  readonly nodes: readonly NoteView[];
  readonly drafts: Readonly<Record<string, string>>;
  readonly noteDrafts: Readonly<Record<string, string>>;
}

function bullet(
  id: string,
  parentId: string,
  sortKey: number,
  text: string
): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: "bullet",
    text,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

export function projectCreateNode(
  state: NotesState,
  input: {
    readonly id: string;
    readonly parentId: string;
    readonly beforeId: string | null;
    readonly text: string;
  }
): OptimisticOutlineState {
  const allocation = allocateSiblingSortKey(
    state.nodes,
    input.parentId,
    input.beforeId
  );
  const created = bullet(
    input.id,
    input.parentId,
    allocation.sortKey,
    input.text
  );
  return {
    nodes: orderOutline([
      ...applyRebalancedSortKeys(
        state.nodes,
        allocation.rebalancedSortKeys
      ),
      created
    ], state.activePageId),
    drafts: state.drafts,
    noteDrafts: state.noteDrafts
  };
}

export function projectSplitNode(
  state: NotesState,
  input: {
    readonly id: string;
    readonly newId: string;
    readonly parentId: string;
    readonly beforeId: string | null;
    readonly prefix: string;
    readonly suffix: string;
  }
): OptimisticOutlineState {
  const allocation = allocateSiblingSortKey(
    state.nodes,
    input.parentId,
    input.beforeId
  );
  const created = bullet(
    input.newId,
    input.parentId,
    allocation.sortKey,
    input.suffix
  );
  return {
    nodes: orderOutline([
      ...applyRebalancedSortKeys(
        state.nodes,
        allocation.rebalancedSortKeys
      ),
      created
    ], state.activePageId),
    drafts: { ...state.drafts, [input.id]: input.prefix },
    noteDrafts: state.noteDrafts
  };
}

export function projectRemoveEmptyNode(
  state: NotesState,
  id: string
): OptimisticOutlineState {
  const source = state.nodes.find((node) => node.id === id);
  if (!source?.parentId) {
    return {
      nodes: state.nodes,
      drafts: omitKeys(state.drafts, [id]),
      noteDrafts: omitKeys(state.noteDrafts, [id])
    };
  }
  const siblings = state.nodes
    .filter((node) => node.parentId === source.parentId && node.id !== id)
    .sort((left, right) =>
      left.sortKey - right.sortKey || left.id.localeCompare(right.id)
    );
  const next = siblings.find((node) => node.sortKey > source.sortKey);
  const children = state.nodes
    .filter((node) => node.parentId === id)
    .sort((left, right) =>
      left.sortKey - right.sortKey || left.id.localeCompare(right.id)
    );
  const nodes = state.nodes
    .filter((node) => node.id !== id)
    .map((node) => {
      const childIndex = children.findIndex((child) => child.id === node.id);
      if (childIndex < 0) return node;
      const ratio = (childIndex + 1) / (children.length + 1);
      return {
        ...node,
        parentId: source.parentId,
        sortKey: next
          ? source.sortKey + (next.sortKey - source.sortKey) * ratio
          : source.sortKey + (childIndex + 1) * 1_024
      };
    });
  return {
    nodes: orderOutline(nodes, state.activePageId),
    drafts: omitKeys(state.drafts, [id]),
    noteDrafts: omitKeys(state.noteDrafts, [id])
  };
}

export function projectMergeNodeBackward(
  state: NotesState,
  input: {
    readonly id: string;
    readonly previousId: string;
    readonly previousText: string;
    readonly currentText: string;
  }
): OptimisticOutlineState {
  const previous = state.nodes.find((node) => node.id === input.previousId);
  const mergedText = input.previousText + input.currentText;
  const nodes = state.nodes
    .filter((node) => node.id !== input.previousId)
    .map((node) => node.id === input.id
      ? {
          ...node,
          sortKey: previous?.sortKey ?? node.sortKey,
          text: mergedText
        }
      : node);
  return {
    nodes: orderOutline(nodes, state.activePageId),
    drafts: {
      ...omitKeys(state.drafts, [input.previousId]),
      [input.id]: mergedText
    },
    noteDrafts: omitKeys(state.noteDrafts, [input.previousId])
  };
}
