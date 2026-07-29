import type { CommandEnvelope } from "../../../packages/contracts/generated/CommandEnvelope";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import type { ImageImportRequest, ImageReplaceRequest } from "./imageApi";
import { previewForest } from "./previewForest";
import { previewHistory } from "./previewHistory";
import {
  createInitialPreviewNodes,
  previewPageNodes
} from "./previewOutline";
import { validatePreviewBatch } from "./previewValidation";
import {
  allocateSiblingSortKey,
  applyRebalancedSortKeys
} from "./outlineSortKeys";
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
const redoStack: PreviewHistoryEntry[] = [];
const receiptsByRequest = new Map<string, MutationReceipt>();
const completedRequestOrder: string[] = [];
const imageBlobs = new Map<string, Blob>();
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
function applyHistoryDelta(delta: PreviewNodeDelta): MutationReceipt {
  nodes = applyPreviewDelta(nodes, delta);
  revision += 1;
  return receipt([...delta.upserts], [...delta.receiptDeletedIds]);
}

async function importImageBytes(
  request: ImageImportRequest
): Promise<MutationReceipt> {
  const priorReceipt = receiptsByRequest.get(request.requestId);
  if (priorReceipt) return priorReceipt;
  if (request.sessionId !== sessionId) {
    throw new Error("Preview session does not match.");
  }
  if (request.baseRevision !== revision) {
    throw new Error("Preview revision is stale.");
  }
  if (request.images.length === 0) {
    throw new Error("The preview image batch is empty.");
  }

  const previousNodes = copyNodes();
  redoStack.length = 0;
  const changed: NoteView[] = [];
  for (const input of request.images) {
    const mimeType = input.declaredMimeType || input.blob.type;
    const extension = extensionForMime(mimeType);
    if (!extension) throw new Error("The preview image type is unsupported.");
    const bytes = new Uint8Array(await input.blob.arrayBuffer());
    const contentHash = await hashBytes(bytes);
    const dimensions = await imageDimensions(input.blob);
    const node: NoteView = {
      id: input.nodeId,
      parentId: request.parentId,
      sortKey: sortKeyBefore(request.parentId, request.beforeId),
      kind: "image",
      image: {
        contentHash,
        originalName: input.originalName,
        mimeType,
        byteLength: bytes.length,
        pixelWidth: dimensions.width,
        pixelHeight: dimensions.height,
        displayWidth: 320
      },
      text: input.originalName,
      note: "",
      marker: "bullet",
      collapsed: false,
      completed: false,
      starred: false,
      deleted: false
    };
    nodes.push(node);
    changed.push(node);
    imageBlobs.set(contentHash, input.blob);
  }
  const historyEntry = createPreviewHistoryEntry(previousNodes, nodes);
  pushBoundedHistory(undoStack, historyEntry);
  revision += 1;
  const nextReceipt = receipt(changed);
  recordReceipt(request.requestId, nextReceipt);
  return nextReceipt;
}

async function importImagePaths(): Promise<never> {
  throw new Error("Native image paths are unavailable in browser preview.");
}

