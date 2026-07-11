import { describe, expect, it } from "vitest";
import type { NoteNode, NoteStructuredSearchQuery } from "../../domain/notes";
import { findNoteDateMatches, formatLocalDateIso } from "./noteDates";
import { tokenizeNoteText } from "./noteTokens";
import {
  createNotesHistorySession,
  type NotesHistorySnapshot
} from "./notesHistory";
import { parseNoteSearchQuery } from "./noteSearchQuery";
import { flattenVisibleOutlineRows } from "./outlineTree";
import { normalizeWorkspace } from "./notesWorkspaceReducer";

const WARMUP_SAMPLES = 5;
const MEASURED_SAMPLES = 31;
const REGRESSION_ALLOWANCE = 1.2;
const HISTORY_SNAPSHOT_LIMIT = 128;
const performanceSuite =
  process.env.NOTES_PERF === "1" ? describe : describe.skip;

interface PerformanceStats {
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly samplesMs: readonly number[];
}

interface PreparedWorkload {
  readonly run: () => unknown;
  readonly expected: unknown;
}

interface PerformanceCase {
  readonly label: string;
  readonly nodeCount: 1_000 | 10_000;
  readonly baselineP95Ms: number;
  readonly prepare: (nodeCount: number) => PreparedWorkload;
}

function percentile(sortedSamples: readonly number[], fraction: number): number {
  return sortedSamples[Math.ceil(sortedSamples.length * fraction) - 1]!;
}

function measureWorkload(workload: PreparedWorkload): PerformanceStats {
  for (let index = 0; index < WARMUP_SAMPLES; index += 1) {
    expect(workload.run()).toEqual(workload.expected);
  }

  const samplesMs: number[] = [];
  for (let index = 0; index < MEASURED_SAMPLES; index += 1) {
    const startedAt = performance.now();
    const result = workload.run();
    samplesMs.push(performance.now() - startedAt);
    expect(result).toEqual(workload.expected);
  }

  const sortedSamples = [...samplesMs].sort((left, right) => left - right);
  return {
    medianMs: percentile(sortedSamples, 0.5),
    p95Ms: percentile(sortedSamples, 0.95),
    samplesMs
  };
}

