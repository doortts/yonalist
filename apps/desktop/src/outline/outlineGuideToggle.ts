/**
 * The indentation guide is the row's own background stripe, not an element, so
 * a click on one is answered by arithmetic: which stripe the pointer sits on,
 * which ancestor paints it, and what that ancestor's range should do next.
 */

/**
 * How far off a stripe a pointer still counts as on it. The lit guide is a
 * hairline like the one it replaces, so this reach is the whole of what makes
 * the line easy to hit.
 */
export const GUIDE_HIT_TOLERANCE = 14;

export interface GuideNode {
  readonly id: string;
  readonly collapsed: boolean;
}

/** The slice of `OutlineIndex` the guide helpers read. */
export interface GuideTree {
  node(id: string): { readonly parentId: string | null } | undefined;
  childrenOf(parentId: string): readonly GuideNode[];
}

export interface GuidePending {
  /** The single collapsed value the last click wrote across the range. */
  readonly applied: boolean;
  /** What the range held just before that click. */
  readonly snapshot: ReadonlyMap<string, boolean>;
}

export interface GuideChange {
  readonly id: string;
  readonly collapsed: boolean;
}

export interface GuidePlan {
  readonly changes: readonly GuideChange[];
  readonly pending: GuidePending | null;
}

/**
 * The stripe index `x` lands on, in the row's own coordinates. `offset` is the
 * first stripe's centre and `indent` the step between them -- both read live
 * off the row, since the narrow layout moves them.
 */
export function guideBandAt(
  x: number,
  offset: number,
  indent: number
): number | null {
  if (!(indent > 0)) return null;
  // A pointer left of the first stripe clamps onto it and is then turned away
  // by the reach test, the same as a pointer that fell between two stripes.
  const band = Math.max(0, Math.round((x - offset) / indent));
  return Math.abs(x - (offset + band * indent)) <= GUIDE_HIT_TOLERANCE
    ? band
    : null;
}

/**
 * The ancestor whose bullet centre the stripe sits at. A row paints no stripe
 * for its own depth, so `band` at or past `depth` owns nothing.
 */
export function guideOwnerId(
  tree: GuideTree,
  rowId: string,
  depth: number,
  band: number
): string | null {
  if (band < 0 || band >= depth) return null;
  let id = rowId;
  for (let level = depth; level > band; level -= 1) {
    const parentId = tree.node(id)?.parentId ?? null;
    if (parentId === null) return null;
    id = parentId;
  }
  return id;
}

/** Every row inside the guide's range that has children to hide. */
export function guideTargets(
  tree: GuideTree,
  ownerId: string
): readonly GuideNode[] {
  const targets: GuideNode[] = [];
  const walk = (parentId: string) => {
    for (const child of tree.childrenOf(parentId)) {
      if (tree.childrenOf(child.id).length === 0) continue;
      targets.push(child);
      walk(child.id);
    }
  };
  walk(ownerId);
  return targets;
}

/**
 * What a click does to the range. The first click writes one value across it
 * and keeps the shape it replaced; the next click hands that shape back, so a
 * deliberately mixed range survives a look at it. The kept shape only stands
 * while the range still reads as the blanket that click wrote -- reopen a row
 * by hand and the next click starts over rather than undoing that edit.
 */
export function planGuideToggle(
  targets: readonly GuideNode[],
  pending: GuidePending | null
): GuidePlan {
  if (targets.length === 0) return { changes: [], pending: null };
  if (pending && targets.every((node) => node.collapsed === pending.applied)) {
    const changes: GuideChange[] = [];
    for (const node of targets) {
      const restored = pending.snapshot.get(node.id) ?? node.collapsed;
      if (restored !== node.collapsed) {
        changes.push({ id: node.id, collapsed: restored });
      }
    }
    return { changes, pending: null };
  }
  const applied = !targets.every((node) => node.collapsed);
  const changes: GuideChange[] = [];
  const snapshot = new Map<string, boolean>();
  for (const node of targets) {
    snapshot.set(node.id, node.collapsed);
    if (node.collapsed !== applied) changes.push({ id: node.id, collapsed: applied });
  }
  return { changes, pending: { applied, snapshot } };
}
