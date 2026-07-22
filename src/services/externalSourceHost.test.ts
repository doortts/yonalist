import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  serializeExternalBulletKey,
  type ExternalSourceProvider
} from "../domain/externalSources";
import type { GitHubNotification } from "../domain/notifications";
import {
  EXTERNAL_SOURCE_COMPLETION_ERROR,
  EXTERNAL_SOURCE_REFRESH_ERROR,
  createExternalSourceHost,
  toExternalSourcePublicError
} from "./externalSourceHost";
import {
  loadExternalSourceSnapshot,
  persistExternalSourceSnapshot
} from "./externalSourceSnapshotStore";
import { githubSourceConnectionId } from "./githubAccountIdentity";
import {
  createGithubNotificationsProvider,
  GITHUB_NOTIFICATIONS_PROVIDER_ID
} from "./githubNotificationsProvider";
import { clearNotificationCache } from "./notifications";

interface Item {
  readonly id: string;
  readonly title: string;
  readonly complete?: boolean;
}

const connectionId = "github.example/alice";
const cached = { id: "cached", title: "Cached" };
const partial = { id: "partial", title: "Partial" };
const first = { id: "first", title: "First" };
const second = { id: "second", title: "Second" };
const syncedAt = new Date("2026-07-21T23:00:00.000Z");
const now = new Date("2026-07-22T00:00:00.000Z");
const incomplete = { id: "todo", title: "Todo", complete: false };
const completed = { ...incomplete, complete: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function providerWith(
  load: ExternalSourceProvider<Item>["load"]
): ExternalSourceProvider<Item> {
  return {
    id: "test-provider",
    title: "Test provider",
    decodeItem(value) {
      if (!value || typeof value !== "object") {
        return null;
      }
      const { id, title, complete } = value as Partial<Item>;
      return typeof id === "string" &&
        typeof title === "string" &&
        (complete === undefined || typeof complete === "boolean")
        ? { id, title, ...(complete === undefined ? {} : { complete }) }
        : null;
    },
    keyOf: (item, account) => ({
      providerId: "test-provider",
      connectionId: account,
      remoteId: item.id
    }),
    canComplete: () => false,
    normalizeSettings: (value) => value,
    project: () => [],
    load
  };
}

type MarkComplete = NonNullable<ExternalSourceProvider<Item>["markComplete"]>;

function providerWithCompletion(
  markComplete: MarkComplete,
  load: ExternalSourceProvider<Item>["load"] = vi.fn().mockResolvedValue([])
): ExternalSourceProvider<Item> {
  return {
    ...providerWith(load),
    canComplete: (item) => item.complete === false,
    markComplete
  };
}

function readyHandleWith(
  provider: ExternalSourceProvider<Item>,
  items: readonly Item[]
) {
  persistExternalSourceSnapshot(provider.id, connectionId, items, syncedAt);
  return createExternalSourceHost(provider, connectionId, { now: () => now });
}

function githubNotification(
  overrides: Partial<GitHubNotification> = {}
): GitHubNotification {
  return {
    id: "thread-17",
    unread: true,
    reason: "mention",
    updated_at: "2026-07-22T10:00:00.000Z",
    last_read_at: null,
    subject: {
      title: "Fix inline caret",
      url: "https://api.github.com/repos/acme/yonalist/issues/17",
      type: "Issue"
    },
    repository: {
      full_name: "acme/yonalist",
      name: "yonalist",
      owner: { login: "acme" }
    },
    ...overrides
  };
}

describe("external source host", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearNotificationCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shares one request and one poll timer across two leases", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue([first]);
    const handle = createExternalSourceHost(providerWith(load), connectionId, {
      pollIntervalMs: 60_000,
      now: () => now
    });

    const releaseA = handle.acquire();
    const releaseB = handle.acquire();

    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(2);

    releaseA();
    releaseB();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent refreshes", async () => {
    const pending = deferred<readonly Item[]>();
    const load = vi.fn(() => pending.promise);
    const handle = createExternalSourceHost(providerWith(load), connectionId);

    const refreshA = handle.refresh();
    const refreshB = handle.refresh();

    expect(refreshB).toBe(refreshA);
    expect(load).toHaveBeenCalledOnce();
    pending.resolve([first]);
    await refreshA;
  });

  it("coalesces synchronous subscriber refresh and disposal before polling", async () => {
    vi.useFakeTimers();
    const loadSignals: AbortSignal[] = [];
    const load = vi.fn<ExternalSourceProvider<Item>["load"]>()
      .mockImplementation((input) => {
        loadSignals.push(input.signal);
        input.publishPartial([partial]);
        return input.signal.aborted
          ? Promise.reject(new DOMException("cancelled", "AbortError"))
          : new Promise(() => undefined);
      });
    const handle = createExternalSourceHost(providerWith(load), connectionId);
    let notifications = 0;
    let reentrantRefresh: Promise<void> | null = null;
    handle.subscribe(() => {
      notifications += 1;
      if (notifications === 1) {
        reentrantRefresh = handle.refresh();
      } else {
        handle.dispose();
      }
    });

    handle.acquire();
    await Promise.resolve();

    expect(reentrantRefresh).not.toBeNull();
    expect(load).toHaveBeenCalledOnce();
    expect(loadSignals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores a cached snapshot without changing snapshot references", () => {
    const provider = providerWith(vi.fn().mockResolvedValue([]));
    persistExternalSourceSnapshot(provider.id, connectionId, [cached], syncedAt);

    const handle = createExternalSourceHost(provider, connectionId);
    const state = handle.getState();

    expect(state).toMatchObject({
      items: [cached],
      loaded: true,
      loading: false,
      error: null,
      syncedAt: syncedAt.toISOString()
    });
    expect(handle.getState()).toBe(state);
  });

  it("keeps partial rows when a refresh fails after a later page", async () => {
    const provider = providerWith(async ({ publishPartial }) => {
      publishPartial([partial]);
      throw new Error("page 2 failed");
    });
    persistExternalSourceSnapshot(provider.id, connectionId, [cached], syncedAt);
    const handle = createExternalSourceHost(provider, connectionId);

    await expect(handle.refresh()).rejects.toThrow(EXTERNAL_SOURCE_REFRESH_ERROR);

    expect(handle.getState()).toMatchObject({
      items: [partial],
      loaded: true,
      loading: false,
      error: EXTERNAL_SOURCE_REFRESH_ERROR,
      syncedAt: syncedAt.toISOString()
    });
    expect(
      loadExternalSourceSnapshot(provider.id, connectionId, provider.decodeItem)
        ?.items
    ).toEqual([cached]);
  });

  it("keeps the last good cached rows when refresh fails", async () => {
    const provider = providerWith(
      vi.fn().mockRejectedValue(new Error("private upstream failure"))
    );
    persistExternalSourceSnapshot(provider.id, connectionId, [cached], syncedAt);
    const handle = createExternalSourceHost(provider, connectionId);

    await expect(handle.refresh()).rejects.toThrow(EXTERNAL_SOURCE_REFRESH_ERROR);

    expect(handle.getState()).toMatchObject({
      items: [cached],
      loaded: true,
      loading: false,
      error: EXTERNAL_SOURCE_REFRESH_ERROR,
      syncedAt: syncedAt.toISOString()
    });
  });

  it("never exposes provider secrets through public load errors", async () => {
    const provider = providerWith(
      vi.fn().mockRejectedValue(
        new Error("ghp_secret: upstream body at /Users/alice/private/response.json")
      )
    );
    const handle = createExternalSourceHost(provider, connectionId);

    await expect(handle.refresh()).rejects.toThrow(EXTERNAL_SOURCE_REFRESH_ERROR);

    expect(handle.getState().error).toBe(EXTERNAL_SOURCE_REFRESH_ERROR);
    expect(JSON.stringify(handle.getState())).not.toMatch(
      /ghp_secret|upstream body|\/Users\/alice/
    );
  });

  it("replaces the displayed and persisted complete snapshot", async () => {
    const load = vi
      .fn<ExternalSourceProvider<Item>["load"]>()
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([first]);
    const provider = providerWith(load);
    const handle = createExternalSourceHost(provider, connectionId, {
      now: () => now
    });

    await handle.refresh();
    await handle.refresh();

    expect(handle.getState().items).toEqual([first]);
    expect(
      loadExternalSourceSnapshot(provider.id, connectionId, provider.decodeItem)
        ?.items
    ).toEqual([first]);
  });

  it("restores complete rows when final release cancels a partial refresh", async () => {
    const loadSignals: AbortSignal[] = [];
    const load = vi.fn<ExternalSourceProvider<Item>["load"]>()
      .mockImplementation(({ signal, publishPartial }) =>
        new Promise((_, reject) => {
          loadSignals.push(signal);
          publishPartial([partial]);
          signal.addEventListener("abort", () => {
            reject(new DOMException("provider cancellation detail", "AbortError"));
          });
        })
      );
    const provider = providerWith(load);
    persistExternalSourceSnapshot(provider.id, connectionId, [cached], syncedAt);
    const handle = createExternalSourceHost(provider, connectionId);
    const release = handle.acquire();

    expect(handle.getState().items).toEqual([partial]);
    release();
    await Promise.resolve();
    await Promise.resolve();

    expect(loadSignals[0]?.aborted).toBe(true);
    expect(handle.getState()).toMatchObject({
      items: [cached],
      loaded: true,
      loading: false,
      error: null,
      syncedAt: syncedAt.toISOString()
    });
  });

  it("ignores a late response after disposal", async () => {
    const pending = deferred<readonly Item[]>();
    const provider = providerWith(vi.fn(() => pending.promise));
    const handle = createExternalSourceHost(provider, connectionId, {
      now: () => now
    });
    const listener = vi.fn();
    handle.subscribe(listener);
    const refresh = handle.refresh();
    const stateBeforeDispose = handle.getState();

    handle.dispose();
    listener.mockClear();
    pending.resolve([first]);
    await refresh;

    expect(listener).not.toHaveBeenCalled();
    expect(handle.getState()).toBe(stateBeforeDispose);
    expect(
      loadExternalSourceSnapshot(provider.id, connectionId, provider.decodeItem)
    ).toBeNull();
  });

  it("does not leak a late account A response into account B state or cache", async () => {
    const pendingA = deferred<readonly Item[]>();
    const provider = providerWith(vi.fn(() => pendingA.promise));
    const accountA = "github.example/account-a";
    const accountB = "github.example/account-b";
    persistExternalSourceSnapshot(provider.id, accountA, [cached], syncedAt);
    const handleA = createExternalSourceHost(provider, accountA, {
      now: () => now
    });
    const refreshA = handleA.refresh();

    handleA.dispose();
    const handleB = createExternalSourceHost(provider, accountB, {
      now: () => now
    });
    expect(handleB.getState()).toMatchObject({ items: [], loaded: false });

    pendingA.resolve([first]);
    await refreshA;

    expect(handleB.getState()).toMatchObject({ items: [], loaded: false });
    expect(
      loadExternalSourceSnapshot(provider.id, accountB, provider.decodeItem)
    ).toBeNull();
    expect(
      loadExternalSourceSnapshot(provider.id, accountA, provider.decodeItem)
        ?.items
    ).toEqual([cached]);
  });

  it("coalesces duplicate completion and changes state only after success", async () => {
    const pending = deferred<Item>();
    const markComplete = vi.fn<MarkComplete>(() => pending.promise);
    const provider = providerWithCompletion(markComplete);
    const handle = readyHandleWith(provider, [incomplete]);
    const key = provider.keyOf(incomplete, connectionId);
    const serialized = serializeExternalBulletKey(key);

    const firstCompletion = handle.complete(key);
    const secondCompletion = handle.complete(key);

    expect(secondCompletion).toBe(firstCompletion);
    expect(markComplete).toHaveBeenCalledOnce();
    expect(handle.getState().items).toEqual([incomplete]);
    expect(handle.getState().completingKeys).toContain(serialized);

    pending.resolve(completed);
    await Promise.all([firstCompletion, secondCompletion]);

    expect(handle.getState().items).toEqual([completed]);
    expect(handle.getState().completingKeys).not.toContain(serialized);
    expect(
      loadExternalSourceSnapshot(provider.id, connectionId, provider.decodeItem)
        ?.items
    ).toEqual([completed]);
  });

  it("keeps failure details private and allows a fresh retry", async () => {
    const markComplete = vi
      .fn<MarkComplete>()
      .mockRejectedValueOnce(
        new Error("ghp_secret: response at /Users/alice/private/body.json")
      )
      .mockResolvedValueOnce(completed);
    const provider = providerWithCompletion(markComplete);
    const handle = readyHandleWith(provider, [incomplete]);
    const key = provider.keyOf(incomplete, connectionId);
    const serialized = serializeExternalBulletKey(key);

    await expect(handle.complete(key)).rejects.toThrow(
      EXTERNAL_SOURCE_COMPLETION_ERROR
    );
    expect(handle.getState().items).toEqual([incomplete]);
    expect(handle.getState().completionErrors[serialized]).toBe(
      EXTERNAL_SOURCE_COMPLETION_ERROR
    );
    expect(JSON.stringify(handle.getState())).not.toMatch(
      /ghp_secret|response at|\/Users\/alice/
    );

    await handle.complete(key);

    expect(markComplete).toHaveBeenCalledTimes(2);
    expect(handle.getState().items).toEqual([completed]);
    expect(handle.getState().completionErrors[serialized]).toBeUndefined();
  });

  it("rejects unsupported completion without a remote request", async () => {
    const unavailableMarkComplete = vi.fn<MarkComplete>();
    const unavailableProvider = {
      ...providerWithCompletion(unavailableMarkComplete),
      canComplete: () => false
    };
    const unavailableHandle = readyHandleWith(unavailableProvider, [incomplete]);
    const unavailableKey = unavailableProvider.keyOf(incomplete, connectionId);

    await expect(unavailableHandle.complete(unavailableKey)).rejects.toThrow(
      EXTERNAL_SOURCE_COMPLETION_ERROR
    );
    expect(unavailableMarkComplete).not.toHaveBeenCalled();

    const missingProvider = {
      ...providerWith(vi.fn().mockResolvedValue([])),
      canComplete: () => true
    };
    const missingHandle = readyHandleWith(missingProvider, [incomplete]);
    const missingKey = missingProvider.keyOf(incomplete, connectionId);

    await expect(missingHandle.complete(missingKey)).rejects.toThrow(
      EXTERNAL_SOURCE_COMPLETION_ERROR
    );
  });

  it("does not retain completion errors for aborts", async () => {
    const provider = providerWithCompletion(
      vi.fn<MarkComplete>().mockRejectedValue(
        new DOMException("provider cancellation detail", "AbortError")
      )
    );
    const handle = readyHandleWith(provider, [incomplete]);
    const key = provider.keyOf(incomplete, connectionId);
    const serialized = serializeExternalBulletKey(key);

    await expect(handle.complete(key)).resolves.toBeUndefined();

    expect(handle.getState().items).toEqual([incomplete]);
    expect(handle.getState().completionErrors[serialized]).toBeUndefined();
  });

  it.each([
    ["malformed", { id: 42, title: "Todo", complete: true }],
    ["different-key", { ...completed, id: "other" }]
  ])("rejects a %s completion response without changing state", async (_, raw) => {
    const provider = providerWithCompletion(
      vi.fn<MarkComplete>().mockResolvedValue(raw as unknown as Item)
    );
    const handle = readyHandleWith(provider, [incomplete]);
    const key = provider.keyOf(incomplete, connectionId);

    await expect(handle.complete(key)).rejects.toThrow(
      EXTERNAL_SOURCE_COMPLETION_ERROR
    );

    expect(handle.getState().items).toEqual([incomplete]);
    expect(
      loadExternalSourceSnapshot(provider.id, connectionId, provider.decodeItem)
        ?.items
    ).toEqual([incomplete]);
  });

  it("updates a matching complete cache while retaining failed partial rows", async () => {
    const provider = providerWithCompletion(
      vi.fn<MarkComplete>().mockResolvedValue(completed),
      async ({ publishPartial }) => {
        publishPartial([incomplete]);
        throw new Error("page 2 failed");
      }
    );
    const handle = readyHandleWith(provider, [incomplete, second]);

    await expect(handle.refresh()).rejects.toThrow(EXTERNAL_SOURCE_REFRESH_ERROR);
    await handle.complete(provider.keyOf(incomplete, connectionId));

    expect(handle.getState().items).toEqual([completed]);
    expect(
      loadExternalSourceSnapshot(provider.id, connectionId, provider.decodeItem)
        ?.items
    ).toEqual([completed, second]);
  });

  it("keeps and completes a partial-only item after failure without caching it", async () => {
    const markComplete = vi.fn<MarkComplete>().mockResolvedValue(completed);
    const provider = providerWithCompletion(
      markComplete,
      async ({ publishPartial }) => {
        publishPartial([incomplete]);
        throw new Error("page 2 failed");
      }
    );
    const handle = readyHandleWith(provider, [second]);

    await expect(handle.refresh()).rejects.toThrow(EXTERNAL_SOURCE_REFRESH_ERROR);
    await handle.complete(provider.keyOf(incomplete, connectionId));

    expect(markComplete).toHaveBeenCalledOnce();
    expect(handle.getState().items).toEqual([completed]);
    expect(
      loadExternalSourceSnapshot(provider.id, connectionId, provider.decodeItem)
        ?.items
    ).toEqual([second]);
  });

  it("keeps a completed active partial item in memory without caching it", async () => {
    const markComplete = vi.fn<MarkComplete>().mockResolvedValue(completed);
    const load = vi.fn<ExternalSourceProvider<Item>["load"]>()
      .mockImplementation(({ signal, publishPartial }) => {
        publishPartial([incomplete]);
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("provider cancellation detail", "AbortError"));
          });
        });
      });
    const provider = providerWithCompletion(markComplete, load);
    const handle = readyHandleWith(provider, [second]);

    const refresh = handle.refresh();
    expect(handle.getState().items).toEqual([incomplete]);

    await handle.complete(provider.keyOf(incomplete, connectionId));
    await refresh;

    expect(markComplete).toHaveBeenCalledOnce();
    expect(handle.getState()).toMatchObject({
      items: [completed],
      loading: false,
      error: null,
      syncedAt: syncedAt.toISOString()
    });
    expect(
      loadExternalSourceSnapshot(provider.id, connectionId, provider.decodeItem)
        ?.items
    ).toEqual([second]);
  });

  it("restores complete rows when active partial completion fails", async () => {
    const markComplete = vi
      .fn<MarkComplete>()
      .mockRejectedValue(new Error("private completion failure"));
    const load = vi.fn<ExternalSourceProvider<Item>["load"]>()
      .mockImplementation(({ signal, publishPartial }) => {
        publishPartial([incomplete]);
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("provider cancellation detail", "AbortError"));
          });
        });
      });
    const provider = providerWithCompletion(markComplete, load);
    const handle = readyHandleWith(provider, [second]);
    const key = provider.keyOf(incomplete, connectionId);
    const serialized = serializeExternalBulletKey(key);

    const refresh = handle.refresh();
    await expect(handle.complete(key)).rejects.toThrow(
      EXTERNAL_SOURCE_COMPLETION_ERROR
    );
    await refresh;

    expect(handle.getState()).toMatchObject({
      items: [second],
      loading: false,
      completionErrors: {
        [serialized]: EXTERNAL_SOURCE_COMPLETION_ERROR
      }
    });
    expect(
      loadExternalSourceSnapshot(provider.id, connectionId, provider.decodeItem)
        ?.items
    ).toEqual([second]);
  });

  it("ignores a pre-completion load that resolves after completion", async () => {
    const pendingLoad = deferred<readonly Item[]>();
    const pendingCompletion = deferred<Item>();
    const loadSignals: AbortSignal[] = [];
    const load = vi.fn<ExternalSourceProvider<Item>["load"]>((input) => {
      loadSignals.push(input.signal);
      return pendingLoad.promise;
    });
    const provider = providerWithCompletion(
      vi.fn<MarkComplete>(() => pendingCompletion.promise),
      load
    );
    const handle = readyHandleWith(provider, [incomplete]);

    const refresh = handle.refresh();
    const completion = handle.complete(
      provider.keyOf(incomplete, connectionId)
    );
    expect(loadSignals[0]?.aborted).toBe(true);

    pendingCompletion.resolve(completed);
    await completion;
    pendingLoad.resolve([incomplete]);
    await refresh;

    expect(handle.getState().items).toEqual([completed]);
    expect(
      loadExternalSourceSnapshot(provider.id, connectionId, provider.decodeItem)
        ?.items
    ).toEqual([completed]);
  });

  it("defers manual and polling refresh until completion settles", async () => {
    vi.useFakeTimers();
    const pendingCompletion = deferred<Item>();
    const load = vi.fn<ExternalSourceProvider<Item>["load"]>()
      .mockResolvedValue([completed]);
    const provider = providerWithCompletion(
      vi.fn<MarkComplete>(() => pendingCompletion.promise),
      load
    );
    const handle = readyHandleWith(provider, [incomplete]);
    const completion = handle.complete(
      provider.keyOf(incomplete, connectionId)
    );

    const refresh = handle.refresh();
    const release = handle.acquire();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).not.toHaveBeenCalled();

    pendingCompletion.resolve(completed);
    await completion;
    await vi.advanceTimersByTimeAsync(0);
    await refresh;

    expect(load).toHaveBeenCalledOnce();
    release();
  });

  it("aborts completion on disposal", async () => {
    const completionSignals: AbortSignal[] = [];
    const markComplete = vi.fn<MarkComplete>(({ signal }) => {
      completionSignals.push(signal);
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("provider cancellation detail", "AbortError"));
        });
      });
    });
    const provider = providerWithCompletion(markComplete);
    const handle = readyHandleWith(provider, [incomplete]);
    const completion = handle.complete(provider.keyOf(incomplete, connectionId));

    handle.dispose();

    expect(completionSignals[0]?.aborted).toBe(true);
    await expect(completion).resolves.toBeUndefined();
  });

  it("reopens a completed GitHub thread when newer unread activity arrives", async () => {
    const connection = {
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      token: "token"
    };
    const account = { id: "account-7", login: "octocat" };
    const githubConnectionId = githubSourceConnectionId(
      connection.apiBaseUrl,
      account.id
    );
    const original = githubNotification();
    const newer = githubNotification({
      unread: true,
      updated_at: "2026-07-22T11:00:00.000Z"
    });
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        init?.method === "PATCH"
          ? new Response(null, { status: 205 })
          : new Response(JSON.stringify([newer]), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createGithubNotificationsProvider({
      connection,
      account,
      now: () => now
    });
    persistExternalSourceSnapshot(
      GITHUB_NOTIFICATIONS_PROVIDER_ID,
      githubConnectionId,
      [original],
      syncedAt
    );
    const handle = createExternalSourceHost(provider, githubConnectionId, {
      now: () => now
    });

    await handle.complete(provider.keyOf(original, githubConnectionId));
    expect(handle.getState().items[0]).toMatchObject({ unread: false });

    await handle.refresh();

    expect(handle.getState().items[0]).toMatchObject({
      id: original.id,
      unread: true,
      updated_at: newer.updated_at
    });
    expect(
      provider.project({
        items: handle.getState().items,
        connectionId: githubConnectionId,
        settings: provider.normalizeSettings({ readRetentionDays: 30 }),
        now
      })[0]
    ).toMatchObject({ completed: false });
  });
});

describe("external source public errors", () => {
  it("maps aborts to null and all other causes to fixed messages", () => {
    expect(
      toExternalSourcePublicError(
        "refresh",
        new DOMException("sensitive cancellation", "AbortError")
      )
    ).toBeNull();
    expect(toExternalSourcePublicError("refresh", "sensitive response")).toBe(
      EXTERNAL_SOURCE_REFRESH_ERROR
    );
    expect(toExternalSourcePublicError("completion", new Error("secret"))).toBe(
      EXTERNAL_SOURCE_COMPLETION_ERROR
    );
  });
});
