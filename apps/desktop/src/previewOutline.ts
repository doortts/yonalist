import type { NoteView } from "../../../packages/contracts/generated/NoteView";

export function createInitialPreviewNodes(): NoteView[] {
  return [
    {
      id: "preview-page",
      parentId: null,
      sortKey: 1024,
      kind: "page",
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
      sortKey: 1024,
      kind: "bullet",
      text: "Start writing. Changes appear instantly.",
      note: "",
      marker: "bullet",
      collapsed: false,
      completed: false,
      starred: true,
      deleted: false
    },
    {
      id: "preview-second",
      parentId: "preview-page",
      sortKey: 2048,
      kind: "bullet",
      text: "Press Enter to add another thought.",
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
  const visible = nodes.filter(
    (node) =>
      node.kind === "bullet" &&
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
