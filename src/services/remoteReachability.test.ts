import { afterEach, describe, expect, it, vi } from "vitest";
import { isRemoteReachable } from "./remoteReachability";

const connection = {
  apiBaseUrl: "https://oss.navercorp.com/api/v3",
  token: "ghp_test"
};

describe("isRemoteReachable", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("probes the lightweight endpoint with no-store, an abort signal and auth, then returns true on success", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response("{}", { status: 200 })
    );

    const result = await isRemoteReachable(connection, {
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 4000
    });

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://oss.navercorp.com/api/v3/rate_limit");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer ghp_test");
  });

  it("returns false on an HTTP error response", async () => {
    const fetchMock = vi.fn(
      async () => new Response("nope", { status: 500 })
    );

    await expect(
      isRemoteReachable(connection, { fetch: fetchMock as unknown as typeof fetch })
    ).resolves.toBe(false);
  });

  it("returns false on a network error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(
      isRemoteReachable(connection, { fetch: fetchMock as unknown as typeof fetch })
    ).resolves.toBe(false);
  });

  it("aborts the probe and returns false once the timeout elapses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        })
    );

    const promise = isRemoteReachable(connection, {
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 1000
    });

    // Still in flight just before the deadline.
    await vi.advanceTimersByTimeAsync(999);
    // Crossing the deadline fires the AbortController.
    await vi.advanceTimersByTimeAsync(1);

    await expect(promise).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("omits the Authorization header when the token is blank", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response("{}", { status: 200 })
    );

    await isRemoteReachable(
      { apiBaseUrl: connection.apiBaseUrl, token: "   " },
      { fetch: fetchMock as unknown as typeof fetch }
    );

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.has("Authorization")).toBe(false);
  });

  it("returns false without fetching when the base URL is empty", async () => {
    const fetchMock = vi.fn(
      async () => new Response("{}", { status: 200 })
    );

    await expect(
      isRemoteReachable(
        { apiBaseUrl: "", token: "x" },
        { fetch: fetchMock as unknown as typeof fetch }
      )
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
