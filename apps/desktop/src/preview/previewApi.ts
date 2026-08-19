import type { CommandEnvelope } from "../../../../packages/contracts/generated/CommandEnvelope";
import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "../api";
import { previewForest } from "./previewForest";
import { previewHistory } from "./previewHistory";
import { PreviewImages } from "./previewImages";
import {
  completionCascade,
  previewDescendants,
  previewSiblings,
  previewVisibleSubtree,
  reopenOverPlacedRows,
  settleOverDepartedRows
} from "./previewTree";
import {
  createInitialPreviewNodes,
  previewPageNodes
} from "./previewOutline";
import { validatePreviewBatch } from "./previewValidation";
import { ROOT_ID } from "../store/storeSupport";
import {
  allocateSiblingSortKey,
  applyRebalancedSortKeys,
  SORT_KEY_STEP
} from "../outline/outlineSortKeys";
import {
  applyPreviewDelta,
  createPreviewHistoryEntry,
  type PreviewHistoryEntry,
  type PreviewNodeDelta
} from "./previewPatchHistory";
const MAX_HISTORY_ENTRIES = 1_000;
const MAX_COMPLETED_REQUESTS = 4_096;
const sessionId = "yonalist-v2-browser-preview";
let revision = 1;
let activePageId = "preview-page";
let nodes = createInitialPreviewNodes();
const undoStack: PreviewHistoryEntry[] = [];
/**
 * The state the running history group started from, and the entry it produced.
 * The server folds commands that share a group into one undo entry, so the
 * preview recomputes that entry from this baseline rather than stacking a second
 * one -- otherwise a gesture written as two commands takes two undos here and one
 * there.
 *
 * The entry is held by identity because a group string recurs by design: a typing
 * run is `text:<id>`, so a pause, an undo, and a resumed run hand the same string
 * over again. Without it, the resumed run would fold into whatever entry happened
 * to be on top and take someone else's edit off the stack with it.
 */
let historyGroupBaseline: {
  group: string;
  nodes: NoteView[];
  entry: PreviewHistoryEntry;
} | null = null;
const redoStack: PreviewHistoryEntry[] = [];
const receiptsByRequest = new Map<string, MutationReceipt>();
const completedRequestOrder: string[] = [];
function copyNodes(source = nodes): NoteView[] {
  return source.map((node) => ({ ...node }));
}
function receipt(changedNodes: NoteView[], deletedIds: string[] = []): MutationReceipt {
  return {
    revision,
    changedNodes: copyNodes(changedNodes),
    deletedIds,
    history: previewHistory(undoStack.length, redoStack.length)
  };
}
function pushBoundedHistory(
  history: PreviewHistoryEntry[],
  entry: PreviewHistoryEntry
): void {
  history.push(entry);
  if (history.length > MAX_HISTORY_ENTRIES) {
    history.shift();
  }
}
function recordReceipt(requestId: string, value: MutationReceipt): void {
  receiptsByRequest.set(requestId, value);
  completedRequestOrder.push(requestId);
  if (completedRequestOrder.length > MAX_COMPLETED_REQUESTS) {
    const expiredRequestId = completedRequestOrder.shift();
    if (expiredRequestId) receiptsByRequest.delete(expiredRequestId);
  }
}
/**
 * Whether two commands name the same rows. A selection hands its ids over in
 * whatever order it holds them, and the order says nothing about which rows the
 * gesture was.
 */
function sameRows(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((id, index) => id === sortedRight[index]);
}

/**
 * The rows a completion command names when it sets them to `completed`, and
 * nothing for any other command. Mirrors the server's own reading.
 */
function completionRows(
  command: CommandEnvelope["command"],
  completed: boolean
): readonly string[] | null {
  if (command.kind === "setCompleted" && command.completed === completed) {
    return [command.id];
  }
  if (command.kind === "setCompletedMany" && command.completed === completed) {
    return command.ids;
  }
  return null;
}

