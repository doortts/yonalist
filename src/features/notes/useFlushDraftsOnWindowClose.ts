import { useEffect, useRef } from "react";
import type { NotesVaultDrainLease } from "./notesVaultDrain";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

interface CloseAttemptSnapshot {
  readonly vaultRoot: string | null;
  readonly acquireVault: (
    vaultRoot: string,
  ) => Promise<NotesVaultDrainLease | null>;
  readonly flushSyncExports:
    | ((vaultRoot: string) => Promise<void>)
    | undefined;
}

interface CloseDrainResult {
  readonly complete: boolean;
  readonly lease: NotesVaultDrainLease | null;
}

function releaseLease(lease: NotesVaultDrainLease): void {
  try {
    lease.release();
  } catch (cause) {
    console.error("Notes could not release the close drain", cause);
  }
}

/**
 * Registers a strict Tauri close barrier. Every close request is prevented
 * until the captured Vault drain and file exporter both succeed; failed or
 * incomplete attempts leave the window open so the user can retry.
 */
export function useFlushDraftsOnWindowClose(
  vaultRoot: string | null,
  acquireVault: (
    vaultRoot: string,
  ) => Promise<NotesVaultDrainLease | null>,
  flushSyncExports?: (vaultRoot: string) => Promise<void>,
): void {
  const vaultRootRef = useRef(vaultRoot);
  vaultRootRef.current = vaultRoot;
  const acquireRef = useRef(acquireVault);
  acquireRef.current = acquireVault;
  const flushSyncRef = useRef(flushSyncExports);
  flushSyncRef.current = flushSyncExports;

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    let closeRequest: Promise<void> | null = null;

    const snapshotAttempt = (): CloseAttemptSnapshot => ({
      vaultRoot: vaultRootRef.current,
      acquireVault: acquireRef.current,
      flushSyncExports: flushSyncRef.current,
    });

    const runStrictDrain = async (
      snapshot: CloseAttemptSnapshot,
    ): Promise<CloseDrainResult> => {
      if (!snapshot.vaultRoot) {
        return { complete: true, lease: null };
      }
      let lease: NotesVaultDrainLease | null;
      try {
        lease = await snapshot.acquireVault(snapshot.vaultRoot);
      } catch (cause) {
        console.error("Notes draft flush before close failed", cause);
        return { complete: false, lease: null };
      }
      if (!lease) {
        console.warn(
          "Notes draft flush before close could not persist every pending change",
        );
        return { complete: false, lease: null };
      }
      if (!snapshot.flushSyncExports) {
        return { complete: true, lease };
      }
      try {
        await snapshot.flushSyncExports(snapshot.vaultRoot);
        return { complete: true, lease };
      } catch (cause) {
        console.error("Notes sync export flush before close failed", cause);
        releaseLease(lease);
        return { complete: false, lease: null };
      }
    };

    const handleBeforeUnload = () => {
      const snapshot = snapshotAttempt();
      void runStrictDrain(snapshot)
        .then((result) => {
          if (result.complete) result.lease?.commit();
        })
        .catch(() => undefined);
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    void (async () => {
      let getCurrentWindow: typeof import("@tauri-apps/api/window").getCurrentWindow;
      try {
        ({ getCurrentWindow } = await import("@tauri-apps/api/window"));
      } catch (cause) {
        console.warn(
          "Notes could not register a flush-on-close handler",
          cause,
        );
        return;
      }
      const appWindow = getCurrentWindow();
      const registered = await appWindow.onCloseRequested((event) => {
        event.preventDefault();
        if (closeRequest) return closeRequest;

        const snapshot = snapshotAttempt();
        const attempt = (async (): Promise<void> => {
          const result = await runStrictDrain(snapshot);
          if (!result.complete) return;
          try {
            await appWindow.destroy();
            result.lease?.commit();
          } catch (cause) {
            console.error(
              "Notes could not destroy the window after flushing drafts",
              cause,
            );
            if (result.lease) releaseLease(result.lease);
          }
        })();
        closeRequest = attempt;
        void attempt.finally(() => {
          if (closeRequest === attempt) closeRequest = null;
        });
        return attempt;
      });
      if (disposed) {
        void Promise.resolve(registered()).catch(() => undefined);
        return;
      }
      unlisten = registered;
    })();

    return () => {
      disposed = true;
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (unlisten) {
        void Promise.resolve(unlisten()).catch(() => undefined);
      }
    };
  }, []);
}
