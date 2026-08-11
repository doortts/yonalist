import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { SORT_KEY_STEP } from "./outlineSortKeys";
import { ROOT_ID } from "./storeSupport";

export function createInitialPreviewNodes(): NoteView[] {
  return [
    {
      // The one row with no parent: Home, and every page is its child.
      id: ROOT_ID,
      parentId: null,
      sortKey: 0,
      kind: "page", image: null,
      text: "Home",
      note: "",
      marker: "bullet",
      collapsed: false,
      completed: false,
      starred: false,
      deleted: false
    },
    {
      id: "preview-page",
      parentId: ROOT_ID,
      sortKey: SORT_KEY_STEP,
      kind: "bullet", image: null,
      text: "Welcome to Yonalist",
      note: "",
      marker: "bullet",
      collapsed: false,
      completed: false,
      starred: false,
      deleted: false
    },
    {
      id: "preview-first",
      parentId: "preview-page",
      sortKey: SORT_KEY_STEP,
      kind: "bullet", image: null,
      text: "Start writing. Changes appear instantly.",
      note: "Shift+Enter opens a note like this one.\nIt can hold several lines.",
      marker: "bullet",
      collapsed: false,
      completed: false,
      starred: true,
      deleted: false
    },
    {
      // The preview keeps no bytes for a seeded picture, so this row renders
      // its placeholder. That is the state a real image shows while it loads.
      id: "preview-picture",
      parentId: "preview-page",
      sortKey: SORT_KEY_STEP * 2,
      kind: "image",
      image: {
        contentHash: "0".repeat(64),
        originalName: "sample.png",
        mimeType: "image/png",
        byteLength: 0,
        pixelWidth: 640,
        pixelHeight: 360,
        displayWidth: 480
      },
      text: "sample.png",
      note: "",
      marker: "bullet",
      collapsed: false,
      completed: false,
      starred: false,
      deleted: false
    }
  ];
}

export function previewPageNodes(
  nodes: readonly NoteView[],
  pageId: string
): NoteView[] {
  const descendants = new Set([pageId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (
        node.parentId &&
        descendants.has(node.parentId) &&
        !descendants.has(node.id)
      ) {
        descendants.add(node.id);
        changed = true;
      }
    }
  }
  // Image rows are page content too — filtering them out here left an
  // imported picture visible only until the next viewport query. The seed row
  // itself is the surface, not one of its own rows.
  const visible = nodes.filter(
    (node) =>
      node.id !== pageId &&
      !node.deleted &&
      descendants.has(node.id)
  );
  const children = new Map<string, NoteView[]>();
  for (const node of visible) {
    const siblings = children.get(node.parentId ?? "") ?? [];
    siblings.push(node);
    children.set(node.parentId ?? "", siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) =>
      left.sortKey - right.sortKey || left.id.localeCompare(right.id)
    );
  }
  const ordered: NoteView[] = [];
  const visit = (node: NoteView): void => {
    ordered.push(node);
    children.get(node.id)?.forEach(visit);
  };
  children.get(pageId)?.forEach(visit);
  return ordered;
}