function applyHistoryDelta(delta: PreviewNodeDelta): MutationReceipt {
  nodes = applyPreviewDelta(nodes, delta);
  revision += 1;
  return receipt([...delta.upserts], [...delta.receiptDeletedIds]);
}

function sortKeyBefore(
  parentId: string,
  beforeId: string | null,
  excludeId?: string
): number {
  const allocation = allocateSiblingSortKey(
    nodes,
    parentId,
    beforeId,
    excludeId
  );
  nodes = [...applyRebalancedSortKeys(
    nodes,
    allocation.rebalancedSortKeys
  )];
  return allocation.sortKey;
}

/**
 * Puts a row's children where the row stood, under `parentId`, and answers with
 * the children it moved. The blank-row removal and the merge into a parent both
 * take one row out of the middle of a list and leave its branch behind --
 * notes-core shares one helper for that, so this mirror does too.
 */
function liftChildrenInto(source: NoteView, parentId: string): NoteView[] {
  const children = previewSiblings(nodes, source.id);
  const siblings = previewSiblings(nodes, parentId);
  const sourceIndex = siblings.findIndex((node) => node.id === source.id);
  const nextKey = siblings[sourceIndex + 1]?.sortKey;
  children.forEach((child, index) => {
    child.parentId = parentId;
    child.sortKey = nextKey === undefined
      ? source.sortKey + (index + 1) * SORT_KEY_STEP
      : source.sortKey +
        Math.trunc((nextKey - source.sortKey) * (index + 1) / (children.length + 1));
  });
  return children;
}

function duplicateSubtree(
  sourceId: string,
  newId: string,
  parentId: string,
  beforeId: string | null
): NoteView[] {
  const sourceNodes = previewVisibleSubtree(nodes, sourceId);
  const copiedIds = new Map<string, string>([[sourceId, newId]]);
  return sourceNodes.map((source, index) => {
    const copiedId = index === 0 ? newId : `${newId}/${index}`;
    copiedIds.set(source.id, copiedId);
    const copiedParentId = index === 0
      ? parentId
      : copiedIds.get(source.parentId ?? "")!;
    const copy = {
      ...source,
      id: copiedId,
      parentId: copiedParentId,
      sortKey: index === 0
        ? sortKeyBefore(parentId, beforeId)
        : source.sortKey,
      deleted: false
    };
    nodes.push(copy);
    return copy;
  });
}

