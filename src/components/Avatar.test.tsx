import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubConnectionContext } from "../GithubConnectionContext";
import type { GithubConnection } from "../hooks/useGithubAuth";
import {
  clearImageProxyCache,
  persistCachedAvatarImage
} from "../services/imageProxy";
import { Avatar } from "./Avatar";

const connection: GithubConnection = {
  apiBaseUrl: "https://oss.navercorp.com/api/v3",
  webBaseUrl: "https://oss.navercorp.com",
  token: "ghp_token"
};

function renderWithConnection(ui: ReactElement) {
  return render(
    <GithubConnectionContext.Provider value={connection}>
      {ui}
    </GithubConnectionContext.Provider>
  );
}

afterEach(() => {
  clearImageProxyCache();
  vi.unstubAllGlobals();
});

describe("Avatar", () => {
  it("renders public avatar URLs directly", () => {
    renderWithConnection(
      <Avatar
        login="octocat"
        avatarUrl="https://avatars.githubusercontent.com/u/1?v=4"
      />
    );

    expect(screen.getByRole("img", { name: "octocat" })).toHaveAttribute(
      "src",
      "https://avatars.githubusercontent.com/u/1?v=4"
    );
  });

  it("loads Enterprise avatar URLs through the authenticated image proxy first", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const fetchMock = vi.fn(async () =>
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/png" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithConnection(
      <Avatar
        login="hyeonseo-kim"
        avatarUrl={`https://oss.navercorp.com/avatars/u/${Math.random()}.png`}
      />
    );

    expect(screen.queryByRole("img", { name: "hyeonseo-kim" })).toBeNull();

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "hyeonseo-kim" })).toHaveAttribute(
        "src",
        expect.stringMatching(/^data:image\/png;base64,/)
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders a cached avatar immediately while stale checks happen in the background", () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    persistCachedAvatarImage(
      "hyeonseo-kim",
      connection,
      "https://oss.navercorp.com/avatars/u/1.png",
      {
        dataUrl: "data:image/png;base64,cached",
        checkedAt: new Date("2026-07-01T00:00:00Z")
      }
    );

    renderWithConnection(
      <Avatar
        login="hyeonseo-kim"
        avatarUrl="https://oss.navercorp.com/avatars/u/1.png"
      />
    );

    expect(screen.getByRole("img", { name: "hyeonseo-kim" })).toHaveAttribute(
      "src",
      "data:image/png;base64,cached"
    );
  });

  it("does not retry the direct Enterprise URL after the auth proxy fails", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<html>login</html>", {
          status: 429,
          headers: { "content-type": "text/html" }
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithConnection(
      <Avatar
        login="hyeonseo-kim"
        avatarUrl={`https://oss.navercorp.com/avatars/u/${Math.random()}.png`}
      />
    );

    await waitFor(() => {
      expect(screen.getByLabelText("hyeonseo-kim")).toHaveTextContent("H");
    });
    expect(screen.queryByRole("img", { name: "hyeonseo-kim" })).toBeNull();
  });

  it("infers a GitHub avatar URL from the current host when the API omits avatar_url", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://oss.navercorp.com/hyeonseo-kim.png?size=72");
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithConnection(<Avatar login="hyeonseo-kim" />);

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "hyeonseo-kim" })).toHaveAttribute(
        "src",
        expect.stringMatching(/^data:image\/png;base64,/)
      );
    });
  });
});
