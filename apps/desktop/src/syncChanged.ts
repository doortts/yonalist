/**
 * Another device's edits arriving, which is the one change this window does
 * not ask for. Everything else it shows is the receipt for something it did.
 *
 * A folder arriving from another device lands as a run of events, one per
 * document, so they are collected for a moment and answered once. Registering
 * is idempotent because React mounts an effect twice in development, and two
 * subscriptions would read the page twice for every arrival.
 */

/** What Tauri's `listen` gives back: the way to stop listening. */
export type Unlisten = () => void;

export type Listen = (
  event: string,
  handler: () => void
) => Promise<Unlisten>;

export const SYNC_CHANGED = "notes://sync-changed";

/**
 * Long enough that a folder's worth of documents is one read, short enough
 * that a single arriving edit still feels immediate.
 */
const COALESCE_MILLIS = 500;

export function listenForVaultChanges(
  listen: Listen,
  absorb: () => Promise<unknown>,
  coalesceMillis: number = COALESCE_MILLIS
): Unlisten {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let unlisten: Unlisten | null = null;

  const subscription = listen(SYNC_CHANGED, () => {
    // The last event decides when: while documents are still arriving there
    // is no point reading a page that is about to change again.
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void absorb();
    }, coalesceMillis);
  }).then((stop) => {
    unlisten = stop;
    // Unsubscribed before the subscription finished — which is exactly what
    // a development double mount does.
    if (stopped) stop();
    return stop;
  });

  return () => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (unlisten) {
      unlisten();
      return;
    }
    void subscription.catch(() => undefined);
  };
}