async function execute(envelope: CommandEnvelope): Promise<MutationReceipt> {
  const priorReceipt = receiptsByRequest.get(envelope.requestId);
  if (priorReceipt) return priorReceipt;
  if (envelope.baseRevision !== revision) {
    throw { code: "revision_conflict", message: "Preview revision is stale.", retryable: true };
  }
  // Every referenced hash is weighed here, before the redo stack is cleared, so
  // a rejected paste fails whole and leaves both stacks alone, as Rust does.
  validatePreviewBatch(nodes, envelope.command, (contentHash, byteLength) =>
    previewImages.holds(contentHash, byteLength));
  const previousNodes = copyNodes();
  redoStack.length = 0;
  // Clearing the very rows the last command ticked replays that command's own
  // inverse, so every row it reached is handed back what it held before rather
  // than cleared with the rest -- the server's own rule, mirrored. It goes
  // forward as its own history entry, so undo puts the branch back.
  const cleared = completionRows(envelope.command, false);
  const tick = undoStack.at(-1);
  if (cleared && tick?.completedRows && sameRows(tick.completedRows, cleared)) {
    pushBoundedHistory(undoStack, {
      forward: tick.inverse,
      inverse: tick.forward
    });
    const restored = applyHistoryDelta(tick.inverse);
    recordReceipt(envelope.requestId, restored);
    return restored;
  }
  let changed: NoteView[] = [];
  let deletedIds: string[] = [];
  const command = envelope.command;
  switch (command.kind) {
    case "createNode": {
      const node: NoteView = {
        id: command.id,
        parentId: command.parent_id,
        sortKey: sortKeyBefore(command.parent_id, command.before_id),
        kind: "bullet", image: null, text: command.text, note: "", marker: "bullet",
        collapsed: false, completed: false, starred: false, deleted: false
      };
      nodes.push(node);
      changed = [node];
      break;
    }
    case "importNodes": {
      for (const imported of command.nodes) {
        const isRoot = imported.parentId === command.parent_id;
        const image = imported.image ?? null;
        const node: NoteView = {
          id: imported.id,
          parentId: imported.parentId,
          sortKey: sortKeyBefore(
            imported.parentId,
            isRoot ? command.before_id : null
          ),
          kind: image ? "image" : "bullet",
          image,
          // An image node carries its file name as text, as notes-core keeps it.
          text: image ? image.originalName : imported.text,
          note: imported.note ?? "",
          marker: imported.marker ?? "bullet",
          collapsed: imported.collapsed ?? false,
          completed: imported.completed ?? false,
          starred: imported.starred ?? false,
          deleted: false
        };
        nodes.push(node);
        changed.push(node);
      }
      break;
    }
    case "updateText": {
      const node = nodes.find((candidate) => candidate.id === command.id);
      if (node) {
        node.text = command.text;
        changed = [node];
      }
      break;
    }
    case "updateNote": {
      const node = nodes.find((candidate) => candidate.id === command.id);
      if (node) {
        node.note = command.note;
        changed = [node];
      }
      break;
    }
    case "splitNode": {
      const source = nodes.find((candidate) => candidate.id === command.id);
      if (source) {
        // notes-core answers DomainError::Invariant here: a split may only put
        // the new half beside the source or inside it.
        const nested = command.parent_id === command.id;
        if (!nested && command.parent_id !== source.parentId) {
          throw new Error(
            `split source ${command.id} is neither a child of ` +
            `${command.parent_id} nor ${command.parent_id} itself`
          );
        }
        source.text = command.prefix;
        // The nested half would be hidden under a collapsed source, so the same
        // command opens it, as notes-core does.
        if (nested) source.collapsed = false;
        const node: NoteView = {
          id: command.new_id,
          parentId: command.parent_id,
          sortKey: sortKeyBefore(command.parent_id, command.before_id),
          kind: "bullet", image: null,
          text: command.suffix,
          note: "",
          // notes-core carries the source's marker onto the new half, never its
          // tick, so a run of To-dos or numbers keeps going under Enter.
          marker: source.marker,
          collapsed: false,
          completed: false,
          starred: false,
          deleted: false
        };
        nodes.push(node);
        changed = [source, node];
      }
      break;
    }
    case "mergeNodeBackward": {
      const current = nodes.find((candidate) => candidate.id === command.id);
      const previous = nodes.find(
        (candidate) => candidate.id === command.previous_id
      );
      if (current && previous) {
        current.text = command.previous_text + command.current_text;
        current.sortKey = previous.sortKey;
        nodes = nodes.filter((node) => node.id !== previous.id);
        changed = [current];
        deletedIds = [previous.id];
      }
      break;
    }
    case "removeEmptyNode": {
      const source = nodes.find((candidate) => candidate.id === command.id);
      if (
        source &&
        (source.text.trim().length > 0 || source.note.trim().length > 0)
      ) {
        // notes-core answers DomainError::NodeNotEmpty here
        throw new Error(`node is not empty: ${command.id}`);
      }
      if (source?.parentId) {
        changed = liftChildrenInto(source, source.parentId);
        nodes = nodes.filter((node) => node.id !== source.id);
        deletedIds = [source.id];
      }
      break;
    }
    case "mergeNodeIntoParent": {
      const source = nodes.find((candidate) => candidate.id === command.id);
      const parent = nodes.find(
        (candidate) => candidate.id === command.parent_id
      );
      if (source && parent) {
        parent.text = command.parent_text + command.current_text;
        changed = [parent, ...liftChildrenInto(source, parent.id)];
        nodes = nodes.filter((node) => node.id !== source.id);
        deletedIds = [source.id];
      }
      break;
    }
    case "moveNode": {
      const node = nodes.find((candidate) => candidate.id === command.id);
      if (node) {
        node.parentId = command.parent_id;
        node.sortKey = sortKeyBefore(
          command.parent_id,
          command.before_id,
          command.id
        );
        changed = [node];
      }
      break;
    }
    case "moveNodes": {
      for (const move of command.moves) {
        const node = nodes.find((candidate) => candidate.id === move.id);
        if (!node) continue;
        node.parentId = move.parentId;
        node.sortKey = sortKeyBefore(move.parentId, move.beforeId, move.id);
        changed.push(node);
        const parent = nodes.find((candidate) => candidate.id === move.parentId);
        if (parent?.collapsed) {
          parent.collapsed = false;
          changed.push(parent);
        }
      }
      break;
    }
    case "indent": {
      const node = nodes.find((candidate) => candidate.id === command.id);
      if (node) {
        node.parentId = command.new_parent_id;
        changed = [node];
      }
      break;
    }
    case "outdent": {
      const node = nodes.find((candidate) => candidate.id === command.id);
      if (node) {
        node.parentId = command.new_parent_id;
        changed = [node];
      }
      break;
    }
    case "duplicate": {
      changed = duplicateSubtree(
        command.id,
        command.new_id,
        command.parent_id,
        command.before_id
      );
      break;
    }
    case "duplicateNodes": {
      for (const duplicate of command.duplicates) {
        changed.push(...duplicateSubtree(
          duplicate.id,
          duplicate.newId,
          duplicate.parentId,
          duplicate.beforeId
        ));
      }
      break;
    }
    case "setCompleted": {
      // The desktop's server settles the whole Todo chain from one tick, so
      // the preview does too.
      const cascade = new Set(
        completionCascade(nodes, command.id, command.completed)
      );
      changed = nodes.filter((node) => cascade.has(node.id));
      changed.forEach((node) => {
        node.completed = command.completed;
      });
      break;
    }
    case "setStarred": {
      const node = nodes.find((candidate) => candidate.id === command.id);
      if (node) {
        node.starred = command.starred;
        changed = [node];
      }
      break;
    }
    case "setCompletedMany": {
      // Each listed row settles its own chain, in order and against the rows
      // the earlier ids already flipped, the way the server's bulk cascade
      // does.
      const cascade = new Set<string>();
      for (const id of command.ids) {
        for (const cascadedId of completionCascade(nodes, id, command.completed)) {
          cascade.add(cascadedId);
          const node = nodes.find((candidate) => candidate.id === cascadedId);
          if (node) node.completed = command.completed;
        }
      }
      changed = nodes.filter((node) => cascade.has(node.id));
      break;
    }
    case "setCollapsed":
    case "setMarker": {
      const node = nodes.find((candidate) => candidate.id === command.id);
      if (node) {
        if (command.kind === "setCollapsed") node.collapsed = command.collapsed;
        else node.marker = command.marker;
        changed = [node];
      }
      break;
    }
    case "deleteSubtree": {
      changed = previewDescendants(nodes, command.id);
      changed.forEach((node) => { node.deleted = true; });
      deletedIds = changed.map((node) => node.id);
      break;
    }
    case "deleteSubtrees": {
      const selected = new Set(
        command.ids.flatMap((id) =>
          previewDescendants(nodes, id).map((node) => node.id))
      );
      changed = nodes.filter((node) => selected.has(node.id));
      changed.forEach((node) => {
        node.deleted = true;
      });
      deletedIds = changed.map((node) => node.id);
      break;
    }
    case "restoreSubtree": {
      changed = previewDescendants(nodes, command.id);
      changed.forEach((node) => { node.deleted = false; });
      break;
    }
  }
  // Settling first and opening second, because an open row that is still there
  // has the last word over one that left.
  for (const id of settleOverDepartedRows(previousNodes, nodes)) {
    const row = nodes.find((node) => node.id === id);
    if (row) row.completed = true;
  }
  for (const id of reopenOverPlacedRows(previousNodes, nodes)) {
    const row = nodes.find((node) => node.id === id);
    if (row) row.completed = false;
  }
  const generatedEntry = createPreviewHistoryEntry(previousNodes, nodes);
  const changedById = new Map(
    generatedEntry.forward.upserts.map((node) => [node.id, node])
  );
  const explicitlyChangedIds = new Set(changed.map((node) => node.id));
  const forwardChangedNodes = [
    ...changed.map((node) => changedById.get(node.id) ?? { ...node }),
    ...generatedEntry.forward.upserts.filter(
      (node) => !explicitlyChangedIds.has(node.id)
    )
  ];
  const explicitlyDeletedIds = new Set(deletedIds);
  const forwardDeletedIds = [
    ...deletedIds,
    ...generatedEntry.forward.receiptDeletedIds.filter(
      (id) => !explicitlyDeletedIds.has(id)
    )
  ];
  const ticked = completionRows(command, true);
  const group = envelope.historyGroup;
  const coalescing = group !== null &&
    historyGroupBaseline?.group === group &&
    undoStack.at(-1) === historyGroupBaseline.entry;
  const baseline = coalescing
    ? historyGroupBaseline!.nodes
    : previousNodes;
  const groupEntry = coalescing
    ? createPreviewHistoryEntry(baseline, nodes)
    : generatedEntry;
  const historyEntry: PreviewHistoryEntry = {
    ...groupEntry,
    forward: {
      ...groupEntry.forward,
      // The receipt's own rows, not the group's: the client redraws from this
      // command, and the entry only has to undo the whole gesture.
      upserts: coalescing ? groupEntry.forward.upserts : forwardChangedNodes,
      receiptDeletedIds: coalescing
        ? groupEntry.forward.receiptDeletedIds
        : forwardDeletedIds
    },
    ...(ticked ? { completedRows: ticked } : {})
  };
  if (coalescing) undoStack.pop();
  pushBoundedHistory(undoStack, historyEntry);
  historyGroupBaseline = group === null
    ? null
    : { group, nodes: baseline, entry: historyEntry };
  revision += 1;
  const nextReceipt = receipt(forwardChangedNodes, forwardDeletedIds);
  recordReceipt(envelope.requestId, nextReceipt);
  return nextReceipt;
}

