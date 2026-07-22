import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncStatus } from "./notesSyncContract";
import {
  clearNotesSyncStatus,
  getNotesSyncStatus,
  publishNotesSyncStatus,
  resetNotesSyncStatusStore,
  subscribeNotesSyncStatus
} from "./notesSyncStatusStore";

const status: SyncStatus = {
  running: true,
  dirtyTopics: 2,
  quarantined: ["milk.1f2a.md"],
  lastExportAt: null,
  lastMergeAt: null
};

afterEach(() => {
  resetNotesSyncStatusStore();
});

describe("notesSyncStatusStore", () => {
  it("returns null for an unknown vault and stores per vault", () => {
    expect(getNotesSyncStatus("/a")).toBeNull();
    publishNotesSyncStatus("/a", status);
    expect(getNotesSyncStatus("/a")).toEqual(status);
    expect(getNotesSyncStatus("/b")).toBeNull();
  });

  it("notifies subscribers on publish and clear, and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotesSyncStatus(listener);
    publishNotesSyncStatus("/a", status);
    expect(listener).toHaveBeenCalledTimes(1);
    clearNotesSyncStatus("/a");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getNotesSyncStatus("/a")).toBeNull();
    unsubscribe();
    publishNotesSyncStatus("/a", status);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not notify when clearing an absent vault", () => {
    const listener = vi.fn();
    subscribeNotesSyncStatus(listener);
    clearNotesSyncStatus("/missing");
    expect(listener).not.toHaveBeenCalled();
  });
});
