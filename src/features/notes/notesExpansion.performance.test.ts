// @vitest-environment node

import { beforeAll, describe, expect, it } from "vitest";
import type { NoteNode, NotesWorkspace } from "../../domain/notes";
import { findNoteDateMatches, formatLocalDateIso } from "./noteDates";
import { tokenizeNoteText } from "./noteTokens";
import {
  createNotesHistorySession,
  type NotesHistorySnapshot
} from "./notesHistory";
import { parseNoteSearchQuery } from "./noteSearchQuery";
import { flattenVisibleOutlineRows } from "./outlineTree";
import {
  normalizeWorkspace,
  notesWorkspaceReducer
} from "./notesWorkspaceReducer";
import { resolveRootLifecycleNavigation } from "./useNotesWorkspace";

// The shared setup registers an unconditional localStorage reset. Supply only
// that hook dependency; Node remains DOM-free for every timed workload.
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { localStorage: { clear() {} } }
});

/**
 * Run serially with:
 * NOTES_PERF=1 npm test -- src/features/notes/notesExpansion.performance.test.ts
 *   --pool=threads --maxWorkers=1 --no-file-parallelism
 */

const WARMUP_SAMPLES = 5;
const MEASURED_SAMPLES = 31;
const REGRESSION_LIMIT = 1.2;
const HISTORY_SNAPSHOT_LIMIT = 128;
const CALIBRATION_ITERATIONS = 10_000_000;
const RECORDED_CALIBRATION_P95_MS = 11.72;
const performanceSuite =
  process.env.NOTES_PERF === "1" ? describe : describe.skip;

const recordedEnvironment = {
  recordedAt: "2026-07-12",
  node: "v26.4.0",
  platform: "darwin-arm64",
  cpu: "Apple M1 Pro",
  memoryGiB: 32,
  calibrationIterations: CALIBRATION_ITERATIONS,
  sampling: "5 warmups + 31 samples; batched timings are per-operation"
} as const;

interface PerformanceStats {
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly samplesMs: readonly number[];
}

interface PreparedWorkload {
  readonly run: () => unknown;
  readonly expected: unknown;
}

interface RecordedBaseline {
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly normalizedP95: number;
}

interface PerformanceCase {
  readonly label: string;
  readonly scope: string;
  readonly nodeCount: 1_000 | 10_000;
  readonly operationsPerSample: number;
  readonly recordedCalibrationP95Ms: number;
  readonly recordedBaseline: RecordedBaseline;
  readonly prepare: (nodeCount: number) => PreparedWorkload;
}

function percentile(sortedSamples: readonly number[], fraction: number): number {
  return sortedSamples[Math.ceil(sortedSamples.length * fraction) - 1]!;
}

function measureWorkload(
  workload: PreparedWorkload,
  operationsPerSample = 1
): PerformanceStats {
  for (let index = 0; index < WARMUP_SAMPLES; index += 1) {
    let result: unknown;
    for (let operation = 0; operation < operationsPerSample; operation += 1) {
      result = workload.run();
    }
    expect(result).toEqual(workload.expected);
  }

  const samplesMs: number[] = [];
  for (let index = 0; index < MEASURED_SAMPLES; index += 1) {
    const startedAt = performance.now();
    let result: unknown;
    for (let operation = 0; operation < operationsPerSample; operation += 1) {
      result = workload.run();
    }
    samplesMs.push((performance.now() - startedAt) / operationsPerSample);
    expect(result).toEqual(workload.expected);
  }

  const sortedSamples = [...samplesMs].sort((left, right) => left - right);
  return {
    medianMs: percentile(sortedSamples, 0.5),
    p95Ms: percentile(sortedSamples, 0.95),
    samplesMs
  };
}

function recordedBaseline(
  medianMs: number,
  p95Ms: number
): RecordedBaseline {
  return {
    medianMs,
    p95Ms,
    normalizedP95: p95Ms / RECORDED_CALIBRATION_P95_MS
  };
}