const previewImages = new PreviewImages({
  sessionId,
  revision: () => revision,
  nodes: () => nodes,
  setNodes: (nextNodes) => {
    nodes = nextNodes;
  },
  copyNodes,
  sortKeyBefore: (parentId, beforeId) =>
    sortKeyBefore(parentId, beforeId),
  priorReceipt: (requestId) => receiptsByRequest.get(requestId),
  recordMutation: (previousNodes) => {
    redoStack.length = 0;
    pushBoundedHistory(
      undoStack,
      createPreviewHistoryEntry(previousNodes, nodes)
    );
  },
  advanceRevision: () => {
    revision += 1;
  },
  receipt: (changedNodes) => receipt(changedNodes),
  recordReceipt
});

export const previewNotesApi: NotesApi = {
  async bootstrap() {
    const pages = nodes
      .filter((node) => node.parentId === ROOT_ID && !node.deleted)
      .map((node) => ({
        id: node.id,
        title: node.text,
        sortKey: node.sortKey
      }))
      .sort((left, right) =>
        left.sortKey - right.sortKey || left.id.localeCompare(right.id));
    return {
      sessionId,
      revision,
      activePageId,
      pages,
      viewport: activePageId ? {
        pageId: activePageId,
        anchorId: null,
        beforeCursor: null,
        afterCursor: null,
        nodes: copyNodes(previewPageNodes(nodes, activePageId))
      } : null,
      history: previewHistory(undoStack.length, redoStack.length)
    };
  },
  async queryViewport(request) {
    return {
      pageId: request.pageId,
      anchorId: request.anchorId,
      beforeCursor: null,
      afterCursor: null,
      nodes: copyNodes(previewPageNodes(nodes, request.pageId))
        .slice(0, request.limit)
    };
  },
  queryForest: async (request) =>
    previewForest(nodes, request.rootIds, request.limit, revision),
  execute,
  importImageBytes: (request) => previewImages.importBytes(request),
  importImagePaths: (request) => previewImages.importPaths(request),
  replaceImageBytes: (request) => previewImages.replaceBytes(request),
  replaceImagePath: (request) => previewImages.replacePath(request),
  readImage: (request) => previewImages.read(request),
  viewImageOriginal: (request) => previewImages.viewOriginal(request),
  downloadImage: (request) => previewImages.download(request),
  async exportNotes(request) {
    const { exportPreviewNotes } = await import("./previewExport");
    return exportPreviewNotes(request, { sessionId, revision, nodes });
  },
  async undo(request) {
    if (request.baseRevision !== revision) throw new Error("Preview revision is stale.");
    const entry = undoStack.pop();
    if (!entry) return receipt([]);
    pushBoundedHistory(redoStack, entry);
    return applyHistoryDelta(entry.inverse);
  },
  async redo(request) {
    if (request.baseRevision !== revision) throw new Error("Preview revision is stale.");
    const entry = redoStack.pop();
    if (!entry) return receipt([]);
    pushBoundedHistory(undoStack, entry);
    return applyHistoryDelta(entry.forward);
  },
  async search(query) {
    const normalized = query.text.toLocaleLowerCase();
    return {
      hits: nodes
        .filter((node) => !node.deleted && node.text.toLocaleLowerCase().includes(normalized))
        .slice(0, query.limit)
        .map((node) => ({
          node: { ...node },
          pageId: node.parentId === ROOT_ID ? node.id : activePageId,
          snippet: node.text
        })),
      nextCursor: null
    };
  },
  async closeSession() {
    return "flushed";
  },
  async unusedAssets() {
    return { count: 0, totalBytes: 0, purged: false };
  },
  async deleteAllData() {
    // The browser preview keeps its in-memory fixture.
  },
  async syncVaultGet() {
    // No vault outside the desktop app: there is no folder to sync into.
    return null;
  },
  async syncAttachments() {
    // The preview has no folder to keep attachments in.
    return [];
  },
  async syncDeleteAttachment() {
    return false;
  },
  async syncStatus() {
    // The preview has no folder to have trouble with.
    return { refused: [], writeError: null, watchError: null };
  },
  async syncFlush() {
    // The preview holds nothing on its way to a folder.
  },
  async syncConflicts() {
    // The preview has no other device to disagree with.
    return [];
  },
  async syncForgetConflict() {
    // Nothing was ever overwritten in a fixture, so there is nothing to drop.
    return false;
  },
  async syncRestoreConflict() {
    // Same reason — nothing was ever overwritten.
  },
  async syncVaultSet() {
    // Same reason — the preview has nowhere to record a choice.
    return "empty" as const;
  },
  async rebuildFromVault() {
    // Nothing to read back: the preview's notes live in memory, not in files.
    return { documents: 0, unreadable: 0 };
  },
  async onboardingWriteGuide() {
    // The preview's outline is a fixture; there is no first run to guide.
  },
  async onboardingFirstRun() {
    // Same reason: the fixture is never a first run, so the card stays away.
    return false;
  }
};
