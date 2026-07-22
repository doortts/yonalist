import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectNotesSyncRuntime,
  startNotesSyncListener,
  type SyncChangedPayload,
  type SyncStatus
} from "./notesSyncListener";
import {
  getNotesSyncStatus,
  resetNotesSyncStatusStore
} from "./notesSyncStatusStore";

type EventHandler = (event: { payload: unknown }) => void;

const listenMock = vi.hoisted(() => vi.fn());
const notesSyncStartMock = vi.hoisted(() => vi.fn());
const notesSyncStatusMock = vi.hoisted(() => vi.fn());
const handlers = new Map<string, Set<EventHandler>>();
const unlistenCalls: Array<ReturnType<typeof vi.fn>> = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock
}));

vi.mock("./notesStore", () => ({
  notesSyncStart: notesSyncStartMock,
  notesSyncStatus: notesSyncStatusMock
}));

function emit(name: string, payload: unknown): void {
  for (const handler of handlers.get(name) ?? []) {
    handler({ payload });
  }
}

describe("notesSyncListener", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    handlers.clear();
    unlistenCalls.splice(0);
    notesSyncStartMock.mockReset().mockResolvedValue({
      running: true,
      dirtyTopics: 0,
      quarantined: [],
      lastExportAt: null,
      lastMergeAt: null
    });
    notesSyncStatusMock.mockReset().mockResolvedValue({
      running: true,
      dirtyTopics: 0,
      quarantined: [],
      lastExportAt: null,
      lastMergeAt: null
    });
    listenMock.mockReset().mockImplementation(
      async (name: string, handler: EventHandler) => {
        const listeners = handlers.get(name) ?? new Set<EventHandler>();
        listeners.add(handler);
        handlers.set(name, listeners);
        const unlisten = vi.fn(() => listeners.delete(handler));
        unlistenCalls.push(unlisten);
        return unlisten;
      }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("filters vaults, coalesces bursts, survives StrictMode cleanup, and contains reload rejection", async () => {
    const reload = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("reload failed"))
      .mockResolvedValue(undefined);
    const statuses: SyncStatus[] = [];
    const options = {
      vaultRoot: "/vault",
      onWorkspaceChanged: reload,
      onStatus: (status: SyncStatus) => statuses.push(status)
    };
    const firstCleanup = await startNotesSyncListener(options);
    firstCleanup();
    firstCleanup();
    const cleanup = await startNotesSyncListener(options);

    emit("notes://sync-changed", {
      vaultPath: "/other",
      topicIds: ["other"]
    } satisfies SyncChangedPayload);
    emit("notes://sync-changed", {
      vaultPath: "/vault",
      topicIds: ["one"]
    } satisfies SyncChangedPayload);
    emit("notes://sync-changed", {
      vaultPath: "/vault",
      topicIds: ["two"]
    } satisfies SyncChangedPayload);
    await vi.advanceTimersByTimeAsync(499);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(1);

    emit("notes://sync-changed", {
      vaultPath: "/vault",
      topicIds: []
    } satisfies SyncChangedPayload);
    await vi.advanceTimersByTimeAsync(500);
    expect(reload).toHaveBeenCalledTimes(2);

    const status: SyncStatus = {
      running: true,
      dirtyTopics: 0,
      quarantined: [],
      lastExportAt: null,
      lastMergeAt: "2026-07-21T00:00:00.000Z"
    };
    emit("notes://sync-status", { vaultPath: "/vault", status });
    expect(statuses).toEqual([status]);

    cleanup();
    cleanup();
    emit("notes://sync-changed", {
      vaultPath: "/vault",
      topicIds: ["after-cleanup"]
    } satisfies SyncChangedPayload);
    await vi.advanceTimersByTimeAsync(500);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(unlistenCalls).toHaveLength(4);
    expect(unlistenCalls.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
  });

  it("registers the listener before native start and ignores a late stale vault generation", async () => {
    let resolveOldListen!: (unlisten: () => void) => void;
    const oldListen = new Promise<() => void>((resolve) => {
      resolveOldListen = resolve;
    });
    listenMock.mockImplementationOnce(() => oldListen);

    const disconnectOld = connectNotesSyncRuntime({
      vaultRoot: "/old",
      onWorkspaceChanged: vi.fn()
    });
    expect(notesSyncStartMock).not.toHaveBeenCalled();
    disconnectOld();
    const disconnectCurrent = connectNotesSyncRuntime({
      vaultRoot: "/current",
      onWorkspaceChanged: vi.fn()
    });
    await vi.waitFor(() => {
      expect(notesSyncStartMock).toHaveBeenCalledTimes(1);
    });
    expect(notesSyncStartMock).toHaveBeenCalledWith("/current");

    const lateOldUnlisten = vi.fn();
    resolveOldListen(lateOldUnlisten);
    await Promise.resolve();
    await Promise.resolve();
    expect(notesSyncStartMock).toHaveBeenCalledTimes(1);

    disconnectCurrent();
    disconnectCurrent();
    await vi.waitFor(() => expect(lateOldUnlisten).toHaveBeenCalledTimes(1));
    expect(unlistenCalls.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
  });

  it("serializes an in-flight old-vault start before activating the current vault", async () => {
    let resolveOldStart!: (status: SyncStatus) => void;
    const oldStart = new Promise<SyncStatus>((resolve) => {
      resolveOldStart = resolve;
    });
    const status: SyncStatus = {
      running: true,
      dirtyTopics: 0,
      quarantined: [],
      lastExportAt: null,
      lastMergeAt: null
    };
    notesSyncStartMock
      .mockImplementationOnce(() => oldStart)
      .mockResolvedValue(status);
    const disconnectOld = connectNotesSyncRuntime({
      vaultRoot: "/old-in-flight",
      onWorkspaceChanged: vi.fn()
    });
    await vi.waitFor(() => expect(notesSyncStartMock).toHaveBeenCalledTimes(1));

    disconnectOld();
    const disconnectCurrent = connectNotesSyncRuntime({
      vaultRoot: "/current-after-old",
      onWorkspaceChanged: vi.fn()
    });
    await Promise.resolve();
    expect(notesSyncStartMock).toHaveBeenCalledTimes(1);

    resolveOldStart(status);
    await vi.waitFor(() => expect(notesSyncStartMock).toHaveBeenCalledTimes(2));
    expect(notesSyncStartMock.mock.calls.map(([vaultRoot]) => vaultRoot)).toEqual([
      "/old-in-flight",
      "/current-after-old"
    ]);
    disconnectCurrent();
  });

  it("keeps concurrent same-vault workspace listeners active", async () => {
    const firstReload = vi.fn();
    const secondReload = vi.fn();
    const disconnectFirst = connectNotesSyncRuntime({
      vaultRoot: "/shared",
      onWorkspaceChanged: firstReload
    });
    const disconnectSecond = connectNotesSyncRuntime({
      vaultRoot: "/shared",
      onWorkspaceChanged: secondReload
    });
    await vi.waitFor(() => expect(unlistenCalls).toHaveLength(4));

    emit("notes://sync-changed", {
      vaultPath: "/shared",
      topicIds: ["shared-topic"]
    } satisfies SyncChangedPayload);
    await vi.advanceTimersByTimeAsync(500);

    expect(firstReload).toHaveBeenCalledTimes(1);
    expect(secondReload).toHaveBeenCalledTimes(1);
    disconnectFirst();
    disconnectSecond();
  });

  it("does not forward an old-vault status while the current native start is queued", async () => {
    const oldStatus: SyncStatus = {
      running: true,
      dirtyTopics: 1,
      quarantined: ["old.md"],
      lastExportAt: null,
      lastMergeAt: null
    };
    const currentStatus: SyncStatus = {
      running: true,
      dirtyTopics: 0,
      quarantined: [],
      lastExportAt: null,
      lastMergeAt: "2026-07-21T00:00:00.000Z"
    };
    let resolveCurrentStart!: (status: SyncStatus) => void;
    const pendingCurrentStart = new Promise<SyncStatus>((resolve) => {
      resolveCurrentStart = resolve;
    });
    notesSyncStartMock
      .mockResolvedValueOnce(oldStatus)
      .mockImplementationOnce(() => pendingCurrentStart);
    notesSyncStatusMock
      .mockResolvedValueOnce(oldStatus)
      .mockResolvedValueOnce(currentStatus);
    const disconnectOld = connectNotesSyncRuntime({
      vaultRoot: "/status-old",
      onWorkspaceChanged: vi.fn()
    });
    await vi.waitFor(() => expect(notesSyncStartMock).toHaveBeenCalledTimes(1));
    const currentStatuses: SyncStatus[] = [];
    const disconnectCurrent = connectNotesSyncRuntime({
      vaultRoot: "/status-current",
      onWorkspaceChanged: vi.fn(),
      onStatus: (status) => currentStatuses.push(status)
    });
    await vi.waitFor(() => expect(notesSyncStartMock).toHaveBeenCalledTimes(2));

    emit("notes://sync-status", {
      vaultPath: "/status-old",
      status: oldStatus
    });
    expect(currentStatuses).toEqual([]);
    resolveCurrentStart(currentStatus);
    await vi.waitFor(() => expect(currentStatuses).toEqual([currentStatus]));

    disconnectOld();
    disconnectCurrent();
  });

  it("refreshes status after activation without overwriting a newer handoff event", async () => {
    const returnedStatus: SyncStatus = {
      running: true,
      dirtyTopics: 1,
      quarantined: ["before-handoff.md"],
      lastExportAt: null,
      lastMergeAt: null
    };
    const newerStatus: SyncStatus = {
      running: true,
      dirtyTopics: 0,
      quarantined: [],
      lastExportAt: "2026-07-21T00:00:01.000Z",
      lastMergeAt: "2026-07-21T00:00:02.000Z"
    };
    let resolveStart!: (status: SyncStatus) => void;
    notesSyncStartMock.mockImplementationOnce(
      () =>
        new Promise<SyncStatus>((resolve) => {
          resolveStart = resolve;
        })
    );
    notesSyncStatusMock.mockResolvedValue(newerStatus);
    const statuses: SyncStatus[] = [];
    const disconnect = connectNotesSyncRuntime({
      vaultRoot: "/status-handoff",
      onWorkspaceChanged: vi.fn(),
      onStatus: (status) => statuses.push(status)
    });
    await vi.waitFor(() => expect(notesSyncStartMock).toHaveBeenCalledTimes(1));

    emit("notes://sync-status", {
      vaultPath: "/status-handoff",
      status: newerStatus
    });
    resolveStart(returnedStatus);

    await vi.waitFor(() => {
      expect(notesSyncStatusMock).toHaveBeenCalledWith("/status-handoff");
      expect(statuses).toEqual([newerStatus]);
    });
    disconnect();
  });

  it("rejects a delayed old-vault status wrapper after the current vault activates", async () => {
    const oldStatus: SyncStatus = {
      running: true,
      dirtyTopics: 4,
      quarantined: ["old.md"],
      lastExportAt: null,
      lastMergeAt: null
    };
    const currentStatus: SyncStatus = {
      running: true,
      dirtyTopics: 0,
      quarantined: [],
      lastExportAt: "2026-07-21T00:00:03.000Z",
      lastMergeAt: "2026-07-21T00:00:04.000Z"
    };
    let resolveCurrentStatus!: (status: SyncStatus) => void;
    const pendingCurrentStatus = new Promise<SyncStatus>((resolve) => {
      resolveCurrentStatus = resolve;
    });
    notesSyncStartMock
      .mockResolvedValueOnce(oldStatus)
      .mockResolvedValueOnce(currentStatus);
    notesSyncStatusMock
      .mockResolvedValueOnce(oldStatus)
      .mockImplementationOnce(() => pendingCurrentStatus);
    const disconnectOld = connectNotesSyncRuntime({
      vaultRoot: "/status-wrapper-old",
      onWorkspaceChanged: vi.fn()
    });
    await vi.waitFor(() => expect(notesSyncStatusMock).toHaveBeenCalledTimes(1));
    const statuses: SyncStatus[] = [];
    const disconnectCurrent = connectNotesSyncRuntime({
      vaultRoot: "/status-wrapper-current",
      onWorkspaceChanged: vi.fn(),
      onStatus: (status) => statuses.push(status)
    });
    await vi.waitFor(() => expect(notesSyncStatusMock).toHaveBeenCalledTimes(2));

    emit("notes://sync-status", {
      vaultPath: "/status-wrapper-old",
      status: oldStatus
    });
    resolveCurrentStatus(currentStatus);

    await vi.waitFor(() => expect(statuses).toEqual([currentStatus]));
    disconnectOld();
    disconnectCurrent();
  });

  it("surfaces a native start failure as an error status instead of swallowing it", async () => {
    resetNotesSyncStatusStore();
    notesSyncStartMock.mockReset().mockRejectedValue(new Error("start boom"));
    const disconnect = connectNotesSyncRuntime({
      vaultRoot: "/start-fail",
      onWorkspaceChanged: vi.fn()
    });

    await vi.waitFor(() => {
      const status = getNotesSyncStatus("/start-fail");
      expect(status?.running).toBe(false);
      expect(status?.lastError).toBe("start boom");
    });

    disconnect();
    resetNotesSyncStatusStore();
  });
});
