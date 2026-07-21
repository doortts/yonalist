import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { notesSyncStart, notesSyncStatus } from "./notesStore";
import { isSyncStatus, type SyncStatus } from "./notesSyncContract";

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
  onStatus?: (status: SyncStatus) => void;
}

let nextConnectionId = 0;
const runtimeConnections = new Map<number, RuntimeConnection>();
let nativeStartQueue: Promise<void> = Promise.resolve();
let activeNativeVaultRoot: string | null = null;
const statusEventSequences = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function isSyncStatusPayload(value: unknown): value is SyncStatusPayload {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["vaultPath", "status"]) &&
    typeof value.vaultPath === "string" &&
    isSyncStatus(value.status)
  );
}

function currentConnection(): RuntimeConnection | undefined {
  return Array.from(runtimeConnections.values()).at(-1);
}

function queueNativeStart(connection: RuntimeConnection): void {
  nativeStartQueue = nativeStartQueue.then(async () => {
    if (!connection.active || currentConnection()?.id !== connection.id) return;
    try {
      const startStatus = await notesSyncStart(connection.vaultRoot);
      if (!connection.active || currentConnection()?.id !== connection.id) return;
      activeNativeVaultRoot = connection.vaultRoot;
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
      for (const activeConnection of runtimeConnections.values()) {
        if (
          activeConnection.active &&
          activeConnection.vaultRoot === connection.vaultRoot
        ) {
          activeConnection.onStatus?.(status);
        }
      }
    } catch {
      // Sync remains retryable on the next workspace activation.
    }
  });
}

export async function startNotesSyncListener(
  options: NotesSyncListenerOptions
): Promise<UnlistenFn> {
  let active = true;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  const unlisten: UnlistenFn[] = [];
  const cleanup = (): void => {
    if (!active) return;
    active = false;
    if (reloadTimer !== null) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }
    for (const stopListening of unlisten.splice(0)) {
      stopListening();
    }
  };

  try {
    unlisten.push(
      await listen<SyncChangedPayload>("notes://sync-changed", (event) => {
        if (!active || event.payload.vaultPath !== options.vaultRoot) return;
        if (reloadTimer !== null) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          if (!active) return;
          void Promise.resolve()
            .then(options.onWorkspaceChanged)
            .catch(() => undefined);
        }, RELOAD_COALESCE_MS);
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

export function connectNotesSyncRuntime(
  options: NotesSyncListenerOptions
): UnlistenFn {
  const connection: RuntimeConnection = {
    id: ++nextConnectionId,
    vaultRoot: options.vaultRoot,
    active: true,
    listenerReady: false,
    onStatus: options.onStatus
  };
  runtimeConnections.set(connection.id, connection);
  let listenerCleanup: UnlistenFn | null = null;

  void startNotesSyncListener({
    ...options,
    onWorkspaceChanged: () => {
      if (
        !connection.active ||
        currentConnection()?.vaultRoot !== connection.vaultRoot
      ) {
        return;
      }
      return options.onWorkspaceChanged();
    },
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
        options.onStatus?.(status);
      }
    }
  })
    .then((cleanup) => {
      if (!connection.active) {
        cleanup();
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
      runtimeConnections.delete(connection.id);
      const fallback = currentConnection();
      if (wasCurrent && fallback?.listenerReady) queueNativeStart(fallback);
    });

  return () => {
    if (!connection.active) return;
    const wasCurrent = currentConnection()?.id === connection.id;
    connection.active = false;
    runtimeConnections.delete(connection.id);
    listenerCleanup?.();
    listenerCleanup = null;
    const fallback = currentConnection();
    if (wasCurrent && fallback?.listenerReady) queueNativeStart(fallback);
  };
}
