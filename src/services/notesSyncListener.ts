import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { notesSyncStart, notesSyncStatus } from "./notesStore";
import { isSyncStatus, type SyncStatus } from "./notesSyncContract";
import { publishNotesSyncStatus } from "./notesSyncStatusStore";

export type { SyncStatus } from "./notesSyncContract";

export interface SyncChangedPayload {
  vaultPath: string;
  topicIds: string[];
}

export interface SyncStatusPayload {
  vaultPath: string;
  status: SyncStatus;
}

export interface NotesSyncListenerOptions {
  vaultRoot: string;
  onWorkspaceChanged: () => void | Promise<void>;
  onStatus?: (status: SyncStatus) => void;
}

const RELOAD_COALESCE_MS = 500;
interface RuntimeConnection {
  id: number;
  vaultRoot: string;
  active: boolean;
  listenerReady: boolean;
  activationReloadCompleted: boolean;
  requestWorkspaceReload: () => void;
  cancelWorkspaceReload: () => void;
  onStatus?: (status: SyncStatus) => void;
}

interface WorkspaceReloadScheduler {
  request: () => void;
  cancel: () => void;
}

let nextConnectionId = 0;
const runtimeConnections = new Map<number, RuntimeConnection>();
let nativeStartQueue: Promise<void> = Promise.resolve();
let activeNativeVaultRoot: string | null = null;
const statusEventSequences = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// C5: forward compatible — the wrapper must carry these keys with the right
// types but may gain more without failing validation.
function hasRequiredKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return keys.every((key) => key in value);
}

function isSyncStatusPayload(value: unknown): value is SyncStatusPayload {
  return (
    isRecord(value) &&
    hasRequiredKeys(value, ["vaultPath", "status"]) &&
    typeof value.vaultPath === "string" &&
    isSyncStatus(value.status)
  );
}

function currentConnection(): RuntimeConnection | undefined {
  return Array.from(runtimeConnections.values()).at(-1);
}

function createWorkspaceReloadScheduler(
  onWorkspaceChanged: () => void | Promise<void>,
  canReload: () => boolean
): WorkspaceReloadScheduler {
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    request: () => {
      if (reloadTimer !== null) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        if (!canReload()) return;
        void Promise.resolve().then(onWorkspaceChanged).catch(() => undefined);
      }, RELOAD_COALESCE_MS);
    },
    cancel: () => {
      if (reloadTimer === null) return;
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }
  };
}

function queueNativeStart(connection: RuntimeConnection): void {
  nativeStartQueue = nativeStartQueue.then(async () => {
    if (!connection.active || currentConnection()?.id !== connection.id) return;
    if (activeNativeVaultRoot !== connection.vaultRoot) {
      activeNativeVaultRoot = null;
    }
    try {
      const startStatus = await notesSyncStart(connection.vaultRoot);
      if (!connection.active || currentConnection()?.id !== connection.id) return;
      const nativeVaultChanged =
        activeNativeVaultRoot !== connection.vaultRoot;
      activeNativeVaultRoot = connection.vaultRoot;
      for (const activeConnection of runtimeConnections.values()) {
        if (
          activeConnection.active &&
          activeConnection.vaultRoot === connection.vaultRoot &&
          (nativeVaultChanged || !activeConnection.activationReloadCompleted)
        ) {
          activeConnection.requestWorkspaceReload();
        }
      }
      const sequenceBeforeRefresh =
        statusEventSequences.get(connection.vaultRoot) ?? 0;
      const status = await notesSyncStatus(connection.vaultRoot).catch(
        () => startStatus
      );
      if (!connection.active || currentConnection()?.id !== connection.id) return;
      if (
        (statusEventSequences.get(connection.vaultRoot) ?? 0) !==
        sequenceBeforeRefresh
      ) {
        return;
      }
      publishNotesSyncStatus(connection.vaultRoot, status);
      for (const activeConnection of runtimeConnections.values()) {
        if (
          activeConnection.active &&
          activeConnection.vaultRoot === connection.vaultRoot
        ) {
          activeConnection.onStatus?.(status);
        }
      }
    } catch (error) {
      // C3: do not swallow a start failure — surface it as an error status so
      // the badge/dialog show it. Sync stays retryable on the next activation
      // because nothing is marked permanently failed.
      if (!connection.active || currentConnection()?.id !== connection.id) {
        return;
      }
      const failure: SyncStatus = {
        running: false,
        dirtyTopics: 0,
        quarantined: [],
        lastExportAt: null,
        lastMergeAt: null,
        lastError:
          error instanceof Error ? error.message : "Notes sync could not start."
      };
      publishNotesSyncStatus(connection.vaultRoot, failure);
      for (const activeConnection of runtimeConnections.values()) {
        if (
          activeConnection.active &&
          activeConnection.vaultRoot === connection.vaultRoot
        ) {
          activeConnection.onStatus?.(failure);
        }
      }
    }
  });
}