function normalizedRegressionRatio(
  currentP95Ms: number,
  currentCalibrationP95Ms: number,
  baseline: RecordedBaseline
): number {
  return currentP95Ms / currentCalibrationP95Ms / baseline.normalizedP95;
}

function calibrationChecksum(iterations: number): number {
  const blockSize = 1024;
  const fullBlocks = Math.floor(iterations / blockSize);
  const remainder = iterations % blockSize;
  return (
    fullBlocks * ((blockSize - 1) * blockSize / 2) +
    (remainder - 1) * remainder / 2
  );
}

function prepareCalibration(): PreparedWorkload {
  return {
    run: () => {
      let checksum = 0;
      for (let index = 0; index < CALIBRATION_ITERATIONS; index += 1) {
        checksum += index & 1023;
      }
      return checksum;
    },
    expected: calibrationChecksum(CALIBRATION_ITERATIONS)
  };
}

function countResidue(total: number, residue: number, divisor: number): number {
  return total <= residue ? 0 : Math.floor((total - 1 - residue) / divisor) + 1;
}

const fixedTimestamp = "2026-07-12T00:00:00.000Z";

function noteNode(
  index: number,
  parentId: string | null,
  overrides: Partial<NoteNode> = {}
): NoteNode {
  return {
    id: `node-${index}`,
    parentId,
    sortKey: index,
    title: `Node ${index}`,
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: fixedTimestamp,
    updatedAt: fixedTimestamp,
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    ...overrides
  };
}

function treeNodes(nodeCount: number): NoteNode[] {
  return Array.from({ length: nodeCount }, (_, index) => {
    const parentIndex = index === 0 ? null : Math.floor((index - 1) / 8);
    return noteNode(
      index,
      parentIndex === null ? null : `node-${parentIndex}`
    );
  });
}

function prepareActiveWorkspaceLoad(nodeCount: number): PreparedWorkload {
  const workspace: NotesWorkspace = { nodes: treeNodes(nodeCount) };
  const emptyState = normalizeWorkspace({ nodes: [] });

  return {
    run: () => {
      const loaded = notesWorkspaceReducer(emptyState, {
        type: "settleQueueWork",
        result: { kind: "authoritative", workspace },
        hasPendingWork: false
      });
      return {
        nodeCount: Object.keys(loaded.nodesById).length,
        rootIds: loaded.rootIds,
        indexedChildCount: Object.values(loaded.childIdsByParent).reduce(
          (total, childIds) => total + childIds.length,
          0
        ),
        status: loaded.status
      };
    },
    expected: {
      nodeCount,
      rootIds: ["node-0"],
      indexedChildCount: nodeCount - 1,
      status: "ready"
    }
  };
}

function prepareTokenization(nodeCount: number): PreparedWorkload {
  const sources: string[] = [];
  let expectedTagCount = 0;
  let expectedTokenCount = 0;
  let expectedEndOffsetChecksum = 0;

  for (let index = 0; index < nodeCount; index += 1) {
    const optionalTags = `${index % 5 === 0 ? " #blocked" : ""}${
      index % 7 === 0 ? " #skip" : ""
    }`;
    const source = `Node ${index} roadmap #project${index % 20} @owner${
      index % 10
    } ${index % 3 === 0 ? "#urgent" : "#routine"}${
      optionalTags
    } due 07/12/2026`;
    const tagCount = 3 + (index % 5 === 0 ? 1 : 0) + (index % 7 === 0 ? 1 : 0);
    sources.push(source);
    expectedTagCount += tagCount;
    expectedTokenCount += tagCount * 2 + 1;
    expectedEndOffsetChecksum += source.length;
  }

  return {
    run: () => {
      let tagCount = 0;
      let tokenCount = 0;
      let endOffsetChecksum = 0;
      for (const source of sources) {
        const tokens = tokenizeNoteText(source);
        tokenCount += tokens.length;
        endOffsetChecksum += tokens.at(-1)?.endUtf16 ?? 0;
        for (const token of tokens) {
          tagCount += token.kind === "tag" ? 1 : 0;
        }
      }
      return { tagCount, tokenCount, endOffsetChecksum };
    },
    expected: {
      tagCount: expectedTagCount,
      tokenCount: expectedTokenCount,
      endOffsetChecksum: expectedEndOffsetChecksum
    }
  };
}

