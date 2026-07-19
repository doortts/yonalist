import type { LogicalSelection } from "./imageAtomModel";

export const IMAGE_ATOM_CARET_AID_ATTRIBUTE = "data-image-atom-caret-aid";
export const IMAGE_ATOM_OVERLAY_ATTRIBUTE = "data-image-atom-overlay";

export interface ImageAtomDomRegions {
  readonly host: HTMLElement;
  readonly before: HTMLElement;
  readonly atom: HTMLElement;
  readonly after: HTMLElement;
}

type DomPoint = {
  readonly node: Node;
  readonly offset: number;
};

type EndpointRole = "start" | "end";

function clamp(value: number, maximum: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? Math.trunc(value) : 0, 0), maximum);
}

function pointOffset(node: Node, offset: number): number {
  return clamp(
    offset,
    node.nodeType === Node.TEXT_NODE ? node.textContent?.length ?? 0 : node.childNodes.length
  );
}

function isIgnoredText(node: Text, root: HTMLElement): boolean {
  for (
    let element = node.parentElement;
    element && element !== root;
    element = element.parentElement
  ) {
    if (
      element.hasAttribute(IMAGE_ATOM_CARET_AID_ATTRIBUTE) ||
      element.hasAttribute(IMAGE_ATOM_OVERLAY_ATTRIBUTE) ||
      element.classList.contains("notes-token-text")
    ) {
      return true;
    }
  }
  return false;
}

function textNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!isIgnoredText(node as Text, root)) nodes.push(node as Text);
  }
  return nodes;
}

function textLength(nodes: readonly Text[]): number {
  return nodes.reduce((length, node) => length + node.length, 0);
}

function normalizeTextOffset(nodes: readonly Text[], offset: number): number {
  const source = nodes.map((node) => node.data).join("");
  const normalized = clamp(offset, source.length);
  return normalized > 0 &&
    normalized < source.length &&
    source.charCodeAt(normalized - 1) >= 0xd800 &&
    source.charCodeAt(normalized - 1) <= 0xdbff &&
    source.charCodeAt(normalized) >= 0xdc00 &&
    source.charCodeAt(normalized) <= 0xdfff
    ? normalized - 1
    : normalized;
}

function pointInRegion(
  nodes: readonly Text[],
  node: Node,
  offset: number
): number {
  const normalizedOffset = pointOffset(node, offset);
  let length = 0;
  for (const textNode of nodes) {
    if (textNode === node) {
      return normalizeTextOffset(nodes, length + normalizedOffset);
    }
    const range = document.createRange();
    range.selectNodeContents(textNode);
    if (range.comparePoint(node, normalizedOffset) === 1) {
      length += textNode.length;
    }
  }
  return normalizeTextOffset(nodes, length);
}

function pointForRegionOffset(
  root: HTMLElement,
  nodes: readonly Text[],
  offset: number
): DomPoint {
  let remaining = normalizeTextOffset(nodes, offset);
  for (const textNode of nodes) {
    if (remaining <= textNode.length) {
      return { node: textNode, offset: remaining };
    }
    remaining -= textNode.length;
  }
  return { node: root, offset: 0 };
}

function isIn(root: HTMLElement, node: Node): boolean {
  return root === node || root.contains(node);
}

function textOffsetWithin(root: HTMLElement, node: Node, offset: number): number | null {
  if (!isIn(root, node)) return null;
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(node, pointOffset(node, offset));
  } catch {
    return null;
  }
  return range.toString().length;
}

function hostPointOffset(
  regions: ImageAtomDomRegions,
  node: Node,
  offset: number,
  beforeLength: number,
  afterLength: number
): number | null {
  if (node !== regions.host) return null;
  const childOffset = pointOffset(node, offset);
  const beforeIndex = Array.prototype.indexOf.call(
    regions.host.childNodes,
    regions.before
  ) as number;
  const atomIndex = Array.prototype.indexOf.call(
    regions.host.childNodes,
    regions.atom
  ) as number;
  const afterIndex = Array.prototype.indexOf.call(
    regions.host.childNodes,
    regions.after
  ) as number;
  if (beforeIndex < 0 || atomIndex < 0 || afterIndex < 0) return null;
  if (childOffset <= beforeIndex) return 0;
  if (childOffset <= atomIndex) return beforeLength;
  if (childOffset <= afterIndex) return beforeLength + 1;
  return beforeLength + 1 + afterLength;
}

function outsidePointOffset(
  regions: ImageAtomDomRegions,
  node: Node,
  offset: number,
  beforeLength: number,
  afterLength: number
): number {
  const hostOffset = hostPointOffset(
    regions,
    node,
    offset,
    beforeLength,
    afterLength
  );
  if (hostOffset !== null) return hostOffset;
  const normalizedOffset = pointOffset(node, offset);
  for (const [region, boundary] of [
    [regions.before, 0],
    [regions.atom, beforeLength],
    [regions.after, beforeLength + 1]
  ] as const) {
    const range = document.createRange();
    range.selectNode(region);
    try {
      if (range.comparePoint(node, normalizedOffset) <= 0) return boundary;
    } catch {
      return 0;
    }
  }
  return beforeLength + 1 + afterLength;
}