async function listenForNotesSyncEvents(
  options: NotesSyncListenerOptions,
  requestWorkspaceReload: () => void
): Promise<UnlistenFn> {
  let active = true;
  const unlisten: UnlistenFn[] = [];
  const cleanup = (): void => {
    if (!active) return;
    active = false;
    for (const stopListening of unlisten.splice(0)) {
      stopListening();
    }
  };

  try {
    unlisten.push(
      await listen<SyncChangedPayload>("notes://sync-changed", (event) => {
        if (!active || event.payload.vaultPath !== options.vaultRoot) return;
        requestWorkspaceReload();
      })
    );
    unlisten.push(
      await listen<unknown>("notes://sync-status", (event) => {
        if (
          active &&
          isSyncStatusPayload(event.payload) &&
          event.payload.vaultPath === options.vaultRoot
        ) {
          options.onStatus?.(event.payload.status);
        }
      })
    );
  } catch (error) {
    cleanup();
    throw error;
  }

  return cleanup;
}

export async function startNotesSyncListener(
  options: NotesSyncListenerOptions
): Promise<UnlistenFn> {
  let active = true;
  const reloadScheduler = createWorkspaceReloadScheduler(
    options.onWorkspaceChanged,
    () => active
  );

  try {
    const stopListening = await listenForNotesSyncEvents(
      options,
      reloadScheduler.request
    );
    return () => {
      if (!active) return;
      active = false;
      reloadScheduler.cancel();
      stopListening();
    };
  } catch (error) {
    active = false;
    reloadScheduler.cancel();
    throw error;
  }
}

export function connectNotesSyncRuntime(
  options: NotesSyncListenerOptions
): UnlistenFn {
  const connection: RuntimeConnection = {
    id: ++nextConnectionId,
    vaultRoot: options.vaultRoot,
    active: true,
    listenerReady: false,
    activationReloadCompleted: false,
    requestWorkspaceReload: () => undefined,
    cancelWorkspaceReload: () => undefined,
    onStatus: options.onStatus
  };
  const reloadScheduler = createWorkspaceReloadScheduler(
    async () => {
      await options.onWorkspaceChanged();
      connection.activationReloadCompleted = true;
    },
    () =>
      connection.active &&
      currentConnection()?.vaultRoot === connection.vaultRoot &&
      activeNativeVaultRoot === connection.vaultRoot
  );
  connection.requestWorkspaceReload = reloadScheduler.request;
  connection.cancelWorkspaceReload = reloadScheduler.cancel;
  runtimeConnections.set(connection.id, connection);
  let listenerCleanup: UnlistenFn | null = null;

  void listenForNotesSyncEvents(
    {
      ...options,
      onStatus: (status) => {
        statusEventSequences.set(
          connection.vaultRoot,
          (statusEventSequences.get(connection.vaultRoot) ?? 0) + 1
        );
        if (
          connection.active &&
          currentConnection()?.vaultRoot === connection.vaultRoot &&
          activeNativeVaultRoot === connection.vaultRoot
        ) {
          // C3: mirror live status into the observable store (badge/dialog) in
          // addition to the caller's optional callback.
          publishNotesSyncStatus(connection.vaultRoot, status);
          options.onStatus?.(status);
        }
      }
    },
    () => {
      if (
        connection.active &&
        currentConnection()?.vaultRoot === connection.vaultRoot
      ) {
        reloadScheduler.request();
      }
    }
  )
    .then((cleanup) => {
      if (!connection.active) {
        cleanup();
        reloadScheduler.cancel();
        return;
      }
      listenerCleanup = cleanup;
      connection.listenerReady = true;
      if (currentConnection()?.id === connection.id) {
        queueNativeStart(connection);
      }
    })
    .catch(() => {
      const wasCurrent = currentConnection()?.id === connection.id;
      connection.active = false;
      reloadScheduler.cancel();
      runtimeConnections.delete(connection.id);
      const fallback = currentConnection();
      if (wasCurrent && fallback?.listenerReady) queueNativeStart(fallback);
    });

  return () => {
    if (!connection.active) return;
    const wasCurrent = currentConnection()?.id === connection.id;
    connection.active = false;
    connection.cancelWorkspaceReload();
    runtimeConnections.delete(connection.id);
    listenerCleanup?.();
    listenerCleanup = null;
    const fallback = currentConnection();
    if (wasCurrent && fallback?.listenerReady) queueNativeStart(fallback);
  };
}