function prepareVisibleRows(nodeCount: number): PreparedWorkload {
  const nodes = treeNodes(nodeCount);
  const depths: number[] = [];
  let expectedDepthChecksum = 0;
  let expectedMaxDepth = 0;

  for (let index = 0; index < nodeCount; index += 1) {
    const parentIndex = index === 0 ? null : Math.floor((index - 1) / 8);
    const depth = parentIndex === null ? 0 : depths[parentIndex]! + 1;
    depths.push(depth);
    expectedDepthChecksum += depth;
    expectedMaxDepth = Math.max(expectedMaxDepth, depth);
  }
  const workspace = normalizeWorkspace({ nodes });

  return {
    run: () => {
      const rows = flattenVisibleOutlineRows(workspace, null);
      let depthChecksum = 0;
      let maxDepth = 0;
      for (const row of rows) {
        depthChecksum += row.depth;
        maxDepth = Math.max(maxDepth, row.depth);
      }
      return {
        rowCount: rows.length,
        depthChecksum,
        maxDepth,
        firstId: rows[0]?.id ?? null
      };
    },
    expected: {
      rowCount: nodeCount,
      depthChecksum: expectedDepthChecksum,
      maxDepth: expectedMaxDepth,
      firstId: "node-0"
    }
  };
}

function prepareTagQueryParser(nodeCount: number): PreparedWorkload {
  const sources: string[] = [];
  let expectedTextLengthChecksum = 0;

  for (let index = 0; index < nodeCount; index += 1) {
    const text = `roadmap${index}`;
    sources.push(
      `${text} #urgent #project${index % 20} OR #project${
        (index + 1) % 20
      } -#blocked`
    );
    expectedTextLengthChecksum += text.length;
  }

  return {
    run: () => {
      let requiredCount = 0;
      let excludedCount = 0;
      let alternativeCount = 0;
      let textLengthChecksum = 0;
      let lastText = "";
      for (const source of sources) {
        const query = parseNoteSearchQuery(source);
        requiredCount += query.requiredTags.length;
        excludedCount += query.excludedTags.length;
        alternativeCount += query.orGroups.reduce(
          (total, group) => total + group.length,
          0
        );
        textLengthChecksum += query.text.length;
        lastText = query.text;
      }
      return {
        parsedQueryCount: sources.length,
        requiredCount,
        excludedCount,
        alternativeCount,
        textLengthChecksum,
        lastText
      };
    },
    expected: {
      parsedQueryCount: nodeCount,
      requiredCount: nodeCount,
      excludedCount: nodeCount,
      alternativeCount: nodeCount * 2,
      textLengthChecksum: expectedTextLengthChecksum,
      lastText: `roadmap${nodeCount - 1}`
    }
  };
}

const dateExpressions = [
  "today",
  "08/15/2026",
  "next week",
  "09/01/2026 - 09/03/2026"
] as const;
const dateStartKeys = [
  "2026-07-12",
  "2026-08-15",
  "2026-07-13",
  "2026-09-01"
] as const;

