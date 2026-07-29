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

  it("reloads the current workspace after native sync activation without waiting for a file event", async () => {
    const status: SyncStatus = {
      running: true,
      dirtyTopics: 0,
      quarantined: [],
      lastExportAt: null,
      lastMergeAt: null
    };
    let resolveStart!: (status: SyncStatus) => void;
    notesSyncStartMock.mockImplementationOnce(
      () =>
        new Promise<SyncStatus>((resolve) => {
          resolveStart = resolve;
        })
    );
    const reload = vi.fn().mockResolvedValue(undefined);
    const disconnect = connectNotesSyncRuntime({
      vaultRoot: "/fresh-vault",
      onWorkspaceChanged: reload
    });

    await vi.waitFor(() => expect(notesSyncStartMock).toHaveBeenCalledOnce());
    expect(reload).not.toHaveBeenCalled();

    resolveStart(status);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());

    disconnect();
  });

  it("coalesces a startup file event with the native activation reload", async () => {
    const status: SyncStatus = {
      running: true,
      dirtyTopics: 0,
      quarantined: [],
      lastExportAt: null,
      lastMergeAt: null
    };
    let resolveStart!: (status: SyncStatus) => void;
    notesSyncStartMock.mockImplementationOnce(
      () =>
        new Promise<SyncStatus>((resolve) => {
          resolveStart = resolve;
        })
    );
    const reload = vi.fn().mockResolvedValue(undefined);
    const disconnect = connectNotesSyncRuntime({
      vaultRoot: "/startup-event",
      onWorkspaceChanged: reload
    });

    await vi.waitFor(() => expect(notesSyncStartMock).toHaveBeenCalledOnce());
    emit("notes://sync-changed", {
      vaultPath: "/startup-event",
      topicIds: ["seeded-topic"]
    } satisfies SyncChangedPayload);
    resolveStart(status);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);

    expect(reload).toHaveBeenCalledOnce();
    disconnect();
  });

  it("does not reload an existing same-vault subscriber for a later activation", async () => {
    const firstReload = vi.fn();
    const secondReload = vi.fn();
    const disconnectFirst = connectNotesSyncRuntime({
      vaultRoot: "/sequential-shared",
      onWorkspaceChanged: firstReload
    });
    await vi.waitFor(() => expect(firstReload).toHaveBeenCalledOnce());
    firstReload.mockClear();

    const disconnectSecond = connectNotesSyncRuntime({
      vaultRoot: "/sequential-shared",
      onWorkspaceChanged: secondReload
    });
    await vi.waitFor(() => expect(secondReload).toHaveBeenCalledOnce());

    expect(firstReload).not.toHaveBeenCalled();
    disconnectFirst();
    disconnectSecond();
  });

  it("cancels a scheduled activation reload when its connection closes", async () => {
    const status: SyncStatus = {
      running: true,
      dirtyTopics: 0,
      quarantined: [],
      lastExportAt: null,
      lastMergeAt: null
    };
    let resolveStart!: (status: SyncStatus) => void;
    notesSyncStartMock.mockImplementationOnce(
      () =>
        new Promise<SyncStatus>((resolve) => {
          resolveStart = resolve;
        })
    );
    const reload = vi.fn().mockResolvedValue(undefined);
    const disconnect = connectNotesSyncRuntime({
      vaultRoot: "/closed-after-start",
      onWorkspaceChanged: reload
    });
    await vi.waitFor(() => expect(notesSyncStartMock).toHaveBeenCalledOnce());

    resolveStart(status);
    await Promise.resolve();
    disconnect();
    await vi.advanceTimersByTimeAsync(500);

    expect(reload).not.toHaveBeenCalled();
  });

  it("waits for the restored vault native start before reloading after a fast handoff", async () => {
    const status: SyncStatus = {
      running: true,
      dirtyTopics: 0,
      quarantined: [],
      lastExportAt: null,
      lastMergeAt: null
    };
    let resolveRestoredStart!: (status: SyncStatus) => void;
    notesSyncStartMock
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(status)
      .mockImplementationOnce(
        () =>
          new Promise<SyncStatus>((resolve) => {
            resolveRestoredStart = resolve;
          })
      );
    const firstReload = vi.fn();
    const secondReload = vi.fn();
    const disconnectFirst = connectNotesSyncRuntime({
      vaultRoot: "/handoff-a",
      onWorkspaceChanged: firstReload
    });
    await vi.waitFor(() =>
      expect(notesSyncStartMock).toHaveBeenCalledWith("/handoff-a")
    );

    const disconnectSecond = connectNotesSyncRuntime({
      vaultRoot: "/handoff-b",
      onWorkspaceChanged: secondReload
    });
    await vi.waitFor(() =>
      expect(notesSyncStartMock).toHaveBeenCalledWith("/handoff-b")
    );
    disconnectSecond();
    await vi.waitFor(() => expect(notesSyncStartMock).toHaveBeenCalledTimes(3));

    await vi.advanceTimersByTimeAsync(500);
    expect(firstReload).not.toHaveBeenCalled();
    expect(secondReload).not.toHaveBeenCalled();

    resolveRestoredStart(status);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(firstReload).toHaveBeenCalledOnce();
    expect(secondReload).not.toHaveBeenCalled();

    disconnectFirst();
  });

  it("retries an activation reload that was skipped during a pending vault handoff", async () => {
    let resolvePendingListen!: (unlisten: () => void) => void;
    const pendingListen = new Promise<() => void>((resolve) => {
      resolvePendingListen = resolve;
    });
    const firstReload = vi.fn();
    const disconnectFirst = connectNotesSyncRuntime({
      vaultRoot: "/pending-handoff-a",
      onWorkspaceChanged: firstReload
    });
    await vi.waitFor(() => expect(notesSyncStartMock).toHaveBeenCalledOnce());

    listenMock.mockImplementationOnce(() => pendingListen);
    const disconnectSecond = connectNotesSyncRuntime({
      vaultRoot: "/pending-handoff-b",
      onWorkspaceChanged: vi.fn()
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(firstReload).not.toHaveBeenCalled();

    disconnectSecond();
    await vi.waitFor(() => expect(notesSyncStartMock).toHaveBeenCalledTimes(2));
    expect(notesSyncStartMock.mock.calls.map(([vaultRoot]) => vaultRoot)).toEqual([
      "/pending-handoff-a",
      "/pending-handoff-a"
    ]);
    await vi.advanceTimersByTimeAsync(500);
    expect(firstReload).toHaveBeenCalledOnce();

    const lateUnlisten = vi.fn();
    resolvePendingListen(lateUnlisten);
    await vi.waitFor(() => expect(lateUnlisten).toHaveBeenCalledOnce());
    disconnectFirst();
  });

  it("reloads the restored vault after a failed handoff", async () => {
    const status: SyncStatus = {
      running: true,
      dirtyTopics: 0,
      quarantined: [],
      lastExportAt: null,
      lastMergeAt: null
    };
    notesSyncStartMock
      .mockResolvedValueOnce(status)
      .mockRejectedValueOnce(new Error("handoff failed"))
      .mockResolvedValueOnce(status);
    const firstReload = vi.fn().mockResolvedValue(undefined);
    const disconnectFirst = connectNotesSyncRuntime({
      vaultRoot: "/failed-handoff-a",
      onWorkspaceChanged: firstReload
    });
    await vi.waitFor(() => expect(firstReload).toHaveBeenCalledOnce());
    firstReload.mockClear();

    const disconnectSecond = connectNotesSyncRuntime({
      vaultRoot: "/failed-handoff-b",
      onWorkspaceChanged: vi.fn()
    });
    await vi.waitFor(() => {
      expect(getNotesSyncStatus("/failed-handoff-b")?.lastError).toBe(
        "handoff failed"
      );
    });

    disconnectSecond();
    await vi.waitFor(() => expect(notesSyncStartMock).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(500);

    expect(firstReload).toHaveBeenCalledOnce();
    disconnectFirst();
  });

  it("retries a failed reload on the next same-vault activation", async () => {
    const firstReload = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("reload failed"))
      .mockResolvedValue(undefined);
    const disconnectFirst = connectNotesSyncRuntime({
      vaultRoot: "/retry-activation-reload",
      onWorkspaceChanged: firstReload
    });
    await vi.waitFor(() => expect(firstReload).toHaveBeenCalledOnce());
    await Promise.resolve();

    const secondReload = vi.fn().mockResolvedValue(undefined);
    const disconnectSecond = connectNotesSyncRuntime({
      vaultRoot: "/retry-activation-reload",
      onWorkspaceChanged: secondReload
    });
    await vi.waitFor(() => expect(notesSyncStartMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(500);

    expect(firstReload).toHaveBeenCalledTimes(2);
    expect(secondReload).toHaveBeenCalledOnce();
    disconnectFirst();
    disconnectSecond();
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
    await vi.waitFor(() => {
      expect(firstReload).toHaveBeenCalledOnce();
      expect(secondReload).toHaveBeenCalledOnce();
    });
    firstReload.mockClear();
    secondReload.mockClear();

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
