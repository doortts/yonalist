export interface PastedOutlineNode {
  readonly title: string;
  readonly children: PastedOutlineNode[];
}

export function flattenPastedOutline(
  roots: readonly PastedOutlineNode[],
  parentId: string,
  createId: () => string
): {
  readonly rootIds: readonly string[];
  readonly nodes: readonly { id: string; parentId: string; text: string }[];
} {
  const nodes: Array<{ id: string; parentId: string; text: string }> = [];
  const append = (source: PastedOutlineNode, importedParentId: string) => {
    const id = createId();
    nodes.push({ id, parentId: importedParentId, text: source.title });
    source.children.forEach((child) => append(child, id));
    return id;
  };
  return { rootIds: roots.map((root) => append(root, parentId)), nodes };
}

const MAX_NODES = 2_000;
const MAX_DEPTH = 64;
const MAX_TITLE_BYTES = 100_000;
const MAX_SOURCE_CHARACTERS = 2_000_000;

interface ParsedLine {
  readonly depth: number;
  readonly title: string;
}

function markdownLine(line: string): (ParsedLine & {
  readonly candidate: boolean;
  readonly valid: boolean;
}) {
  const indent = line.match(/^[\t ]*/u)?.[0] ?? "";
  const content = line.slice(indent.length);
  const candidate = /^-(?: |$)/u.test(content);
  return {
    candidate,
    valid: candidate && !indent.includes("\t") && indent.length % 2 === 0,
    depth: indent.length / 2,
    title: content === "-" ? "" : content.slice(2)
  };
}

function plainLine(line: string): ParsedLine {
  const indent = line.match(/^[\t ]*/u)?.[0] ?? "";
  const tabCount = [...indent].filter((character) => character === "\t").length;
  return {
    depth: tabCount > 0 ? tabCount : Math.floor(indent.length / 2),
    title: line.slice(indent.length).trimEnd()
  };
}

export function parsePastedOutline(source: string): PastedOutlineNode[] | null {
  if (
    source.length === 0 ||
    source.length > MAX_SOURCE_CHARACTERS ||
    !/[\r\n]/u.test(source)
  ) {
    return null;
  }
  const lines = source
    .replace(/\r\n?|\n/gu, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0 || lines.length > MAX_NODES) return null;

  const markdown = lines.map(markdownLine);
  const hasMarkdown = markdown.some((line) => line.candidate);
  if (hasMarkdown && !markdown.every((line) => line.valid)) return null;
  const parsed = hasMarkdown
    ? markdown.map(({ depth, title }) => ({ depth, title }))
    : lines.map(plainLine);
  if (!hasMarkdown && parsed.length < 2) return null;
  if (parsed.some((line) =>
    new TextEncoder().encode(line.title).byteLength > MAX_TITLE_BYTES)) {
    return null;
  }

  const roots: PastedOutlineNode[] = [];
  const stack: PastedOutlineNode[] = [];
  const baseline = parsed[0].depth;
  for (const line of parsed) {
    const depth = Math.min(Math.max(0, line.depth - baseline), stack.length);
    if (depth >= MAX_DEPTH) return null;
    stack.length = depth;
    const node: PastedOutlineNode = { title: line.title, children: [] };
    if (depth === 0) roots.push(node);
    else stack[depth - 1].children.push(node);
    stack.push(node);
  }
  return roots;
}
