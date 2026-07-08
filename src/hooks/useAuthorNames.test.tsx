import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubConnectionContext } from "../GithubConnectionContext";
import type { ItemDocument } from "../domain/types";
import type { GithubConnection } from "./useGithubAuth";
import { useAuthorNames } from "./useAuthorNames";

const fetchUserProfilesMock = vi.hoisted(() => vi.fn());

vi.mock("../services/userProfiles", () => ({
  fetchUserProfiles: fetchUserProfilesMock
}));

const signedIn: GithubConnection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "ghp_test"
};

const signedOut: GithubConnection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: ""
};

function itemBy(login: string, number: number): ItemDocument {
  return {
    path: `/vault/github.com/acme/app/issues/${number}/issue.md`,
    body: "Body",
    frontMatter: {
      kind: "issue",
      host: "github.com",
      owner: "acme",
      repo: "app",
      number,
      title: `Issue ${number}`,
      state: "open",
      author: login,
      labels: [],
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
      local: { favorite: false },
      sync: { status: "synced" }
    }
  };
}

function wrapperFor(connection: GithubConnection) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <GithubConnectionContext.Provider value={connection}>
        {children}
      </GithubConnectionContext.Provider>
    );
  };
}

describe("useAuthorNames", () => {
  beforeEach(() => {
    fetchUserProfilesMock.mockReset();
    fetchUserProfilesMock.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves display names for the unique author logins of the items", async () => {
    fetchUserProfilesMock.mockResolvedValue({
      "sw-chae": { login: "sw-chae", name: "Suwon Chae" },
      mona: { login: "mona", name: "Mona Lisa" }
    });

    const { result } = renderHook(
      () =>
        useAuthorNames([
          itemBy("sw-chae", 1),
          itemBy("mona", 2),
          itemBy("sw-chae", 3)
        ]),
      { wrapper: wrapperFor(signedIn) }
    );

    await waitFor(() => {
      expect(result.current.get("sw-chae")?.name).toBe("Suwon Chae");
    });
    expect(result.current.get("mona")?.name).toBe("Mona Lisa");

    expect(fetchUserProfilesMock).toHaveBeenCalledTimes(1);
    const [, logins] = fetchUserProfilesMock.mock.calls[0];
    expect([...logins].sort()).toEqual(["mona", "sw-chae"]);
  });

  it("omits logins whose profile has neither a name nor an avatar (caller falls back to login)", async () => {
    fetchUserProfilesMock.mockResolvedValue({
      mona: { login: "mona" }
    });

    const { result } = renderHook(() => useAuthorNames([itemBy("mona", 1)]), {
      wrapper: wrapperFor(signedIn)
    });

    await waitFor(() => {
      expect(fetchUserProfilesMock).toHaveBeenCalled();
    });
    expect(result.current.get("mona")).toBeUndefined();
  });

  it("exposes the avatar URL for author logins whose profile carries one", async () => {
    fetchUserProfilesMock.mockResolvedValue({
      mona: {
        login: "mona",
        name: "Mona Lisa",
        avatarUrl: "https://avatars.example.com/mona.png"
      }
    });

    const { result } = renderHook(() => useAuthorNames([itemBy("mona", 1)]), {
      wrapper: wrapperFor(signedIn)
    });

    await waitFor(() => {
      expect(result.current.get("mona")?.avatarUrl).toBe(
        "https://avatars.example.com/mona.png"
      );
    });
    expect(result.current.get("mona")?.name).toBe("Mona Lisa");
  });

  it("exposes the avatar URL even when the profile has no distinct display name", async () => {
    fetchUserProfilesMock.mockResolvedValue({
      mona: { login: "mona", avatarUrl: "https://avatars.example.com/mona.png" }
    });

    const { result } = renderHook(() => useAuthorNames([itemBy("mona", 1)]), {
      wrapper: wrapperFor(signedIn)
    });

    await waitFor(() => {
      expect(result.current.get("mona")?.avatarUrl).toBe(
        "https://avatars.example.com/mona.png"
      );
    });
    expect(result.current.get("mona")?.name).toBeUndefined();
  });

  it("does not fetch when disabled (demo mode / offline)", async () => {
    const { result } = renderHook(
      () => useAuthorNames([itemBy("mona", 1)], { enabled: false }),
      { wrapper: wrapperFor(signedIn) }
    );

    await Promise.resolve();
    expect(fetchUserProfilesMock).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });

  it("does not fetch when there is no token", async () => {
    renderHook(() => useAuthorNames([itemBy("mona", 1)]), {
      wrapper: wrapperFor(signedOut)
    });

    await Promise.resolve();
    expect(fetchUserProfilesMock).not.toHaveBeenCalled();
  });

  it("does not fetch when there are no items", async () => {
    renderHook(() => useAuthorNames([]), {
      wrapper: wrapperFor(signedIn)
    });

    await Promise.resolve();
    expect(fetchUserProfilesMock).not.toHaveBeenCalled();
  });

  it("ignores empty and unknown author logins", async () => {
    renderHook(
      () => useAuthorNames([itemBy("", 1), itemBy("unknown", 2)]),
      { wrapper: wrapperFor(signedIn) }
    );

    await Promise.resolve();
    expect(fetchUserProfilesMock).not.toHaveBeenCalled();
  });

  it("does not update state after unmount", async () => {
    let resolveProfiles: (value: Record<string, unknown>) => void = () => {};
    fetchUserProfilesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveProfiles = resolve;
      })
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderHook(() => useAuthorNames([itemBy("mona", 1)]), {
      wrapper: wrapperFor(signedIn)
    });

    unmount();
    resolveProfiles({ mona: { login: "mona", name: "Mona Lisa" } });
    await Promise.resolve();

    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes("unmounted")
      )
    ).toBe(false);
  });
});
