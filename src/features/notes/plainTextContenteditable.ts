import type { NotesHistoryPrimarySelection } from "./notesHistory";

export interface PlainTextSnapshot {
  readonly source: string;
  readonly selection: NotesHistoryPrimarySelection;
}

function normalizedText(value: string): string {
  return value
    .replaceAll("\u00a0", " ")
    .replace(/[\u2028\u2029]/gu, "\n");
}

function readNodes(root: Node): string {
  let source = "";
  for (const child of root.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      source += child.nodeValue ?? "";
    } else if (
      child.nodeType === Node.ELEMENT_NODE &&
      (child as Element).tagName === "BR"
    ) {
      source += "\n";
    } else {
      source += readNodes(child);
    }
  }
  return normalizedText(source);
}

export function readPlainText(root: HTMLElement): string {
  const source = readNodes(root);
  return root.lastChild instanceof HTMLBRElement && source.endsWith("\n")
    ? source.slice(0, -1)
    : source;
}

function containsEndpoint(root: HTMLElement, node: Node | null): node is Node {
  return node !== null && (node === root || root.contains(node));
}

function offsetFromRoot(
  root: HTMLElement,
  node: Node,
  offset: number
): number | null {
  try {
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    const fragment = range.cloneContents();
    return readNodes(fragment).length;
  } catch {
    return null;
  }
}

export function readPlainTextSelection(
  root: HTMLElement
): NotesHistoryPrimarySelection | null {
  const selection = root.ownerDocument.getSelection();
  if (
    !selection ||
    !containsEndpoint(root, selection.anchorNode) ||
    !containsEndpoint(root, selection.focusNode)
  ) {
    return null;
  }
  const anchorUtf16 = offsetFromRoot(
    root,
    selection.anchorNode,
    selection.anchorOffset
  );
  const focusUtf16 = offsetFromRoot(
    root,
    selection.focusNode,
    selection.focusOffset
  );
  if (anchorUtf16 === null || focusUtf16 === null) return null;
  const length = readPlainText(root).length;
  return {
    anchorUtf16: Math.min(length, anchorUtf16),
    focusUtf16: Math.min(length, focusUtf16)
  };
}

function textEndpoint(
  root: HTMLElement,
  requestedOffset: number
): { readonly node: Node; readonly offset: number } {
  const sourceLength = readPlainText(root).length;
  let remaining = Math.max(0, Math.min(sourceLength, requestedOffset));
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode();
  let lastTextNode: Text | null = null;
  while (textNode) {
    const text = textNode as Text;
    lastTextNode = text;
    if (remaining <= text.data.length) {
      return { node: text, offset: remaining };
    }
    remaining -= text.data.length;
    textNode = walker.nextNode();
  }
  return lastTextNode
    ? { node: lastTextNode, offset: lastTextNode.data.length }
    : { node: root, offset: 0 };
}

export function restorePlainTextSelection(
  root: HTMLElement,
  selection: NotesHistoryPrimarySelection
): boolean {
  if (!root.isConnected) return false;
  const anchor = textEndpoint(root, selection.anchorUtf16);
  const focus = textEndpoint(root, selection.focusUtf16);
  try {
    root.ownerDocument
      .getSelection()
      ?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    return root.ownerDocument.getSelection()?.anchorNode !== null;
  } catch {
    return false;
  }
}

export function replacePlainText(
  root: HTMLElement,
  source: string,
  selection: NotesHistoryPrimarySelection = {
    anchorUtf16: source.length,
    focusUtf16: source.length
  }
): boolean {
  root.replaceChildren(
    ...(source.length > 0 ? [root.ownerDocument.createTextNode(source)] : [])
  );
  return restorePlainTextSelection(root, selection);
}

export function insertPlainTextAtSelection(
  root: HTMLElement,
  text: string
): PlainTextSnapshot | null {
  const selection = root.ownerDocument.getSelection();
  if (
    !selection ||
    selection.rangeCount === 0 ||
    !containsEndpoint(root, selection.anchorNode) ||
    !containsEndpoint(root, selection.focusNode)
  ) {
    return null;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const inserted = root.ownerDocument.createTextNode(text);
  range.insertNode(inserted);
  range.setStartAfter(inserted);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  const nextSelection = readPlainTextSelection(root);
  return nextSelection
    ? { source: readPlainText(root), selection: nextSelection }
    : null;
}