function prepareDateIndexEntries(nodeCount: number): PreparedWorkload {
  const sources = Array.from(
    { length: nodeCount },
    (_, index) => `Node ${index} schedule ${dateExpressions[index % 4]} #calendar`
  );
  const expectedRangeCount =
    countResidue(nodeCount, 2, 4) + countResidue(nodeCount, 3, 4);

  return {
    run: () => {
      const preparedEntries: string[] = [];
      let rangeCount = 0;
      for (const source of sources) {
        const matches = findNoteDateMatches(source, {
          today: { year: 2026, month: 7, day: 12 },
          weekStartsOn: "monday"
        });
        for (const match of matches) {
          const start = formatLocalDateIso(match.start);
          const end = match.end === null ? "" : formatLocalDateIso(match.end);
          preparedEntries.push(`${start}:${end}`);
          rangeCount += match.end === null ? 0 : 1;
        }
      }
      return {
        preparedEntryCount: preparedEntries.length,
        rangeCount,
        keyLengthChecksum: preparedEntries.reduce(
          (total, entry) => total + entry.length,
          0
        ),
        uniqueStartCount: new Set(
          preparedEntries.map((entry) => entry.slice(0, 10))
        ).size,
        firstStart: preparedEntries[0]?.slice(0, 10) ?? null,
        lastStart: preparedEntries.at(-1)?.slice(0, 10) ?? null
      };
    },
    expected: {
      preparedEntryCount: nodeCount,
      rangeCount: expectedRangeCount,
      keyLengthChecksum: nodeCount * 11 + expectedRangeCount * 10,
      uniqueStartCount: 4,
      firstStart: dateStartKeys[0],
      lastStart: dateStartKeys[(nodeCount - 1) % 4]
    }
  };
}

function lifecycleNodes(nodeCount: number, archived: boolean): NoteNode[] {
  return Array.from({ length: nodeCount }, (_, index) => {
    const rootIndex = index - index % 10;
    return noteNode(index, index % 10 === 0 ? null : `node-${rootIndex}`, {
      archivedAt: archived ? fixedTimestamp : null,
      archiveRootId: archived ? `node-${rootIndex}` : null
    });
  });
}

function prepareArchiveLifecycle(nodeCount: number): PreparedWorkload {
  const targetRootIndex = Math.floor(nodeCount / 20) * 10;
  const targetRootId = `node-${targetRootIndex}`;
  const fallbackRootId = `node-${targetRootIndex + 10}`;
  const targetIds = new Set(
    Array.from({ length: 10 }, (_, offset) => `node-${targetRootIndex + offset}`)
  );
  const activeNodes = lifecycleNodes(nodeCount, false);
  const archivedNodes = lifecycleNodes(nodeCount, true);
  const activeAfterNodes = activeNodes.filter((node) => !targetIds.has(node.id));
  const archiveAfterNodes = archivedNodes.filter(
    (node) => !targetIds.has(node.id)
  );

  const navigation = (scope: "active" | "archive") => ({
    selectedId: `node-${targetRootIndex + 1}`,
    zoomRootId: targetRootId,
    editingNoteId: `node-${targetRootIndex + 1}`,
    pendingFocusId: `node-${targetRootIndex + 1}`,
    pendingFocusField: "title" as const,
    locallyExpandedNodeIds: new Set([targetRootId]),
    scope: { kind: scope } as const
  });

  return {
    run: () => {
      const activeBefore = normalizeWorkspace({ nodes: activeNodes });
      const activeAfter = normalizeWorkspace({ nodes: activeAfterNodes });
      const archiveTransition = resolveRootLifecycleNavigation(
        activeBefore,
        activeAfter,
        targetRootId,
        navigation("active")
      );
      const archiveBefore = normalizeWorkspace({ nodes: archivedNodes });
      const archiveAfter = normalizeWorkspace({ nodes: archiveAfterNodes });
      const unarchiveTransition = resolveRootLifecycleNavigation(
        archiveBefore,
        archiveAfter,
        targetRootId,
        navigation("archive")
      );
      return {
        archiveRemainingNodes: Object.keys(activeAfter.nodesById).length,
        archiveFallbackId: archiveTransition.after.selectedId,
        archiveScope: archiveTransition.after.scope.kind,
        archiveExpansionCount:
          archiveTransition.after.locallyExpandedNodeIds.size,
        unarchiveRemainingNodes: Object.keys(archiveAfter.nodesById).length,
        unarchiveFallbackId: unarchiveTransition.after.selectedId,
        unarchiveScope: unarchiveTransition.after.scope.kind,
        unarchiveExpansionCount:
          unarchiveTransition.after.locallyExpandedNodeIds.size
      };
    },
    expected: {
      archiveRemainingNodes: nodeCount - 10,
      archiveFallbackId: fallbackRootId,
      archiveScope: "active",
      archiveExpansionCount: 0,
      unarchiveRemainingNodes: nodeCount - 10,
      unarchiveFallbackId: fallbackRootId,
      unarchiveScope: "archive",
      unarchiveExpansionCount: 0
    }
  };
}

