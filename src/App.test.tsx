import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notificationDetailInputs = vi.hoisted(() => vi.fn());
const loadVaultStateOverride = vi.hoisted(() => vi.fn());

vi.mock("./hooks/useNotificationDetail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hooks/useNotificationDetail")>();
  return {
    ...actual,
    useNotificationDetail: (...args: Parameters<typeof actual.useNotificationDetail>) => {
      notificationDetailInputs(args[0]);
      return actual.useNotificationDetail(...args);
    }
  };
});

vi.mock("./services/vaultStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./services/vaultStore")>();
  return {
    ...actual,
    loadVaultState: (...args: Parameters<typeof actual.loadVaultState>) => {
      const override = loadVaultStateOverride.getMockImplementation();
      return override ? override(...args) : actual.loadVaultState(...args);
    }
  };
});

import App from "./App";
import { serializeMarkdownDocument } from "./domain/markdown";
import type { NoteNode, UpdateNoteNodeInput } from "./domain/notes";
import type { ItemFrontMatter } from "./domain/types";
import { clearWorkItemsCache } from "./hooks/useWorkItems";
import { activeFeatureStorageKey } from "./features/core/featureSelection";
import { notesFeature } from "./features/notes/NotesFeature";
import { notesStore } from "./services/notesStore";
import { clearDetailRenderSnapshots } from "./services/detailRenderCache";
import { clearNotificationDetailCache } from "./services/notificationDetail";
import { clearNotificationCache } from "./services/notifications";
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

