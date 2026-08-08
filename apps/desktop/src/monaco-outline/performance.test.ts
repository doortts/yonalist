import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { PaneImageZones, type ImageZonePort } from "./imageZones";
import { MonacoOutlineSession } from "./session";

const NODE_COUNT = 5_000;

// Design §6's mixed page: 5,000 nodes as 4,000 plain bullets, 700 carrying a
// two-line note and 300 pictures — 6,400 model lines once the runs unfold.
const TEXT_COUNT = 4_000;
const NOTE_COUNT = 700;
const NOTE_LINES = 2;
const IMAGE_COUNT = 300;
const MIXED_PAGE_ID = "mixed-performance-page";

function node(index: number): NoteView {
  return {
    id: `node-${index}`,
    parentId: "performance-page",
    sortKey: (index + 1) * 1_024,
    kind: "bullet",
    image: null,
    text: `line ${index}`,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

// One 50-node cycle of 40 plain bullets, 7 noted ones and 3 pictures, run 100
// times: the quotas come out exact and no kind ever clusters into a window.
const NOTE_SLOTS = new Set([3, 10, 17, 24, 31, 38, 45]);
const IMAGE_SLOTS = new Set([8, 26, 44]);

function mixedNodes(): readonly NoteView[] {
  const total = TEXT_COUNT + NOTE_COUNT + IMAGE_COUNT;
  return Array.from({ length: total }, (_, index) => {
    const slot = index % 50;
    const base = { ...node(index), parentId: MIXED_PAGE_ID };
    if (NOTE_SLOTS.has(slot)) {
      return {
        ...base,
        note: Array.from({ length: NOTE_LINES }, (_, part) =>
          `note ${index} line ${part}`).join("\n")
      };
    }
    if (!IMAGE_SLOTS.has(slot)) return base;
    return {
      ...base,
      kind: "image" as const,
      text: `shot-${index}.png`,
      image: {
        contentHash: `${index}`.padStart(64, "0"),
        originalName: `shot-${index}.png`,
        mimeType: "image/png",
        byteLength: 1_024,
        pixelWidth: 800,
        pixelHeight: 400,
        displayWidth: 400
      }
    };
  });
}

function receipt(): MutationReceipt {
  return {
    revision: 2,
    changedNodes: [],
    deletedIds: [],
    history: {
      canUndo: false,
      canRedo: false,
      undoDepth: 0,
      redoDepth: 0
    }
  };
}

describe("Monaco outline bounded performance", () => {
  it("applies 200 edits and 100 splits without a full-model replacement", async () => {
    let allocated = 0;
    const session = MonacoOutlineSession.create({
      pageId: "performance-page",
      nodes: Array.from({ length: NODE_COUNT }, (_, index) => node(index)),
      persistence: {
        executeEditorBatch: vi.fn().mockResolvedValue(receipt())
      },
      allocateId: () => `inserted-${allocated++}`
    });

    for (let index = 0; index < 200; index += 1) {
      const column = session.model.getLineMaxColumn(index + 1);
      session.model.pushEditOperations([], [{
        range: new monaco.Range(index + 1, column, index + 1, column),
        text: "!"
      }], () => null);
    }
    for (let index = 0; index < 100; index += 1) {
      const lineNumber = index * 2 + 1;
      const column = session.model.getLineMaxColumn(lineNumber);
      session.model.pushEditOperations([], [{
        range: new monaco.Range(
          lineNumber,
          column,
          lineNumber,
          column
        ),
        text: "\n"
      }], () => null);
    }

    expect(session.model.getLineCount()).toBe(5_100);
    expect(session.metadata.current().lines).toHaveLength(5_100);
    expect(session.metrics.fullModelReplacementCount).toBe(0);
    expect(session.metrics.maxDecorationLinesPerEdit)
      .toBeLessThanOrEqual(3);
    await session.dispose();
  }, 20_000);

  it("keeps the same budget on a page of notes and pictures", async () => {
    const session = MonacoOutlineSession.create({
      pageId: MIXED_PAGE_ID,
      nodes: mixedNodes(),
      persistence: {
        executeEditorBatch: vi.fn().mockResolvedValue(receipt())
      }
    });
    const lines = session.metadata.current().lines;
    const noteLines = lineNumbersOfKind(lines, "note");
    const imageLines = lineNumbersOfKind(lines, "image");

    // Design §6: notes and captions are ordinary text edits, so the same
    // per-edit budget has to hold on the rows they added.
    expect(lines).toHaveLength(
      TEXT_COUNT + NOTE_COUNT * (1 + NOTE_LINES) + IMAGE_COUNT
    );
    expect(noteLines).toHaveLength(NOTE_COUNT * NOTE_LINES);
    expect(imageLines).toHaveLength(IMAGE_COUNT);

    for (const lineNumber of noteLines.slice(0, 100)) {
      appendTo(session, lineNumber, "!");
    }
    for (const lineNumber of imageLines.slice(0, 100)) {
      appendTo(session, lineNumber, "?");
    }
    for (const lineNumber of lineNumbersOfKind(lines, "text").slice(0, 100)) {
      appendTo(session, lineNumber, ".");
    }

    expect(session.metrics.fullModelReplacementCount).toBe(0);
    expect(session.metrics.maxDecorationLinesPerEdit).toBeLessThanOrEqual(3);

    // Contract I8: the zones alive at once follow the visible window, never
    // the page's picture count.
    const zones = new PaneImageZones({
      editor: zoneEditor(),
      port: zonePort()
    });
    zones.sync({
      lines: session.metadata.current().lines,
      images: session.imageByNodeId,
      window: [1, 60],
      hidden: []
    });
    expect(zones.size).toBeGreaterThan(0);
    expect(zones.size).toBeLessThanOrEqual(60);
    expect(zones.size).toBeLessThan(IMAGE_COUNT);
    zones.dispose();

    await session.dispose();
  }, 20_000);
});

function appendTo(
  session: MonacoOutlineSession,
  lineNumber: number,
  text: string
): void {
  const column = session.model.getLineMaxColumn(lineNumber);
  session.model.pushEditOperations([], [{
    range: new monaco.Range(lineNumber, column, lineNumber, column),
    text
  }], () => null);
}

function lineNumbersOfKind(
  lines: readonly { readonly kind: string }[],
  kind: string
): readonly number[] {
  return lines.flatMap((line, index) => line.kind === kind ? [index + 1] : []);
}

/** The zone host: only the two calls `PaneImageZones` makes on an editor. */
function zoneEditor(): monaco.editor.ICodeEditor {
  let nextId = 0;
  return {
    getLayoutInfo: () => ({ contentWidth: 900 }),
    changeViewZones: (
      callback: (accessor: monaco.editor.IViewZoneChangeAccessor) => void
    ) => callback({
      addZone: () => `zone-${++nextId}`,
      removeZone: () => undefined,
      layoutZone: () => undefined
    } as unknown as monaco.editor.IViewZoneChangeAccessor)
  } as unknown as monaco.editor.ICodeEditor;
}

function zonePort(): ImageZonePort {
  return {
    residency: {
      activate: () => () => undefined,
      subscribe: () => () => undefined,
      getSnapshot: () => ({ status: "idle" })
    },
    resize: () => Promise.resolve(),
    openLightbox: () => undefined
  };
}
