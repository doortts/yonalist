import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import type { ExternalSourceState } from "./externalSourceHost";
import {
  githubMaterializedBridgeToken,
  createGithubMaterializedBridgePump
} from "./githubMaterializedBridge";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const item: GitHubNotification = {
  id: "thread-17",
  unread: true,
  reason: "mention",
  updated_at: "2026-07-22T10:00:00.000Z",
  last_read_at: null,
  subject: {
    title: "Bridge raw source",
    url: "https://api.github.com/repos/acme/yonalist/issues/17",
    type: "Issue"
  },
  repository: {
    full_name: "acme/yonalist",
    name: "yonalist",
    owner: { login: "acme" }
  }
};

function state(
  overrides: Partial<ExternalSourceState<GitHubNotification>> = {}
): ExternalSourceState<GitHubNotification> {
  return {
    items: [item],
    loaded: true,
    isComplete: true,
    loading: false,
    error: null,
    syncedAt: "2026-07-22T10:01:00.000Z",
    completionVersion: 0,
    completingKeys: new Set(),
    completionErrors: {},
    ...overrides
  };
}

describe("GitHub materialized bridge", () => {
  afterEach(() => vi.useRealTimers());

  it("never bridges a loading or partial page merely because an older snapshot has syncedAt", () => {
    expect(
      githubMaterializedBridgeToken(
        "github.example/acme",
        state({ isComplete: false, loading: true })
      )
    ).toBeNull();
    expect(
      githubMaterializedBridgeToken(
        "github.example/acme",
        state({ isComplete: false, loading: false })
      )
    ).toBeNull();
  });

  it("bridges a partial-only successful mark-read by its revision", () => {
    const token = githubMaterializedBridgeToken(
      "github.example/acme",
      state({
        items: [{ ...item, unread: false }],
        isComplete: false,
        loading: false,
        completionVersion: 1
      })
    );

    expect(token).toBe("github.example/acme\u0000completion\u00001");
  });

  it("keeps an authoritative completion on its normal snapshot token after a refresh error", () => {
    const completed = state({
      items: [{ ...item, unread: false }],
      isComplete: true,
      loading: false,
      completionVersion: 1
    });
    const settled = githubMaterializedBridgeToken(
      "github.example/acme",
      completed
    );
    const afterFailedRefresh = githubMaterializedBridgeToken(
      "github.example/acme",
      { ...completed, error: "Unable to refresh external source." }
    );

    expect(settled).toContain("\u0000snapshot\u0000");
    expect(afterFailedRefresh).toBe(settled);
  });

  it("does not bridge changed partial rows after an already-bridged completion", () => {
    const settled = githubMaterializedBridgeToken(
      "github.example/acme",
      state({
        items: [{ ...item, unread: false }],
        isComplete: true,
        loading: false,
        completionVersion: 1
      })
    );
    const partial = githubMaterializedBridgeToken(
      "github.example/acme",
      state({
        items: [{ ...item, id: "new-partial", updated_at: "2026-07-23T10:00:00.000Z" }],
        isComplete: false,
        loading: true,
        completionVersion: 1
      })
    );
    const terminalFailure = githubMaterializedBridgeToken(
      "github.example/acme",
      state({
        items: [{ ...item, unread: false }],
        error: "Unable to refresh external source.",
        isComplete: true,
        loading: false,
        completionVersion: 1
      })
    );

    expect(partial).toBeNull();
    expect(terminalFailure).toBe(settled);
  });

  it.each(["failed", "skipped"] as const)(
    "retries a %s workspace outcome after one second",
    async (outcome) => {
      vi.useFakeTimers();
      const execute = vi
        .fn<(request: { id: string }) => Promise<typeof outcome | "committed">>()
        .mockResolvedValueOnce(outcome)
        .mockResolvedValueOnce("committed");
      const pump = createGithubMaterializedBridgePump(execute);

      pump.submit({ token: "A", request: { id: "A" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(execute).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(999);
      expect(execute).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(execute).toHaveBeenCalledTimes(2);
    }
  );

  it("retries a rejected workspace action after one second", async () => {
    vi.useFakeTimers();
    const execute = vi
      .fn<(request: { id: string }) => Promise<"committed">>()
      .mockRejectedValueOnce(new Error("workspace closed"))
      .mockResolvedValueOnce("committed");
    const pump = createGithubMaterializedBridgePump(execute);

    pump.submit({ token: "A", request: { id: "A" } });
    await vi.advanceTimersByTimeAsync(999);
    expect(execute).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("replaces a same-token in-flight request after invalidation", async () => {
    const first = deferred<"committed">();
    const second = {
      connectionId: "github.example/acme",
      webBaseUrl: "https://replacement.example/acme"
    };
    const staleHandler = vi.fn(
      (_request: { connectionId: string; webBaseUrl: string }) => first.promise
    );
    const replacementHandler = vi.fn(
      (_request: { connectionId: string; webBaseUrl: string }) =>
        Promise.resolve("committed" as const)
    );
    let currentHandler: (request: {
      connectionId: string;
      webBaseUrl: string;
    }) => Promise<"committed" | "failed"> = staleHandler;
    const pump = createGithubMaterializedBridgePump((request: {
      connectionId: string;
      webBaseUrl: string;
    }) => currentHandler(request));

    pump.submit({
      token: "github.example/acme\u0000completion\u00001",
      request: {
        connectionId: "github.example/acme",
        webBaseUrl: "https://original.example/acme"
      }
    });
    pump.invalidate();
    currentHandler = replacementHandler;
    pump.submit({ token: "github.example/acme\u0000completion\u00001", request: second });
    first.resolve("committed");
    await Promise.resolve();

    expect(staleHandler).toHaveBeenCalledOnce();
    expect(replacementHandler).toHaveBeenCalledOnce();
    expect(replacementHandler).toHaveBeenLastCalledWith(second);
  });

  it("does not drop completion revision one from a recreated source after invalidation", async () => {
    const execute = vi.fn(() => Promise.resolve("committed" as const));
    const pump = createGithubMaterializedBridgePump(execute);
    const first = { source: "first-host", completionVersion: 1 };
    const recreated = { source: "recreated-host", completionVersion: 1 };
    const token = "github.example/acme\u0000completion\u00001";

    pump.submit({ token, request: first });
    await Promise.resolve();
    pump.submit({ token, request: first });
    pump.invalidate();
    pump.submit({ token, request: recreated });
    await Promise.resolve();

    expect(execute.mock.calls).toEqual([[first], [recreated]]);
  });

  it("drops a stale retry before resubmitting through the replacement handler", async () => {
    vi.useFakeTimers();
    const staleHandler = vi.fn((_request: { id: string }) =>
      Promise.resolve("failed" as const)
    );
    const replacementHandler = vi.fn((_request: { id: string }) =>
      Promise.resolve("committed" as const)
    );
    let currentHandler: (request: { id: string }) => Promise<
      "committed" | "failed"
    > = staleHandler;
    const pump = createGithubMaterializedBridgePump((request: { id: string }) =>
      currentHandler(request)
    );

    pump.submit({ token: "same", request: { id: "stale" } });
    await vi.advanceTimersByTimeAsync(0);
    pump.invalidate();
    currentHandler = replacementHandler;
    pump.submit({ token: "same", request: { id: "replacement" } });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(staleHandler).toHaveBeenCalledOnce();
    expect(replacementHandler).toHaveBeenCalledOnce();
    expect(replacementHandler).toHaveBeenLastCalledWith({ id: "replacement" });
  });

  it("keeps only the newest pending request while one bridge is running", async () => {
    const first = deferred<"committed">();
    const execute = vi.fn((request: { id: string }) =>
      request.id === "A" ? first.promise : Promise.resolve("committed" as const)
    );
    const pump = createGithubMaterializedBridgePump(execute);

    pump.submit({ token: "A", request: { id: "A" } });
    pump.submit({ token: "B", request: { id: "B" } });
    pump.submit({ token: "C", request: { id: "C" } });
    expect(execute).toHaveBeenCalledTimes(1);

    first.resolve("committed");
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith({ id: "C" });
  });

  it("ignores a rejected action after disposal without scheduling a retry", async () => {
    vi.useFakeTimers();
    const first = deferred<"committed">();
    const execute = vi.fn(() => first.promise);
    const pump = createGithubMaterializedBridgePump(execute);

    pump.submit({ token: "A", request: { id: "A" } });
    pump.dispose();
    first.reject(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(execute).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bridges a completed empty source so the repository can preserve omitted materialized rows", () => {
    expect(
      githubMaterializedBridgeToken(
        "github.example/acme",
        state({ items: [] })
      )
    ).not.toBeNull();
  });
});
