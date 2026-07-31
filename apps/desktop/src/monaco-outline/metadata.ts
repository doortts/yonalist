export interface OutlineLineMetadata {
  readonly nodeId: string;
  readonly parentId: string;
  readonly depth: number;
  readonly kind: "text";
  readonly collapsed: boolean;
  readonly completed: boolean;
}

export interface OutlineMetadataSnapshot {
  readonly alternativeVersionId: number;
  readonly lines: readonly OutlineLineMetadata[];
  readonly lineByNodeId: ReadonlyMap<string, number>;
}

export class OutlineMetadataTimeline {
  readonly #versions = new Map<number, OutlineMetadataSnapshot>();
  #active: OutlineMetadataSnapshot;

  private constructor(initial: OutlineMetadataSnapshot) {
    this.#versions.set(initial.alternativeVersionId, initial);
    this.#active = initial;
  }

  static hydrate(
    alternativeVersionId: number,
    lines: readonly OutlineLineMetadata[]
  ): OutlineMetadataTimeline {
    return new OutlineMetadataTimeline(
      createSnapshot(alternativeVersionId, lines)
    );
  }

  current(): OutlineMetadataSnapshot {
    return this.#active;
  }

  record(
    alternativeVersionId: number,
    lines: readonly OutlineLineMetadata[]
  ): OutlineMetadataSnapshot {
    assertAlternativeVersionId(alternativeVersionId);
    if (this.#versions.has(alternativeVersionId)) {
      throw new Error(
        `Outline metadata version ${alternativeVersionId} is already recorded.`
      );
    }

    validateOutlineMetadata(lines);
    const snapshot = sameMetadata(this.#active.lines, lines)
      ? Object.freeze({
          alternativeVersionId,
          lines: this.#active.lines,
          lineByNodeId: this.#active.lineByNodeId
        })
      : createSnapshot(alternativeVersionId, lines);
    this.#versions.set(alternativeVersionId, snapshot);
    this.#active = snapshot;
    return snapshot;
  }

  restore(alternativeVersionId: number): OutlineMetadataSnapshot {
    const snapshot = this.#versions.get(alternativeVersionId);
    if (!snapshot) {
      throw new Error(
        `Outline metadata version ${alternativeVersionId} was not recorded.`
      );
    }
    return snapshot;
  }

  replaceCurrent(snapshot: OutlineMetadataSnapshot): void {
    const recorded = this.#versions.get(snapshot.alternativeVersionId);
    if (recorded !== snapshot) {
      throw new Error("Only a recorded outline metadata snapshot can be active.");
    }
    this.#active = recorded;
  }

  rewriteCurrent(
    lines: readonly OutlineLineMetadata[]
  ): OutlineMetadataSnapshot {
    const snapshot = createSnapshot(this.#active.alternativeVersionId, lines);
    this.#versions.set(snapshot.alternativeVersionId, snapshot);
    this.#active = snapshot;
    return snapshot;
  }
}

export function validateOutlineMetadata(
  lines: readonly OutlineLineMetadata[]
): void {
  const nodeIds = new Set<string>();
  const preorderParents: string[] = [];
  let rootParentId: string | null = null;
  let previousDepth = 0;

  for (const [index, line] of lines.entries()) {
    if (!line.nodeId || !line.parentId) {
      throw new Error("Outline node and parent IDs must be nonempty.");
    }
    if (nodeIds.has(line.nodeId)) {
      throw new Error("Outline node IDs must be unique.");
    }
    nodeIds.add(line.nodeId);

    if (!Number.isSafeInteger(line.depth) || line.depth < 0) {
      throw new Error("Outline depth must be a nonnegative integer.");
    }
    if (index === 0 && line.depth !== 0) {
      throw new Error("The first outline line must have depth zero.");
    }
    if (index > 0 && line.depth > previousDepth + 1) {
      throw new Error("Outline depth may increase by at most one.");
    }

    if (line.depth === 0) {
      rootParentId ??= line.parentId;
      if (line.parentId !== rootParentId) {
        throw new Error("Top-level outline lines must share one page parent.");
      }
    } else if (preorderParents[line.depth - 1] !== line.parentId) {
      throw new Error("Outline parent must match the visible preorder.");
    }

    preorderParents[line.depth] = line.nodeId;
    preorderParents.length = line.depth + 1;
    previousDepth = line.depth;
  }
}

function createSnapshot(
  alternativeVersionId: number,
  lines: readonly OutlineLineMetadata[]
): OutlineMetadataSnapshot {
  assertAlternativeVersionId(alternativeVersionId);
  validateOutlineMetadata(lines);
  const frozenLines = Object.freeze(
    lines.map((line) => Object.freeze({ ...line }))
  );
  const lineByNodeId = new Map(
    frozenLines.map((line, index) => [line.nodeId, index + 1])
  );
  return Object.freeze({
    alternativeVersionId,
    lines: frozenLines,
    lineByNodeId
  });
}

function sameMetadata(
  current: readonly OutlineLineMetadata[],
  next: readonly OutlineLineMetadata[]
): boolean {
  return (
    current.length === next.length &&
    current.every((line, index) => {
      const candidate = next[index];
      return (
        candidate !== undefined &&
        line.nodeId === candidate.nodeId &&
        line.parentId === candidate.parentId &&
        line.depth === candidate.depth &&
        line.kind === candidate.kind &&
        line.collapsed === candidate.collapsed &&
        line.completed === candidate.completed
      );
    })
  );
}

function assertAlternativeVersionId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Monaco alternative version IDs must be positive integers.");
  }
}
