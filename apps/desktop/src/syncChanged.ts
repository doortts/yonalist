/**
 * Another device's edits arriving, which is the one change this window does
 * not ask for. Everything else it shows is the receipt for something it did.
 *
 * A folder arriving from another device lands as a run of events, one per
 * document, so they are collected for a moment and answered once. Registering
 * is idempotent because React mounts an effect twice in development, and two
 * subscriptions would read the page twice for every arrival.
 */

import type { SyncChanged } from "../../../packages/contracts/generated/SyncChanged";

/** What Tauri's `listen` gives back: the way to stop listening. */
export type Unlisten = () => void;

export type Listen = (
  event: string,
  handler: (change: SyncChanged) => void
) => Promise<Unlisten>;

/** What arrived, once the run of events has been collected into one. */
export interface VaultChange {
  readonly revision: number;
  readonly changedNodeIds: readonly string[];
  readonly deletedNodeIds: readonly string[];
}

export const SYNC_CHANGED = "notes://sync-changed";
/** Says only that the state moved; whoever hears it asks what it is now. */
export const SYNC_STATUS = "notes://sync-status";

/**
 * Hears one event and answers the way to stop hearing it. Registering is
 * idempotent for the same reason as below: React mounts an effect twice in
 * development, and two subscriptions ask everything twice.
 */
export function listenForEvent(
  listen: (event: string, handler: () => void) => Promise<Unlisten>,
  event: string,
  heard: () => void
): Unlisten {
  let stopped = false;
  let unlisten: Unlisten | null = null;
  const subscription = listen(event, heard).then((stop) => {
    unlisten = stop;
    if (stopped) stop();
    return stop;
  });
  return () => {
    if (stopped) return;
    stopped = true;
    if (unlisten) {
      unlisten();
      return;
    }
    void subscription.catch(() => undefined);
  };
}

/**
 * Listening, and then asking. Every merge the vault sweep announces between the
 * ask and the subscription is announced to nobody — Tauri drops an emit nothing
 * is listening for — and the window is left holding the revision it was handed
 * while the session has moved past it, which is its next keystroke refused.
 *
 * The snapshot is read whichever way the registration settles: a window that
 * cannot hear the folder is still a window with notes in it.
 */
export function connectVaultSync(
  listen: Listen,
  absorb: (change: VaultChange) => Promise<unknown>,
  bootstrap: () => Promise<void>,
  coalesceMillis?: number
): Unlisten {
  return listenForVaultChanges(
    (event, handler) => {
      const registration = listen(event, handler).catch((cause) => {
        // Said out loud because nothing else says it: a window that cannot
        // hear the folder shows another device's edits only when something
        // else reads the page, and the only other sign is the conflict banner
        // coming back with nothing to explain it.
        console.error("Yonalist could not listen for vault changes", cause);
        // Nothing is listening, so there is nothing for the caller to stop —
        // and the window still asks for its notes below.
        return () => undefined;
      });
      void registration.then(() => bootstrap());
      return registration;
    },
    absorb,
    coalesceMillis
  );
}

/**
 * Long enough that a folder's worth of documents is one read, short enough
 * that a single arriving edit still feels immediate.
 */
const COALESCE_MILLIS = 500;

export function listenForVaultChanges(
  listen: Listen,
  absorb: (change: VaultChange) => Promise<unknown>,
  coalesceMillis: number = COALESCE_MILLIS
): Unlisten {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let unlisten: Unlisten | null = null;
  // What the whole run of events said, kept together: each document arrives
  // as its own event, and answering one of them would leave the rest unread.
  let changed = new Set<string>();
  let deleted = new Set<string>();
  let revision = 0;

  const subscription = listen(SYNC_CHANGED, (change) => {
    for (const id of change.changedNodeIds) {
      changed.add(id);
      // A row that came back is not gone, whatever an earlier event in this run
      // said. Naming it as both would have the reader drop the caret's own
      // typing on a row the re-read then brings back alive.
      deleted.delete(id);
    }
    for (const id of change.deletedNodeIds) {
      deleted.add(id);
      // Whatever it said before it went is not news any more. Trashing names
      // the row in both lists at once, and this order is what makes gone win
      // inside one event.
      changed.delete(id);
    }
    revision = Math.max(revision, change.revision);
    // The last event decides when: while documents are still arriving there
    // is no point reading a page that is about to change again.
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const collected = {
        revision,
        changedNodeIds: [...changed],
        deletedNodeIds: [...deleted]
      };
      changed = new Set();
      deleted = new Set();
      revision = 0;
      void absorb(collected);
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