function appTestNote(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
    parentId: null,
    sortKey: 1024,
    title: "",
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("Yonalist app shell", () => {
  beforeEach(() => {
    installLocalStorageMock();
    notificationDetailInputs.mockClear();
    loadVaultStateOverride.mockReset();
    clearWorkItemsCache();
    clearDetailRenderSnapshots();
    clearNotificationCache();
    clearNotificationDetailCache();
    // Existing shell tests assume the app is past the startup login gate.
    window.localStorage.setItem("yonalist.auth.skipLogin.v1", "true");
  });

  it("starts on the login page on first run and can skip into demo mode", async () => {
    window.localStorage.removeItem("yonalist.auth.skipLogin.v1");
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByLabelText("Restoring GitHub session")).toBeInTheDocument();
    expect(screen.queryByLabelText("GitHub login")).not.toBeInTheDocument();

    const login = await screen.findByLabelText("GitHub login");
    expect(within(login).getByText("GitHub 로그인")).toBeInTheDocument();
    // The gate checks the persisted session store before settling on
    // "required", so the server picker appears asynchronously.
    expect(await within(login).findByLabelText("GitHub servers")).toBeInTheDocument();
    expect(screen.queryByLabelText("Navigation")).not.toBeInTheDocument();

    await user.click(
      within(login).getByRole("button", { name: /샘플 데이터로 둘러보기/ })
    );

    expect(screen.getByLabelText("Navigation")).toBeInTheDocument();
    expect(window.localStorage.getItem("yonalist.auth.skipLogin.v1")).toBe("true");
  });

  it("opens Notes immediately while startup auth restoration keeps running", () => {
    window.localStorage.removeItem("yonalist.auth.skipLogin.v1");
    vi.mocked(window.localStorage.setItem).mockClear();
    render(<App />);

    const restore = screen.getByLabelText("Restoring GitHub session");
    fireEvent.click(within(restore).getByRole("button", { name: "Notes" }));

    expect(screen.getByLabelText("Notes library")).toBeInTheDocument();
    expect(window.localStorage.getItem("yonalist.auth.skipLogin.v1")).toBeNull();
    expect(window.localStorage.setItem).not.toHaveBeenCalledWith(
      "yonalist.auth.skipLogin.v1",
      expect.anything()
    );
  });

  it("opens Notes without a GitHub session or persisting skip-login", async () => {
    window.localStorage.removeItem("yonalist.auth.skipLogin.v1");
    const user = userEvent.setup();
    render(<App />);

    const login = await screen.findByLabelText("GitHub login");
    await user.click(within(login).getByRole("button", { name: "Notes" }));

    expect(screen.getByLabelText("Notes library")).toBeInTheDocument();
    expect(window.localStorage.getItem("yonalist.auth.skipLogin.v1")).toBeNull();

    await user.click(screen.getByRole("button", { name: "GitHub Inbox" }));

    expect(await screen.findByLabelText("GitHub login")).toBeInTheDocument();
    expect(window.localStorage.getItem("yonalist.auth.skipLogin.v1")).toBeNull();
  });

  it("continues to edit Notes while offline and unsigned in", async () => {
    window.localStorage.removeItem("yonalist.auth.skipLogin.v1");
    vi.spyOn(notesStore, "initialize").mockResolvedValue(undefined);
    vi.spyOn(notesStore, "loadWorkspace").mockResolvedValue({
      nodes: [appTestNote({ id: "offline-note", title: "Offline note" })]
    });
    const updateNodeSpy = vi
      .spyOn(notesStore, "updateNode")
      .mockImplementation(async (_vaultPath: string, input: UpdateNoteNodeInput) => {
        return {
          nodes: [
            appTestNote({
              id: input.id,
              title: input.title ?? "",
              note: input.note ?? ""
            })
          ]
        };
      });
    const fetchMock = vi.fn(async () => {
      throw new Error("Network access is forbidden in local Notes");
    });
    vi.stubGlobal("fetch", fetchMock);
    let rendered: ReturnType<typeof render> | null = null;

    try {
      const user = userEvent.setup();
      rendered = render(<App initialOnline={false} />);

      const login = await screen.findByLabelText("GitHub login");
      await user.click(within(login).getByRole("button", { name: "Notes" }));
      expect(screen.getByLabelText("Notes outline")).toBeInTheDocument();

      const presentation = await screen.findByRole("group", {
        name: "Edit node title"
      });
      const mountedTitle = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Edit node title"]'
      );
      expect(presentation).toHaveAttribute("tabindex", "0");
      expect(
        screen.queryByRole("textbox", { name: "Edit node title" })
      ).not.toBeInTheDocument();
      expect(mountedTitle).toHaveAttribute("aria-hidden", "true");
      expect(mountedTitle).toHaveAttribute("tabindex", "-1");

      await user.click(presentation);

      const title = await screen.findByRole("textbox", {
        name: "Edit node title"
      });
      expect(title).toBe(mountedTitle);
      expect(title).toHaveFocus();
      expect(presentation).toHaveAttribute("aria-hidden", "true");
      await user.clear(title);
      await user.type(title, "Edited offline");
      fireEvent.blur(title);

      expect(title).toHaveValue("Edited offline");
      await waitFor(() =>
        expect(updateNodeSpy).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ title: "Edited offline" }),
          expect.any(Object)
        )
      );
      expect(window.localStorage.getItem("yonalist.auth.skipLogin.v1")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      rendered?.unmount();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("persists a selected Notes feature", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Notes" }));

    expect(window.localStorage.getItem(activeFeatureStorageKey)).toBe("notes");
  });

  it("keeps Inbox filter state when returning from Notes", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));
    const search = within(screen.getByLabelText("Items")).getByRole("textbox", {
      name: "Search"
    });
    await user.type(search, "Design");

    await user.click(screen.getByRole("button", { name: "Notes" }));

    expect(screen.getByLabelText("Notes library")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notes" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(
      screen.queryByRole("button", { name: /^All items/ })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Notifications/ })).not.toHaveClass(
      "active"
    );

    await user.click(screen.getByRole("button", { name: "GitHub Inbox" }));

    expect(screen.getByRole("textbox", { name: "Search" })).toHaveValue("Design");
  });

  it("restores the selected notification after visiting Notes", async () => {
    const user = userEvent.setup();
    render(<App />);

    const notification = screen.getByRole("button", {
      name: /Design offline issue reading/
    });
    await user.click(notification);
    expect(
      within(screen.getByLabelText("Detail")).getByRole("heading", {
        name: "Design offline issue reading"
      })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Notes" }));
    expect(screen.getByLabelText("Notes library")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Notifications/ }));

    expect(
      await within(screen.getByLabelText("Detail")).findByRole("heading", {
        name: "Design offline issue reading"
      })
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: /Design offline issue reading/ })
        .closest(".notification-row")
    ).toHaveClass("selected");
  });

  it("mounts the active feature Provider around both resolved panes", () => {
    const OriginalProvider = notesFeature.Provider;
    notesFeature.Provider = ({ children }) => (
      <div aria-label="Notes feature provider sentinel">
        <OriginalProvider>{children}</OriginalProvider>
      </div>
    );
    window.localStorage.setItem(activeFeatureStorageKey, "notes");

    try {
      render(<App />);

      const provider = screen.getByLabelText("Notes feature provider sentinel");
      expect(within(provider).getByLabelText("Notes library")).toBeInTheDocument();
      expect(within(provider).getByLabelText("Notes outline")).toBeInTheDocument();
    } finally {
      notesFeature.Provider = OriginalProvider;
    }
  });

  it("keeps the Notes workspace session alive across feature switches", async () => {
    const user = userEvent.setup();
    const initializeSpy = vi
      .spyOn(notesStore, "initialize")
      .mockResolvedValue(undefined);
    const loadWorkspaceSpy = vi
      .spyOn(notesStore, "loadWorkspace")
      .mockResolvedValue({
        nodes: [appTestNote({ id: "kept-note", title: "Kept alive" })]
      });
    window.localStorage.setItem(activeFeatureStorageKey, "notes");

    render(<App />);

    // Let the workspace session settle so the baseline reflects a single
    // initialize/load for the freshly mounted Notes feature.
    expect(await screen.findByLabelText("Notes library")).toBeInTheDocument();
    await waitFor(() => expect(initializeSpy).toHaveBeenCalledTimes(1));
    const loadsAfterMount = loadWorkspaceSpy.mock.calls.length;
    expect(loadsAfterMount).toBeGreaterThan(0);

    // Navigate away to Inbox and back to Notes.
    await user.click(screen.getByRole("button", { name: "GitHub Inbox" }));
    expect(screen.getByLabelText("Items")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Notes" }));
    expect(screen.getByLabelText("Notes library")).toBeInTheDocument();

    // The provider was never torn down, so the session is not re-created: no
    // extra initialize and no extra active-scope reload from the round-trip.
    await act(async () => {
      await Promise.resolve();
    });
    expect(initializeSpy).toHaveBeenCalledTimes(1);
    expect(loadWorkspaceSpy.mock.calls.length).toBe(loadsAfterMount);
  });

  it("keeps the inactive Notes panes mounted but hidden", async () => {
    const user = userEvent.setup();
    vi.spyOn(notesStore, "initialize").mockResolvedValue(undefined);
    vi.spyOn(notesStore, "loadWorkspace").mockResolvedValue({ nodes: [] });
    window.localStorage.setItem(activeFeatureStorageKey, "notes");

    render(<App />);
    expect(await screen.findByLabelText("Notes library")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "GitHub Inbox" }));

    // Inbox is now the visible feature.
    expect(screen.getByLabelText("Items")).toBeInTheDocument();

    // The Notes panes remain in the tree (getByLabelText ignores visibility)
    // but are wrapped in a `hidden` slot, so they leave the accessibility tree
    // and the grid flow.
    const hiddenLibrary = screen.getByLabelText("Notes library");
    expect(hiddenLibrary).toBeInTheDocument();
    expect(hiddenLibrary.closest(".feature-pane-slot")).toHaveAttribute("hidden");
    expect(screen.getByLabelText("Notes outline").closest(".feature-pane-slot")).toHaveAttribute(
      "hidden"
    );
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

  it("restores a persisted OAuth session on restart without asking to log in", async () => {
    window.localStorage.removeItem("yonalist.auth.skipLogin.v1");
    // A previous run signed in via OAuth and persisted the session token.
    window.localStorage.setItem(
      "yonalist.github.sessionTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "gho_persisted" })
    );
    window.localStorage.setItem(
      "yonalist.github.lastAuthenticatedUrl.v1",
      "https://oss.navercorp.com/api/v3"
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/user")) {
        return new Response(JSON.stringify({ login: "doortts" }), { status: 200 });
      }
      if (String(url).includes("/search/issues")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (String(url).includes("/api/graphql")) {
        return new Response(JSON.stringify({ data: { search: { nodes: [] } } }), {
          status: 200
        });
      }
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App />);

      // Straight into the app — no login page.
      expect(await screen.findByLabelText("Navigation")).toBeInTheDocument();
      expect(screen.queryByLabelText("GitHub login")).not.toBeInTheDocument();

      // Data requests carry the restored session token.
      await waitFor(() => {
        const notificationCall = fetchMock.mock.calls.find(([url]) =>
          String(url).includes("/notifications")
        );
        expect(notificationCall).toBeTruthy();
        const init = (notificationCall as unknown[])?.[1] as RequestInit;
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer gho_persisted");
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps Inbox background work paused while restored Notes is active", async () => {
    window.localStorage.removeItem("yonalist.auth.skipLogin.v1");
    window.localStorage.setItem(activeFeatureStorageKey, "notes");
    window.localStorage.setItem(
      "yonalist.github.sessionTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "gho_persisted" })
    );
    window.localStorage.setItem(
      "yonalist.github.lastAuthenticatedUrl.v1",
      "https://oss.navercorp.com/api/v3"
    );
    vi.mocked(window.localStorage.getItem).mockClear();
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/user")) {
        return new Response(JSON.stringify({ login: "doortts" }), { status: 200 });
      }
      if (target.includes("/search/issues")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (target.includes("/api/graphql")) {
        return new Response(JSON.stringify({ data: { search: { nodes: [] } } }), {
          status: 200
        });
      }
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const user = userEvent.setup();
      render(<App />);

      expect(await screen.findByLabelText("Notes library")).toBeInTheDocument();
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "https://oss.navercorp.com/api/v3/user",
          expect.anything()
        )
      );
      await act(async () => Promise.resolve());

      const backgroundTargets = fetchMock.mock.calls.map(([url]) => String(url));
      expect(backgroundTargets.some((url) => url.includes("/search/issues"))).toBe(
        false
      );
      expect(backgroundTargets.some((url) => url.includes("/notifications"))).toBe(
        false
      );
      expect(backgroundTargets.some((url) => url.includes("/user/repos"))).toBe(false);
      expect(window.localStorage.getItem).not.toHaveBeenCalledWith(
        "yonalist.vaultDocuments.v1"
      );

      await user.click(screen.getByRole("button", { name: "GitHub Inbox" }));

      await waitFor(() => {
        const resumedTargets = fetchMock.mock.calls.map(([url]) => String(url));
        expect(resumedTargets.some((url) => url.includes("/search/issues"))).toBe(true);
        expect(resumedTargets.some((url) => url.includes("/notifications"))).toBe(true);
        expect(resumedTargets.some((url) => url.includes("/user/repos"))).toBe(true);
        expect(window.localStorage.getItem).toHaveBeenCalledWith(
          "yonalist.vaultDocuments.v1"
        );
      });
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

  it("lands on the notifications view after passing the gate", async () => {
    render(<App />);

    expect(screen.getByLabelText("Notifications")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Empty notification detail")
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Items")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(window.localStorage.getItem(activeFeatureStorageKey)).toBe("inbox");
    });
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
      within(await screen.findByLabelText("Settings sections")).getByRole("tab", {
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

  it("keeps the app shell mounted when an active signed-in session goes offline", async () => {
    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "ghp_test" })
    );
    window.localStorage.setItem(
      "yonalist.github.lastAuthenticatedUrl.v1",
      "https://oss.navercorp.com/api/v3"
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/user")) {
        return new Response(JSON.stringify({ login: "doortts" }), { status: 200 });
      }
      if (target.includes("/notifications")) {
        return new Response(JSON.stringify([]), { status: 200 });
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
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(
        <React.StrictMode>
          <App initialOnline />
        </React.StrictMode>
      );

      const navigation = await screen.findByLabelText("Navigation");

      fireEvent(window, new Event("offline"));

      await waitFor(() => {
        expect(within(navigation).getByText("Offline")).toBeInTheDocument();
      });
      expect(screen.queryByText(/Yonalist failed to start/)).not.toBeInTheDocument();
      expect(screen.getByLabelText("Yonalist layout")).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
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
    window.localStorage.setItem(
      "yonalist.github.lastAuthenticatedUrl.v1",
      "https://oss.navercorp.com/api/v3"
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

  it("collapses and expands the sidebar pane, zeroing its grid width", async () => {
    const user = userEvent.setup();
    render(<App />);

    const shell = await screen.findByLabelText("Yonalist layout");
    const sidebarToggle = screen.getByRole("button", {
      name: "사이드바 접기/펼치기"
    });

    expect(shell).not.toHaveAttribute("data-sidebar-collapsed");
    expect(sidebarToggle).toHaveAttribute("aria-pressed", "false");
    expect(sidebarToggle.querySelector("svg")).toHaveAttribute(
      "data-pane-icon",
      "sidebar-collapse"
    );
    expect(shell.style.getPropertyValue("--sidebar-width")).toBe("240px");

    await user.click(sidebarToggle);

    expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
    expect(sidebarToggle).toHaveAttribute("aria-pressed", "true");
    expect(sidebarToggle.querySelector("svg")).toHaveAttribute(
      "data-pane-icon",
      "sidebar-open"
    );
    expect(sidebarToggle.querySelector("svg path")).toHaveAttribute(
      "d",
      "M16 7v10"
    );
    expect(shell.style.getPropertyValue("--sidebar-width")).toBe("0px");

    await user.click(sidebarToggle);

    expect(shell).not.toHaveAttribute("data-sidebar-collapsed");
    expect(sidebarToggle).toHaveAttribute("aria-pressed", "false");
    // Expanding restores the previous width rather than a hard-coded default.
    expect(shell.style.getPropertyValue("--sidebar-width")).toBe("240px");
  });

  it("anchors the sidebar toggle to the sidebar edge, then to the frontmost pane", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByLabelText("Yonalist layout");
    const paneGroup = screen.getByRole("group", { name: "Pane layout" });
    const sidebarToggle = screen.getByRole("button", {
      name: "사이드바 접기/펼치기"
    });

    // Sidebar open: tucked inside the sidebar's right edge (its width, minus an
    // inset), well clear of the macOS traffic lights.
    expect(paneGroup).toHaveAttribute("data-position", "sidebar-end");
    expect(paneGroup.style.left).toContain("var(--sidebar-width");

    await user.click(sidebarToggle);

    // Sidebar collapsed: the pane is gone, so the toggle rides the right edge
    // of the now-frontmost pane, while keeping a traffic-light-safe fallback.
    expect(paneGroup).toHaveAttribute("data-position", "pane-start");
    expect(paneGroup.style.left).toContain("var(--list-width");
    expect(paneGroup.style.left).not.toBe("78px");
  });

  it("puts a detail maximize toggle in its own right-aligned group", () => {
    render(<App />);

    const detailGroup = screen.getByRole("group", { name: "Detail layout" });
    expect(
      within(detailGroup).getByRole("button", { name: "상세 최대화" })
    ).toBeInTheDocument();
    // Anchored to the right edge of the window (the detail pane's right side).
    expect(detailGroup.style.right).toBe("12px");
    // The standalone list toggle is gone — collapsing the list is now folded
    // into the maximize action.
    expect(
      screen.queryByRole("button", { name: "목록 접기/펼치기" })
    ).not.toBeInTheDocument();
  });

  it("maximizes the detail pane by collapsing both siblings and back again", async () => {
    const user = userEvent.setup();
    render(<App />);

    const shell = await screen.findByLabelText("Yonalist layout");
    const maximizeToggle = screen.getByRole("button", { name: "상세 최대화" });

    expect(maximizeToggle).toHaveAttribute("aria-pressed", "false");
    expect(shell).not.toHaveAttribute("data-sidebar-collapsed");
    expect(shell).not.toHaveAttribute("data-list-collapsed");

    await user.click(maximizeToggle);

    expect(maximizeToggle).toHaveAttribute("aria-pressed", "true");
    expect(shell).toHaveAttribute("data-detail-maximized", "true");
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
    expect(shell).toHaveAttribute("data-list-collapsed", "true");
    expect(shell.style.getPropertyValue("--sidebar-width")).toBe("0px");
    expect(shell.style.getPropertyValue("--list-width")).toBe("0px");

    await user.click(maximizeToggle);

    expect(maximizeToggle).toHaveAttribute("aria-pressed", "false");
    expect(shell).not.toHaveAttribute("data-detail-maximized");
    expect(shell).not.toHaveAttribute("data-sidebar-collapsed");
    expect(shell).not.toHaveAttribute("data-list-collapsed");
    expect(shell.style.getPropertyValue("--sidebar-width")).toBe("240px");
    expect(shell.style.getPropertyValue("--list-width")).toBe("340px");
  });

  it("restores only the panes collapsed before the detail was maximized", async () => {
    const user = userEvent.setup();
    render(<App />);

    const shell = await screen.findByLabelText("Yonalist layout");
    const sidebarToggle = screen.getByRole("button", {
      name: "사이드바 접기/펼치기"
    });
    const maximizeToggle = screen.getByRole("button", { name: "상세 최대화" });

    // Pre-state: only the sidebar is collapsed.
    await user.click(sidebarToggle);
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
    expect(shell).not.toHaveAttribute("data-list-collapsed");

    // Maximizing hides both siblings.
    await user.click(maximizeToggle);
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
    expect(shell).toHaveAttribute("data-list-collapsed", "true");

    // Un-maximizing returns to the snapshot: sidebar still collapsed, list back.
    await user.click(maximizeToggle);
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
    expect(shell).not.toHaveAttribute("data-list-collapsed");
    expect(maximizeToggle).toHaveAttribute("aria-pressed", "false");
    expect(sidebarToggle).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps both pane toggles reachable while a pane is collapsed", async () => {
    const user = userEvent.setup();
    render(<App />);

    const sidebarToggle = await screen.findByRole("button", {
      name: "사이드바 접기/펼치기"
    });

    await user.click(sidebarToggle);

    // Even with the sidebar collapsed, both toggles remain in the document
    // (they live in the title bar, not inside the collapsed pane).
    expect(
      screen.getByRole("button", { name: "사이드바 접기/펼치기" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "상세 최대화" })
    ).toBeInTheDocument();

    // ...and the sidebar toggle can still be used to expand it again.
    await user.click(screen.getByRole("button", { name: "사이드바 접기/펼치기" }));
    expect(
      await screen.findByLabelText("Yonalist layout")
    ).not.toHaveAttribute("data-sidebar-collapsed");
  });

  it("restores the collapsed pane state after a reload", async () => {
    const user = userEvent.setup();
    const first = render(<App />);

    await screen.findByLabelText("Yonalist layout");
    // Maximizing the detail collapses both siblings, so their collapsed state
    // is what should persist across a reload.
    await user.click(screen.getByRole("button", { name: "상세 최대화" }));

    expect(window.localStorage.getItem("yonalist.paneCollapsed.v1")).toContain(
      "\"sidebar\":true"
    );
    expect(window.localStorage.getItem("yonalist.paneCollapsed.v1")).toContain(
      "\"list\":true"
    );

    // Simulate a fresh launch against the same persisted storage.
    first.unmount();
    render(<App />);

    const shell = await screen.findByLabelText("Yonalist layout");
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
    expect(shell).toHaveAttribute("data-list-collapsed", "true");
    expect(shell.style.getPropertyValue("--sidebar-width")).toBe("0px");
    expect(shell.style.getPropertyValue("--list-width")).toBe("0px");
    expect(
      screen.getByRole("button", { name: "사이드바 접기/펼치기" })
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps collapsed panes mounted in the grid flow instead of removing them", async () => {
    const user = userEvent.setup();
    render(<App />);

    const shell = await screen.findByLabelText("Yonalist layout");
    // Maximizing collapses both siblings in one action.
    await user.click(screen.getByRole("button", { name: "상세 최대화" }));

    expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
    expect(shell).toHaveAttribute("data-list-collapsed", "true");

    // Regression guard for the grid auto-placement bug: hiding a collapsed pane
    // with display:none pulled it out of the row's left-to-right auto-placement
    // flow, shifting the detail pane into the (zero-width) list column and
    // blanking the right edge. The panes must stay mounted so the surviving
    // columns keep their positions — the stylesheet now hides them with
    // visibility, not display:none or a conditional unmount. jsdom does not
    // resolve stylesheet rules, so we assert the panes remain in the document
    // and are never hidden via an inline display:none.
    const sidebar = shell.querySelector<HTMLElement>(".sidebar");
    const middlePane = shell.querySelector<HTMLElement>(".notifications-pane");
    const detailPane = shell.querySelector<HTMLElement>(".detail-pane");
    expect(sidebar).not.toBeNull();
    expect(middlePane).not.toBeNull();
    expect(detailPane).not.toBeNull();
    expect(sidebar?.style.display).not.toBe("none");
    expect(middlePane?.style.display).not.toBe("none");
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
    // The portalled tooltip stays mounted so aria-describedby resolves at rest.
    // Its visual state still opens only when the button is focused.
    expect(notificationOpen).not.toHaveAttribute("title");
    expect(notificationOpen.textContent).toBe("");
    const notificationTip = document.getElementById(
      notificationOpen.getAttribute("aria-describedby")!
    );
    expect(notificationTip).toHaveClass("tooltip-popup");
    expect(notificationTip).toHaveAttribute("data-closed");
    expect(notificationTip).toHaveTextContent("브라우저에서 열기");
    notificationOpen.focus();
    await waitFor(() => expect(notificationTip).toHaveAttribute("data-open"));

    // Item detail: the visible label now lives in a Base UI Tooltip popup, not
    // a native `title`; the accessible name is still carried by `aria-label`.
    await user.click(screen.getByRole("button", { name: /^All items/ }));
    const itemOpen = within(screen.getByLabelText("Detail")).getByRole("button", {
      name: "Open in browser"
    });
    expect(itemOpen).not.toHaveAttribute("title");
    expect(itemOpen.textContent).toBe("");
    const itemTip = document.getElementById(
      itemOpen.getAttribute("aria-describedby")!
    );
    expect(itemTip).toHaveClass("tooltip-popup");
    expect(itemTip).toHaveAttribute("data-closed");
    expect(itemTip).toHaveTextContent("브라우저에서 열기");
    itemOpen.focus();
    await waitFor(() => expect(itemTip).toHaveAttribute("data-open"));
  });

  it("shows the item state and its comment thread in the detail pane", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));

    const detail = screen.getByLabelText("Detail");
    expect(within(detail).getByText("Open")).toHaveClass("state-open");
    const comments = within(detail).getByLabelText("Comments");
    expect(
      await within(comments).findByText(/Sample reply so the conversation thread/)
    ).toBeInTheDocument();
    expect(within(detail).getByText(/댓글 2/)).toBeInTheDocument();
  });

  it("resets the detail pane scroll to the top when a different work item is selected", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));

    const detailScroll = container.querySelector<HTMLDivElement>(".detail-scroll");
    expect(detailScroll).not.toBeNull();
    const items = screen.getByLabelText("Items");

    await user.click(
      within(items).getByRole("button", { name: /Refresh publishing notes/ })
    );

    // jsdom performs no layout, but scrollTop is a real settable/readable
    // property here, so we can simulate the user having scrolled the detail
    // pane down before switching to another item.
    detailScroll!.scrollTop = 480;
    expect(detailScroll!.scrollTop).toBe(480);

    await user.click(
      within(items).getByRole("button", { name: /v0\.1\.0 packaging checklist/ })
    );

    expect(detailScroll!.scrollTop).toBe(0);
  });

  it("resets the detail pane scroll to the top when a different notification is selected", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);

    const detailScroll = container.querySelector<HTMLDivElement>(".detail-scroll");
    expect(detailScroll).not.toBeNull();

    // The notifications feed is the default landing view.
    await user.click(
      screen.getByRole("button", { name: /Design offline issue reading/ })
    );

    detailScroll!.scrollTop = 480;
    expect(detailScroll!.scrollTop).toBe(480);

    await user.click(
      screen.getByRole("button", { name: /Cache linked attachments in the vault/ })
    );

    expect(detailScroll!.scrollTop).toBe(0);
  });

  it("keeps the detail pane scroll position when the same work item is re-selected", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));

    const detailScroll = container.querySelector<HTMLDivElement>(".detail-scroll");
    expect(detailScroll).not.toBeNull();
    const items = screen.getByLabelText("Items");

    await user.click(
      within(items).getByRole("button", { name: /Refresh publishing notes/ })
    );

    detailScroll!.scrollTop = 480;
    // Re-clicking the already-selected item keeps the reset key unchanged, so
    // the effect must not fire and the scroll offset should be preserved.
    await user.click(
      within(items).getByRole("button", { name: /Refresh publishing notes/ })
    );

    expect(detailScroll!.scrollTop).toBe(480);
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

  it("queues a close-only issue action when the comment body is empty", async () => {
    const user = userEvent.setup();
    render(<App initialOnline={false} />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));
    await user.click(screen.getByLabelText("Write a comment"));
    await user.click(screen.getByRole("button", { name: "Queue and close" }));

    expect(
      screen.getByRole("button", { name: "Open outbox, 1 pending change" })
    ).toBeInTheDocument();
    expect(window.localStorage.getItem("yonalist.vaultDocuments.v1")).toContain(
      "close_after_comment"
    );
  });

  it("opens the target item when a queued outbox comment is clicked", async () => {
    const user = userEvent.setup();
    render(<App initialOnline={false} />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));
    await user.type(screen.getByLabelText("Write a comment"), "Return to this item.");
    await user.click(screen.getByRole("button", { name: "Queue comment" }));
    await user.click(screen.getByRole("button", { name: /^Notifications/ }));

    expect(screen.getByLabelText("Empty notification detail")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /outbox/i }));
    await user.click(screen.getByRole("button", { name: /Open target/ }));

    const detail = screen.getByLabelText("Detail");
    expect(within(detail).getByRole("heading", { name: "Design offline issue reading" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Outbox" })).not.toBeInTheDocument();
  });

  it("deletes a queued outbox comment from the queue and local draft storage", async () => {
    const user = userEvent.setup();
    render(<App initialOnline={false} />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));
    await user.type(screen.getByLabelText("Write a comment"), "Delete this queued draft.");
    await user.click(screen.getByRole("button", { name: "Queue comment" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("yonalist.vaultDocuments.v1")).toContain(
        "Delete this queued draft."
      );
    });

    await user.click(screen.getByRole("button", { name: /outbox/i }));
    const outboxDialog = screen.getByRole("dialog", { name: "Outbox" });
    await user.click(
      within(outboxDialog).getByRole("button", { name: /Delete create_comment/ })
    );

    await waitFor(() => {
      expect(within(outboxDialog).getByText("No queued changes.")).toBeInTheDocument();
    });
    expect(window.localStorage.getItem("yonalist.vaultDocuments.v1")).not.toContain(
      "Delete this queued draft."
    );
  });

  it("returns a queued outbox comment to its original composer for editing", async () => {
    const user = userEvent.setup();
    render(<App initialOnline={false} />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));
    await user.type(screen.getByLabelText("Write a comment"), "Edit before syncing.");
    await user.click(screen.getByRole("button", { name: "Queue comment" }));
    await user.click(screen.getByRole("button", { name: /^Notifications/ }));

    expect(screen.getByLabelText("Empty notification detail")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /outbox/i }));
    const outboxDialog = screen.getByRole("dialog", { name: "Outbox" });
    await user.click(
      within(outboxDialog).getByRole("button", { name: /Edit create_comment/ })
    );

    const detail = screen.getByLabelText("Detail");
    expect(
      within(detail).getByRole("heading", { name: "Design offline issue reading" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Outbox" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Write a comment")).toHaveValue(
      "Edit before syncing."
    );
    expect(window.localStorage.getItem("yonalist.vaultDocuments.v1")).not.toContain(
      "Edit before syncing."
    );
  });

  it("returns a queued issue draft to the new issue composer for editing", async () => {
    const user = userEvent.setup();
    render(<App initialOnline={false} />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));
    await user.click(screen.getByRole("button", { name: "New issue" }));
    await user.type(screen.getByLabelText("Issue title"), "Edit queued issue");
    await user.type(screen.getByLabelText("Issue body"), "Bring this draft back.");
    await user.click(screen.getByRole("button", { name: "Queue issue" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("yonalist.vaultDocuments.v1")).toContain(
        "Bring this draft back."
      );
    });

    await user.click(screen.getByRole("button", { name: /outbox/i }));
    const outboxDialog = screen.getByRole("dialog", { name: "Outbox" });
    await user.click(
      within(outboxDialog).getByRole("button", { name: /Edit create_issue/ })
    );

    expect(screen.getByLabelText("New issue composer")).toBeInTheDocument();
    expect(screen.getByLabelText("Issue title")).toHaveValue("Edit queued issue");
    expect(screen.getByLabelText("Issue body")).toHaveValue("Bring this draft back.");
    expect(screen.queryByRole("dialog", { name: "Outbox" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("yonalist.vaultDocuments.v1")).not.toContain(
      "Bring this draft back."
    );
  });

  it("loads a persisted queued issue body before returning it to the composer", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App initialOnline={false} />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));
    await user.click(screen.getByRole("button", { name: "New issue" }));
    await user.type(screen.getByLabelText("Issue title"), "Restarted queued issue");
    await user.type(screen.getByLabelText("Issue body"), "Persisted body survives.");
    await user.click(screen.getByRole("button", { name: "Queue issue" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("yonalist.vaultDocuments.v1")).toContain(
        "Persisted body survives."
      );
    });

    unmount();
    render(<App initialOnline={false} />);
    await user.click(screen.getByRole("button", { name: /^All items/ }));
    await user.click(screen.getByRole("button", { name: /outbox/i }));
    const outboxDialog = screen.getByRole("dialog", { name: "Outbox" });
    await user.click(
      within(outboxDialog).getByRole("button", { name: /Edit create_issue/ })
    );

    expect(screen.getByLabelText("New issue composer")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("Issue body")).toHaveValue(
        "Persisted body survives."
      );
    });
  });

  it("syncs a comment immediately when online and signed in", async () => {
    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "ghp_test" })
    );
    window.localStorage.setItem(
      "yonalist.github.lastAuthenticatedUrl.v1",
      "https://oss.navercorp.com/api/v3"
    );
    let postedCommentBody: string | null = null;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (
        target.endsWith("/repos/acme/app/issues/2/comments") &&
        init?.method === "POST"
      ) {
        postedCommentBody = JSON.parse(String(init.body)).body;
        return new Response(
          JSON.stringify({
            id: 9001,
            node_id: "IC_9001",
            body: postedCommentBody,
            html_url: "https://oss.navercorp.com/acme/app/issues/2#issuecomment-9001",
            created_at: "2026-07-07T01:00:00Z",
            updated_at: "2026-07-07T01:00:00Z"
          }),
          { status: 201 }
        );
      }
      if (target.includes("/search/issues")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                number: 2,
                title: "Online issue",
                state: "open",
                body: "Fetched from GitHub",
                user: { login: "alice" },
                labels: [],
                comments: 0,
                created_at: "2026-07-06T00:00:00Z",
                updated_at: "2026-07-06T01:00:00Z",
                html_url: "https://oss.navercorp.com/acme/app/issues/2",
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
      if (target.includes("/notifications")) {
        return new Response(
          JSON.stringify([
            {
              id: "notification-acme-app",
              unread: true,
              reason: "mention",
              updated_at: "2026-07-02T00:00:00Z",
              last_read_at: null,
              subject: {
                title: "Real fetched issue",
                type: "Issue",
                url: "https://oss.navercorp.com/api/v3/repos/acme/app/issues/101"
              },
              repository: {
                full_name: "acme/app",
                name: "app",
                owner: { login: "acme" }
              }
            }
          ]),
          { status: 200 }
        );
      }
      if (target.includes("/user/repos")) {
        return new Response(
          JSON.stringify([
            {
              name: "app",
              full_name: "acme/app",
              owner: { login: "acme" },
              open_issues_count: 1,
              pushed_at: "2026-07-06T00:00:00Z"
            }
          ]),
          { status: 200 }
        );
      }
      if (target.includes("/user/subscriptions") || target.includes("/notifications")) {
        return new Response("[]", { status: 200 });
      }
      if (target.includes("/issues/2/comments")) {
        return new Response(
          JSON.stringify(
            postedCommentBody
              ? [
                  {
                    id: 9001,
                    body: postedCommentBody,
                    user: { login: "alice", name: "Alice" },
                    author_association: "OWNER",
                    created_at: "2026-07-07T01:00:00Z",
                    updated_at: "2026-07-07T01:00:00Z"
                  }
                ]
              : []
          ),
          { status: 200 }
        );
      }
      if (target.endsWith("/repos/acme/app/issues/2")) {
        return new Response(
          JSON.stringify({
            state: "open",
            user: { login: "alice", name: "Alice" },
            labels: [],
            body: "Fetched from GitHub",
            created_at: "2026-07-06T00:00:00Z",
            updated_at: "2026-07-06T01:00:00Z"
          }),
          { status: 200 }
        );
      }
      if (target.includes("/users/alice")) {
        return new Response(
          JSON.stringify({ login: "alice", name: "Alice", avatar_url: "" }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const user = userEvent.setup();
      render(<App initialOnline />);

      await user.click(screen.getByRole("button", { name: /^All items/ }));
      expect((await screen.findAllByText("Online issue")).length).toBeGreaterThan(0);

      await user.type(screen.getByLabelText("Write a comment"), "Ship it now.");
      await user.click(screen.getByRole("button", { name: "Comment" }));

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(
            ([url, init]) =>
              String(url).endsWith("/repos/acme/app/issues/2/comments") &&
              (init as RequestInit | undefined)?.method === "POST"
          )
        ).toBe(true);
      });
      expect(
        await screen.findByRole("button", {
          name: "Open outbox, 0 pending changes"
        })
      ).toBeInTheDocument();
      expect(await screen.findByText(/Synced 1 queued change/)).toBeInTheDocument();
      expect(await screen.findByText("Ship it now.")).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows the app-wide outbox in the bottom status bar", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^All items/ }));

    const navigation = screen.getByLabelText("Navigation");
    const statusBar = screen.getByLabelText("Status bar");
    const outboxButton = within(statusBar).getByRole("button", {
      name: "Open outbox, 0 pending changes"
    });
    expect(outboxButton).toHaveTextContent("Outbox 0");
    // The description is mounted at rest and opens visually on focus.
    const outboxTip =
      "Outbox stores offline issues and comments waiting to sync to GitHub.";
    expect(outboxButton).not.toHaveAttribute("title");
    const outboxPopup = document.getElementById(
      outboxButton.getAttribute("aria-describedby")!
    );
    expect(outboxPopup).toHaveClass("tooltip-popup");
    expect(outboxPopup).toHaveAttribute("data-closed");
    expect(outboxPopup).toHaveTextContent(outboxTip);
    outboxButton.focus();
    await waitFor(() => expect(outboxPopup).toHaveAttribute("data-open"));
    expect(
      within(navigation).queryByRole("button", {
        name: /Open outbox/
      })
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Detail")).queryByRole("button", {
        name: /outbox/i
      })
    ).not.toBeInTheDocument();
  });

  it("shows notification cache stats while the Notifications tab is active", () => {
    render(<App />);

    expect(screen.getByLabelText("Performance metrics")).toHaveTextContent(
      /Cache Notifications 0\/0 B · Notification details 0\/0 B · Markdown/
    );
  });

  it("clears notification detail activity when Notes becomes active", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: /Design offline issue reading/ })
    );
    await waitFor(() => {
      expect(notificationDetailInputs).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: expect.any(String) })
      );
    });

    notificationDetailInputs.mockClear();
    await user.click(screen.getByRole("button", { name: "Notes" }));

    expect(screen.getByLabelText("Notes library")).toBeInTheDocument();
    await waitFor(() => {
      expect(notificationDetailInputs).toHaveBeenLastCalledWith(null);
    });
  });

  it("clears notification detail activity when All items becomes active", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: /Design offline issue reading/ })
    );
    await waitFor(() => {
      expect(notificationDetailInputs).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: expect.any(String) })
      );
    });

    notificationDetailInputs.mockClear();
    await user.click(screen.getByRole("button", { name: /^All items/ }));

    expect(screen.getByLabelText("Items")).toBeInTheDocument();
    await waitFor(() => {
      expect(notificationDetailInputs).toHaveBeenLastCalledWith(null);
    });
  });

  it("uses neutral status metrics while Notes is active", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: /Design offline issue reading/ })
    );
    await user.click(screen.getByRole("button", { name: "Notes" }));

    expect(screen.getByLabelText("Notes library")).toBeInTheDocument();
    expect(screen.getByLabelText("Performance metrics")).toHaveTextContent(
      "List --Item --Prefetch off · 0 visibleCache --"
    );
  });

  it("caps notification prefetch targets at thirty rows", async () => {
    window.localStorage.removeItem("yonalist.auth.skipLogin.v1");
    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "ghp_test" })
    );
    window.localStorage.setItem(
      "yonalist.github.lastAuthenticatedUrl.v1",
      "https://oss.navercorp.com/api/v3"
    );
    const notifications = Array.from({ length: 35 }, (_, index) => {
      const number = index + 1;
      return {
        id: `notification-${number}`,
        unread: true,
        reason: "mention",
        updated_at: `2026-07-${String((number % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        last_read_at: null,
        subject: {
          title: `Notification ${number}`,
          type: "Issue",
          url: `https://oss.navercorp.com/api/v3/repos/acme/app/issues/${number}`
        },
        repository: {
          full_name: "acme/app",
          name: "app",
          owner: { login: "acme" }
        }
      };
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/user")) {
        return new Response(JSON.stringify({ login: "doortts" }), { status: 200 });
      }
      if (target.includes("/notifications")) {
        return new Response(JSON.stringify(notifications), { status: 200 });
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
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App initialOnline />);

      expect(await screen.findByLabelText("Notifications")).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByLabelText("Performance metrics")).toHaveTextContent(
          /Prefetch 30 visible/
        );
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("updates the status bar when visible signed-in items are prefetched", async () => {
    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "ghp_test" })
    );
    window.localStorage.setItem(
      "yonalist.github.lastAuthenticatedUrl.v1",
      "https://oss.navercorp.com/api/v3"
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/user")) {
        return new Response(JSON.stringify({ login: "doortts" }), { status: 200 });
      }
      if (target.includes("/search/issues")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                number: 10,
                title: "Issue with comments",
                state: "open",
                body: "Large body",
                user: { login: "alice" },
                labels: [],
                comments: 2,
                created_at: "2026-07-06T00:00:00Z",
                updated_at: "2026-07-06T01:00:00Z",
                html_url: "https://oss.navercorp.com/acme/app/issues/10",
                repository_url: "https://oss.navercorp.com/api/v3/repos/acme/app"
              },
              {
                number: 11,
                title: "Second visible issue",
                state: "open",
                body: "Second body",
                user: { login: "bob" },
                labels: [],
                comments: 1,
                created_at: "2026-07-06T00:00:00Z",
                updated_at: "2026-07-06T02:00:00Z",
                html_url: "https://oss.navercorp.com/acme/app/issues/11",
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
      if (target.includes("/notifications")) {
        return new Response(
          JSON.stringify([
            {
              id: "notification-acme-app",
              unread: true,
              reason: "mention",
              updated_at: "2026-07-02T00:00:00Z",
              last_read_at: null,
              subject: {
                title: "Real fetched issue",
                type: "Issue",
                url: "https://oss.navercorp.com/api/v3/repos/acme/app/issues/101"
              },
              repository: {
                full_name: "acme/app",
                name: "app",
                owner: { login: "acme" }
              }
            }
          ]),
          { status: 200 }
        );
      }
      if (target.includes("/user/repos")) {
        return new Response(
          JSON.stringify([
            {
              name: "app",
              full_name: "acme/app",
              owner: { login: "acme" },
              open_issues_count: 2,
              pushed_at: "2026-07-06T00:00:00Z"
            }
          ]),
          { status: 200 }
        );
      }
      if (target.includes("/user/subscriptions") || target.includes("/notifications")) {
        return new Response("[]", { status: 200 });
      }
      if (target.includes("/issues/10/comments")) {
        return new Response(
          JSON.stringify([
            {
              id: 1001,
              body: "First comment",
              user: { login: "alice", name: "Alice" },
              created_at: "2026-07-06T03:00:00Z"
            }
          ]),
          { status: 200 }
        );
      }
      if (target.includes("/issues/11/comments")) {
        return new Response(
          JSON.stringify([
            {
              id: 1101,
              body: "Second comment",
              user: { login: "bob", name: "Bob" },
              created_at: "2026-07-06T04:00:00Z"
            }
          ]),
          { status: 200 }
        );
      }
      if (target.endsWith("/repos/acme/app/issues/10")) {
        return new Response(
          JSON.stringify({
            state: "open",
            user: { login: "alice", name: "Alice" },
            labels: []
          }),
          { status: 200 }
        );
      }
      if (target.endsWith("/repos/acme/app/issues/11")) {
        return new Response(
          JSON.stringify({
            state: "open",
            user: { login: "bob", name: "Bob" },
            labels: []
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const user = userEvent.setup();
      render(<App initialOnline />);

      await user.click(await screen.findByRole("button", { name: /^Issues/ }));
      const list = screen.getByLabelText("Items");
      expect(await within(list).findByText("Issue with comments")).toBeInTheDocument();

      await new Promise((resolve) => setTimeout(resolve, 2200));

      await waitFor(() => {
        expect(screen.getByLabelText("Performance metrics")).toHaveTextContent(
          /Prefetch \d+ visible · [1-9]\d* done/
        );
      });
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes("/issues/11/comments"))
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
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

  function autoFlushFetchMock(
    issuePost: () => Response,
    rateLimit: () => Response | Promise<Response> = () =>
      new Response(JSON.stringify({ resources: {} }), { status: 200 })
  ) {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      // The reconnect reachability probe hits /rate_limit; answer it before the
      // generic fallthrough so tests can toggle the remote in/out of reach.
      if (target.includes("/rate_limit")) {
        return rateLimit();
      }
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

  function reconnectProbeCalls(fetchMock: ReturnType<typeof autoFlushFetchMock>) {
    return fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/rate_limit")
    );
  }

  function queuedIssuePostCalls(fetchMock: ReturnType<typeof autoFlushFetchMock>) {
    return fetchMock.mock.calls.filter(
      ([url, init]) =>
        /\/repos\/[^/]+\/[^/]+\/issues$/.test(String(url)) &&
        (init as RequestInit | undefined)?.method === "POST"
    );
  }

  // Flush pending microtasks plus one macrotask so an in-flight reachability
  // probe settles; used to assert that *no* prompt surfaces.
  async function settleReconnectProbe() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("prompts before syncing on reconnect and sends only after the user confirms", async () => {
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

      // A confirmation appears (after the reachability probe) and nothing is
      // sent yet — the reconnect flush no longer happens automatically.
      const dialog = await screen.findByRole("alertdialog", {
        name: "대기 중인 변경 전송"
      });
      expect(
        within(dialog).getByText(/오프라인에서 작성한 변경 1건/)
      ).toBeInTheDocument();
      expect(reconnectProbeCalls(fetchMock).length).toBeGreaterThan(0);
      expect(queuedIssuePostCalls(fetchMock)).toHaveLength(0);

      await user.click(within(dialog).getByRole("button", { name: "전송" }));

      expect(await screen.findByText(/Synced 1 queued change/)).toBeInTheDocument();
      expect(queuedIssuePostCalls(fetchMock)).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retains a reconnect until the active Inbox vault load completes", async () => {
    const user = userEvent.setup();
    await seedQueuedIssueDraft(user);

    const vaultLoad = deferred<void>();
    loadVaultStateOverride.mockImplementation(async (vaultRoot: string) => {
      await vaultLoad.promise;
      loadVaultStateOverride.mockReset();
      const { loadVaultState } = await import("./services/vaultStore");
      return loadVaultState(vaultRoot);
    });
    const fetchMock = autoFlushFetchMock(
      () => new Response(JSON.stringify({ number: 205 }), { status: 201 })
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App initialOnline={false} />);
      await user.click(screen.getByRole("button", { name: "Go online" }));

      expect(reconnectProbeCalls(fetchMock)).toHaveLength(0);
      vaultLoad.resolve();

      expect(
        await screen.findByRole("alertdialog", { name: "대기 중인 변경 전송" })
      ).toBeInTheDocument();
      expect(reconnectProbeCalls(fetchMock)).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("waits for a fresh Inbox vault generation after returning from Notes", async () => {
    const user = userEvent.setup();
    await seedQueuedIssueDraft(user);

    const fetchMock = autoFlushFetchMock(
      () => new Response(JSON.stringify({ number: 206 }), { status: 201 })
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App initialOnline={false} />);
      await user.click(screen.getByRole("button", { name: /^All items/ }));
      expect((await screen.findAllByText("Auto flush me")).length).toBeGreaterThan(0);

      await user.click(screen.getByRole("button", { name: "Notes" }));
      const freshVaultLoad = deferred<void>();
      loadVaultStateOverride.mockImplementation(async (vaultRoot: string) => {
        await freshVaultLoad.promise;
        loadVaultStateOverride.mockReset();
        const { loadVaultState } = await import("./services/vaultStore");
        return loadVaultState(vaultRoot);
      });

      await user.click(screen.getByRole("button", { name: "Go online" }));
      await user.click(screen.getByRole("button", { name: "GitHub Inbox" }));

      expect(reconnectProbeCalls(fetchMock)).toHaveLength(0);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

      freshVaultLoad.resolve();
      expect(
        await screen.findByRole("alertdialog", { name: "대기 중인 변경 전송" })
      ).toBeInTheDocument();
      expect(reconnectProbeCalls(fetchMock)).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores a reconnect probe that resolves after Notes becomes active", async () => {
    const user = userEvent.setup();
    await seedQueuedIssueDraft(user);

    const reachability = deferred<Response>();
    const fetchMock = autoFlushFetchMock(
      () => new Response(JSON.stringify({ number: 207 }), { status: 201 }),
      () => reachability.promise
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App initialOnline={false} />);
      await user.click(screen.getByRole("button", { name: /^All items/ }));
      expect((await screen.findAllByText("Auto flush me")).length).toBeGreaterThan(0);
      const notesButton = screen.getByRole("button", { name: "Notes" });

      await user.click(screen.getByRole("button", { name: "Go online" }));
      await waitFor(() => expect(reconnectProbeCalls(fetchMock)).toHaveLength(1));

      fireEvent.click(notesButton);
      reachability.resolve(
        new Response(JSON.stringify({ resources: {} }), { status: 200 })
      );
      await settleReconnectProbe();

      expect(screen.getByLabelText("Notes library")).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("closes an open reconnect prompt when Notes becomes active", async () => {
    const user = userEvent.setup();
    await seedQueuedIssueDraft(user);

    const fetchMock = autoFlushFetchMock(
      () => new Response(JSON.stringify({ number: 208 }), { status: 201 })
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App initialOnline={false} />);
      await user.click(screen.getByRole("button", { name: /^All items/ }));
      expect((await screen.findAllByText("Auto flush me")).length).toBeGreaterThan(0);
      const notesButton = screen.getByRole("button", { name: "Notes" });

      await user.click(screen.getByRole("button", { name: "Go online" }));
      expect(
        await screen.findByRole("alertdialog", { name: "대기 중인 변경 전송" })
      ).toBeInTheDocument();

      fireEvent.click(notesButton);

      expect(screen.getByLabelText("Notes library")).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defers a Notes reconnect until Inbox is active without touching Inbox data", async () => {
    const user = userEvent.setup();
    await seedQueuedIssueDraft(user);
    window.localStorage.setItem(activeFeatureStorageKey, "notes");

    const fetchMock = autoFlushFetchMock(
      () => new Response(JSON.stringify({ number: 204 }), { status: 201 })
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App initialOnline={false} />);
      expect(await screen.findByLabelText("Notes library")).toBeInTheDocument();
      await waitFor(() =>
        expect(window.localStorage.getItem(activeFeatureStorageKey)).toBe("notes")
      );
      vi.mocked(window.localStorage.setItem).mockClear();

      await user.click(screen.getByRole("button", { name: "Go online" }));
      await settleReconnectProbe();

      expect(reconnectProbeCalls(fetchMock)).toHaveLength(0);
      expect(queuedIssuePostCalls(fetchMock)).toHaveLength(0);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(window.localStorage.setItem).not.toHaveBeenCalledWith(
        "yonalist.vaultDocuments.v1",
        expect.anything()
      );

      await user.click(screen.getByRole("button", { name: "GitHub Inbox" }));

      expect(
        await screen.findByRole("alertdialog", { name: "대기 중인 변경 전송" })
      ).toBeInTheDocument();
      expect(reconnectProbeCalls(fetchMock)).toHaveLength(1);
      expect(queuedIssuePostCalls(fetchMock)).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not send and does not re-ask when the reconnect prompt is cancelled", async () => {
    const user = userEvent.setup();
    await seedQueuedIssueDraft(user);

    const fetchMock = autoFlushFetchMock(
      () => new Response(JSON.stringify({ number: 201 }), { status: 201 })
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App initialOnline={false} />);
      await user.click(screen.getByRole("button", { name: /^All items/ }));
      expect((await screen.findAllByText("Auto flush me")).length).toBeGreaterThan(0);

      await user.click(screen.getByRole("button", { name: "Go online" }));

      const dialog = await screen.findByRole("alertdialog", {
        name: "대기 중인 변경 전송"
      });
      await user.click(within(dialog).getByRole("button", { name: "나중에" }));

      await waitFor(() =>
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
      );
      // Cancelling sends nothing and does not resurface on its own.
      await settleReconnectProbe();
      expect(queuedIssuePostCalls(fetchMock)).toHaveLength(0);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

      // A fresh offline→online transition re-evaluates and asks again.
      fireEvent(window, new Event("offline"));
      fireEvent(window, new Event("online"));
      expect(
        await screen.findByRole("alertdialog", { name: "대기 중인 변경 전송" })
      ).toBeInTheDocument();
      expect(queuedIssuePostCalls(fetchMock)).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not prompt or send on reconnect when the remote is unreachable", async () => {
    const user = userEvent.setup();
    await seedQueuedIssueDraft(user);

    const fetchMock = autoFlushFetchMock(
      () => new Response(JSON.stringify({ number: 202 }), { status: 201 }),
      // The reachability probe fails: internet is up but the GHE host is not.
      () => new Response(JSON.stringify({ message: "unreachable" }), { status: 502 })
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App initialOnline={false} />);
      await user.click(screen.getByRole("button", { name: /^All items/ }));
      expect((await screen.findAllByText("Auto flush me")).length).toBeGreaterThan(0);

      await user.click(screen.getByRole("button", { name: "Go online" }));

      await waitFor(() =>
        expect(reconnectProbeCalls(fetchMock).length).toBeGreaterThan(0)
      );
      await settleReconnectProbe();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(queuedIssuePostCalls(fetchMock)).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not probe or prompt on reconnect when the sync setting is off", async () => {
    const user = userEvent.setup();
    await seedQueuedIssueDraft(user);
    // Disable the reconnect-sync preference for this run.
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify({ syncQueuedOnReconnect: false })
    );

    const fetchMock = autoFlushFetchMock(
      () => new Response(JSON.stringify({ number: 203 }), { status: 201 })
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App initialOnline={false} />);
      await user.click(screen.getByRole("button", { name: /^All items/ }));
      expect((await screen.findAllByText("Auto flush me")).length).toBeGreaterThan(0);

      await user.click(screen.getByRole("button", { name: "Go online" }));

      await settleReconnectProbe();
      // With the setting off we never even probe reachability, let alone ask.
      expect(reconnectProbeCalls(fetchMock)).toHaveLength(0);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(queuedIssuePostCalls(fetchMock)).toHaveLength(0);
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

      // Confirm the reconnect prompt before the (doomed) send is attempted.
      const prompt = await screen.findByRole("alertdialog", {
        name: "대기 중인 변경 전송"
      });
      await user.click(within(prompt).getByRole("button", { name: "전송" }));

      const dialog = await screen.findByRole("dialog", { name: "Outbox" });
      expect(within(dialog).getByText(/Blocked/)).toBeInTheDocument();
      // Blocked operations are not preselected for another doomed retry.
      expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
      // Permanent failures are not retried.
      expect(queuedIssuePostCalls(fetchMock)).toHaveLength(1);
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
      if (target.includes("/notifications")) {
        return new Response(
          JSON.stringify([
            {
              id: "notification-acme-app",
              unread: true,
              reason: "mention",
              updated_at: "2026-07-02T00:00:00Z",
              last_read_at: null,
              subject: {
                title: "Real fetched issue",
                type: "Issue",
                url: "https://oss.navercorp.com/api/v3/repos/acme/app/issues/101"
              },
              repository: {
                full_name: "acme/app",
                name: "app",
                owner: { login: "acme" }
              }
            }
          ]),
          { status: 200 }
        );
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
      within(await screen.findByLabelText("Settings sections")).getByRole("tab", {
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

  it("resets all settings and caches without deleting vault documents", async () => {
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify({ vaultFolder: "/Users/doortts/CustomVault" })
    );
    window.localStorage.setItem("yonalist.themeMode.v1", "dark");
    window.localStorage.setItem("yonalist.lightTheme.v1", "yona");
    window.localStorage.setItem("yonalist.repositorySummaries.v1", "{\"cache\":true}");
    window.localStorage.setItem(
      "yonalist.vaultDocuments.v1",
      JSON.stringify({
        "/Users/doortts/CustomVault": {
          "github.com/acme/app/issues/1/issue.md": "issue"
        }
      })
    );

    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      within(await screen.findByLabelText("Settings sections")).getByRole("tab", {
        name: /Reset/
      })
    );
    await user.click(
      await screen.findByRole("button", { name: "Reset settings and caches" })
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Reset all settings and caches?"
    });
    expect(dialog).toHaveTextContent("Vault Markdown files and outbox documents");

    await user.click(
      within(dialog).getByRole("button", { name: "Yes, reset everything" })
    );

    const progress = await screen.findByLabelText("Reset progress");
    await waitFor(() => {
      expect(progress).toHaveTextContent(
        "Reset complete. Vault Markdown files and outbox documents were kept."
      );
      expect(within(progress).getAllByText("Done")).toHaveLength(5);
      expect(window.localStorage.getItem("yonalist.settings.v1")).toBeNull();
      expect(window.localStorage.getItem("yonalist.themeMode.v1")).toBe("system");
      expect(window.localStorage.getItem("yonalist.lightTheme.v1")).toBe("graphite");
      expect(window.localStorage.getItem("yonalist.darkTheme.v1")).toBe("dark");
      expect(document.documentElement.dataset.theme).toBe("graphite");
      expect(window.localStorage.getItem("yonalist.repositorySummaries.v1")).toBeNull();
    });
    expect(window.localStorage.getItem("yonalist.vaultDocuments.v1")).toContain(
      "github.com/acme/app/issues/1/issue.md"
    );
  });

  it("lists default GitHub servers and switches the selected one", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      within(await screen.findByLabelText("Settings sections")).getByRole("tab", {
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
      within(await screen.findByLabelText("Settings sections")).getByRole("tab", {
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
    // Auth method is a Base UI ToggleGroup; its segments render as toggle buttons.
    await user.click(within(section).getByRole("button", { name: "개인 토큰" }));
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
      if (target.includes("/notifications")) {
        return new Response(
          JSON.stringify([
            {
              id: "notification-acme-app",
              unread: true,
              reason: "mention",
              updated_at: "2026-07-02T00:00:00Z",
              last_read_at: null,
              subject: {
                title: "Real fetched issue",
                type: "Issue",
                url: "https://oss.navercorp.com/api/v3/repos/acme/app/issues/101"
              },
              repository: {
                full_name: "acme/app",
                name: "app",
                owner: { login: "acme" }
              }
            }
          ]),
          { status: 200 }
        );
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
      await waitFor(() => {
        const initialIssueCall = fetchMock.mock.calls.find(([url]) => {
          const target = String(url);
          return (
            target.includes("/search/issues") &&
            target.includes("sort=created") &&
            target.includes("order=desc")
          );
        });
        expect(initialIssueCall).toBeTruthy();
      });

      await user.click(
        within(list).getByRole("button", {
          name: "Sort by Created descending"
        })
      );
      await user.click(screen.getByRole("menuitem", { name: "↑ Updated" }));
      await waitFor(() => {
        const updatedAscendingIssueCall = fetchMock.mock.calls.find(([url]) => {
          const target = String(url);
          return (
            target.includes("/search/issues") &&
            target.includes("sort=updated") &&
            target.includes("order=asc")
          );
        });
        expect(updatedAscendingIssueCall).toBeTruthy();
      });
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(([url]) => String(url).includes("/notifications"))
        ).toBe(true)
      );
      await waitFor(() =>
        expect(
          window.localStorage.getItem("yonalist.projectVisibility.v1")
        ).toContain('"acme/app":true')
      );

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

  it("shows cached inbox items when a repository fetch is still loading", async () => {
    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "ghp_test" })
    );
    let resolveRepoIssues: (response: Response) => void = () => undefined;
    const repoIssues = new Promise<Response>((resolve) => {
      resolveRepoIssues = resolve;
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/repos/acme/app/issues")) {
        return repoIssues;
      }
      if (target.includes("/search/issues")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                number: 101,
                title: "Inbox cached issue",
                state: "open",
                body: "from the inbox cache",
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
      if (target.includes("/notifications")) {
        return new Response(
          JSON.stringify([
            {
              id: "notification-acme-app",
              unread: true,
              reason: "mention",
              updated_at: "2026-07-02T00:00:00Z",
              last_read_at: null,
              subject: {
                title: "Inbox cached issue",
                type: "Issue",
                url: "https://oss.navercorp.com/api/v3/repos/acme/app/issues/101"
              },
              repository: {
                full_name: "acme/app",
                name: "app",
                owner: { login: "acme" }
              }
            }
          ]),
          { status: 200 }
        );
      }
      if (target.includes("/user/repos")) {
        return new Response(
          JSON.stringify([
            {
              name: "app",
              full_name: "acme/app",
              owner: { login: "acme" },
              open_issues_count: 1,
              pushed_at: "2026-07-01T00:00:00Z"
            }
          ]),
          { status: 200 }
        );
      }
      if (target.includes("/api/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (String(body.query).includes("RepositoryItemStateCounts")) {
          return new Response(
            JSON.stringify({
              data: {
                r0: {
                  issuesOpen: { totalCount: 1 },
                  pullRequestsOpen: { totalCount: 0 },
                  discussionsOpen: { totalCount: 0 },
                  issuesClosed: { totalCount: 0 },
                  pullRequestsClosed: { totalCount: 0 },
                  pullRequestsMerged: { totalCount: 0 },
                  discussionsClosed: { totalCount: 0 }
                }
              }
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ data: { search: { nodes: [] } } }), {
          status: 200
        });
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

      const navigation = screen.getByLabelText("Navigation");
      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(([url]) => String(url).includes("/search/issues"))
        ).toBe(true);
      });

      await user.click(await within(navigation).findByRole("button", { name: /^app/ }));

      const list = screen.getByLabelText("Items");
      expect(within(list).getByText("Inbox cached issue")).toBeInTheDocument();
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/repos/acme/app/issues")
        )
      ).toBe(true);
    } finally {
      resolveRepoIssues(new Response("[]", { status: 200 }));
      vi.unstubAllGlobals();
    }
  });

  it("requests exact project counts only after a project is selected", async () => {
    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "ghp_test" })
    );
    const user = userEvent.setup();
    const countQueries: string[] = [];
    const countVariables: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/search/issues")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (target.includes("/api/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (String(body.query).includes("RepositoryItemStateCounts")) {
          countQueries.push(String(body.query));
          countVariables.push(body.variables as Record<string, unknown>);
          return new Response(
            JSON.stringify({
              data: {
                r0: {
                  issuesOpen: { totalCount: 1 },
                  pullRequestsOpen: { totalCount: 1 },
                  discussionsOpen: { totalCount: 1 },
                  issuesClosed: { totalCount: 2 },
                  pullRequestsClosed: { totalCount: 2 },
                  pullRequestsMerged: { totalCount: 4 },
                  discussionsClosed: { totalCount: 2 }
                }
              }
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ data: { search: { nodes: [] } } }), {
          status: 200
        });
      }
      if (target.includes("/notifications")) {
        return new Response(
          JSON.stringify([
            {
              id: "notification-acme-visible",
              unread: true,
              reason: "mention",
              updated_at: "2026-07-02T00:00:00Z",
              last_read_at: null,
              subject: {
                title: "Visible repo ping",
                type: "Issue",
                url: "https://oss.navercorp.com/api/v3/repos/acme/visible/issues/1"
              },
              repository: {
                full_name: "acme/visible",
                name: "visible",
                owner: { login: "acme" }
              }
            }
          ]),
          { status: 200 }
        );
      }
      if (target.includes("affiliation=owner%2Ccollaborator")) {
        return new Response(
          JSON.stringify([
            {
              name: "visible",
              full_name: "acme/visible",
              owner: { login: "acme" },
              open_issues_count: 1,
              pushed_at: "2026-07-01T00:00:00Z"
            }
          ]),
          { status: 200 }
        );
      }
      if (target.includes("affiliation=organization_member")) {
        return new Response(
          JSON.stringify([
            {
              name: "hidden",
              full_name: "pi/hidden",
              owner: { login: "pi" },
              open_issues_count: 99,
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
      render(<App />);

      const navigation = await screen.findByLabelText("Navigation");
      const visibleProject = await within(navigation).findByRole("button", {
        name: /^visible/
      });
      expect(visibleProject).toBeInTheDocument();
      expect(
        within(navigation).queryByRole("button", { name: /^hidden/ })
      ).not.toBeInTheDocument();

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(([url]) =>
            String(url).includes("affiliation=owner%2Ccollaborator")
          )
        ).toBe(true)
      );
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      expect(countQueries).toHaveLength(0);

      await user.click(visibleProject);

      await waitFor(() => expect(countQueries).toHaveLength(1));
      expect(JSON.stringify(countVariables)).toContain("visible");
      expect(JSON.stringify(countVariables)).not.toContain("hidden");
      const list = screen.getByLabelText("Items");
      expect(
        await within(list).findByRole("tab", { name: /^Open\s*3$/ })
      ).toBeInTheDocument();
      expect(
        within(list).getByRole("tab", { name: /^Closed\s*10$/ })
      ).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows repository loading failures in a bottom snackbar", async () => {
    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ "https://oss.navercorp.com/api/v3": "ghp_test" })
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/search/issues")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (target.includes("/api/graphql")) {
        return new Response(JSON.stringify({ data: { search: { nodes: [] } } }), {
          status: 200
        });
      }
      if (target.includes("affiliation=owner%2Ccollaborator")) {
        return new Response(JSON.stringify({ message: "repo list unavailable" }), {
          status: 500
        });
      }
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<App />);

      // The message renders inside a Base UI Toast whose root carries the
      // legacy `.app-snackbar` class for visual parity.
      const message = await screen.findByText(/Could not load repositories/i);
      expect(message.closest(".app-snackbar")).not.toBeNull();
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
    expect(within(list).getByRole("tab", { name: /^Open\s*\d+$/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(within(list).queryByText("Closed local issue")).not.toBeInTheDocument();

    await user.click(within(list).getByRole("tab", { name: /^Closed\s*\d+$/ }));

    expect(within(list).getByRole("tab", { name: /^Closed\s*\d+$/ })).toHaveAttribute(
      "aria-selected",
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

  it("remembers item sort separately for inbox tabs and repositories", async () => {
    const user = userEvent.setup();
    render(<App />);

    const navigation = screen.getByLabelText("Navigation");
    const sortButton = () =>
      within(screen.getByLabelText("Items")).getByRole("button", {
        name: /Sort by/
      });

    await user.click(
      within(navigation).getByRole("button", { name: /^All items/ })
    );
    expect(sortButton()).toHaveAccessibleName("Sort by Created descending");

    await user.click(sortButton());
    await user.click(screen.getByRole("menuitem", { name: "↑ Updated" }));
    expect(sortButton()).toHaveAccessibleName("Sort by Updated ascending");

    await user.click(
      within(navigation).getByRole("button", { name: /^Issues/ })
    );
    expect(sortButton()).toHaveAccessibleName("Sort by Created descending");

    await user.click(within(navigation).getByRole("button", { name: /^blog/ }));
    expect(sortButton()).toHaveAccessibleName("Sort by Created descending");

    await user.click(sortButton());
    await user.click(screen.getByRole("menuitem", { name: "↓ Updated" }));
    expect(sortButton()).toHaveAccessibleName("Sort by Updated descending");

    await user.click(
      within(navigation).getByRole("button", { name: /^All items/ })
    );
    expect(sortButton()).toHaveAccessibleName("Sort by Updated ascending");

    await user.click(within(navigation).getByRole("button", { name: /^blog/ }));
    expect(sortButton()).toHaveAccessibleName("Sort by Updated descending");
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

  it("clears the active project when Notifications is selected", async () => {
    const user = userEvent.setup();
    render(<App />);

    const navigation = screen.getByLabelText("Navigation");
    const project = within(navigation).getByRole("button", { name: /^blog/ });
    await user.click(project);

    expect(project).toHaveAttribute("aria-pressed", "true");

    await user.click(within(navigation).getByRole("button", { name: /^Notifications/ }));

    expect(
      within(navigation).getByRole("button", { name: /^Notifications/ })
    ).toHaveClass("active");
    expect(project).toHaveAttribute("aria-pressed", "false");
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
      within(await screen.findByLabelText("Settings sections")).getByRole("tab", {
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
    await user.click(screen.getByRole("button", { name: "GitHub Inbox" }));
    expect(
      within(navigation).getByRole("button", { name: /^blog/ })
    ).toBeInTheDocument();
  });

  it("opens project visibility settings from the Repository header shortcut", async () => {
    const user = userEvent.setup();
    render(<App />);

    const navigation = screen.getByLabelText("Navigation");
    await user.click(
      within(navigation).getByRole("button", {
        name: "Open repository filter settings"
      })
    );

    const settingsSections = await screen.findByLabelText("Settings sections");
    expect(
      within(settingsSections).getByRole("tab", { name: /Projects 표시/ })
    ).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByLabelText("Project visibility")).toBeInTheDocument();
  });

  it("filters the project visibility list by owner or repository name", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      within(await screen.findByLabelText("Settings sections")).getByRole("tab", {
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
      within(await screen.findByLabelText("Settings sections")).getByRole("tab", {
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

  it("shows grouped sample notifications without per-notification hiding", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^Notifications/ }));

    const pane = screen.getByLabelText("Notifications");
    expect(within(pane).getByText("Today")).toBeInTheDocument();
    expect(
      within(pane).getByText("Design offline issue reading")
    ).toBeInTheDocument();
    expect(pane.querySelector(".notification-lead .avatar")).toBeNull();
    expect(
      pane.querySelector(".notification-lead .notification-reason")
    ).not.toBeNull();
    expect(
      within(pane).queryByRole("button", { name: "Hide notification" })
    ).not.toBeInTheDocument();
    expect(
      within(pane).queryByLabelText("Show hidden notifications")
    ).not.toBeInTheDocument();
  });

  // The newest sample must group under "Today" regardless of wall-clock
  // time. A fixed offset used to cross local midnight, dropping the sample
  // into "Yesterday" between 00:00 and 00:05 local time and flaking this
  // suite. Fake only Date so userEvent's real timers still resolve.
  it.each([
    ["just after local midnight", new Date(2026, 0, 15, 0, 2, 0)],
    ["midday", new Date(2026, 0, 15, 12, 0, 0)]
  ])("groups the newest sample under Today (%s)", async (_label, frozenNow) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(frozenNow);
    try {
      const user = userEvent.setup();
      render(<App />);

      await user.click(screen.getByRole("button", { name: /^Notifications/ }));

      const pane = screen.getByLabelText("Notifications");
      expect(within(pane).getByText("Today")).toBeInTheDocument();
      expect(
        within(pane).getByText("Design offline issue reading")
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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
    window.localStorage.setItem("yonalist.lightTheme.v1", "default");
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.getByRole("radio", { name: "Graphite light theme" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Soft Paper light theme" })
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("radio", { name: "Graphite light theme" })
    );
    expect(document.documentElement.dataset.theme).toBe("graphite");
    expect(window.localStorage.getItem("yonalist.lightTheme.v1")).toBe(
      "graphite"
    );

    await user.click(await screen.findByRole("radio", { name: "Yona light theme" }));

    expect(document.documentElement.dataset.theme).toBe("yona");
    expect(window.localStorage.getItem("yonalist.lightTheme.v1")).toBe("yona");

    await user.click(screen.getByRole("radio", { name: "Dark mode" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("yonalist.themeMode.v1")).toBe("dark");

    await user.click(screen.getByRole("radio", { name: "Light mode" }));

    expect(document.documentElement.dataset.theme).toBe("yona");
    expect(window.localStorage.getItem("yonalist.themeMode.v1")).toBe("light");

    await user.click(screen.getByRole("radio", { name: "Default light theme" }));

    expect(document.documentElement.dataset.theme).toBe("default");
    expect(window.localStorage.getItem("yonalist.lightTheme.v1")).toBe("default");

    await user.click(screen.getByRole("radio", { name: "Yonal Light light theme" }));

    expect(document.documentElement.dataset.theme).toBe("yonal-light");
    expect(window.localStorage.getItem("yonalist.lightTheme.v1")).toBe("yonal-light");

    await user.click(screen.getByRole("radio", { name: "System mode" }));

    expect(document.documentElement.dataset.theme).toBe("yonal-light");
    expect(window.localStorage.getItem("yonalist.themeMode.v1")).toBe("system");
  });

  it("switches markdown rendering style from the appearance settings", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByLabelText("Markdown rendering samples")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Yona markdown style" }));
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(window.localStorage.getItem("yonalist.settings.v1")).toContain(
      '"markdownStyle":"yona"'
    );

    await user.click(screen.getByRole("button", { name: "Close settings" }));
    await user.click(screen.getByRole("button", { name: /^All items/ }));

    const detail = screen.getByLabelText("Detail");
    expect(detail.querySelector(".markdown-body-yona")).not.toBeNull();
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

    fireEvent.pointerDown(navigationResizer, { clientX: 240, button: 0 });
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

  // The detail maximize control moves between the header (inline, while the
  // header is on screen) and the fixed titlebar corner (once the header scrolls
  // away), so it never overlaps the header's own actions.
  describe("detail maximize toggle placement", () => {
    let ioCallback: IntersectionObserverCallback | null = null;
    let ioInstance: IntersectionObserver;

    class MockIntersectionObserver implements IntersectionObserver {
      root: Element | Document | null = null;
      rootMargin = "";
      scrollMargin = "";
      thresholds: ReadonlyArray<number> = [];
      constructor(cb: IntersectionObserverCallback) {
        ioCallback = cb;
        ioInstance = this as unknown as IntersectionObserver;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = () => [];
    }

    // isIntersecting reflects the header sentinel: true → header on screen.
    function fireHeaderVisible(isIntersecting: boolean) {
      act(() => {
        ioCallback?.([{ isIntersecting } as IntersectionObserverEntry], ioInstance);
      });
    }

    beforeEach(() => {
      ioCallback = null;
      vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("keeps the fixed corner toggle on the header-less landing view", () => {
      render(<App />);
      // The landing notification detail is empty (no header), so the fixed
      // corner maximize toggle is the only one present.
      const detailGroup = screen.getByRole("group", { name: "Detail layout" });
      expect(
        within(detailGroup).getByRole("button", { name: "상세 최대화" })
      ).toBeInTheDocument();
    });

    it("hides the fixed corner toggle and shows it inline while the detail header is visible", async () => {
      const user = userEvent.setup();
      render(<App />);

      await user.click(
        screen.getByRole("button", { name: /Design offline issue reading/ })
      );

      // The header is on screen, so the fixed corner group is gone and the
      // toggle lives inline in the detail header actions instead.
      expect(screen.queryByRole("group", { name: "Detail layout" })).toBeNull();
      const detail = screen.getByLabelText("Detail");
      expect(
        within(detail).getByRole("button", { name: "상세 최대화" })
      ).toBeInTheDocument();
    });

    it("restores the fixed corner toggle once the detail header scrolls out of view", async () => {
      const user = userEvent.setup();
      render(<App />);

      await user.click(
        screen.getByRole("button", { name: /Design offline issue reading/ })
      );
      expect(screen.queryByRole("group", { name: "Detail layout" })).toBeNull();

      // The header leaves the viewport → the fixed corner toggle returns.
      fireHeaderVisible(false);

      const detailGroup = await screen.findByRole("group", {
        name: "Detail layout"
      });
      expect(
        within(detailGroup).getByRole("button", { name: "상세 최대화" })
      ).toBeInTheDocument();
    });

    it("maximizes the detail pane from the inline header toggle", async () => {
      const user = userEvent.setup();
      render(<App />);
      const shell = await screen.findByLabelText("Yonalist layout");

      await user.click(
        screen.getByRole("button", { name: /Design offline issue reading/ })
      );

      const inlineMaximize = within(screen.getByLabelText("Detail")).getByRole(
        "button",
        { name: "상세 최대화" }
      );
      expect(inlineMaximize).toHaveAttribute("aria-pressed", "false");

      await user.click(inlineMaximize);

      expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
      expect(shell).toHaveAttribute("data-list-collapsed", "true");
      expect(inlineMaximize).toHaveAttribute("aria-pressed", "true");
    });
  });
});