function countResidue(total: number, residue: number, divisor: number): number {
  return total <= residue ? 0 : Math.floor((total - 1 - residue) / divisor) + 1;
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

const fixedTimestamp = "2026-07-12T00:00:00.000Z";

function noteNode(
  index: number,
  parentId: string | null,
  isCollapsed = false
): NoteNode {
  return {
    id: `node-${index}`,
    parentId,
    sortKey: index,
    title: `Node ${index}`,
    note: "",
    layoutMode: "bullets",
    isCollapsed,
    isStarred: false,
    completedAt: null,
    createdAt: fixedTimestamp,
    updatedAt: fixedTimestamp,
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null
  };
}

function prepareVisibleRows(nodeCount: number): PreparedWorkload {
  const nodes: NoteNode[] = [];
  const depths: number[] = [];
  let expectedDepthChecksum = 0;
  let expectedMaxDepth = 0;

  for (let index = 0; index < nodeCount; index += 1) {
    const parentIndex = index === 0 ? null : Math.floor((index - 1) / 8);
    const depth = parentIndex === null ? 0 : depths[parentIndex]! + 1;
    nodes.push(
      noteNode(index, parentIndex === null ? null : `node-${parentIndex}`)
    );
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

function searchTagKey(prefix: string, normalizedTag: string): string {
  return `${prefix}\u0000${normalizedTag}`;
}

// Structured candidate matching is backend-owned, so the pure harness mirrors
// AND/OR/NOT semantics while exercising the production parser and tokenizer.
function matchesParsedTagQuery(
  source: string,
  query: NoteStructuredSearchQuery
): boolean {
  const tags = new Set<string>();
  for (const token of tokenizeNoteText(source)) {
    if (token.kind === "tag") {
      tags.add(searchTagKey(token.prefix, token.normalized));
    }
  }
  const hasTag = (tag: { prefix: string; normalizedTag: string }) =>
    tags.has(searchTagKey(tag.prefix, tag.normalizedTag));

  return (
    source.toLowerCase().includes(query.text.toLowerCase()) &&
    query.requiredTags.every(hasTag) &&
    query.excludedTags.every((tag) => !hasTag(tag)) &&
    query.orGroups.every((group) => group.some(hasTag))
  );
}

function prepareTagQuery(nodeCount: number): PreparedWorkload {
  const sources: string[] = [];
  let expectedMatchedCount = 0;

  for (let index = 0; index < nodeCount; index += 1) {
    const urgent = index % 3 === 0;
    const blocked = index % 5 === 0;
    const project = index % 20;
    sources.push(
      `Roadmap node ${index} #project${project} @owner${index % 10} ${
        urgent ? "#urgent" : "#routine"
      }${blocked ? " #blocked" : ""}`
    );
    if (urgent && !blocked && (project === 1 || project === 2)) {
      expectedMatchedCount += 1;
    }
  }

  return {
    run: () => {
      const query = parseNoteSearchQuery(
        "roadmap #urgent #project1 OR #project2 -#blocked"
      );
      let matchedCount = 0;
      for (const source of sources) {
        matchedCount += matchesParsedTagQuery(source, query) ? 1 : 0;
      }
      return {
        matchedCount,
        text: query.text,
        requiredCount: query.requiredTags.length,
        excludedCount: query.excludedTags.length,
        orGroupSizes: query.orGroups.map((group) => group.length)
      };
    },
    expected: {
      matchedCount: expectedMatchedCount,
      text: "roadmap",
      requiredCount: 1,
      excludedCount: 1,
      orGroupSizes: [2]
    }
  };
}

const dateExpressions = [
  "today",
  "08/15/2026",
  "next week",
  "09/01/2026 - 09/03/2026"
] as const;

function prepareDateIndex(nodeCount: number): PreparedWorkload {
  const sources = Array.from(
    { length: nodeCount },
    (_, index) => `Node ${index} schedule ${dateExpressions[index % 4]} #calendar`
  );

  return {
    run: () => {
      const index = new Map<string, number>();
      let matchCount = 0;
      let rangeCount = 0;
      for (const source of sources) {
        const matches = findNoteDateMatches(source, {
          today: { year: 2026, month: 7, day: 12 },
          weekStartsOn: "monday"
        });
        for (const match of matches) {
          const key = formatLocalDateIso(match.start);
          index.set(key, (index.get(key) ?? 0) + 1);
          matchCount += 1;
          rangeCount += match.end === null ? 0 : 1;
        }
      }
      return {
        matchCount,
        rangeCount,
        bucketCounts: [
          index.get("2026-07-12") ?? 0,
          index.get("2026-08-15") ?? 0,
          index.get("2026-07-13") ?? 0,
          index.get("2026-09-01") ?? 0
        ]
      };
    },
    expected: {
      matchCount: nodeCount,
      rangeCount:
        countResidue(nodeCount, 2, 4) + countResidue(nodeCount, 3, 4),
      bucketCounts: [0, 1, 2, 3].map((residue) =>
        countResidue(nodeCount, residue, 4)
      )
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

const cases: readonly PerformanceCase[] = [
  // Baselines are conservative CI envelopes; the enforced budget is +20%.
  {
    label: "tokenization",
    nodeCount: 1_000,
    baselineP95Ms: 15,
    prepare: prepareTokenization
  },
  {
    label: "tokenization",
    nodeCount: 10_000,
    baselineP95Ms: 70,
    prepare: prepareTokenization
  },
  {
    label: "visible-row derivation",
    nodeCount: 1_000,
    baselineP95Ms: 2,
    prepare: prepareVisibleRows
  },
  {
    label: "visible-row derivation",
    nodeCount: 10_000,
    baselineP95Ms: 12,
    prepare: prepareVisibleRows
  },
  {
    label: "tag AND/OR/NOT parse + match",
    nodeCount: 1_000,
    baselineP95Ms: 8,
    prepare: prepareTagQuery
  },
  {
    label: "tag AND/OR/NOT parse + match",
    nodeCount: 10_000,
    baselineP95Ms: 75,
    prepare: prepareTagQuery
  },
  {
    label: "date parse + index derivation",
    nodeCount: 1_000,
    baselineP95Ms: 12,
    prepare: prepareDateIndex
  },
  {
    label: "date parse + index derivation",
    nodeCount: 10_000,
    baselineP95Ms: 110,
    prepare: prepareDateIndex
  },
  {
    label: "local history eviction",
    nodeCount: 1_000,
    baselineP95Ms: 6,
    prepare: prepareHistory
  },
  {
    label: "local history eviction",
    nodeCount: 10_000,
    baselineP95Ms: 40,
    prepare: prepareHistory
  }
];

performanceSuite("notes expansion frontend performance", () => {
  it.each(cases)(
    "$label: $nodeCount nodes; p95 <= baseline +20%",
    { timeout: 120_000 },
    ({ label, nodeCount, baselineP95Ms, prepare }) => {
      const budgetP95Ms = baselineP95Ms * REGRESSION_ALLOWANCE;
      const stats = measureWorkload(prepare(nodeCount));

      expect(stats.samplesMs).toHaveLength(MEASURED_SAMPLES);
      expect(stats.samplesMs.every(Number.isFinite)).toBe(true);
      console.info(
        `[notes-perf] ${label}; nodes=${nodeCount}; warmups=${WARMUP_SAMPLES}; ` +
          `samples=${MEASURED_SAMPLES}; median=${stats.medianMs.toFixed(2)}ms; ` +
          `p95=${stats.p95Ms.toFixed(2)}ms; baseline=${baselineP95Ms.toFixed(
            2
          )}ms; budget=${budgetP95Ms.toFixed(2)}ms`
      );
      expect(stats.p95Ms).toBeLessThanOrEqual(budgetP95Ms);
    }
  );
});