async function replaceImageBytes(
  request: ImageReplaceRequest
): Promise<MutationReceipt> {
  const priorReceipt = receiptsByRequest.get(request.requestId);
  if (priorReceipt) return priorReceipt;
  if (request.sessionId !== sessionId || request.baseRevision !== revision) {
    throw new Error("Preview image replacement context is stale.");
  }
  const position = nodes.findIndex((node) =>
    node.id === request.targetId &&
    node.kind === "image" &&
    !node.deleted
  );
  const target = nodes[position];
  if (position < 0 || !target?.image) throw new Error("Image unavailable");
  const mimeType = request.image.declaredMimeType || request.image.blob.type;
  if (!extensionForMime(mimeType)) {
    throw new Error("The preview image type is unsupported.");
  }
  const bytes = new Uint8Array(await request.image.blob.arrayBuffer());
  const contentHash = await hashBytes(bytes);
  const dimensions = await imageDimensions(request.image.blob);
  const replacement: NoteView = {
    ...target,
    text: request.image.originalName,
    image: {
      contentHash,
      originalName: request.image.originalName,
      mimeType,
      byteLength: bytes.length,
      pixelWidth: dimensions.width,
      pixelHeight: dimensions.height,
      displayWidth: target.image.displayWidth
    }
  };
  const previousNodes = copyNodes();
  nodes = nodes.map((node, index) => index === position ? replacement : node);
  imageBlobs.set(contentHash, request.image.blob);
  redoStack.length = 0;
  pushBoundedHistory(undoStack, createPreviewHistoryEntry(previousNodes, nodes));
  revision += 1;
  const nextReceipt = receipt([replacement]);
  recordReceipt(request.requestId, nextReceipt);
  return nextReceipt;
}

async function replaceImagePath(): Promise<never> {
  throw new Error("Native image paths are unavailable in browser preview.");
}

async function viewImageOriginal(request: {
  readonly sessionId: string;
  readonly nodeId: string;
}): Promise<void> {
  await readImage(request);
}

async function downloadImage(request: {
  readonly sessionId: string;
  readonly nodeId: string;
}): Promise<void> {
  await readImage(request);
}

async function readImage(
  request: { readonly sessionId: string; readonly nodeId: string }
): Promise<Uint8Array> {
  if (request.sessionId !== sessionId) {
    throw new Error("Preview session does not match.");
  }
  const node = nodes.find((candidate) =>
    candidate.id === request.nodeId &&
    candidate.kind === "image" &&
    !candidate.deleted
  );
  const blob = node?.image ? imageBlobs.get(node.image.contentHash) : undefined;
  if (!node?.image || !blob) throw new Error("Image unavailable");
  return new Uint8Array(await blob.arrayBuffer());
}

function extensionForMime(mimeType: string): string | null {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  return null;
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digestInput = new Uint8Array(bytes.length);
    digestInput.set(bytes);
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      digestInput.buffer
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  let value = 0;
  bytes.forEach((byte) => {
    value = Math.imul(value ^ byte, 16_777_619) >>> 0;
  });
  return value.toString(16).padStart(8, "0").repeat(8);
}

async function imageDimensions(
  blob: Blob
): Promise<{ readonly width: number; readonly height: number }> {
  if (typeof globalThis.createImageBitmap !== "function") {
    return { width: 1, height: 1 };
  }
  const bitmap = await globalThis.createImageBitmap(blob);
  const dimensions = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return dimensions;
}

function descendantsOf(id: string): NoteView[] {
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        changed = true;
      }
    }
  }
  return nodes.filter((node) => ids.has(node.id));
}

function visibleSubtreeOf(id: string): NoteView[] {
  const subtree: NoteView[] = [];
  const visit = (nodeId: string): void => {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.deleted) return;
    subtree.push(node);
    siblingsOf(nodeId).forEach((child) => visit(child.id));
  };
  visit(id);
  return subtree;
}

