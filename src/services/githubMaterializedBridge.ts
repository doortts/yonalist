import type { GitHubNotification } from "../domain/notifications";
import type { ExternalSourceState } from "./externalSourceHost";

function sourceItemsIdentity(items: readonly GitHubNotification[]): string {
  return JSON.stringify(
    items.map((item) => [
      item.id,
      item.unread,
      item.reason,
      item.updated_at,
      item.last_read_at,
      item.subject.title,
      item.subject.url,
      item.subject.type,
      item.repository.full_name,
      item.repository.name,
      item.repository.owner.login
    ])
  );
}

/**
 * Produces a durable raw-source bridge key only after a whole snapshot, or
 * after a successful completion has settled. The caller records it only once
 * its Notes mutation has settled.
 */
export function githubMaterializedBridgeToken(
  connectionId: string,
  state: ExternalSourceState<GitHubNotification>
): string | null {
  // Only a partial-only mark-read needs the completion revision. A completed
  // cached snapshot keeps its normal identity even if a later refresh error
  // remains visible.
  if (
    state.completionVersion > 0 &&
    !state.loading &&
    !state.isComplete
  ) {
    return `${connectionId}\u0000completion\u0000${state.completionVersion}`;
  }
  if (
    state.loaded &&
    state.isComplete &&
    !state.loading &&
    state.syncedAt !== null
  ) {
    return `${connectionId}\u0000snapshot\u0000${state.syncedAt}\u0000${sourceItemsIdentity(state.items)}`;
  }
  return null;
}

export type GithubMaterializedBridgeOutcome =
  | "committed"
  | "skipped"
  | "failed";

export interface GithubMaterializedBridgeEntry<Request> {
  readonly token: string;
  readonly request: Request;
}

export interface GithubMaterializedBridgePump<Request> {
  submit(entry: GithubMaterializedBridgeEntry<Request>): void;
  /** Drops stale settlement retries while allowing the current mutation to finish. */
  invalidate(): void;
  dispose(): void;
}

/**
 * Serializes Notes materialization: one mutation runs at once, with only the
 * latest queued snapshot retained. A non-committed workspace outcome retries
 * after a short delay instead of becoming a false success.
 */
export function createGithubMaterializedBridgePump<Request>(
  execute: (request: Request) => Promise<GithubMaterializedBridgeOutcome>,
  retryDelayMs = 1_000
): GithubMaterializedBridgePump<Request> {
  type Entry = GithubMaterializedBridgeEntry<Request>;
  type Running = { readonly entry: Entry; readonly generation: number };

  let lastSuccessfulToken: string | null = null;
  let inFlight: Running | null = null;
  let pending: Entry | null = null;
  let retry: Entry | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let generation = 0;

  function clearRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    retry = null;
  }

  function start(entry: Entry): void {
    if (disposed || entry.token === lastSuccessfulToken) return;
    if (inFlight !== null) {
      if (
        inFlight.generation !== generation ||
        inFlight.entry.token !== entry.token
      ) {
        pending = entry;
      }
      return;
    }
    const running: Running = { entry, generation };
    inFlight = running;
    void Promise.resolve(execute(entry.request)).then(
      (outcome) => settle(running, outcome === "committed"),
      () => settle(running, false)
    );
  }

  function drain(): void {
    if (disposed || inFlight !== null || pending === null) return;
    const next = pending;
    pending = null;
    start(next);
  }

  function scheduleRetry(entry: Entry): void {
    retry = entry;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const next = retry;
      retry = null;
      if (next !== null) start(next);
    }, retryDelayMs);
  }

  function settle(running: Running, committed: boolean): void {
    if (inFlight !== running) return;
    inFlight = null;
    if (disposed) return;
    if (running.generation !== generation) {
      drain();
      return;
    }
    if (committed) lastSuccessfulToken = running.entry.token;
    if (pending !== null) {
      drain();
      return;
    }
    if (!committed) scheduleRetry(running.entry);
  }

  return {
    submit(entry) {
      if (disposed || entry.token === lastSuccessfulToken) return;
      if (retry !== null) {
        if (retry.token === entry.token) return;
        clearRetry();
      }
      start(entry);
    },
    invalidate() {
      generation += 1;
      lastSuccessfulToken = null;
      clearRetry();
      pending = null;
    },
    dispose() {
      disposed = true;
      generation += 1;
      clearRetry();
      pending = null;
    }
  };
}
