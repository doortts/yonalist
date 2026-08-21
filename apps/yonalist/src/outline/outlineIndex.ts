import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { bySiblingOrder } from "./outlineSortKeys";

export class OutlineIndex {
  private readonly byId = new Map<string, NoteView>();
  private readonly positions = new Map<string, number>();
  private readonly children = new Map<string, NoteView[]>();
  private readonly siblingPositions = new Map<string, number>();
  private readonly depthsByRoot = new Map<string, Map<string, number>>();
  private readonly descendantsByRoot = new Map<string, Set<string>>();

  constructor(nodes: readonly NoteView[]) {
    nodes.forEach((node, position) => {
      this.byId.set(node.id, node);
      this.positions.set(node.id, position);
      if (node.parentId === null) return;
      const siblings = this.children.get(node.parentId) ?? [];
      siblings.push(node);
      this.children.set(node.parentId, siblings);
    });
    for (const siblings of this.children.values()) {
      siblings.sort(bySiblingOrder);
      siblings.forEach((node, position) => {
        this.siblingPositions.set(node.id, position);
      });
    }
  }

  node(id: string): NoteView | undefined {
    return this.byId.get(id);
  }

  positionOf(id: string): number {
    return this.positions.get(id) ?? -1;
  }

  childrenOf(parentId: string): readonly NoteView[] {
    return this.children.get(parentId) ?? [];
  }

  firstChildId(parentId: string): string | null {
    return this.childrenOf(parentId)[0]?.id ?? null;
  }

  hasChildren(parentId: string): boolean {
    return this.childrenOf(parentId).length > 0;
  }

  nextSiblingId(id: string): string | null {
    const node = this.node(id);
    if (!node?.parentId) return null;
    const siblings = this.childrenOf(node.parentId);
    const position = this.siblingPositions.get(id) ?? -1;
    return position >= 0 ? siblings[position + 1]?.id ?? null : null;
  }

  siblingPositionOf(id: string): number {
    return this.siblingPositions.get(id) ?? -1;
  }

  depthOf(id: string, rootId: string): number {
    let depths = this.depthsByRoot.get(rootId);
    if (!depths) {
      depths = new Map();
      this.depthsByRoot.set(rootId, depths);
    }
    const known = depths.get(id);
    if (known !== undefined) return known;

    let currentId = id;
    const path: string[] = [];
    const visited = new Set<string>();
    let depth = 0;
    while (!visited.has(currentId)) {
      const cached = depths.get(currentId);
      if (cached !== undefined) {
        depth = cached;
        break;
      }
      visited.add(currentId);
      const parentId = this.node(currentId)?.parentId ?? null;
      if (!parentId || parentId === rootId) {
        depths.set(currentId, 0);
        break;
      }
      path.push(currentId);
      currentId = parentId;
    }
    for (let position = path.length - 1; position >= 0; position -= 1) {
      depth += 1;
      depths.set(path[position]!, depth);
    }
    return depths.get(id) ?? depth;
  }

  isDescendant(id: string, rootId: string): boolean {
    let descendants = this.descendantsByRoot.get(rootId);
    if (!descendants) {
      descendants = new Set();
      const pending = [...this.childrenOf(rootId)];
      while (pending.length > 0) {
        const node = pending.pop()!;
        if (descendants.has(node.id)) continue;
        descendants.add(node.id);
        pending.push(...this.childrenOf(node.id));
      }
      this.descendantsByRoot.set(rootId, descendants);
    }
    return descendants.has(id);
  }
}