function endpointRoles(selection: Selection): {
  readonly anchor: EndpointRole;
  readonly focus: EndpointRole;
} {
  if (selection.isCollapsed) return { anchor: "start", focus: "start" };
  const range = selection.getRangeAt(0);
  const anchorIsStart =
    selection.anchorNode === range.startContainer &&
    selection.anchorOffset === range.startOffset;
  return anchorIsStart
    ? { anchor: "start", focus: "end" }
    : { anchor: "end", focus: "start" };
}

function readPoint(
  regions: ImageAtomDomRegions,
  nodes: { readonly before: readonly Text[]; readonly after: readonly Text[] },
  node: Node,
  offset: number,
  role: EndpointRole
): number {
  const beforeLength = textLength(nodes.before);
  const afterLength = textLength(nodes.after);
  if (isIn(regions.before, node)) {
    return pointInRegion(nodes.before, node, offset);
  }
  if (isIn(regions.atom, node)) {
    return role === "start" ? beforeLength : beforeLength + 1;
  }
  if (isIn(regions.after, node)) {
    return beforeLength + 1 + pointInRegion(nodes.after, node, offset);
  }
  return outsidePointOffset(regions, node, offset, beforeLength, afterLength);
}

/** Maps a browser caret hit-test point into the editor's image-aware UTF-16 space. */
export function imageAtomLogicalOffsetFromDomPoint(
  regions: ImageAtomDomRegions,
  node: Node,
  offset: number
): number {
  const nodes = { before: textNodes(regions.before), after: textNodes(regions.after) };
  const beforeLength = textLength(nodes.before);
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  const overlay = element?.closest<HTMLElement>(
    `[${IMAGE_ATOM_OVERLAY_ATTRIBUTE}]`
  );
  if (overlay && regions.before.contains(overlay)) {
    return normalizeTextOffset(
      nodes.before,
      textOffsetWithin(overlay, node, offset) ?? 0
    );
  }
  if (overlay && regions.after.contains(overlay)) {
    return beforeLength + 1 + normalizeTextOffset(
      nodes.after,
      textOffsetWithin(overlay, node, offset) ?? 0
    );
  }
  return readPoint(regions, nodes, node, offset, "start");
}

function isHostRelated(regions: ImageAtomDomRegions, node: Node): boolean {
  return regions.host === node || regions.host.contains(node);
}

function logicalPoint(
  regions: ImageAtomDomRegions,
  nodes: { readonly before: readonly Text[]; readonly after: readonly Text[] },
  logicalOffset: number
): DomPoint {
  const beforeLength = textLength(nodes.before);
  const afterLength = textLength(nodes.after);
  const normalized = clamp(logicalOffset, beforeLength + 1 + afterLength);
  return normalized <= beforeLength
    ? pointForRegionOffset(regions.before, nodes.before, normalized)
    : pointForRegionOffset(regions.after, nodes.after, normalized - beforeLength - 1);
}

export function readImageAtomDomSelection(
  regions: ImageAtomDomRegions,
  selection: Selection
): LogicalSelection | null {
  if (
    selection.rangeCount === 0 ||
    !selection.anchorNode ||
    !selection.focusNode ||
    (!isHostRelated(regions, selection.anchorNode) &&
      !isHostRelated(regions, selection.focusNode))
  ) {
    return null;
  }
  const nodes = { before: textNodes(regions.before), after: textNodes(regions.after) };
  const roles = endpointRoles(selection);
  return {
    anchorUtf16: readPoint(
      regions,
      nodes,
      selection.anchorNode,
      selection.anchorOffset,
      roles.anchor
    ),
    focusUtf16: readPoint(
      regions,
      nodes,
      selection.focusNode,
      selection.focusOffset,
      roles.focus
    )
  };
}

export function writeImageAtomDomSelection(
  regions: ImageAtomDomRegions,
  logical: LogicalSelection,
  selection: Selection
): void {
  const nodes = { before: textNodes(regions.before), after: textNodes(regions.after) };
  const anchor = logicalPoint(regions, nodes, logical.anchorUtf16);
  const focus = logicalPoint(regions, nodes, logical.focusUtf16);
  selection.removeAllRanges();
  const setBaseAndExtent = (
    selection as Selection & { setBaseAndExtent?: Selection["setBaseAndExtent"] }
  ).setBaseAndExtent;
  if (setBaseAndExtent) {
    try {
      setBaseAndExtent.call(selection, anchor.node, anchor.offset, focus.node, focus.offset);
      return;
    } catch {
      selection.removeAllRanges();
    }
  }
  const range = document.createRange();
  const forward = logical.anchorUtf16 <= logical.focusUtf16;
  range.setStart(forward ? anchor.node : focus.node, forward ? anchor.offset : focus.offset);
  range.setEnd(forward ? focus.node : anchor.node, forward ? focus.offset : anchor.offset);
  selection.addRange(range);
}
