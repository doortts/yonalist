export interface OutlineLineMetadata {
  readonly nodeId: string;
  readonly parentId: string;
  readonly depth: number;
  readonly kind: "text" | "note" | "image";
  readonly collapsed: boolean;
  readonly completed: boolean;
}

export interface OutlineMetadataSnapshot {
  readonly alternativeVersionId: number;
  readonly lines: readonly OutlineLineMetadata[];
  /** Line number of each node's title line — note run lines are excluded. */
  readonly titleLineByNodeId: ReadonlyMap<string, number>;
  /** Inclusive 1-based line numbers of each node's note run, when it has one. */
  readonly noteRangeByNodeId: ReadonlyMap<string, readonly [number, number]>;
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

  get versionCount(): number {
    return this.#versions.size;
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
          titleLineByNodeId: this.#active.titleLineByNodeId,
          noteRangeByNodeId: this.#active.noteRangeByNodeId
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

  deleteVersion(alternativeVersionId: number): void {
    if (this.#active.alternativeVersionId === alternativeVersionId) {
      throw new Error("The active outline metadata version cannot be deleted.");
    }
    this.#versions.delete(alternativeVersionId);
  }
}

export function validateOutlineMetadata(
  lines: readonly OutlineLineMetadata[]
): void {
  const nodeIds = new Set<string>();
  const imageIds = new Set<string>();
  const preorderParents: string[] = [];
  let rootParentId: string | null = null;
  let previousDepth = 0;
  let previousLine: OutlineLineMetadata | null = null;
  let title: OutlineLineMetadata | null = null;

  for (const [index, line] of lines.entries()) {
    if (!line.nodeId || !line.parentId) {
      throw new Error("Outline node and parent IDs must be nonempty.");
    }

    // A note line borrows its owner's identity, so it skips the preorder chain
    // and only has to stay welded to the title line it follows.
    if (line.kind === "note") {
      if (index === 0) {
        throw new Error("The first outline line must be a text or image line.");
      }
      if (
        !previousLine ||
        !title ||
        previousLine.nodeId !== line.nodeId ||
        previousLine.kind === "image"
      ) {
        throw new Error("An outline note line must follow its own title line.");
      }
      if (
        line.parentId !== title.parentId ||
        line.depth !== title.depth ||
        line.collapsed !== title.collapsed ||
        line.completed !== title.completed
      ) {
        throw new Error("An outline note line must copy its title line metadata.");
      }
      previousLine = line;
      continue;
    }

    if (nodeIds.has(line.nodeId)) {
      throw new Error("Outline node IDs must be unique.");
    }
    nodeIds.add(line.nodeId);
    if (line.kind === "image") {
      imageIds.add(line.nodeId);
    }

    if (!Number.isSafeInteger(line.depth) || line.depth < 0) {
      throw new Error("Outline depth must be a nonnegative integer.");
    }
    if (index === 0 && line.depth !== 0) {
      throw new Error("The first outline line must have depth zero.");
    }
    if (index > 0 && line.depth > previousDepth + 1) {
      throw new Error("Outline depth may increase by at most one.");
    }
    if (imageIds.has(line.parentId)) {
      throw new Error("An outline image line cannot have children.");
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
    previousLine = line;
    title = line;
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
  const titleLineByNodeId = new Map<string, number>();
  const noteRangeByNodeId = new Map<string, readonly [number, number]>();
  for (const [index, line] of frozenLines.entries()) {
    const lineNumber = index + 1;
    if (line.kind !== "note") {
      titleLineByNodeId.set(line.nodeId, lineNumber);
      continue;
    }
    const range = noteRangeByNodeId.get(line.nodeId);
    noteRangeByNodeId.set(
      line.nodeId,
      Object.freeze([range?.[0] ?? lineNumber, lineNumber] as const)
    );
  }
  return Object.freeze({
    alternativeVersionId,
    lines: frozenLines,
    titleLineByNodeId,
    noteRangeByNodeId
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
