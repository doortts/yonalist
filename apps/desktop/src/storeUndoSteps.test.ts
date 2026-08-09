import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { CommandEnvelope } from "../../../packages/contracts/generated/CommandEnvelope";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { NotesStore } from "./notesStore";
import { DRAFT_DEBOUNCE_MS } from "./storeSupport";

interface HistoryEntry {
  readonly group: string | null;
  readonly id: string;
  readonly text: string;
  readonly note: string;
}

function bullet(id: string): NoteView {
  return {
    id,
    parentId: "page-1",
    sortKey: 1_024,
    kind: "bullet",
    image: null,
    text: id,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

/**
 * A backend that keeps just enough history to answer "how many undo steps did
 * that typing produce". It mirrors the Rust coalescer: an entry folds into the
 * previous one only when the history group matches, and folding keeps the
 * older restore point.
 */
async function harness(): Promise<{
  readonly store: NotesStore;
  readonly groups: readonly (string | null)[];
}> {
  const nodes = new Map<string, NoteView>([["one", bullet("one")]]);
  const undoStack: HistoryEntry[] = [];
  const groups: (string | null)[] = [];
  let revision = 1;

  const receiptFor = (id: string): MutationReceipt => ({
    revision,
    changedNodes: [nodes.get(id)!],
    deletedIds: [],
    history: {
      canUndo: undoStack.length > 0,
      canRedo: false,
      undoDepth: undoStack.length,
      redoDepth: 0
    }
  });

  const record = (entry: HistoryEntry): void => {
    const previous = undoStack.at(-1);
    if (entry.group !== null && previous?.group === entry.group) return;
    undoStack.push(entry);
  };

  const boot: BootSnapshot = {
    sessionId: "session-1",
    revision,
    activePageId: "page-1",
    pages: [{ id: "page-1", title: "Page" }],
    viewport: {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: [...nodes.values()]
    },
    history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
  };

  const api: NotesApi = {
    bootstrap: vi.fn().mockResolvedValue(boot),
    queryViewport: vi.fn(),
    queryForest: vi.fn(),
    execute: vi.fn(async (envelope: CommandEnvelope) => {
      const { command } = envelope;
      if (command.kind !== "updateText" && command.kind !== "updateNote") {
        throw new Error(`unexpected command ${command.kind}`);
      }
      groups.push(envelope.historyGroup);
      const node = nodes.get(command.id)!;
      record({
        group: envelope.historyGroup,
        id: command.id,
        text: node.text,
        note: node.note
      });
      nodes.set(command.id, command.kind === "updateText"
        ? { ...node, text: command.text }
        : { ...node, note: command.note });
      revision += 1;
      return receiptFor(command.id);
    }),
    importImageBytes: vi.fn(),
    importImagePaths: vi.fn(),
    replaceImageBytes: vi.fn(),
    replaceImagePath: vi.fn(),
    readImage: vi.fn(),
    viewImageOriginal: vi.fn(),
    downloadImage: vi.fn(),
    undo: vi.fn(async () => {
      const entry = undoStack.pop();
      if (!entry) throw new Error("nothing to undo");
      const node = nodes.get(entry.id)!;
      nodes.set(entry.id, { ...node, text: entry.text, note: entry.note });
      revision += 1;
      return receiptFor(entry.id);
    }),
    redo: vi.fn(),
    search: vi.fn(),
    exportNotes: vi.fn(),
    closeSession: vi.fn(),
    unusedAssets: vi.fn(),
    deleteAllData: vi.fn()
  };

  const store = new NotesStore(api);
  await store.bootstrap();
  vi.useFakeTimers();
  return { store, groups };
}

describe("drafts left behind by a flush", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears a title draft that matches the text it flushed", async () => {
    const { store } = await harness();

    store.setDraft("one", "one");
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);

    expect(store.getSnapshot().drafts).toEqual({});
  });

  it("clears a note draft that matches the note it flushed", async () => {
    const { store } = await harness();

    store.setNoteDraft("one", "");
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);

    expect(store.getSnapshot().noteDrafts).toEqual({});
  });

  it("does not show a stale title draft over the text an undo restored", async () => {
    const { store } = await harness();

    store.setDraft("one", "hello");
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    // A character typed and deleted again: the draft matches what was already
    // committed, so the flush has nothing to send.
    store.setDraft("one", "hello");
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);

    await store.undo();

    expect(store.getSnapshot().nodes[0].text).toBe("one");
    expect(store.getNodeSnapshot("one").title).toBe("one");
  });

  it("does not resurrect the pre-undo text on the next keystroke", async () => {
    const { store } = await harness();

    store.setDraft("one", "hello");
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    store.setDraft("one", "hello");
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    await store.undo();

    store.setDraft("one", `${store.getNodeSnapshot("one").title}!`);
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);

    expect(store.getSnapshot().nodes[0].text).toBe("one!");
  });

  it("does not show a stale note draft over the note an undo restored", async () => {
    const { store } = await harness();

    store.setNoteDraft("one", "hello");
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    store.setNoteDraft("one", "hello");
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);

    await store.undo();

    expect(store.getNodeSnapshot("one").note).toBe("");
  });
});