function siblingsOf(parentId: string, excludeId?: string): NoteView[] {
  return nodes
    .filter((node) =>
      node.parentId === parentId &&
      node.id !== excludeId &&
      !node.deleted
    )
    .sort((left, right) =>
      left.sortKey - right.sortKey || left.id.localeCompare(right.id)
    );
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

function duplicateSubtree(
  sourceId: string,
  newId: string,
  parentId: string,
  beforeId: string | null
): NoteView[] {
  const sourceNodes = visibleSubtreeOf(sourceId);
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
  validatePreviewBatch(nodes, envelope.command);
  const previousNodes = copyNodes();
  redoStack.length = 0;
  let changed: NoteView[] = [];
  let deletedIds: string[] = [];
  const command = envelope.command;
  switch (command.kind) {
    case "createPage": {
      const node: NoteView = {
        id: command.id, parentId: null, sortKey: nodes.length * 1024 + 1024,
        kind: "page", image: null, text: command.text, note: "", marker: "bullet",
        collapsed: false, completed: false, starred: false, deleted: false
      };
      nodes.push(node);
      activePageId = node.id;
      changed = [node];
      break;
    }
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
        const node: NoteView = {
          id: imported.id,
          parentId: imported.parentId,
          sortKey: sortKeyBefore(
            imported.parentId,
            isRoot ? command.before_id : null
          ),
          kind: "bullet", image: null,
          text: imported.text,
          note: "",
          marker: "bullet",
          collapsed: false,
          completed: false,
          starred: false,
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
        source.text = command.prefix;
        const node: NoteView = {
          id: command.new_id,
          parentId: command.parent_id,
          sortKey: sortKeyBefore(command.parent_id, command.before_id),
          kind: "bullet", image: null,
          text: command.suffix,
          note: "",
          marker: "bullet",
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
        source?.parentId &&
        source.text.trim().length === 0 &&
        source.note.trim().length === 0
      ) {
        const children = siblingsOf(source.id);
        const parentId = source.parentId;
        const siblings = siblingsOf(parentId);
        const sourceIndex = siblings.findIndex((node) => node.id === source.id);
        const nextKey = siblings[sourceIndex + 1]?.sortKey;
        children.forEach((child, index) => {
          child.parentId = parentId;
          child.sortKey = nextKey === undefined
            ? source.sortKey + (index + 1) * 1024
            : source.sortKey +
              Math.trunc((nextKey - source.sortKey) * (index + 1) / (children.length + 1));
        });
        nodes = nodes.filter((node) => node.id !== source.id);
        changed = children;
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
    case "setCompleted":
    case "setStarred": {
      const node = nodes.find((candidate) => candidate.id === command.id);
      if (node) {
        if (command.kind === "setCompleted") node.completed = command.completed;
        else node.starred = command.starred;
        changed = [node];
      }
      break;
    }
    case "setCompletedMany": {
      changed = nodes.filter((node) => command.ids.includes(node.id));
      changed.forEach((node) => {
        node.completed = command.completed;
      });
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
      changed = descendantsOf(command.id);
      changed.forEach((node) => { node.deleted = true; });
      deletedIds = changed.map((node) => node.id);
      break;
    }
    case "deleteSubtrees": {
      const selected = new Set(
        command.ids.flatMap((id) => descendantsOf(id).map((node) => node.id))
      );
      changed = nodes.filter((node) => selected.has(node.id));
      changed.forEach((node) => {
        node.deleted = true;
      });
      deletedIds = changed.map((node) => node.id);
      break;
    }
    case "restoreSubtree": {
      changed = descendantsOf(command.id);
      changed.forEach((node) => { node.deleted = false; });
      break;
    }
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
  const historyEntry: PreviewHistoryEntry = {
    ...generatedEntry,
    forward: {
      ...generatedEntry.forward,
      upserts: forwardChangedNodes,
      receiptDeletedIds: forwardDeletedIds
    }
  };
  pushBoundedHistory(undoStack, historyEntry);
  revision += 1;
  const nextReceipt = receipt(forwardChangedNodes, forwardDeletedIds);
  recordReceipt(envelope.requestId, nextReceipt);
  return nextReceipt;
}

export const previewNotesApi: NotesApi = {
  async bootstrap() {
    const pages = nodes
      .filter((node) => node.kind === "page" && !node.deleted)
      .map((node) => ({ id: node.id, title: node.text }));
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
  importImageBytes,
  importImagePaths,
  replaceImageBytes,
  replaceImagePath,
  readImage,
  viewImageOriginal,
  downloadImage,
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
          pageId: node.kind === "page" ? node.id : activePageId,
          snippet: node.text
        })),
      nextCursor: null
    };
  },
  async closeSession() {
    return "flushed";
  }
};
