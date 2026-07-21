import { useEffect, useRef } from "react";

/**
 * The write queue is in-memory, so quitting the app while a draft is still
 * debounced would drop the pending input. When running inside Tauri we
 * intercept the window close request, drain every pending draft through the
 * real write pipeline, and only then destroy the window. The flush is raced
 * against a hard deadline so a stuck write can never leave the window
 * unclosable.
 */
const FLUSH_ON_CLOSE_TIMEOUT_MS = 3000;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * What happened to the shutdown flush. Anything other than `flushed` means at
 * least one pending draft may not have reached disk before the window closed,
 * so the handler logs it — the window still closes regardless.
 */
type FlushOutcome =
  | { kind: "flushed" }
  | { kind: "incomplete" }
  | { kind: "failed"; error: unknown }
  | { kind: "timeout" };

async function raceFlushAgainstTimeout(
  flush: () => Promise<boolean>,
  timeoutMs: number
): Promise<FlushOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<FlushOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const attempt: Promise<FlushOutcome> = Promise.resolve()
    .then(flush)
    .then(
      (flushed) => (flushed ? { kind: "flushed" } : { kind: "incomplete" }),
      (error) => ({ kind: "failed", error })
    );
  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Registers a Tauri close-requested handler (and a best-effort `beforeunload`
 * fallback for dev-mode reloads) that flushes all pending Notes drafts before
 * the window goes away. Outside Tauri this is a no-op. StrictMode safe: the
 * effect registers exactly one subscription and the cleanup unlistens it.
 */
export function useFlushDraftsOnWindowClose(
  flushAllDrafts: () => Promise<boolean>,
  // B1: after the in-memory drafts land in SQLite, force the file-SSOT exporter
  // to write the dirty topics out before the window goes away, so a close never
  // strands the just-flushed edits inside the debounce window. Optional so the
  // hook stays usable without the sync runtime; failures only warn.
  flushSyncExports?: () => Promise<void>
): void {
  const flushRef = useRef(flushAllDrafts);
  flushRef.current = flushAllDrafts;
  const flushSyncRef = useRef(flushSyncExports);
  flushSyncRef.current = flushSyncExports;

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Guards against re-entrant close requests: once we begin the shutdown
    // flush, a second close request is allowed straight through.
    let closing = false;

    const handleBeforeUnload = () => {
      // Fire-and-forget: `beforeunload` cannot await, so this only helps the
      // fast dev-mode reload path where the queue is usually already idle.
      void Promise.resolve()
        .then(() => flushRef.current())
        .then(() => flushSyncRef.current?.())
        .catch(() => undefined);
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    void (async () => {
      let getCurrentWindow: typeof import("@tauri-apps/api/window").getCurrentWindow;
      try {
        ({ getCurrentWindow } = await import("@tauri-apps/api/window"));
      } catch (cause) {
        // The module can throw when evaluated outside a real Tauri runtime.
        console.warn(
          "Notes could not register a flush-on-close handler",
          cause
        );
        return;
      }
      const appWindow = getCurrentWindow();
      const registered = await appWindow.onCloseRequested(async (event) => {
        if (closing) {
          return;
        }
        closing = true;
        event.preventDefault();
        try {
          const outcome = await raceFlushAgainstTimeout(
            () => flushRef.current(),
            FLUSH_ON_CLOSE_TIMEOUT_MS
          );
          if (outcome.kind === "failed") {
            console.error(
              "Notes draft flush before close failed",
              outcome.error
            );
          } else if (outcome.kind === "incomplete") {
            console.warn(
              "Notes draft flush before close could not persist every pending change; closing anyway"
            );
          } else if (outcome.kind === "timeout") {
            console.warn(
              `Notes draft flush before close timed out after ${FLUSH_ON_CLOSE_TIMEOUT_MS}ms; closing anyway`
            );
          }
          const flushSyncExports = flushSyncRef.current;
          if (flushSyncExports) {
            const syncOutcome = await raceFlushAgainstTimeout(
              () => flushSyncExports().then(() => true),
              FLUSH_ON_CLOSE_TIMEOUT_MS
            );
            if (syncOutcome.kind !== "flushed") {
              console.warn(
                "Notes sync export flush before close did not complete; closing anyway",
                syncOutcome
              );
            }
          }
        } catch (cause) {
          // Defensive: raceFlushAgainstTimeout resolves on every branch, but
          // never leave the window unclosable if it ever throws unexpectedly.
          console.warn("Notes draft flush before close failed", cause);
        } finally {
          try {
            await appWindow.destroy();
          } catch (cause) {
            console.error(
              "Notes could not destroy the window after flushing drafts",
              cause
            );
          }
        }
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
