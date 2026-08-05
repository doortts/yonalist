import type { NoteView } from "../../../packages/contracts/generated/NoteView";

const MAX_CLIPBOARD_NODES = 2_000;
const MAX_CLIPBOARD_DEPTH = 64;
const MAX_TITLE_UTF8_BYTES = 100_000;

export function normalizeSelectedRoots(
  nodes: readonly NoteView[],
  selectedIds: readonly string[]
): readonly string[] {
  if (selectedIds.length === 0) return [];
  const selected = new Set(selectedIds);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes
    .filter((node) => selected.has(node.id))
    .filter((node) => {
      let parentId = node.parentId;
      const visited = new Set<string>();
      while (parentId && visited.add(parentId)) {
        if (selected.has(parentId)) return false;
        parentId = byId.get(parentId)?.parentId ?? null;
      }
      return true;
    })
    .map((node) => node.id);
}

export function serializeSelectedOutline(
  nodes: readonly NoteView[],
  drafts: Readonly<Record<string, string>>,
  selectedIds: readonly string[]
): string | null {
  const roots = normalizeSelectedRoots(nodes, selectedIds);
  if (roots.length === 0 || roots.length > MAX_CLIPBOARD_NODES) return null;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, NoteView[]>();
  for (const node of nodes) {
    if (!node.parentId || node.deleted) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) =>
      left.sortKey - right.sortKey || left.id.localeCompare(right.id));
  }

  const pending = roots
    .slice()
    .reverse()
    .map((id) => ({ id, depth: 0 }));
  const lines: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const node = byId.get(current.id);
    if (
      !node ||
      current.depth >= MAX_CLIPBOARD_DEPTH ||
      lines.length >= MAX_CLIPBOARD_NODES
    ) {
      return null;
    }
    const title = (drafts[node.id] ?? node.text).replace(/\r\n|\r|\n/g, " ");
    if (new TextEncoder().encode(title).byteLength > MAX_TITLE_UTF8_BYTES) return null;
    lines.push(`${"  ".repeat(current.depth)}${title ? `- ${title}` : "-"}`);
    const nodeChildren = children.get(node.id) ?? [];
    for (let index = nodeChildren.length - 1; index >= 0; index -= 1) {
      pending.push({ id: nodeChildren[index].id, depth: current.depth + 1 });
    }
  }
  return lines.join("\n");
}

export function canCutSelectedOutline(
  nodes: readonly NoteView[],
  drafts: Readonly<Record<string, string>>,
  noteDrafts: Readonly<Record<string, string>>,
  selectedIds: readonly string[]
): boolean {
  const roots = new Set(normalizeSelectedRoots(nodes, selectedIds));
  if (roots.size === 0) return false;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.every((node) => {
    let current: NoteView | undefined = node;
    const visited = new Set<string>();
    let selectedSubtree = false;
    while (current && visited.add(current.id)) {
      if (roots.has(current.id)) {
        selectedSubtree = true;
        break;
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (!selectedSubtree) return true;
    const title = drafts[node.id] ?? node.text;
    const note = noteDrafts[node.id] ?? node.note;
    return !/[\r\n]/u.test(title) && note.length === 0;
  });
}

export function writeOutlineClipboardEvent(
  clipboardData: Pick<DataTransfer, "setData">,
  text: string
): boolean {
  try {
    clipboardData.setData("text/plain", text);
    clipboardData.setData("text/markdown", text);
    return true;
  } catch {
    return false;
  }
}

export async function writeOutlineClipboard(text: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard) throw new Error("Clipboard access is unavailable.");
  if (typeof ClipboardItem === "function" && typeof clipboard.write === "function") {
    try {
      const blob = new Blob([text], { type: "text/plain" });
      await clipboard.write([new ClipboardItem({
        "text/plain": blob,
        "text/markdown": new Blob([text], { type: "text/markdown" })
      })]);
      return;
    } catch {
      // Some WebViews expose ClipboardItem but reject custom MIME writes.
    }
  }
  if (typeof clipboard.writeText === "function") {
    await clipboard.writeText(text);
    return;
  }
  throw new Error("Clipboard write is unavailable.");
}