function prepareMutationUndo(nodeCount: number): PreparedWorkload {
  const originalNodes = treeNodes(nodeCount);
  const targetId = `node-${nodeCount - 1}`;
  const mutatedTitle = `Mutated ${nodeCount - 1}`;
  const mutatedNodes = originalNodes.map((node) =>
    node.id === targetId
      ? { ...node, title: mutatedTitle, isStarred: true }
      : node
  );
  const initial = notesWorkspaceReducer(
    normalizeWorkspace({ nodes: originalNodes }),
    {
      type: "setUiState",
      selectedId: targetId,
      zoomRootId: "node-0",
      editingNoteId: targetId,
      pendingFocusId: targetId,
      pendingFocusField: "title"
    }
  );

  return {
    run: () => {
      const mutated = notesWorkspaceReducer(initial, {
        type: "settleQueueWork",
        result: {
          kind: "authoritative",
          workspace: { nodes: mutatedNodes }
        },
        hasPendingWork: false
      });
      const undone = notesWorkspaceReducer(mutated, {
        type: "settleQueueWork",
        result: {
          kind: "authoritative",
          workspace: { nodes: originalNodes }
        },
        hasPendingWork: false
      });
      return {
        nodeCount: Object.keys(undone.nodesById).length,
        mutatedTitle: mutated.nodesById[targetId]?.title ?? null,
        mutatedStarred: mutated.nodesById[targetId]?.isStarred ?? null,
        undoneTitle: undone.nodesById[targetId]?.title ?? null,
        undoneStarred: undone.nodesById[targetId]?.isStarred ?? null,
        selectedId: undone.selectedId,
        pendingFocusId: undone.pendingFocusId,
        status: undone.status
      };
    },
    expected: {
      nodeCount,
      mutatedTitle,
      mutatedStarred: true,
      undoneTitle: `Node ${nodeCount - 1}`,
      undoneStarred: false,
      selectedId: targetId,
      pendingFocusId: targetId,
      status: "ready"
    }
  };
}

function historySnapshot(selectedId: string): NotesHistorySnapshot {
  return {
    scope: { kind: "active" },
    selectedId,
    zoomRootId: selectedId,
    locallyExpandedNodeIds: [selectedId],
    focus: { nodeId: selectedId, field: "title" }
  };
}

function prepareHistory(nodeCount: number): PreparedWorkload {
  return {
    run: () => {
      let idSequence = 0;
      const history = createNotesHistorySession({
        createId: () => `perf-${idSequence++}`,
        maxSnapshots: HISTORY_SNAPSHOT_LIMIT
      });
      let lastEntryId = "";
      for (let index = 0; index < nodeCount; index += 1) {
        const entry = history.beginStructuralEntry(
          index % 2 === 0 ? "move" : "archive",
          historySnapshot(`before-${index}`)
        );
        history.rememberAfter(entry.entryId, historySnapshot(`after-${index}`));
        lastEntryId = entry.entryId;
      }
      const replay = history.snapshotForReplay(lastEntryId, "redo");
      return {
        sessionId: history.sessionId,
        lastEntryId,
        snapshotCount: history.snapshotCount(),
        replaySelectedId: replay?.selectedId ?? null,
        replayFocusField: replay?.focus?.field ?? null
      };
    },
    expected: {
      sessionId: "perf-0",
      lastEntryId: `perf-${nodeCount}`,
      snapshotCount: Math.min(nodeCount, HISTORY_SNAPSHOT_LIMIT),
      replaySelectedId: `after-${nodeCount - 1}`,
      replayFocusField: "title"
    }
  };
}

const productionScope = "exported production pure frontend path";
const preparationScope =
  "frontend preparation only; backend native search is measured separately";

