import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Base UI's Avatar.Image resolves its load state with a detached `new Image()`,
// which jsdom never fires. Substitute a controllable Image so the load-status
// machine (loaded -> <img>, error -> fallback) actually runs in tests. Any src
// listed in `failImageSrcs` (substring match) reports an error; everything else
// reports a successful load on the next microtask.
const failImageSrcs: string[] = [];

class MockImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  complete = false;
  naturalWidth = 0;
  crossOrigin: string | null = null;
  referrerPolicy = "";
  sizes = "";
  srcset = "";
  private currentSrc = "";

  set src(value: string) {
    this.currentSrc = value;
    queueMicrotask(() => {
      if (this.currentSrc !== value) {
        return;
      }
      if (failImageSrcs.some((token) => value.includes(token))) {
        this.onerror?.();
        return;
      }
      this.complete = true;
      this.naturalWidth = 1;
      this.onload?.();
    });
  }

  get src() {
    return this.currentSrc;
  }
}

function renderWithConnection(ui: ReactElement) {
  return render(
    <GithubConnectionContext.Provider value={connection}>
      {ui}
    </GithubConnectionContext.Provider>
  );
}

beforeEach(() => {
  failImageSrcs.length = 0;
  vi.stubGlobal("Image", MockImage);
});

afterEach(() => {
  clearImageProxyCache();
  vi.unstubAllGlobals();
});

describe("Avatar", () => {
  it("renders public avatar URLs directly", async () => {
    renderWithConnection(
      <Avatar
        login="octocat"
        avatarUrl="https://avatars.githubusercontent.com/u/1?v=4"
      />
    );

    expect(await screen.findByRole("img", { name: "octocat" })).toHaveAttribute(
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

  it("renders a cached avatar immediately while stale checks happen in the background", async () => {
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

    // The cached data URL is used without waiting on the (never-resolving)
    // background fetch.
    expect(
      await screen.findByRole("img", { name: "hyeonseo-kim" })
    ).toHaveAttribute("src", "data:image/png;base64,cached");
  });

  it("does not show a cached avatar when it belongs to a different avatar URL", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const fetchMock = vi.fn(async () =>
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/png" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    persistCachedAvatarImage(
      "hyeonseo-kim",
      connection,
      "https://oss.navercorp.com/avatars/u/old.png",
      {
        dataUrl: "data:image/png;base64,old",
        checkedAt: new Date("2026-07-01T00:00:00Z")
      }
    );

    renderWithConnection(
      <Avatar
        login="hyeonseo-kim"
        avatarUrl="https://oss.navercorp.com/avatars/u/new.png"
      />
    );

    expect(screen.queryByRole("img", { name: "hyeonseo-kim" })).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole("img", { name: "hyeonseo-kim" })).toHaveAttribute(
        "src",
        expect.not.stringContaining("old")
      );
    });
  });

  it("does not keep the previous user's image while a new avatar resolves", async () => {
    const firstBytes = new Uint8Array([137, 80, 78, 71, 1]);
    const secondBytes = new Uint8Array([137, 80, 78, 71, 2]);
    const pendingSecond = new Promise<Response>(() => {});
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/old.png")) {
        return new Response(firstBytes, {
          status: 200,
          headers: { "content-type": "image/png" }
        });
      }
      if (String(url).includes("/new.png")) {
        return pendingSecond;
      }
      return new Response(secondBytes, {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderWithConnection(
      <Avatar login="old-user" avatarUrl="https://oss.navercorp.com/avatars/u/old.png" />
    );

    const oldImage = await screen.findByRole("img", { name: "old-user" });
    expect(oldImage).toHaveAttribute("src", expect.stringMatching(/^data:image\/png/));

    rerender(
      <GithubConnectionContext.Provider value={connection}>
        <Avatar
          login="new-user"
          avatarUrl="https://oss.navercorp.com/avatars/u/new.png"
        />
      </GithubConnectionContext.Provider>
    );

    expect(screen.queryByRole("img", { name: "new-user" })).toBeNull();
    expect(screen.queryByRole("img", { name: "old-user" })).toBeNull();
    expect(screen.getByLabelText("new-user")).toHaveTextContent("N");
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

  it("renders the fallback initial when a public image fails to load", async () => {
    // Make Base UI's load-status machine report an error for this src.
    failImageSrcs.push("avatars.githubusercontent.com");

    renderWithConnection(
      <Avatar
        login="octocat"
        avatarUrl="https://avatars.githubusercontent.com/u/1?v=4"
      />
    );

    await waitFor(() => {
      expect(screen.getByLabelText("octocat")).toHaveTextContent("O");
    });
    expect(screen.queryByRole("img", { name: "octocat" })).toBeNull();
  });

  it("renders nothing when showFallback is false and there is no image", () => {
    const { container } = renderWithConnection(
      <Avatar login="unknown" showFallback={false} />
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows a loading skeleton (no fallback initial) while an image resolves", () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    renderWithConnection(
      <Avatar
        login="hyeonseo-kim"
        avatarUrl="https://oss.navercorp.com/avatars/u/pending.png"
        showFallback={false}
      />
    );

    expect(
      screen.getByLabelText("Loading avatar for hyeonseo-kim")
    ).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("H")).toBeNull();
  });

  it("renders nothing (no lingering skeleton) when showFallback is false and the auth image is unavailable", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<html>login</html>", {
          status: 429,
          headers: { "content-type": "text/html" }
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderWithConnection(
      <Avatar
        login="hyeonseo-kim"
        avatarUrl={`https://oss.navercorp.com/avatars/u/${Math.random()}.png`}
        showFallback={false}
      />
    );

    await waitFor(() => {
      expect(
        screen.queryByLabelText("Loading avatar for hyeonseo-kim")
      ).toBeNull();
    });
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("img")).toBeNull();
    // Never the initial letter for showFallback=false.
    expect(screen.queryByText("H")).toBeNull();
  });
});
