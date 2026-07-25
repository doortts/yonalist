import { useEffect, useRef } from "react";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Registers a strict Tauri close barrier. Every close request is prevented
 * until the shared Notes drain and file exporter both succeed; failed or
 * incomplete attempts leave the window open so the user can retry.
 */
export function useFlushDraftsOnWindowClose(
  drainVault: () => Promise<boolean>,
  flushSyncExports?: () => Promise<void>,
  releaseVault?: () => Promise<void>,
): void {
  const drainRef = useRef(drainVault);
  drainRef.current = drainVault;
  const flushSyncRef = useRef(flushSyncExports);
  flushSyncRef.current = flushSyncExports;
  const releaseRef = useRef(releaseVault);
  releaseRef.current = releaseVault;

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    let closeRequest: Promise<void> | null = null;

    const releaseDrain = async (): Promise<void> => {
      try {
        await releaseRef.current?.();
      } catch (cause) {
        console.error("Notes could not release the close drain", cause);
      }
    };

    const runStrictDrain = async (): Promise<boolean> => {
      let drained: boolean;
      try {
        drained = await drainRef.current();
      } catch (cause) {
        console.error("Notes draft flush before close failed", cause);
        return false;
      }
      if (!drained) {
        console.warn(
          "Notes draft flush before close could not persist every pending change",
        );
        return false;
      }
      const flushSyncExports = flushSyncRef.current;
      if (!flushSyncExports) return true;
      try {
        await flushSyncExports();
        return true;
      } catch (cause) {
        console.error("Notes sync export flush before close failed", cause);
        await releaseDrain();
        return false;
      }
    };

    const handleBeforeUnload = () => {
      void runStrictDrain()
        .then((drained) => {
          if (drained) return releaseDrain();
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

        const attempt = (async (): Promise<void> => {
          if (!(await runStrictDrain())) return;
          try {
            await appWindow.destroy();
          } catch (cause) {
            console.error(
              "Notes could not destroy the window after flushing drafts",
              cause,
            );
            await releaseDrain();
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