const cases: readonly PerformanceCase[] = [
  {
    label: "active workspace load",
    scope: productionScope,
    nodeCount: 1_000,
    operationsPerSample: 50,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(0.19, 0.2),
    prepare: prepareActiveWorkspaceLoad
  },
  {
    label: "active workspace load",
    scope: productionScope,
    nodeCount: 10_000,
    operationsPerSample: 10,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(3.17, 3.26),
    prepare: prepareActiveWorkspaceLoad
  },
  {
    label: "tokenization",
    scope: productionScope,
    nodeCount: 1_000,
    operationsPerSample: 10,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(2.98, 3),
    prepare: prepareTokenization
  },
  {
    label: "tokenization",
    scope: productionScope,
    nodeCount: 10_000,
    operationsPerSample: 2,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(30.06, 30.49),
    prepare: prepareTokenization
  },
  {
    label: "visible-row derivation",
    scope: productionScope,
    nodeCount: 1_000,
    operationsPerSample: 200,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(0.21, 0.23),
    prepare: prepareVisibleRows
  },
  {
    label: "visible-row derivation",
    scope: productionScope,
    nodeCount: 10_000,
    operationsPerSample: 20,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(2.47, 2.56),
    prepare: prepareVisibleRows
  },
  {
    label: "tag query parser preparation",
    scope: preparationScope,
    nodeCount: 1_000,
    operationsPerSample: 3,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(5.86, 6.08),
    prepare: prepareTagQueryParser
  },
  {
    label: "tag query parser preparation",
    scope: preparationScope,
    nodeCount: 10_000,
    operationsPerSample: 2,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(58.46, 59.46),
    prepare: prepareTagQueryParser
  },
  {
    label: "date token parse + index preparation",
    scope: preparationScope,
    nodeCount: 1_000,
    operationsPerSample: 4,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(4.35, 4.51),
    prepare: prepareDateIndexEntries
  },
  {
    label: "date token parse + index preparation",
    scope: preparationScope,
    nodeCount: 10_000,
    operationsPerSample: 2,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(44.42, 44.98),
    prepare: prepareDateIndexEntries
  },
  {
    label: "Archive/unarchive lifecycle preparation",
    scope: productionScope,
    nodeCount: 1_000,
    operationsPerSample: 20,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(0.69, 0.75),
    prepare: prepareArchiveLifecycle
  },
  {
    label: "Archive/unarchive lifecycle preparation",
    scope: productionScope,
    nodeCount: 10_000,
    operationsPerSample: 5,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(10.73, 11.24),
    prepare: prepareArchiveLifecycle
  },
  {
    label: "mutation + Undo workspace settlement",
    scope: productionScope,
    nodeCount: 1_000,
    operationsPerSample: 30,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(0.33, 0.34),
    prepare: prepareMutationUndo
  },
  {
    label: "mutation + Undo workspace settlement",
    scope: productionScope,
    nodeCount: 10_000,
    operationsPerSample: 3,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(5.3, 5.6),
    prepare: prepareMutationUndo
  },
  {
    label: "local history eviction",
    scope: productionScope,
    nodeCount: 1_000,
    operationsPerSample: 10,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(1.06, 1.11),
    prepare: prepareHistory
  },
  {
    label: "local history eviction",
    scope: productionScope,
    nodeCount: 10_000,
    operationsPerSample: 2,
    recordedCalibrationP95Ms: RECORDED_CALIBRATION_P95_MS,
    recordedBaseline: recordedBaseline(11.96, 12.22),
    prepare: prepareHistory
  }
];

let calibrationStats: PerformanceStats;

