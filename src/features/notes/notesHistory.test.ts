import { describe, expect, it } from "vitest";
import type { NotesWorkspaceScope } from "../../domain/notes";
import {
  createNotesHistoryOwnerRegistry,
  createNotesHistorySession,
  type NotesHistorySnapshot
} from "./notesHistory";

const ids = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005",
  "10000000-0000-4000-8000-000000000006"
];

function idFactory(): () => string {
  let index = 0;
  return () => ids[index++]!;
}

function snapshot(
  selectedId: string | null,
  field: "title" | "note" = "title",
  scope: NotesWorkspaceScope = { kind: "active" }
): NotesHistorySnapshot {
  return {
    scope,
    selectedId,
    zoomRootId: selectedId,
    locallyExpandedNodeIds: selectedId ? [selectedId] : [],
    focus: selectedId ? { nodeId: selectedId, field } : null
  };
}

describe("notes history session", () => {
  it("bounds completed owners without evicting in-flight metadata", () => {
    const owners = createNotesHistoryOwnerRegistry<string>(2);
    owners.begin("one", "owner");
    owners.begin("two", "owner");
    owners.begin("three", "owner");

    expect(owners.size()).toBe(3);
    expect(owners.owner("one")).toBe("owner");

    owners.complete("one");
    owners.complete("two");
    owners.complete("three");
    expect(owners.size()).toBe(2);
    expect(owners.owner("one")).toBeUndefined();

    for (let index = 0; index < 300; index += 1) {
      const entryId = `failed-${index}`;
      owners.begin(entryId, "owner");
      owners.discard(entryId);
    }
    expect(owners.size()).toBe(2);
  });

  it("allocates a stable text entry when a draft begins and replaces it after closure", () => {
    const history = createNotesHistorySession({ createId: idFactory() });

    const first = history.beginTextBurst("node-a", snapshot("node-a"));
    const continued = history.beginTextBurst("node-a", snapshot("node-a"));
    history.closeTextBurst();
    const next = history.beginTextBurst("node-a", snapshot("node-a"));

    expect(history.sessionId).toBe(ids[0]);
    expect(continued).toEqual(first);
    expect(first).toMatchObject({
      sessionId: ids[0],
      entryId: ids[1],
      commandKind: "text"
    });
    expect(next.entryId).toBe(ids[2]);
  });

  it("closes the active burst when editing switches fields on the same node", () => {
    const history = createNotesHistorySession({ createId: idFactory() });

    const title = history.beginTextBurst(
      "node-a",
      snapshot("node-a", "title")
    );
    const continuedTitle = history.beginTextBurst(
      "node-a",
      snapshot("node-a", "title")
    );
    const note = history.beginTextBurst(
      "node-a",
      snapshot("node-a", "note")
    );

    expect(continuedTitle.entryId).toBe(title.entryId);
    expect(note.entryId).not.toBe(title.entryId);
    expect(note.entryId).toBe(ids[2]);
  });

  it("closes text before allocating a distinct structural entry", () => {
    const history = createNotesHistorySession({ createId: idFactory() });
    const text = history.beginTextBurst("node-a", snapshot("node-a"));

    const structural = history.beginStructuralEntry(
      "split",
      snapshot("node-a")
    );
    const nextText = history.beginTextBurst("node-a", snapshot("node-a"));

    expect(structural).toMatchObject({
      sessionId: history.sessionId,
      entryId: ids[2],
      commandKind: "split"
    });
    expect(structural.entryId).not.toBe(text.entryId);
    expect(nextText.entryId).toBe(ids[3]);
  });

  it("merges before and latest after snapshots for a backend entry", () => {
    const history = createNotesHistorySession({ createId: idFactory() });
    const context = history.beginTextBurst("node-a", snapshot("node-a"));

    history.rememberAfter(context.entryId, snapshot("node-a", "note"));
    history.rememberAfter(
      context.entryId,
      snapshot("node-b", "title", { kind: "starred" })
    );

    expect(history.snapshotForReplay(context.entryId, "undo")).toEqual(
      snapshot("node-a")
    );
    expect(history.snapshotForReplay(context.entryId, "redo")).toEqual(
      snapshot("node-b", "title", { kind: "starred" })
    );
  });

  it("returns null for missing or evicted snapshots", () => {
    const history = createNotesHistorySession({
      createId: idFactory(),
      maxSnapshots: 2
    });
    const first = history.beginStructuralEntry("create", snapshot("node-a"));
    history.rememberAfter(first.entryId, snapshot("node-a"));
    const second = history.beginStructuralEntry("move", snapshot("node-b"));
    history.rememberAfter(second.entryId, snapshot("node-b"));
    const third = history.beginStructuralEntry("star", snapshot("node-c"));
    history.rememberAfter(third.entryId, snapshot("node-c"));

    expect(history.snapshotForReplay(first.entryId, "undo")).toBeNull();
    expect(history.snapshotForReplay(second.entryId, "undo")).toEqual(
      snapshot("node-b")
    );
    expect(history.snapshotForReplay(ids[5], "redo")).toBeNull();
  });

  it("never evicts entries that are still awaiting authoritative completion", () => {
    const history = createNotesHistorySession({
      createId: idFactory(),
      maxSnapshots: 1
    });
    const first = history.beginStructuralEntry("create", snapshot("node-a"));
    const second = history.beginStructuralEntry("move", snapshot("node-b"));

    expect(history.snapshotForReplay(first.entryId, "undo")).toEqual(
      snapshot("node-a")
    );
    expect(history.snapshotForReplay(second.entryId, "undo")).toEqual(
      snapshot("node-b")
    );

    history.rememberAfter(first.entryId, snapshot("node-c"));
    history.rememberAfter(second.entryId, snapshot("node-d"));

    expect(history.snapshotForReplay(first.entryId, "undo")).toBeNull();
    expect(history.snapshotForReplay(second.entryId, "undo")).toEqual(
      snapshot("node-b")
    );
  });

  it("discards settled failures without leaking snapshots or the active burst", () => {
    let sequence = 0;
    const history = createNotesHistorySession({
      createId: () => `history-${sequence++}`,
      maxSnapshots: 2
    });

    for (let index = 0; index < 300; index += 1) {
      const structural = history.beginStructuralEntry(
        "move",
        snapshot(`node-${index}`)
      );
      history.discard(structural.entryId);
    }
    const text = history.beginTextBurst("node-a", snapshot("node-a"));
    history.discard(text.entryId);
    const nextText = history.beginTextBurst("node-a", snapshot("node-a"));

    expect(nextText.entryId).not.toBe(text.entryId);
    expect(history.snapshotCount()).toBe(1);
  });

  it("creates independent session IDs for separate vault coordinator entries", () => {
    const createId = idFactory();
    const first = createNotesHistorySession({ createId });
    const second = createNotesHistorySession({ createId });

    expect(first.sessionId).toBe(ids[0]);
    expect(second.sessionId).toBe(ids[1]);
  });
});
