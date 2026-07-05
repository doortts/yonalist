import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { serializeMarkdownDocument } from "./domain/markdown";
import type { ItemFrontMatter } from "./domain/types";
import * as windowDrag from "./windowDrag";

function installLocalStorageMock() {
  let store: Record<string, string> = {};
  const localStorageMock = {
    get length() {
      return Object.keys(store).length;
    },
    clear: vi.fn(() => {
      store = {};
    }),
    getItem: vi.fn((key: string) => store[key] ?? null),
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = String(value);
    })
  } as Storage;

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorageMock
  });
}

describe("Yonalist app shell", () => {
  beforeEach(() => {
    installLocalStorageMock();
    // Existing shell tests assume the app is past the startup login gate.
    window.localStorage.setItem("yonalist.auth.skipLogin.v1", "true");
  });

  it("starts on the login page on first run and can skip into demo mode", async () => {
    window.localStorage.removeItem("yonalist.auth.skipLogin.v1");
    const user = userEvent.setup();
    render(<App />);

    const login = screen.getByLabelText("GitHub login");
    expect(within(login).getByText("GitHub 로그인")).toBeInTheDocument();
    expect(within(login).getByLabelText("GitHub servers")).toBeInTheDocument();
    expect(screen.queryByLabelText("Navigation")).not.toBeInTheDocument();

    await user.click(
      within(login).getByRole("button", { name: /샘플 데이터로 둘러보기/ })
    );

    expect(screen.getByLabelText("Navigation")).toBeInTheDocument();
    expect(window.localStorage.getItem("yonalist.auth.skipLogin.v1")).toBe("true");
  });

  it("opens straight into the app when the last authenticated host verifies", async () => {
    window.localStorage.removeItem("yonalist.auth.skipLogin.v1");
    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "ghp_valid" })
    );
    window.localStorage.setItem(
      "yonalist.github.lastAuthenticatedUrl.v1",
      "https://oss.navercorp.com/api/v3"
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/user")) {
        return new Response(JSON.stringify({ login: "doortts" }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App />);

      expect(await screen.findByLabelText("Navigation")).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(
        "https://oss.navercorp.com/api/v3/user",
        expect.anything()
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows the login page when the stored credentials fail verification", async () => {
    window.localStorage.removeItem("yonalist.auth.skipLogin.v1");
    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "ghp_expired" })
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/user")) {
        return new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401
        });
      }
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App />);

      expect(await screen.findByLabelText("GitHub login")).toBeInTheDocument();
      expect(
        await screen.findByText(/인증에 실패했습니다/)
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Navigation")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows animated loading dots while notifications refresh", async () => {
    window.localStorage.removeItem("yonalist.auth.skipLogin.v1");
    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "ghp_valid" })
    );
    window.localStorage.setItem(
      "yonalist.github.lastAuthenticatedUrl.v1",
      "https://oss.navercorp.com/api/v3"
    );
    // Repositories never resolve, so the loading indicator stays visible.
    let resolveRepos: (value: Response) => void = () => {};
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/user")) {
        return new Response(JSON.stringify({ login: "doortts" }), { status: 200 });
      }
      if (target.includes("/user/repos")) {
        return new Promise<Response>((resolve) => {
          resolveRepos = resolve;
        });
      }
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App />);

      const nav = await screen.findByLabelText("Navigation");
      expect(
        await within(nav).findByLabelText("Refreshing notifications")
      ).toBeInTheDocument();
      resolveRepos(new Response("[]", { status: 200 }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lands on the notifications view after passing the gate", () => {
    render(<App />);

    expect(screen.getByLabelText("Notifications")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Empty notification detail")
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Items")).not.toBeInTheDocument();
  });

  it("collapses owners with no selected repositories in the project tree", async () => {
    window.localStorage.setItem(
      "yonalist.projectVisibility.v1",
      JSON.stringify({ "doortts/blog": false })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      within(await screen.findByLabelText("Settings sections")).getByRole("button", {
        name: /Projects 표시/
      })
    );

    const section = await screen.findByLabelText("Project visibility");
    // doortts has nothing selected → collapsed; Yona-projects stays open.
    const doorttsToggle = within(section).getByRole("button", {
      name: "Toggle doortts projects"
    });
    expect(doorttsToggle).toHaveAttribute("aria-expanded", "false");
    expect(
      within(section).queryByRole("checkbox", { name: "Show doortts/blog" })
    ).not.toBeInTheDocument();
    expect(
      within(section).getByRole("checkbox", { name: "Show Yona-projects/Home" })
    ).toBeInTheDocument();

    await user.click(doorttsToggle);

    expect(doorttsToggle).toHaveAttribute("aria-expanded", "true");
    expect(
      within(section).getByRole("checkbox", { name: "Show doortts/blog" })
    ).toBeInTheDocument();
  });

  it("shows the offline badge at the top of the first column", () => {
    render(<App initialOnline={false} />);

    const leftColumn = screen.getByLabelText("Navigation");
    expect(within(leftColumn).getByText("Offline")).toBeInTheDocument();
  });

  it("shows a login-required icon next to the network control when unsigned", () => {
    render(<App />);

    const leftColumn = screen.getByLabelText("Navigation");
    expect(
      within(leftColumn).getByLabelText("Login required")
    ).toBeInTheDocument();
  });

  it("hides the login-required icon when a token is configured", async () => {
    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "ghp_test" })
    );

    render(<App />);

    const leftColumn = await screen.findByLabelText("Navigation");
    expect(
      within(leftColumn).queryByLabelText("Login required")
    ).not.toBeInTheDocument();
  });

  it("marks the top-left titlebar area as the native window drag region", () => {
    render(<App />);

    expect(screen.getByLabelText("Window drag region")).toHaveAttribute(
      "data-tauri-drag-region"
    );
  });

  it("starts native dragging from the top-left titlebar area", async () => {
    const user = userEvent.setup();
    const startDrag = vi
      .spyOn(windowDrag, "startNativeWindowDrag")
      .mockResolvedValue(undefined);
    render(<App />);

    await user.pointer({
      keys: "[MouseLeft>]",
      target: screen.getByLabelText("Window drag region")
    });

    expect(startDrag).toHaveBeenCalledTimes(1);
    startDrag.mockRestore();
  });

  it("toggles the red bookmark favorite control in the detail header", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));

    const bookmark = screen.getByRole("button", { name: /toggle favorite/i });
    expect(bookmark).toHaveAttribute("aria-pressed", "true");

    await user.click(bookmark);

    expect(bookmark).toHaveAttribute("aria-pressed", "false");
  });

  it("offers icon-only open-in-browser buttons on both detail panes", async () => {
    const user = userEvent.setup();
    render(<App />);

    // Notifications detail
    await user.click(
      screen.getByRole("button", { name: /Design offline issue reading/ })
    );
    const notificationOpen = within(screen.getByLabelText("Detail")).getByRole(
      "button",
      { name: "Open in browser" }
    );
    expect(notificationOpen).toHaveAttribute("title", "브라우저에서 열기");
    expect(notificationOpen.textContent).toBe("");

    // Item detail
    await user.click(screen.getByRole("button", { name: /^All items/ }));
    const itemOpen = within(screen.getByLabelText("Detail")).getByRole("button", {
      name: "Open in browser"
    });
    expect(itemOpen).toHaveAttribute("title", "브라우저에서 열기");
    expect(itemOpen.textContent).toBe("");
  });

  it("shows the item state and its comment thread in the detail pane", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));

    const detail = screen.getByLabelText("Detail");
    expect(within(detail).getByText("Open")).toHaveClass("state-open");
    const comments = within(detail).getByLabelText("Comments");
    expect(
      within(comments).getByText(/Sample reply so the conversation thread/)
    ).toBeInTheDocument();
    expect(within(detail).getByText(/댓글 2/)).toBeInTheDocument();
  });

  it("shows a green Comment button online and Queue comment offline", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App initialOnline />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));

    const onlineButton = screen.getByRole("button", { name: "Comment" });
    expect(onlineButton).toHaveClass("comment-button");
    expect(screen.queryByRole("button", { name: "Queue comment" })).toBeNull();
    // The label text appears once (as the textarea placeholder), not twice.
    expect(screen.queryByText("Write a comment")).toBeNull();
    unmount();

    render(<App initialOnline={false} />);
    await user.click(screen.getByRole("button", { name: /^All items/ }));

    expect(screen.getByRole("button", { name: "Queue comment" })).not.toHaveClass(
      "comment-button"
    );
  });

  it("creates an offline comment draft and shows it in the outbox", async () => {
    const user = userEvent.setup();
    render(<App initialOnline={false} />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));

    await user.type(
      screen.getByLabelText("Write a comment"),
      "I can write this offline."
    );
    await user.click(screen.getByRole("button", { name: "Queue comment" }));
    await user.click(screen.getByRole("button", { name: /outbox/i }));

    expect(screen.getByText("Pending sync")).toBeInTheDocument();
    expect(screen.getByText(/I can write this offline/)).toBeInTheDocument();
  });

  it("opens the new issue composer as the full right pane", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));

    await user.click(screen.getByRole("button", { name: "New issue" }));

    expect(screen.getByLabelText("New issue composer")).toBeInTheDocument();
    expect(screen.queryByText("Issue conversation")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Issue title"), "A local draft");
    await user.click(screen.getByRole("button", { name: "Queue issue" }));

    expect(screen.getAllByText("A local draft").length).toBeGreaterThan(0);
  });

  it("restores queued issue drafts and outbox operations from the local vault", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));
    await user.click(screen.getByRole("button", { name: "New issue" }));
    await user.type(screen.getByLabelText("Issue title"), "Persist after restart");
    await user.type(screen.getByLabelText("Issue body"), "Stored as Markdown.");
    await user.click(screen.getByRole("button", { name: "Queue issue" }));

    expect(window.localStorage.getItem("yonalist.vaultDocuments.v1")).toContain(
      "Persist after restart"
    );

    unmount();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));

    expect((await screen.findAllByText("Persist after restart")).length).toBeGreaterThan(
      0
    );

    await user.click(screen.getByRole("button", { name: /outbox/i }));

    const outboxDialog = screen.getByRole("dialog", { name: "Outbox" });
    expect(outboxDialog).toBeInTheDocument();
    expect(within(outboxDialog).getByText(/Persist after restart/)).toBeInTheDocument();
  });

  it("asks which queued changes to sync when the app comes back online", async () => {
    const user = userEvent.setup();
    render(<App initialOnline={false} />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));

    await user.type(screen.getByLabelText("Write a comment"), "Sync this later.");
    await user.click(screen.getByRole("button", { name: "Queue comment" }));
    await user.click(screen.getByRole("button", { name: "Go online" }));

    expect(screen.getByRole("dialog", { name: "Outbox" })).toBeInTheDocument();
    expect(screen.getByText("Choose queued changes to sync.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync selected" })).toBeEnabled();
  });

  it("marks queued drafts with a pending badge in the list", async () => {
    const user = userEvent.setup();
    render(<App initialOnline={false} />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));
    await user.click(screen.getByRole("button", { name: "New issue" }));
    await user.type(screen.getByLabelText("Issue title"), "Pending badge draft");
    await user.click(screen.getByRole("button", { name: "Queue issue" }));

    const matches = await screen.findAllByText("Pending badge draft");
    const card = matches
      .map((element) => element.closest(".item-card"))
      .find(Boolean) as HTMLElement;
    expect(card).toBeTruthy();
    expect(within(card).getByText("Pending")).toBeInTheDocument();
  });

  async function seedQueuedIssueDraft(user: ReturnType<typeof userEvent.setup>) {
    const seeded = render(<App initialOnline={false} />);
    await user.click(screen.getByRole("button", { name: /^All items/ }));
    await user.click(screen.getByRole("button", { name: "New issue" }));
    await user.type(screen.getByLabelText("Issue title"), "Auto flush me");
    await user.click(screen.getByRole("button", { name: "Queue issue" }));
    seeded.unmount();

    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "ghp_test" })
    );
  }

  function autoFlushFetchMock(issuePost: () => Response) {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (/\/repos\/[^/]+\/[^/]+\/issues$/.test(target) && init?.method === "POST") {
        return issuePost();
      }
      if (target.includes("/search/issues")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (target.includes("/api/graphql")) {
        return new Response(JSON.stringify({ data: { search: { nodes: [] } } }), {
          status: 200
        });
      }
      if (target.includes("/user/repos") || target.includes("/user/subscriptions")) {
        return new Response("[]", { status: 200 });
      }
      if (target.includes("/notifications")) {
        return new Response("[]", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
  }

  it("auto-syncs the outbox on reconnect when signed in", async () => {
    const user = userEvent.setup();
    await seedQueuedIssueDraft(user);

    const fetchMock = autoFlushFetchMock(
      () =>
        new Response(
          JSON.stringify({
            number: 200,
            node_id: "I_200",
            html_url: "https://oss.navercorp.com/acme/app/issues/200",
            created_at: "2026-07-05T00:00:00Z",
            updated_at: "2026-07-05T00:00:00Z"
          }),
          { status: 201 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App initialOnline={false} />);
      await user.click(screen.getByRole("button", { name: /^All items/ }));
      // Vault (and with it the outbox) has loaded once the draft is visible.
      expect((await screen.findAllByText("Auto flush me")).length).toBeGreaterThan(0);

      await user.click(screen.getByRole("button", { name: "Go online" }));

      expect(await screen.findByText(/Synced 1 queued change/)).toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Outbox" })).not.toBeInTheDocument();
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            /\/repos\/[^/]+\/[^/]+\/issues$/.test(String(url)) &&
            (init as RequestInit | undefined)?.method === "POST"
        )
      ).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("blocks permanently failed operations and opens the outbox for review", async () => {
    const user = userEvent.setup();
    await seedQueuedIssueDraft(user);

    const fetchMock = autoFlushFetchMock(
      () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App initialOnline={false} />);
      await user.click(screen.getByRole("button", { name: /^All items/ }));
      expect((await screen.findAllByText("Auto flush me")).length).toBeGreaterThan(0);

      await user.click(screen.getByRole("button", { name: "Go online" }));

      const dialog = await screen.findByRole("dialog", { name: "Outbox" });
      expect(within(dialog).getByText(/Blocked/)).toBeInTheDocument();
      // Blocked operations are not preselected for another doomed retry.
      expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
      // Permanent failures are not retried.
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            /\/repos\/[^/]+\/[^/]+\/issues$/.test(String(url)) &&
            (init as RequestInit | undefined)?.method === "POST"
        )
      ).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renames synced issue drafts to their remote issue path in the vault", async () => {
    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "ghp_test" })
    );
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/repos/acme/app/issues") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            number: 100,
            node_id: "I_100",
            html_url: "https://github.com/acme/app/issues/100",
            created_at: "2026-07-03T00:00:00Z",
            updated_at: "2026-07-03T00:00:00Z"
          }),
          { status: 201 }
        );
      }
      if (target.includes("/search/issues")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                number: 101,
                title: "Existing issue",
                state: "open",
                body: "from the API",
                user: { login: "doortts" },
                labels: [],
                created_at: "2026-07-01T00:00:00Z",
                updated_at: "2026-07-02T00:00:00Z",
                repository_url: "https://oss.navercorp.com/api/v3/repos/acme/app"
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (target.includes("/api/graphql")) {
        return new Response(JSON.stringify({ data: { search: { nodes: [] } } }), {
          status: 200
        });
      }
      if (target.includes("/user/repos")) {
        return new Response(
          JSON.stringify([
            {
              name: "app",
              full_name: "acme/app",
              owner: { login: "acme" },
              open_issues_count: 3,
              pushed_at: "2026-07-01T00:00:00Z"
            }
          ]),
          { status: 200 }
        );
      }
      if (target.includes("/user/subscriptions")) {
        return new Response("[]", { status: 200 });
      }
      if (target.includes("/issues/101/comments")) {
        return new Response("[]", { status: 200 });
      }
      if (target.includes("/issues/101")) {
        return new Response(JSON.stringify({ state: "open" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const user = userEvent.setup();
      render(<App />);

      await user.click(screen.getByRole("button", { name: /^All items/ }));
      expect((await screen.findAllByText("Existing issue")).length).toBeGreaterThan(
        0
      );

      await user.click(screen.getByRole("button", { name: "New issue" }));
      await user.type(screen.getByLabelText("Issue title"), "Sync me");
      await user.click(screen.getByRole("button", { name: "Queue issue" }));
      await user.click(screen.getByRole("button", { name: /outbox/i }));
      await user.click(screen.getByRole("button", { name: "Sync selected" }));

      await waitFor(() => {
        const stored = window.localStorage.getItem("yonalist.vaultDocuments.v1");
        expect(stored).toContain("issues/100/issue.md");
        expect(stored).not.toContain("issues/_drafts");
      });
      expect(screen.queryByRole("dialog", { name: "Outbox" })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens settings and saves vault preferences", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByLabelText("Settings page")).toBeInTheDocument();
    await user.click(
      within(await screen.findByLabelText("Settings sections")).getByRole("button", {
        name: /Vault and sync/
      })
    );

    await user.clear(screen.getByLabelText("Vault folder"));
    await user.type(screen.getByLabelText("Vault folder"), "/Users/doortts/Yonalist");
    await user.click(screen.getByLabelText("Cache linked attachments"));
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(screen.getByText("Settings saved")).toBeInTheDocument();
    expect(window.localStorage.getItem("yonalist.settings.v1")).toContain(
      "/Users/doortts/Yonalist"
    );
    expect(screen.getByLabelText("Cache linked attachments")).not.toBeChecked();
  });

  it("lists default GitHub servers and switches the selected one", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      within(await screen.findByLabelText("Settings sections")).getByRole("button", {
        name: /GitHub 서버/
      })
    );

    const section = await screen.findByLabelText("GitHub servers");
    const naver = within(section).getByRole("radio", {
      name: "네이버 — https://oss.navercorp.com/api/v3"
    });
    const github = within(section).getByRole("radio", {
      name: "Github — https://api.github.com"
    });
    expect(naver).toBeChecked();
    expect(
      within(section).getByRole("button", { name: "Login to Github" })
    ).toBeInTheDocument();

    await user.click(github);

    expect(github).toBeChecked();
    expect(
      within(section).getByText("서버를 변경했습니다. 새 서버로 다시 로그인하세요.")
    ).toBeInTheDocument();
    expect(
      window.localStorage.getItem("yonalist.github.apiBaseUrl.v1")
    ).toBe("https://api.github.com");
  });

  it("adds a custom GHE server with a personal token", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      within(await screen.findByLabelText("Settings sections")).getByRole("button", {
        name: /GitHub 서버/
      })
    );

    const section = await screen.findByLabelText("GitHub servers");
    await user.click(within(section).getByRole("button", { name: /URL 추가/ }));

    await user.type(
      within(section).getByLabelText("API Base URL"),
      "https://ghe.example.com/api/v3"
    );
    await user.type(within(section).getByLabelText("별칭"), "사내 GHE");
    await user.click(within(section).getByRole("radio", { name: "개인 토큰" }));
    await user.type(
      within(section).getByLabelText("Personal Access Token"),
      "ghp_test_token"
    );
    await user.click(within(section).getByRole("button", { name: "추가" }));

    expect(
      within(section).getByRole("radio", {
        name: "사내 GHE — https://ghe.example.com/api/v3"
      })
    ).toBeInTheDocument();
    expect(
      window.localStorage.getItem("yonalist.github.personalTokens.v1")
    ).toContain("ghp_test_token");

    // Selecting the token-backed server signs in without the OAuth flow.
    await user.click(
      within(section).getByRole("radio", {
        name: "사내 GHE — https://ghe.example.com/api/v3"
      })
    );
    expect(within(section).getByText("개인 토큰으로 인증됨")).toBeInTheDocument();
  });

  it("loads work items and owner-grouped projects from GitHub when signed in", async () => {
    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "ghp_test" })
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/search/issues")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                number: 101,
                title: "Real fetched issue",
                state: "open",
                body: "from the API",
                user: { login: "doortts" },
                labels: [],
                created_at: "2026-07-01T00:00:00Z",
                updated_at: "2026-07-02T00:00:00Z",
                repository_url: "https://oss.navercorp.com/api/v3/repos/acme/app"
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (target.includes("/api/graphql")) {
        return new Response(JSON.stringify({ data: { search: { nodes: [] } } }), {
          status: 200
        });
      }
      if (target.includes("/user/repos")) {
        return new Response(
          JSON.stringify([
            {
              name: "app",
              full_name: "acme/app",
              owner: { login: "acme" },
              open_issues_count: 3,
              pushed_at: "2026-07-01T00:00:00Z"
            }
          ]),
          { status: 200 }
        );
      }
      if (target.includes("/user/subscriptions")) {
        return new Response("[]", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const user = userEvent.setup();
      render(<App />);

      await user.click(screen.getByRole("button", { name: /^All items/ }));
      const list = screen.getByLabelText("Items");
      expect(await within(list).findByText("Real fetched issue")).toBeInTheDocument();

      const navigation = screen.getByLabelText("Navigation");
      expect(await within(navigation).findByText("acme")).toBeInTheDocument();
      expect(
        within(navigation).getByRole("button", { name: /^app/ })
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Design offline issue reading")
      ).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deduplicates a fetched item that already exists in the local vault with a different path root", async () => {
    const title = "2026-05-19 AI Engineering : 10장 AI 엔지니어링 아키텍처와 사용자 피드백";
    const storedDiscussion: ItemFrontMatter = {
      kind: "discussion",
      host: "oss.navercorp.com",
      owner: "pi",
      repo: "agent-dev",
      number: 50,
      title,
      state: "open",
      author: "sw-codex",
      labels: [],
      created_at: "2026-05-19T00:00:00Z",
      updated_at: "2026-05-19T00:00:00Z",
      html_url: "https://oss.navercorp.com/pi/agent-dev/discussions/50",
      local: { favorite: false },
      sync: { status: "synced" }
    };
    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "ghp_test" })
    );
    window.localStorage.setItem(
      "yonalist.vaultDocuments.v1",
      JSON.stringify({
        "~/Yonalist": {
          "oss.navercorp.com/pi/agent-dev/discussions/50/discussion.md":
            serializeMarkdownDocument(storedDiscussion, "Stored discussion body")
        }
      })
    );

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/search/issues")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (target.includes("/api/graphql")) {
        return new Response(
          JSON.stringify({
            data: {
              search: {
                nodes: [
                  {
                    number: 50,
                    title,
                    body: "Fetched discussion body",
                    url: "https://oss.navercorp.com/pi/agent-dev/discussions/50",
                    closed: false,
                    createdAt: "2026-05-19T00:00:00Z",
                    updatedAt: "2026-05-19T00:00:00Z",
                    author: { login: "sw-codex" },
                    repository: {
                      name: "agent-dev",
                      owner: { login: "pi" }
                    },
                    labels: { nodes: [] }
                  }
                ]
              }
            }
          }),
          { status: 200 }
        );
      }
      if (target.includes("/user/repos")) {
        return new Response(
          JSON.stringify([
            {
              name: "agent-dev",
              full_name: "pi/agent-dev",
              owner: { login: "pi" },
              open_issues_count: 1,
              pushed_at: "2026-05-19T00:00:00Z"
            }
          ]),
          { status: 200 }
        );
      }
      if (target.includes("/user/subscriptions") || target.includes("/notifications")) {
        return new Response("[]", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const user = userEvent.setup();
      render(<App />);

      await user.click(screen.getByRole("button", { name: /^Discussions/ }));
      const list = screen.getByLabelText("Items");

      await waitFor(() => {
        expect(within(list).getAllByText(title)).toHaveLength(1);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("filters the list with the Discussions tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^Discussions/ }));

    const list = screen.getByLabelText("Items");
    expect(
      within(list).getByText("v0.1.0 packaging checklist")
    ).toBeInTheDocument();
    expect(
      within(list).queryByText("Design offline issue reading")
    ).not.toBeInTheDocument();
  });

  it("switches the item list between opened and closed items", async () => {
    const closedIssue: ItemFrontMatter = {
      kind: "issue",
      host: "github.com",
      owner: "doortts",
      repo: "blog",
      number: 44,
      title: "Closed local issue",
      state: "closed",
      author: "mona",
      labels: [],
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-02T00:00:00Z",
      local: { favorite: false },
      sync: { status: "synced" }
    };
    window.localStorage.setItem(
      "yonalist.vaultDocuments.v1",
      JSON.stringify({
        "~/Yonalist": {
          "github.com/doortts/blog/issues/44/issue.md":
            serializeMarkdownDocument(closedIssue, "Already handled.")
        }
      })
    );

    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));

    const list = screen.getByLabelText("Items");
    expect(within(list).getByRole("button", { name: "Opened" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(within(list).queryByText("Closed local issue")).not.toBeInTheDocument();

    await user.click(within(list).getByRole("button", { name: "Closed" }));

    expect(within(list).getByRole("button", { name: "Closed" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(await within(list).findByText("Closed local issue")).toBeInTheDocument();
    expect(
      within(list).queryByText("Design offline issue reading")
    ).not.toBeInTheDocument();
  });

  it("groups projects by owner and scopes the list to a repository", async () => {
    const user = userEvent.setup();
    render(<App />);

    const navigation = screen.getByLabelText("Navigation");
    expect(within(navigation).getByText("doortts")).toBeInTheDocument();
    expect(within(navigation).getByText("Yona-projects")).toBeInTheDocument();

    await user.click(within(navigation).getByRole("button", { name: /^blog/ }));

    const list = screen.getByLabelText("Items");
    expect(within(list).getByText("Refresh publishing notes")).toBeInTheDocument();
    expect(
      within(list).getByText("v0.1.0 packaging checklist")
    ).toBeInTheDocument();
    expect(
      within(list).queryByText("Design offline issue reading")
    ).not.toBeInTheDocument();
  });

  it("shows a project when selected even if another item-type filter was active", async () => {
    const user = userEvent.setup();
    render(<App />);

    const navigation = screen.getByLabelText("Navigation");
    await user.click(within(navigation).getByRole("button", { name: /^Issues/ }));
    await user.click(within(navigation).getByRole("button", { name: /^blog/ }));

    expect(
      within(navigation).getByRole("button", { name: /^All items/ })
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(navigation).getByRole("button", { name: /^Issues/ })
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(navigation).getByRole("button", { name: /^blog/ })
    ).toHaveAttribute("aria-pressed", "true");

    const list = screen.getByLabelText("Items");
    expect(within(list).getByText("Refresh publishing notes")).toBeInTheDocument();
    expect(
      within(list).getByText("v0.1.0 packaging checklist")
    ).toBeInTheDocument();
    expect(within(list).queryByText("No items match this view.")).not.toBeInTheDocument();
  });

  it("switches from a project collection back to an inbox collection", async () => {
    const user = userEvent.setup();
    render(<App />);

    const navigation = screen.getByLabelText("Navigation");
    await user.click(within(navigation).getByRole("button", { name: /^blog/ }));
    expect(
      within(navigation).getByRole("button", { name: /^blog/ })
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(within(navigation).getByRole("button", { name: /^Issues/ }));

    expect(
      within(navigation).getByRole("button", { name: /^blog/ })
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(navigation).getByRole("button", { name: /^Issues/ })
    ).toHaveAttribute("aria-pressed", "true");

    const list = screen.getByLabelText("Items");
    expect(within(list).getByText("Design offline issue reading")).toBeInTheDocument();
    expect(
      within(list).queryByText("v0.1.0 packaging checklist")
    ).not.toBeInTheDocument();
  });

  it("keeps the selected project active when clicked again", async () => {
    const user = userEvent.setup();
    render(<App />);

    const navigation = screen.getByLabelText("Navigation");
    const project = within(navigation).getByRole("button", { name: /^blog/ });
    await user.click(project);
    await user.click(project);

    expect(project).toHaveAttribute("aria-pressed", "true");
    expect(
      within(navigation).getByRole("button", { name: /^All items/ })
    ).toHaveAttribute("aria-pressed", "false");

    const list = screen.getByLabelText("Items");
    expect(within(list).getByText("Refresh publishing notes")).toBeInTheDocument();
    expect(
      within(list).getByText("v0.1.0 packaging checklist")
    ).toBeInTheDocument();
  });

  it("hides a project from the sidebar when unchecked in settings", async () => {
    const user = userEvent.setup();
    render(<App />);

    const navigation = screen.getByLabelText("Navigation");
    expect(
      within(navigation).getByRole("button", { name: /^blog/ })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      within(await screen.findByLabelText("Settings sections")).getByRole("button", {
        name: /Projects 표시/
      })
    );
    const section = await screen.findByLabelText("Project visibility");
    await user.click(
      within(section).getByRole("checkbox", { name: "Show doortts/blog" })
    );

    expect(
      within(navigation).queryByRole("button", { name: /^blog/ })
    ).not.toBeInTheDocument();
    expect(
      window.localStorage.getItem("yonalist.projectVisibility.v1")
    ).toContain('"doortts/blog":false');

    // Owner checkbox restores the whole group.
    await user.click(
      within(section).getByRole("checkbox", { name: "Show doortts projects" })
    );
    expect(
      within(navigation).getByRole("button", { name: /^blog/ })
    ).toBeInTheDocument();
  });

  it("filters the project visibility list by owner or repository name", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      within(await screen.findByLabelText("Settings sections")).getByRole("button", {
        name: /Projects 표시/
      })
    );
    const section = await screen.findByLabelText("Project visibility");

    await user.type(within(section).getByLabelText("Filter projects"), "Home");

    expect(
      within(section).getByRole("checkbox", { name: "Show Yona-projects/Home" })
    ).toBeInTheDocument();
    expect(
      within(section).queryByRole("checkbox", { name: "Show doortts/blog" })
    ).not.toBeInTheDocument();

    await user.clear(within(section).getByLabelText("Filter projects"));
    await user.type(within(section).getByLabelText("Filter projects"), "doortts");

    expect(
      within(section).getByRole("checkbox", { name: "Show doortts/blog" })
    ).toBeInTheDocument();
  });

  it("filters notifications by the project visibility selection", async () => {
    const user = userEvent.setup();
    render(<App />);

    // Landing notifications include doortts/blog items initially.
    const pane = screen.getByLabelText("Notifications");
    expect(
      within(pane).getByText("Refresh publishing notes")
    ).toBeInTheDocument();

    // Uncheck doortts/blog in Settings → Projects 표시.
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      within(await screen.findByLabelText("Settings sections")).getByRole("button", {
        name: /Projects 표시/
      })
    );
    await user.click(
      within(await screen.findByLabelText("Project visibility")).getByRole("checkbox", {
        name: "Show doortts/blog"
      })
    );

    await user.click(screen.getByRole("button", { name: /^Notifications/ }));

    const filtered = screen.getByLabelText("Notifications");
    expect(
      within(filtered).queryByText("Refresh publishing notes")
    ).not.toBeInTheDocument();
    expect(
      within(filtered).queryByText("v0.1.0 packaging checklist")
    ).not.toBeInTheDocument();
    expect(
      within(filtered).getByText("Design offline issue reading")
    ).toBeInTheDocument();
  });

  it("shows grouped sample notifications and hides one on demand", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^Notifications/ }));

    const pane = screen.getByLabelText("Notifications");
    expect(within(pane).getByText("Today")).toBeInTheDocument();
    expect(
      within(pane).getByText("Design offline issue reading")
    ).toBeInTheDocument();

    const hideButtons = within(pane).getAllByRole("button", {
      name: "Hide notification"
    });
    await user.click(hideButtons[0]);

    expect(
      within(pane).queryByText("Design offline issue reading")
    ).not.toBeInTheDocument();

    await user.click(within(pane).getByLabelText("Show hidden notifications"));

    expect(
      within(pane).getByText("Design offline issue reading")
    ).toBeInTheDocument();
  });

  it("shows the selected notification's conversation in the detail pane", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^Notifications/ }));

    const detailPane = screen.getByLabelText("Detail");
    expect(
      within(detailPane).getByLabelText("Empty notification detail")
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Design offline issue reading/ })
    );

    expect(
      within(detailPane).getByRole("heading", {
        name: "Design offline issue reading"
      })
    ).toBeInTheDocument();
    expect(
      within(detailPane).getByText(/Offline-first reading keeps GitHub work/)
    ).toBeInTheDocument();
    expect(
      within(detailPane).getByText(
        /Sample reply so the conversation thread layout is visible offline/
      )
    ).toBeInTheDocument();
  });

  it("switches themes from the settings page and persists the choice", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("radio", { name: "Dark theme" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("yonalist.themeMode.v1")).toBe("dark");

    await user.click(screen.getByRole("radio", { name: "Light theme" }));

    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("resizes panes from the column separators", () => {
    render(<App />);

    const layout = screen.getByLabelText("Yonalist layout");
    const navigationResizer = screen.getByRole("separator", {
      name: "Resize navigation pane"
    });
    const listResizer = screen.getByRole("separator", {
      name: "Resize item list pane"
    });

    fireEvent.pointerDown(navigationResizer, { clientX: 280, button: 0 });
    fireEvent.pointerMove(window, { clientX: 340 });
    fireEvent.pointerUp(window);

    expect(layout).toHaveStyle("--sidebar-width: 340px");
    expect(window.localStorage.getItem("yonalist.paneWidths.v1")).toContain(
      '"sidebar":340'
    );

    fireEvent.pointerDown(listResizer, { clientX: 700, button: 0 });
    fireEvent.pointerMove(window, { clientX: 540 });
    fireEvent.pointerUp(window);

    expect(layout).toHaveStyle("--list-width: 320px");
  });
});
