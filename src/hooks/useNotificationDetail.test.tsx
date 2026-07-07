import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import {
  clearNotificationDetailCache,
  fetchNotificationDetail
} from "../services/notificationDetail";
import { persistNotificationDetail } from "../services/notificationStores";
import { useNotificationDetail } from "./useNotificationDetail";

const connection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "ghp_test"
};

function notification(updatedAt: string): GitHubNotification {
  return {
    id: "1",
    unread: true,
    reason: "mention",
    updated_at: updatedAt,
    last_read_at: null,
    subject: {
      title: "Subject",
      url: "https://api.github.com/repos/acme/app/issues/7",
      type: "Issue"
    },
    repository: { full_name: "acme/app", name: "app", owner: { login: "acme" } }
  };
}

interface HarnessProps {
  token?: string;
  online?: boolean;
  note?: GitHubNotification | null;
}

function Harness({ token = "ghp_test", online = true, note }: HarnessProps) {
  const selected = note === undefined ? notification("2026-07-01T00:00:00Z") : note;
  const state = useNotificationDetail(
    selected,
    { ...connection, token },
    online
  );
  return (
    <div>
      <span>{state.loading ? "loading" : "idle"}</span>
      <span>{state.refreshing ? "refreshing" : "settled"}</span>
      <span>{state.error ?? "no-error"}</span>
      <span>{state.detail?.title ?? "no-detail"}</span>
    </div>
  );
}

/** A fetch mock whose issue title resolves on demand. */
function deferredIssueFetch() {
  const resolvers: Array<(title: string) => void> = [];
  let issueCall = 0;
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const target = String(url);
    if (target.includes("/comments")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (target.includes("/users/")) {
      return new Response(JSON.stringify({ login: "mona" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const index = issueCall;
    issueCall += 1;
    const title = await new Promise<string>((resolve) => {
      resolvers[index] = resolve;
    });
    return new Response(
      JSON.stringify({ title, state: "open", user: { login: "mona" } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });
  return {
    fetchMock,
    resolveIssue: (index: number, title: string) => {
      const resolve = resolvers[index];
      if (!resolve) {
        throw new Error(`No pending issue fetch at index ${index}`);
      }
      resolve(title);
    }
  };
}

function issueFetch(title: string) {
  return vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes("/comments")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(
      JSON.stringify({ title, state: "open", user: { login: "mona" } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });
}

describe("useNotificationDetail", () => {
  afterEach(() => {
    clearNotificationDetailCache();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows a cached detail synchronously without a spinner", async () => {
    const note = notification("2026-07-01T00:00:00Z");
    const fetchMock = issueFetch("Cached title");
    vi.stubGlobal("fetch", fetchMock);
    // Prime the cache so the hook's first render hits the synchronous peek.
    await fetchNotificationDetail({
      ...connection,
      notification: note,
      fetchImpl: fetchMock as unknown as typeof fetch
    });
    const callsAfterPrime = fetchMock.mock.calls.length;

    render(<Harness note={note} />);

    // No loading flash: the detail is present on the very first commit.
    expect(screen.getByText("Cached title")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.getByText("settled")).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(callsAfterPrime);
  });

  it("shows the previous detail while refreshing after a version change", async () => {
    const { fetchMock, resolveIssue } = deferredIssueFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <Harness note={notification("2026-07-01T00:00:00Z")} />
    );

    resolveIssue(0, "old title");
    await screen.findByText("old title");
    await waitFor(() => {
      expect(screen.getByText("idle")).toBeInTheDocument();
    });

    // A new activity bumps updated_at -> versioned cache miss.
    rerender(<Harness note={notification("2026-07-05T00:00:00Z")} />);

    await waitFor(() => {
      expect(screen.getByText("refreshing")).toBeInTheDocument();
    });
    // The previously seen conversation stays on screen instead of a skeleton.
    expect(screen.getByText("old title")).toBeInTheDocument();
    expect(screen.getByText("loading")).toBeInTheDocument();

    resolveIssue(1, "new title");

    expect(await screen.findByText("new title")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("settled")).toBeInTheDocument();
    });
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("shows a spinner and no detail when nothing is cached", async () => {
    const { fetchMock } = deferredIssueFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<Harness note={notification("2026-07-01T00:00:00Z")} />);

    await waitFor(() => {
      expect(screen.getByText("loading")).toBeInTheDocument();
    });
    expect(screen.getByText("no-detail")).toBeInTheDocument();
    expect(screen.getByText("settled")).toBeInTheDocument();
  });

  it("shows a persisted detail while offline instead of an error", () => {
    const note = notification("2026-07-01T00:00:00Z");
    persistNotificationDetail(connection.apiBaseUrl, note, {
      title: "Offline copy",
      state: "open",
      author: "mona",
      body: "stored body",
      labels: [],
      comments: []
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<Harness note={note} online={false} />);

    expect(screen.getByText("Offline copy")).toBeInTheDocument();
    expect(screen.getByText("no-error")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the offline error when nothing is cached", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<Harness note={notification("2026-07-01T00:00:00Z")} online={false} />);

    expect(
      screen.getByText("Offline — the conversation loads when you reconnect.")
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows demo content without any network in demo mode", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<Harness token="" note={notification("2026-07-01T00:00:00Z")} />);

    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.queryByText("no-detail")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