performanceSuite("notes expansion frontend performance", () => {
  beforeAll(() => {
    calibrationStats = measureWorkload(prepareCalibration());
    console.info(
      "[notes-perf] invocation: NOTES_PERF=1 npm test -- " +
        "src/features/notes/notesExpansion.performance.test.ts " +
        "--pool=threads --maxWorkers=1 --no-file-parallelism"
    );
    console.info(
      `[notes-perf] recorded=${JSON.stringify(recordedEnvironment)}; ` +
        `calibration median=${calibrationStats.medianMs.toFixed(2)}ms; ` +
        `p95=${calibrationStats.p95Ms.toFixed(2)}ms; ` +
        `recordedP95=${RECORDED_CALIBRATION_P95_MS.toFixed(2)}ms`
    );
  });

  it("covers every reviewed pure frontend workload at 1k and 10k nodes", () => {
    const sizesByLabel = new Map<string, number[]>();
    for (const performanceCase of cases) {
      const sizes = sizesByLabel.get(performanceCase.label) ?? [];
      sizes.push(performanceCase.nodeCount);
      sizesByLabel.set(performanceCase.label, sizes);
    }

    expect(Object.fromEntries(sizesByLabel)).toMatchObject({
      "active workspace load": [1_000, 10_000],
      "Archive/unarchive lifecycle preparation": [1_000, 10_000],
      "mutation + Undo workspace settlement": [1_000, 10_000]
    });
  });

  it("labels backend-owned search work as frontend preparation only", () => {
    expect(cases.map(({ label }) => label)).toContain(
      "tag query parser preparation"
    );
    expect(cases.map(({ label }) => label)).toContain(
      "date token parse + index preparation"
    );
    expect(cases.some(({ label }) => /tag.*match|production search/iu.test(label)))
      .toBe(false);
    expect(
      cases
        .filter(({ label }) => /tag|date/iu.test(label))
        .every(({ scope }) => scope === preparationScope)
    ).toBe(true);
  });

  it("stores consistent raw and normalized baseline metadata", () => {
    for (const performanceCase of cases) {
      expect(performanceCase.recordedCalibrationP95Ms).toBeGreaterThan(0);
      expect(performanceCase.recordedBaseline.normalizedP95).toBeCloseTo(
        performanceCase.recordedBaseline.p95Ms /
          performanceCase.recordedCalibrationP95Ms,
        10
      );
    }
  });

  it("normalizes a two-times-slower host before applying the 20% gate", () => {
    const baseline = {
      medianMs: 8,
      p95Ms: 10,
      normalizedP95: 5
    };
    expect(normalizedRegressionRatio(24, 4, baseline)).toBeCloseTo(1.2, 10);
    expect(normalizedRegressionRatio(24.01, 4, baseline)).toBeGreaterThan(
      REGRESSION_LIMIT
    );
  });

  it("runs pure timing in Node without a DOM environment", () => {
    expect(process.release.name).toBe("node");
    expect(typeof document).toBe("undefined");
  });

  it.each(cases)(
    "$label: $nodeCount nodes; normalized p95 <= recorded +20%",
    { timeout: 120_000 },
    ({
      label,
      scope,
      nodeCount,
      operationsPerSample,
      recordedBaseline: baseline,
      prepare
    }) => {
      const stats = measureWorkload(prepare(nodeCount), operationsPerSample);
      const ratio = normalizedRegressionRatio(
        stats.p95Ms,
        calibrationStats.p95Ms,
        baseline
      );

      expect(stats.samplesMs).toHaveLength(MEASURED_SAMPLES);
      expect(stats.samplesMs.every(Number.isFinite)).toBe(true);
      console.info(
        `[notes-perf] ${label}; scope=${scope}; nodes=${nodeCount}; ` +
          `warmups=${WARMUP_SAMPLES}; samples=${MEASURED_SAMPLES}; ` +
          `operationsPerSample=${operationsPerSample}; ` +
          `median=${stats.medianMs.toFixed(2)}ms; p95=${stats.p95Ms.toFixed(
            2
          )}ms; recordedMedian=${baseline.medianMs.toFixed(2)}ms; ` +
          `recordedP95=${baseline.p95Ms.toFixed(2)}ms; ` +
          `normalizedRatio=${ratio.toFixed(3)}; gate=${REGRESSION_LIMIT.toFixed(
            2
          )}`
      );
      expect(ratio).toBeLessThanOrEqual(REGRESSION_LIMIT);
    }
  );
});
